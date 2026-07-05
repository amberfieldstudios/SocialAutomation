/**
 * Mastodon connector.
 *
 * Auth model: standard OAuth2 Authorization Code grant, per-instance. Unlike
 * single-host platforms, Mastodon has no shared API host — every account
 * lives on its own instance, and a developer "app" must be registered
 * separately on EACH instance (`POST /api/v1/apps`, done once out-of-band by
 * the auth layer / account-connection flow, not by this connector). The
 * resulting `client_id`/`client_secret` travel as `AppCredentials.clientId`/
 * `clientSecret`; the instance's base URL travels as
 * `AppCredentials.extra.instanceUrl` (e.g. `https://mastodon.social`) since
 * `AppCredentials` has no first-class per-platform host field — this mirrors
 * how `plugins/bluesky` carries its PDS `serviceUrl` in `app.extra`.
 *
 * `authenticate` supports the `authorize_url` / `exchange_code` /
 * `client_credentials` kinds (all genuine, documented Mastodon OAuth2
 * grants — see docs.joinmastodon.org/methods/oauth/). Mastodon has no
 * password/direct-credential grant for third-party apps, so `kind:
 * 'password'` is rejected with `AuthError` (mirrors how plugins/bluesky
 * rejects the kinds it doesn't implement).
 *
 * Every network call targets `${instanceUrl}/api/v1/*` or `/api/v2/*` /
 * `/oauth/*` — official, documented REST endpoints only. No scraping, no
 * undocumented endpoints, no browser automation.
 */

import {
  AuthError,
  ValidationFailedError,
  type AnalyticsQuery,
  type AnalyticsSnapshot,
  type AppCredentials,
  type AuthRequest,
  type AuthResult,
  type ConnectInput,
  type ConnectResult,
  type ConnectorRuntime,
  type DeleteRequest,
  type DeleteResult,
  type DisconnectResult,
  type EditRequest,
  type EditResult,
  type MediaSource,
  type OperationContext,
  type PlatformConnector,
  type PostPayload,
  type PublishResult,
  type RefreshInput,
  type StructuredLogger,
  type TokenSet,
  type UploadedMedia,
  type ValidationResult,
} from '@social/core';

import { capabilities } from './capabilities';
import { MastodonClient } from './http-client';
import { readMediaBytes } from './media-io';
import { validateMastodonPost } from './validate';

interface TokenResponse {
  access_token: string;
  token_type?: string;
  scope?: string;
  created_at?: number; // epoch seconds
  expires_in?: number; // seconds; Mastodon 4.3+ expiring tokens
  refresh_token?: string;
}

interface CredentialsAccount {
  id: string;
  username: string;
  url?: string;
  avatar?: string;
  display_name?: string;
  followers_count?: number;
}

interface MediaAttachmentResponse {
  id: string;
  url?: string | null;
  preview_url?: string | null;
}

interface StatusResponse {
  id: string;
  uri: string;
  url?: string;
  created_at: string;
  edited_at?: string | null;
  favourites_count?: number;
  reblogs_count?: number;
  replies_count?: number;
}

const DEFAULT_INSTANCE_URL = 'https://mastodon.social';

function instanceUrlFrom(app: AppCredentials, fallback: string): string {
  return (app.extra?.instanceUrl ?? fallback).replace(/\/+$/, '');
}

export class MastodonConnector implements PlatformConnector {
  readonly capabilities = capabilities;

  private readonly logger: StructuredLogger;
  private readonly now: () => Date;
  private instanceUrl: string = DEFAULT_INSTANCE_URL;

  constructor(runtime: ConnectorRuntime) {
    this.logger = runtime.logger.child({ platform: 'mastodon' });
    this.now = runtime.now ?? (() => new Date());
  }

  private client(): MastodonClient {
    return new MastodonClient({ instanceUrl: this.instanceUrl, logger: this.logger });
  }

  // ---------------------------------------------------------------------
  // connect
  // ---------------------------------------------------------------------

  async connect(input: ConnectInput): Promise<ConnectResult> {
    const op = 'connect' as const;
    this.instanceUrl = instanceUrlFrom(input.app, this.instanceUrl);
    const log = this.logger.child({ operation: op, accountId: input.accountId });
    log.info('mastodon.connect.start', { instanceUrl: this.instanceUrl });

    try {
      const { body } = await this.client().call<{ version?: string }>({ method: 'GET', path: '/api/v2/instance' });
      log.info('mastodon.connect.ok', { version: body?.version });
      return { ready: true, platform: 'mastodon', apiVersion: body?.version };
    } catch (cause) {
      log.error('mastodon.connect.failed', { error: (cause as Error).message });
      throw cause;
    }
  }

  // ---------------------------------------------------------------------
  // authenticate / refreshToken
  // ---------------------------------------------------------------------

  async authenticate(request: AuthRequest): Promise<AuthResult> {
    const log = this.logger.child({ operation: 'authenticate' as const });
    this.instanceUrl = instanceUrlFrom(request.app, this.instanceUrl);

    if (request.kind === 'authorize_url') {
      const url = new URL(`${this.instanceUrl}/oauth/authorize`);
      url.searchParams.set('client_id', request.app.clientId);
      url.searchParams.set('response_type', 'code');
      if (request.app.redirectUri) url.searchParams.set('redirect_uri', request.app.redirectUri);
      url.searchParams.set('scope', request.scopes.join(' '));
      url.searchParams.set('state', request.state);
      if (request.codeChallenge) {
        url.searchParams.set('code_challenge', request.codeChallenge);
        url.searchParams.set('code_challenge_method', 'S256');
      }
      log.info('mastodon.authenticate.authorize_url', { instanceUrl: this.instanceUrl });
      return { authorizeUrl: url.toString() };
    }

    if (request.kind === 'exchange_code') {
      log.info('mastodon.authenticate.exchange_code.start', {});
      const { body } = await this.client().call<TokenResponse>({
        method: 'POST',
        path: '/oauth/token',
        jsonBody: {
          grant_type: 'authorization_code',
          client_id: request.app.clientId,
          client_secret: request.app.clientSecret,
          redirect_uri: request.app.redirectUri,
          code: request.code,
          code_verifier: request.codeVerifier,
        },
      });
      const token = this.toTokenSet(body);
      const profile = await this.fetchProfile(token.accessToken);
      log.info('mastodon.authenticate.exchange_code.ok', { remoteId: profile?.remoteId });
      return { token, profile };
    }

    if (request.kind === 'client_credentials') {
      log.info('mastodon.authenticate.client_credentials.start', {});
      const { body } = await this.client().call<TokenResponse>({
        method: 'POST',
        path: '/oauth/token',
        jsonBody: {
          grant_type: 'client_credentials',
          client_id: request.app.clientId,
          client_secret: request.app.clientSecret,
          scope: request.scopes.join(' '),
        },
      });
      log.info('mastodon.authenticate.client_credentials.ok', {});
      return { token: this.toTokenSet(body) };
    }

    throw new AuthError(
      `Mastodon has no password/direct-credential grant for third-party apps; AuthRequest.kind "${request.kind}" is not supported ` +
        `(use "authorize_url" then "exchange_code").`,
      { platform: 'mastodon', operation: 'authenticate' },
    );
  }

  private toTokenSet(body: TokenResponse): TokenSet {
    const obtainedAt = this.now();
    const expiresAt = body.expires_in !== undefined ? new Date(obtainedAt.getTime() + body.expires_in * 1000).toISOString() : undefined;
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      tokenType: body.token_type ?? 'Bearer',
      scopes: body.scope ? body.scope.split(' ') : [],
      expiresAt,
      obtainedAt: obtainedAt.toISOString(),
    };
  }

  private async fetchProfile(accessToken: string): Promise<AuthResult['profile']> {
    try {
      const { body } = await this.client().call<CredentialsAccount>({
        method: 'GET',
        path: '/api/v1/accounts/verify_credentials',
        token: accessToken,
      });
      return {
        remoteId: body.id,
        handle: body.username,
        displayName: body.display_name,
        avatarUrl: body.avatar,
        profileUrl: body.url,
        raw: body,
      };
    } catch {
      return undefined;
    }
  }

  async refreshToken(input: RefreshInput): Promise<TokenSet> {
    const log = this.logger.child({ operation: 'refreshToken' as const });
    this.instanceUrl = instanceUrlFrom(input.app, this.instanceUrl);
    if (!input.token.refreshToken) {
      throw new AuthError(
        'No refresh token available for this Mastodon session (older non-expiring tokens have none; re-authenticate instead).',
        { platform: 'mastodon' },
      );
    }

    log.info('mastodon.refreshToken.start', {});
    const { body } = await this.client().call<TokenResponse>({
      method: 'POST',
      path: '/oauth/token',
      jsonBody: {
        grant_type: 'refresh_token',
        client_id: input.app.clientId,
        client_secret: input.app.clientSecret,
        refresh_token: input.token.refreshToken,
      },
    });

    log.info('mastodon.refreshToken.ok', {});
    const refreshed = this.toTokenSet(body);
    // Mastodon may omit refresh_token on renewal (rotation not always applied); keep the prior one.
    return { ...refreshed, refreshToken: refreshed.refreshToken ?? input.token.refreshToken };
  }

  // ---------------------------------------------------------------------
  // validatePost
  // ---------------------------------------------------------------------

  async validatePost(payload: PostPayload): Promise<ValidationResult> {
    return validateMastodonPost(payload, this.capabilities, this.now);
  }

  // ---------------------------------------------------------------------
  // uploadMedia
  // ---------------------------------------------------------------------

  async uploadMedia(media: MediaSource, ctx: OperationContext): Promise<UploadedMedia> {
    const log = ctx.logger.child({ operation: 'uploadMedia' as const, platform: 'mastodon', accountId: ctx.accountId });
    this.instanceUrl = instanceUrlFrom(ctx.app, this.instanceUrl);
    log.info('mastodon.uploadMedia.start', { mimeType: media.mimeType, assetId: media.assetId });

    const bytes = await readMediaBytes(media.uri);
    const form = new FormData();
    form.set('file', new Blob([bytes], { type: media.mimeType }), media.assetId);
    if (media.altText) form.set('description', media.altText);

    const { status, body } = await this.client().call<MediaAttachmentResponse>({
      method: 'POST',
      path: '/api/v2/media',
      token: ctx.token.accessToken,
      formBody: form,
    });

    log.info('mastodon.uploadMedia.ok', { id: body.id, processing: status === 202 });
    return {
      source: media,
      remoteMediaId: body.id,
      remoteUrl: body.url ?? undefined,
      raw: body,
    };
  }

  // ---------------------------------------------------------------------
  // publish
  // ---------------------------------------------------------------------

  async publish(payload: PostPayload, ctx: OperationContext): Promise<PublishResult> {
    const log = ctx.logger.child({ operation: 'publish' as const, platform: 'mastodon', accountId: ctx.accountId });
    this.instanceUrl = instanceUrlFrom(ctx.app, this.instanceUrl);

    const validation = await this.validatePost(payload);
    if (!validation.ok) {
      log.warn('mastodon.publish.validation_failed', { errorCount: validation.errors.length });
      throw new ValidationFailedError(validation, { platform: 'mastodon', operation: 'publish' });
    }

    log.info('mastodon.publish.start', { hasMedia: (payload.media?.length ?? 0) > 0, hasThread: (payload.thread?.length ?? 0) > 0 });

    const chain: PostPayload[] = [payload, ...(payload.thread ?? [])];
    const threadRemoteIds: string[] = [];
    let inReplyToId: string | undefined = payload.replyToRemoteId;
    let first: PublishResult | undefined;

    for (const [index, post] of chain.entries()) {
      const created = await this.createOneStatus(post, ctx, inReplyToId, index === 0 ? payload.scheduledAt : undefined, log);
      threadRemoteIds.push(created.id);
      inReplyToId = created.id;
      if (!first) {
        first = {
          remoteId: created.id,
          remoteUrl: created.url,
          publishedAt: created.created_at ?? this.now().toISOString(),
          raw: created,
        };
      }
    }

    log.info('mastodon.publish.ok', { remoteId: first!.remoteId, threadLength: threadRemoteIds.length });
    return { ...first!, threadRemoteIds: threadRemoteIds.length > 1 ? threadRemoteIds : undefined };
  }

  private async createOneStatus(
    post: PostPayload,
    ctx: OperationContext,
    inReplyToId: string | undefined,
    scheduledAt: string | undefined,
    log: StructuredLogger,
  ): Promise<StatusResponse> {
    const mediaIds: string[] = [];
    for (const media of post.media ?? []) {
      const uploaded = await this.uploadMedia(media, ctx);
      mediaIds.push(uploaded.remoteMediaId);
    }

    const text = assembleText(post.text, post.tags, post.mentions);
    const spoilerText = post.platformOptions?.spoilerText as string | undefined;
    const visibility = (post.platformOptions?.visibility as string | undefined) ?? 'public';

    const jsonBody: Record<string, unknown> = { status: text, visibility };
    if (mediaIds.length > 0) jsonBody.media_ids = mediaIds;
    if (spoilerText) jsonBody.spoiler_text = spoilerText;
    if (post.sensitive !== undefined) jsonBody.sensitive = post.sensitive;
    else if (spoilerText) jsonBody.sensitive = true;
    if (post.language) jsonBody.language = post.language;
    if (inReplyToId) jsonBody.in_reply_to_id = inReplyToId;
    if (scheduledAt) jsonBody.scheduled_at = scheduledAt;

    log.debug('mastodon.publish.createStatus', { textLength: text.length, mediaCount: mediaIds.length, isReply: Boolean(inReplyToId) });

    const { body } = await this.client().call<StatusResponse>({
      method: 'POST',
      path: '/api/v1/statuses',
      token: ctx.token.accessToken,
      jsonBody,
    });
    return body;
  }

  // ---------------------------------------------------------------------
  // delete
  // ---------------------------------------------------------------------

  async delete(request: DeleteRequest, ctx: OperationContext): Promise<DeleteResult> {
    const log = ctx.logger.child({ operation: 'delete' as const, platform: 'mastodon', accountId: ctx.accountId });
    this.instanceUrl = instanceUrlFrom(ctx.app, this.instanceUrl);

    log.info('mastodon.delete.start', { remoteId: request.remoteId });
    const { body } = await this.client().call<StatusResponse>({
      method: 'DELETE',
      path: `/api/v1/statuses/${encodeURIComponent(request.remoteId)}`,
      token: ctx.token.accessToken,
    });

    log.info('mastodon.delete.ok', { remoteId: request.remoteId });
    return { removed: true, raw: body };
  }

  // ---------------------------------------------------------------------
  // edit
  // ---------------------------------------------------------------------

  async edit(request: EditRequest, ctx: OperationContext): Promise<EditResult> {
    const log = ctx.logger.child({ operation: 'edit' as const, platform: 'mastodon', accountId: ctx.accountId });
    this.instanceUrl = instanceUrlFrom(ctx.app, this.instanceUrl);

    const validation = await this.validatePost(request.payload);
    if (!validation.ok) {
      log.warn('mastodon.edit.validation_failed', { errorCount: validation.errors.length });
      throw new ValidationFailedError(validation, { platform: 'mastodon', operation: 'edit' });
    }

    const mediaIds: string[] = [];
    for (const media of request.payload.media ?? []) {
      const uploaded = await this.uploadMedia(media, ctx);
      mediaIds.push(uploaded.remoteMediaId);
    }

    const text = assembleText(request.payload.text, request.payload.tags, request.payload.mentions);
    const spoilerText = request.payload.platformOptions?.spoilerText as string | undefined;

    const jsonBody: Record<string, unknown> = {
      status: text,
      media_ids: mediaIds, // always sent explicitly: Mastodon's edit endpoint requires it, even as [], to state intent
    };
    if (spoilerText) jsonBody.spoiler_text = spoilerText;
    if (request.payload.sensitive !== undefined) jsonBody.sensitive = request.payload.sensitive;
    if (request.payload.language) jsonBody.language = request.payload.language;

    log.info('mastodon.edit.start', { remoteId: request.remoteId });
    const { body } = await this.client().call<StatusResponse>({
      method: 'PUT',
      path: `/api/v1/statuses/${encodeURIComponent(request.remoteId)}`,
      token: ctx.token.accessToken,
      jsonBody,
    });

    log.info('mastodon.edit.ok', { remoteId: request.remoteId });
    return { remoteId: body.id, editedAt: body.edited_at ?? this.now().toISOString(), remoteUrl: body.url, raw: body };
  }

  // ---------------------------------------------------------------------
  // getAnalytics
  // ---------------------------------------------------------------------

  async getAnalytics(query: AnalyticsQuery, ctx: OperationContext): Promise<AnalyticsSnapshot> {
    const log = ctx.logger.child({ operation: 'getAnalytics' as const, platform: 'mastodon', accountId: ctx.accountId });
    this.instanceUrl = instanceUrlFrom(ctx.app, this.instanceUrl);

    log.info('mastodon.getAnalytics.start', { remoteId: query.remoteId });
    const { body: status } = await this.client().call<StatusResponse>({
      method: 'GET',
      path: `/api/v1/statuses/${encodeURIComponent(query.remoteId)}`,
      token: ctx.token.accessToken,
    });

    const metrics: Record<string, number> = {
      likes: status.favourites_count ?? 0,
      shares: status.reblogs_count ?? 0,
      comments: status.replies_count ?? 0,
    };

    // Best-effort: absolute follower count (not a delta, so kept as a
    // platform-only extra key rather than the canonical `followersDelta`).
    // No documented public API exposes impressions/reach/views/clicks/saves
    // for a status, so those canonical metrics are never populated.
    try {
      const { body: account } = await this.client().call<CredentialsAccount>({
        method: 'GET',
        path: '/api/v1/accounts/verify_credentials',
        token: ctx.token.accessToken,
      });
      if (account.followers_count !== undefined) metrics.followersCount = account.followers_count;
    } catch (cause) {
      log.warn('mastodon.getAnalytics.followers_unavailable', { error: (cause as Error).message });
    }

    log.info('mastodon.getAnalytics.ok', { remoteId: query.remoteId });
    return { remoteId: query.remoteId, collectedAt: this.now().toISOString(), metrics, raw: status };
  }

  // ---------------------------------------------------------------------
  // disconnect
  // ---------------------------------------------------------------------

  async disconnect(ctx: OperationContext): Promise<DisconnectResult> {
    const log = ctx.logger.child({ operation: 'disconnect' as const, platform: 'mastodon', accountId: ctx.accountId });
    this.instanceUrl = instanceUrlFrom(ctx.app, this.instanceUrl);

    log.info('mastodon.disconnect.start', {});
    try {
      await this.client().call({
        method: 'POST',
        path: '/oauth/revoke',
        jsonBody: {
          client_id: ctx.app.clientId,
          client_secret: ctx.app.clientSecret,
          token: ctx.token.accessToken,
        },
      });
      log.info('mastodon.disconnect.ok', {});
      return { revoked: true };
    } catch (cause) {
      // Best-effort: local account cleanup proceeds either way, so this never throws.
      log.warn('mastodon.disconnect.revoke_failed', { error: (cause as Error).message });
      return { revoked: false };
    }
  }
}

/**
 * Assembles the final status text from a `PostPayload`-shaped input: base
 * text, plus any structured hashtags/mentions not already present inline.
 * Mastodon auto-linkifies plain `#tag`/`@user@instance` substrings server-side
 * — unlike Bluesky, there is no separate structured facet mechanism to build.
 */
export function assembleText(text: string | undefined, tags: string[] | undefined, mentions: string[] | undefined): string {
  const base = text ?? '';
  const extras: string[] = [];

  for (const tag of tags ?? []) {
    const token = `#${tag}`;
    if (!base.includes(token)) extras.push(token);
  }
  for (const mention of mentions ?? []) {
    const token = `@${mention}`;
    if (!base.includes(token)) extras.push(token);
  }

  if (extras.length === 0) return base;
  return base.length > 0 ? `${base}\n\n${extras.join(' ')}` : extras.join(' ');
}
