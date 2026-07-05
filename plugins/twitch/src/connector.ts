/**
 * Twitch PlatformConnector.
 *
 * Twitch/Helix is not a "post" network, so the ten-method contract is mapped
 * as follows (full rationale in README.md):
 *
 *  - publish/edit  -> Modify Channel Information (title/category/tags) via
 *                     `PATCH /helix/channels`. The channel is a singleton
 *                     resource, so both operations converge on the same call;
 *                     `remoteId` is the broadcaster's Twitch user id.
 *  - delete        -> not supported (channel info can only be overwritten).
 *  - uploadMedia   -> not supported (no Helix endpoint accepts an arbitrary
 *                     media upload for channel content).
 *  - getAnalytics  -> Get Streams (live viewer count) + Get Channel Followers
 *                     (total follower count), for the channel `remoteId`.
 *  - authenticate  -> Authorization Code + PKCE / Client Credentials against
 *                     id.twitch.tv/oauth2 (per docs/AUTH.md).
 *  - disconnect    -> POST /oauth2/revoke.
 *
 * Official Twitch Helix + OAuth endpoints only. No scraping, no undocumented
 * endpoints, no browser automation.
 */

import type {
  AnalyticsQuery,
  AnalyticsSnapshot,
  AuthRequest,
  AuthResult,
  ConnectInput,
  ConnectResult,
  ConnectorRuntime,
  DeleteRequest,
  DeleteResult,
  DisconnectResult,
  EditRequest,
  EditResult,
  MediaSource,
  OperationContext,
  PlatformConnector,
  PostPayload,
  PublishResult,
  RefreshInput,
  StructuredLogger,
  TokenSet,
  UploadedMedia,
  ValidationIssue,
  ValidationResult,
} from '@social/core';
import {
  AuthError,
  NotSupportedError,
  TokenExpiredError,
  TokenRevokedError,
  TransientError,
  ValidationFailedError,
  assertSupported,
} from '@social/core';

import { capabilities, TWITCH_MAX_TAGS, TWITCH_TAG_MAX_LENGTH, TWITCH_TITLE_CHARACTER_LIMIT } from './capabilities';
import { OAUTH_BASE_URL, helixRequest, type OAuthTokenResponse, type OAuthValidateResponse } from './http';

const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_]{0,24}$/;

// Helix API response shape (for reference; type checking handled by assertions in getAnalytics)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface HelixChannelInfo {
  broadcaster_id: string;
  broadcaster_login: string;
  broadcaster_name: string;
  game_id: string;
  game_name: string;
  title: string;
  tags?: string[];
}

interface HelixStream {
  id: string;
  user_id: string;
  viewer_count: number;
  started_at: string;
  game_name: string;
}

interface HelixFollowersResponse {
  total: number;
}

function titleOf(payload: PostPayload): string | undefined {
  return payload.title ?? payload.text;
}

/** Pure rule check — no network calls, matches `capabilities` exactly. */
function validate(payload: PostPayload): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const title = titleOf(payload);
  if (!title || title.trim().length === 0) {
    errors.push({
      code: 'title_required',
      message: 'Twitch publish requires a non-empty channel title (payload.title or payload.text).',
      severity: 'error',
      field: 'title',
    });
  } else if (title.length > TWITCH_TITLE_CHARACTER_LIMIT) {
    errors.push({
      code: 'text_too_long',
      message: `Channel title exceeds Twitch's ${TWITCH_TITLE_CHARACTER_LIMIT}-character limit.`,
      severity: 'error',
      field: 'title',
      limit: TWITCH_TITLE_CHARACTER_LIMIT,
      actual: title.length,
    });
  }

  if (payload.tags && payload.tags.length > 0) {
    if (payload.tags.length > TWITCH_MAX_TAGS) {
      errors.push({
        code: 'too_many_tags',
        message: `Twitch allows at most ${TWITCH_MAX_TAGS} tags per channel.`,
        severity: 'error',
        field: 'tags',
        limit: TWITCH_MAX_TAGS,
        actual: payload.tags.length,
      });
    }
    payload.tags.forEach((tag, index) => {
      if (!TAG_PATTERN.test(tag) || tag.length > TWITCH_TAG_MAX_LENGTH) {
        errors.push({
          code: 'invalid_tag',
          message: `Tag "${tag}" must be 1-${TWITCH_TAG_MAX_LENGTH} alphanumeric/underscore characters, starting with a letter or digit.`,
          severity: 'error',
          field: `tags[${index}]`,
          limit: TWITCH_TAG_MAX_LENGTH,
          actual: tag.length,
        });
      }
    });
  }

  if (payload.mentions && payload.mentions.length > 0) {
    errors.push({
      code: 'mentions_not_supported',
      message: 'Twitch channel information does not support mentions.',
      severity: 'error',
      field: 'mentions',
    });
  }

  if (payload.media && payload.media.length > 0) {
    errors.push({
      code: 'media_not_supported',
      message: 'Twitch channel information updates do not accept media attachments.',
      severity: 'error',
      field: 'media',
      limit: 0,
      actual: payload.media.length,
    });
  }

  if (payload.thread && payload.thread.length > 0) {
    errors.push({
      code: 'threads_not_supported',
      message: 'Twitch does not support threaded posts.',
      severity: 'error',
      field: 'thread',
    });
  }

  if (payload.scheduledAt) {
    warnings.push({
      code: 'native_scheduling_not_supported',
      message: 'Twitch has no native scheduling for channel updates; scheduledAt will be ignored by this connector.',
      severity: 'warning',
      field: 'scheduledAt',
    });
  }

  return { ok: errors.length === 0, errors, warnings };
}

export class TwitchConnector implements PlatformConnector {
  readonly capabilities = capabilities;

  private readonly logger: StructuredLogger;
  private readonly now: () => Date;

  constructor(runtime: ConnectorRuntime) {
    this.logger = runtime.logger.child({ platform: 'twitch' });
    this.now = runtime.now ?? (() => new Date());
  }

  async connect(input: ConnectInput): Promise<ConnectResult> {
    if (!input.app.clientId) {
      throw new AuthError('Twitch connect requires app.clientId.', { platform: 'twitch', operation: 'connect' });
    }

    if (input.token) {
      // Reachability + token liveness check via the documented validate
      // endpoint (id.twitch.tv/oauth2/validate) — never a scrape, never a
      // Helix data call, so it costs nothing against the Helix rate bucket.
      await this.validateToken(input.token.accessToken);
    }

    this.logger.info('twitch.connect', { accountId: input.accountId, hasToken: Boolean(input.token) });
    return { ready: true, platform: 'twitch', apiVersion: 'helix' };
  }

  async authenticate(request: AuthRequest): Promise<AuthResult> {
    if (request.kind === 'authorize_url') {
      const url = new URL('/oauth2/authorize', OAUTH_BASE_URL);
      url.searchParams.set('client_id', request.app.clientId);
      url.searchParams.set('redirect_uri', request.app.redirectUri ?? '');
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', request.scopes.join(' '));
      url.searchParams.set('state', request.state);
      if (request.codeChallenge) {
        url.searchParams.set('code_challenge', request.codeChallenge);
        url.searchParams.set('code_challenge_method', 'S256');
      }
      this.logger.info('twitch.authenticate.authorize_url', { scopes: request.scopes.length });
      return { authorizeUrl: url.toString() };
    }

    if (request.kind === 'exchange_code') {
      const body = new URLSearchParams({
        client_id: request.app.clientId,
        grant_type: 'authorization_code',
        code: request.code,
        redirect_uri: request.app.redirectUri ?? '',
      });
      if (request.app.clientSecret) body.set('client_secret', request.app.clientSecret);
      if (request.codeVerifier) body.set('code_verifier', request.codeVerifier);

      const token = await this.tokenRequest(body);
      const profile = await this.fetchOwnProfile(token, request.app.clientId);
      this.logger.info('twitch.authenticate.exchange_code', { hasRefreshToken: Boolean(token.refreshToken) });
      return { token, profile };
    }

    if (request.kind === 'password') {
      // Twitch has no password-grant flow; this platform is pure OAuth2.
      throw new AuthError('Twitch does not support password-grant authentication.', {
        platform: 'twitch',
        operation: 'authenticate',
      });
    }

    // client_credentials — app-level token, no user profile.
    const body = new URLSearchParams({
      client_id: request.app.clientId,
      client_secret: request.app.clientSecret ?? '',
      grant_type: 'client_credentials',
      scope: request.scopes.join(' '),
    });
    const token = await this.tokenRequest(body);
    this.logger.info('twitch.authenticate.client_credentials', { scopes: request.scopes.length });
    return { token };
  }

  async refreshToken(input: RefreshInput): Promise<TokenSet> {
    if (!input.token.refreshToken) {
      throw new TokenRevokedError('No refresh token available for this Twitch account; re-authentication required.', {
        platform: 'twitch',
        operation: 'refreshToken',
      });
    }
    const body = new URLSearchParams({
      client_id: input.app.clientId,
      grant_type: 'refresh_token',
      refresh_token: input.token.refreshToken,
    });
    if (input.app.clientSecret) body.set('client_secret', input.app.clientSecret);

    let response: Response;
    try {
      response = await fetch(new URL('/oauth2/token', OAUTH_BASE_URL), { method: 'POST', body });
    } catch (cause) {
      throw new TransientError('Network error refreshing Twitch token.', { platform: 'twitch', cause });
    }

    if (response.status === 400 || response.status === 401) {
      this.logger.warn('twitch.refreshToken.revoked', { status: response.status });
      throw new TokenRevokedError('Twitch rejected the refresh token; re-authentication required.', {
        platform: 'twitch',
        operation: 'refreshToken',
        details: { status: response.status },
      });
    }
    if (!response.ok) {
      throw new TransientError(`Twitch token refresh failed with status ${response.status}.`, {
        platform: 'twitch',
        operation: 'refreshToken',
      });
    }

    const json = (await response.json()) as OAuthTokenResponse;
    this.logger.info('twitch.refreshToken.ok', { hasRefreshToken: Boolean(json.refresh_token) });
    return this.toTokenSet(json);
  }

  async validatePost(payload: PostPayload): Promise<ValidationResult> {
    return validate(payload);
  }

  async uploadMedia(_media: MediaSource, _ctx: OperationContext): Promise<UploadedMedia> {
    assertSupported(this.capabilities, 'uploadMedia');
    throw new NotSupportedError('uploadMedia', 'twitch');
  }

  async publish(payload: PostPayload, ctx: OperationContext): Promise<PublishResult> {
    assertSupported(this.capabilities, 'publish');
    const result = await this.updateChannel(payload, ctx, 'publish');
    return {
      remoteId: result.broadcasterId,
      remoteUrl: `https://twitch.tv/${result.login}`,
      publishedAt: this.now().toISOString(),
    };
  }

  async delete(_request: DeleteRequest, _ctx: OperationContext): Promise<DeleteResult> {
    assertSupported(this.capabilities, 'delete');
    throw new NotSupportedError('delete', 'twitch');
  }

  async edit(request: EditRequest, ctx: OperationContext): Promise<EditResult> {
    assertSupported(this.capabilities, 'edit');
    const result = await this.updateChannel(request.payload, ctx, 'edit');
    if (result.broadcasterId !== request.remoteId) {
      this.logger.warn('twitch.edit.remoteId_mismatch', {
        expected: request.remoteId,
        actual: result.broadcasterId,
      });
    }
    return {
      remoteId: result.broadcasterId,
      editedAt: this.now().toISOString(),
      remoteUrl: `https://twitch.tv/${result.login}`,
    };
  }

  async getAnalytics(query: AnalyticsQuery, ctx: OperationContext): Promise<AnalyticsSnapshot> {
    assertSupported(this.capabilities, 'getAnalytics');

    if (query.since || query.until) {
      this.logger.warn('twitch.getAnalytics.range_ignored', {
        reason: 'Helix has no historical channel-metrics endpoint; returning the current snapshot only.',
      });
    }

    const metrics: Record<string, number> = {};
    const raw: Record<string, unknown> = {};

    // Contract v1.1: Client-Id comes straight from OperationContext.app — no
    // more spending a call on /oauth2/validate just to learn it (see README
    // "Contract gap" note, now resolved).
    const clientId = ctx.app.clientId;

    const streams = await helixRequest<{ data: HelixStream[] }>({
      path: 'streams',
      query: { user_id: query.remoteId },
      clientId,
      accessToken: ctx.token.accessToken,
      logger: ctx.logger,
      operation: 'getAnalytics.streams',
    });
    const live = streams?.data?.[0];
    if (live) {
      metrics.views = live.viewer_count;
      raw.stream = { startedAt: live.started_at, gameName: live.game_name };
    }

    try {
      const followers = await helixRequest<HelixFollowersResponse>({
        path: 'channels/followers',
        query: { broadcaster_id: query.remoteId, first: 1 },
        clientId,
        accessToken: ctx.token.accessToken,
        logger: ctx.logger,
        operation: 'getAnalytics.followers',
      });
      if (followers) {
        // Total follower count, not a delta — CANONICAL_METRICS only has
        // `followersDelta`, which needs two snapshots diffed over time. That
        // aggregation is owned by analytics-logging; we surface the raw total
        // here so it can do so.
        raw.followersTotal = followers.total;
      }
    } catch (error) {
      // Requires `moderator:read:followers`; degrade gracefully if the scope
      // wasn't granted rather than failing the whole snapshot.
      ctx.logger.warn('twitch.getAnalytics.followers_unavailable', { error: (error as Error).message });
    }

    return { remoteId: query.remoteId, collectedAt: this.now().toISOString(), metrics, raw };
  }

  async disconnect(ctx: OperationContext): Promise<DisconnectResult> {
    // Contract v1.1: Client-Id comes from OperationContext.app — no need to
    // call /oauth2/validate first just to learn it.
    const body = new URLSearchParams({ client_id: ctx.app.clientId, token: ctx.token.accessToken });
    try {
      const response = await fetch(new URL('/oauth2/revoke', OAUTH_BASE_URL), { method: 'POST', body });
      ctx.logger.info('twitch.disconnect', { status: response.status });
      // Twitch returns 200 on success; a 400 for an already-invalid token
      // still means the credential is dead at the platform, so treat both as
      // revoked from our point of view.
      return { revoked: response.ok || response.status === 400 };
    } catch (cause) {
      ctx.logger.error('twitch.disconnect.failed', { error: (cause as Error).message });
      return { revoked: false };
    }
  }

  // ---------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------

  private async updateChannel(
    payload: PostPayload,
    ctx: OperationContext,
    operation: 'publish' | 'edit',
  ): Promise<{ broadcasterId: string; login: string }> {
    const result = validate(payload);
    if (!result.ok) {
      throw new ValidationFailedError(result, { platform: 'twitch', operation });
    }

    // The broadcaster's Twitch user id is only obtainable by resolving the
    // token's identity — OperationContext has no Twitch-native user id field,
    // only the internal `accountId`. This validate() call is therefore still
    // required (unlike the client-id-only lookups in getAnalytics/disconnect,
    // which Contract v1.1's `ctx.app.clientId` made unnecessary).
    const identity = await this.validateToken(ctx.token.accessToken);
    const broadcasterId = identity.user_id;
    if (!broadcasterId) {
      throw new AuthError('Twitch token validation did not return a user_id.', { platform: 'twitch', operation });
    }

    const title = titleOf(payload)!;
    const options = (payload.platformOptions ?? {}) as { gameId?: string; categoryId?: string };
    const body: Record<string, unknown> = { title };
    const gameId = options.gameId ?? options.categoryId;
    if (gameId) body.game_id = gameId;
    if (payload.tags) body.tags = payload.tags;

    await helixRequest<void>({
      method: 'PATCH',
      path: 'channels',
      query: { broadcaster_id: broadcasterId },
      body,
      clientId: ctx.app.clientId,
      accessToken: ctx.token.accessToken,
      logger: ctx.logger,
      operation: `${operation}.channels`,
    });

    ctx.logger.info(`twitch.${operation}`, { accountId: ctx.accountId, broadcasterId, titleLength: title.length });

    return { broadcasterId, login: identity.login ?? broadcasterId };
  }

  private async validateToken(accessToken: string): Promise<OAuthValidateResponse> {
    let response: Response;
    try {
      response = await fetch(new URL('/oauth2/validate', OAUTH_BASE_URL), {
        headers: { Authorization: `OAuth ${accessToken}` },
      });
    } catch (cause) {
      throw new TransientError('Network error validating Twitch token.', { platform: 'twitch', cause });
    }
    if (response.status === 401) {
      throw new TokenExpiredError('Twitch access token failed validation (401).', { platform: 'twitch' });
    }
    if (!response.ok) {
      throw new TransientError(`Twitch token validation failed with status ${response.status}.`, {
        platform: 'twitch',
      });
    }
    return (await response.json()) as OAuthValidateResponse;
  }

  private async tokenRequest(body: URLSearchParams): Promise<TokenSet> {
    let response: Response;
    try {
      response = await fetch(new URL('/oauth2/token', OAUTH_BASE_URL), { method: 'POST', body });
    } catch (cause) {
      throw new TransientError('Network error obtaining Twitch token.', { platform: 'twitch', cause });
    }
    if (!response.ok) {
      const text = await response.text().catch(() => undefined);
      throw new AuthError(`Twitch token endpoint returned status ${response.status}.`, {
        platform: 'twitch',
        details: { status: response.status, body: text },
      });
    }
    const json = (await response.json()) as OAuthTokenResponse;
    return this.toTokenSet(json);
  }

  /**
   * `GET /helix/users` with no `login`/`id` query param resolves to the token
   * owner, so this needs only the app's Client-Id (Contract v1.1:
   * `request.app.clientId`, passed in by the caller) — no extra
   * `/oauth2/validate` round trip.
   */
  private async fetchOwnProfile(token: TokenSet, clientId: string): Promise<AuthResult['profile']> {
    const users = await helixRequest<{ data: Array<{ id: string; login: string; display_name: string; profile_image_url: string }> }>(
      {
        path: 'users',
        clientId,
        accessToken: token.accessToken,
        logger: this.logger,
        operation: 'authenticate.users',
      },
    );
    const user = users?.data?.[0];
    if (!user) return undefined;
    return {
      remoteId: user.id,
      handle: user.login,
      displayName: user.display_name,
      avatarUrl: user.profile_image_url,
      profileUrl: `https://twitch.tv/${user.login}`,
      raw: user,
    };
  }

  private toTokenSet(json: OAuthTokenResponse): TokenSet {
    const obtainedAt = this.now();
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      tokenType: json.token_type ?? 'bearer',
      scopes: json.scope ?? [],
      expiresAt: json.expires_in ? new Date(obtainedAt.getTime() + json.expires_in * 1000).toISOString() : undefined,
      obtainedAt: obtainedAt.toISOString(),
    };
  }
}
