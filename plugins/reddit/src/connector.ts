/**
 * Reddit PlatformConnector.
 *
 * Reddit's official REST API (`oauth.reddit.com`) IS a "post" network, unlike
 * Twitch, so the ten-method contract maps closely onto Reddit's submission
 * primitives (full rationale in README.md):
 *
 *  - publish        -> `POST /api/submit` (self-text or link post to one
 *                       subreddit). `remoteId` is the returned "fullname"
 *                       (`t3_<id36>`).
 *  - edit            -> `POST /api/editusertext` — Reddit can only rewrite a
 *                       SELF post's body; there is no endpoint to change a
 *                       post's title or a link post's target URL after
 *                       creation. `edit` here always sends `payload.text`.
 *  - delete          -> `POST /api/del`.
 *  - uploadMedia     -> NOT SUPPORTED. Reddit's image/video/gallery upload
 *                       flow (`/api/media/asset.json` + direct-to-S3 lease) is
 *                       an internal flow used by Reddit's own apps, not part
 *                       of the stable public `/dev/api` reference — so per the
 *                       official-API-only rule this connector does not
 *                       implement it. A link post pointing at already-hosted
 *                       media is the supported path for attaching media.
 *  - getAnalytics    -> `GET /api/info` (score / upvote_ratio / num_comments).
 *  - authenticate /
 *    refreshToken    -> OAuth2 against `www.reddit.com/api/v1/access_token`:
 *                       authorization_code (web apps), password grant
 *                       (script apps — Contract v1.1's `AuthRequest.kind ===
 *                       'password'`), client_credentials (app-only, read-only
 *                       token; cannot `publish`/`edit`/`delete`).
 *  - disconnect      -> `POST /api/v1/revoke_token`.
 *
 * Official Reddit endpoints only (`oauth.reddit.com`, `www.reddit.com`). No
 * scraping, no undocumented endpoints, no browser automation. Every request
 * carries the required descriptive `User-Agent` header
 * (https://github.com/reddit-archive/reddit/wiki/API) sourced from
 * `AppCredentials.extra.userAgent`.
 */

import {
  AuthError,
  NotSupportedError,
  TokenRevokedError,
  TransientError,
  ValidationFailedError,
  assertSupported,
  type AnalyticsQuery,
  type AnalyticsSnapshot,
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
  type TargetContext,
  type TokenSet,
  type UploadedMedia,
  type ValidationIssue,
  type ValidationResult,
} from '@social/core';

import { capabilities, REDDIT_BODY_CHARACTER_LIMIT, REDDIT_TITLE_CHARACTER_LIMIT } from './capabilities';
import { OAUTH_API_BASE_URL, TOKEN_BASE_URL, WWW_BASE_URL, redditRequest, requireUserAgent, type OAuthTokenResponse } from './http';

const SUBREDDIT_PATTERN = /^[A-Za-z0-9_]{3,21}$/;

/**
 * Reddit-specific fields read from `PostPayload.platformOptions`:
 *  - `subreddit` (required): the target subreddit, WITHOUT the leading `r/`.
 *  - `flairId` / `flairText` (optional): applied via `/api/submit`'s
 *    `flair_id`/`flair_text` params.
 *  - `nsfw` / `spoiler` (optional booleans).
 */
interface RedditPlatformOptions {
  subreddit?: string;
  flairId?: string;
  flairText?: string;
  nsfw?: boolean;
  spoiler?: boolean;
}

function platformOptionsOf(payload: PostPayload): RedditPlatformOptions {
  return (payload.platformOptions ?? {}) as RedditPlatformOptions;
}

interface SubmitResponse {
  json: {
    errors: [string, string, string][];
    data?: { id: string; name: string; url: string };
  };
}

interface InfoListing {
  data: {
    children: Array<{
      data: {
        id: string;
        name: string;
        score: number;
        upvote_ratio?: number;
        num_comments: number;
        permalink: string;
        title?: string;
      };
    }>;
  };
}

/** Pure rule check — no network calls, matches `capabilities` exactly. */
function validate(payload: PostPayload): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const options = platformOptionsOf(payload);

  const title = payload.title;
  if (!title || title.trim().length === 0) {
    errors.push({
      code: 'title_required',
      message: 'Reddit publish requires a non-empty post title (payload.title).',
      severity: 'error',
      field: 'title',
    });
  } else if (title.length > REDDIT_TITLE_CHARACTER_LIMIT) {
    errors.push({
      code: 'text_too_long',
      message: `Post title exceeds Reddit's ${REDDIT_TITLE_CHARACTER_LIMIT}-character limit.`,
      severity: 'error',
      field: 'title',
      limit: REDDIT_TITLE_CHARACTER_LIMIT,
      actual: title.length,
    });
  }

  if (!options.subreddit || options.subreddit.trim().length === 0) {
    errors.push({
      code: 'subreddit_required',
      message: 'Reddit publish requires platformOptions.subreddit (without the leading "r/").',
      severity: 'error',
      field: 'platformOptions.subreddit',
    });
  } else if (!SUBREDDIT_PATTERN.test(options.subreddit)) {
    errors.push({
      code: 'invalid_subreddit',
      message: `Subreddit "${options.subreddit}" must be 3-21 characters, letters/digits/underscores only.`,
      severity: 'error',
      field: 'platformOptions.subreddit',
    });
  }

  const hasLink = Boolean(payload.link && payload.link.trim().length > 0);
  const hasText = Boolean(payload.text && payload.text.trim().length > 0);

  if (hasLink && hasText) {
    errors.push({
      code: 'self_and_link_mutually_exclusive',
      message: 'A Reddit post is either a self (text) post or a link post, never both. Set either payload.text or payload.link, not both.',
      severity: 'error',
      field: 'link',
    });
  }

  if (hasLink) {
    try {
      const url = new URL(payload.link!);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('non-http(s) scheme');
    } catch {
      errors.push({
        code: 'invalid_link',
        message: `payload.link "${payload.link}" is not a valid absolute http(s) URL.`,
        severity: 'error',
        field: 'link',
      });
    }
  }

  if (hasText && payload.text!.length > REDDIT_BODY_CHARACTER_LIMIT) {
    errors.push({
      code: 'text_too_long',
      message: `Self-post body exceeds Reddit's ${REDDIT_BODY_CHARACTER_LIMIT}-character limit.`,
      severity: 'error',
      field: 'text',
      limit: REDDIT_BODY_CHARACTER_LIMIT,
      actual: payload.text!.length,
    });
  }

  if (payload.media && payload.media.length > 0) {
    errors.push({
      code: 'media_not_supported',
      message:
        'Reddit media/gallery upload is not part of the stable public API and is not implemented; ' +
        'attach media by publishing a link post (payload.link) pointing at already-hosted media instead.',
      severity: 'error',
      field: 'media',
      limit: 0,
      actual: payload.media.length,
    });
  }

  if (payload.thread && payload.thread.length > 0) {
    errors.push({
      code: 'threads_not_supported',
      message: 'Reddit has no sequential post-thread concept; each submission is independent.',
      severity: 'error',
      field: 'thread',
    });
  }

  if (payload.tags && payload.tags.length > 0) {
    warnings.push({
      code: 'hashtags_cosmetic_only',
      message: 'Reddit has no hashtag feature; tags[] would render as literal "#text" in the body, not a platform tag.',
      severity: 'warning',
      field: 'tags',
    });
  }

  if (payload.scheduledAt) {
    warnings.push({
      code: 'native_scheduling_not_supported',
      message: 'Reddit has no native post-scheduling API; scheduledAt will be ignored by this connector.',
      severity: 'warning',
      field: 'scheduledAt',
    });
  }

  return { ok: errors.length === 0, errors, warnings };
}

export class RedditConnector implements PlatformConnector {
  readonly capabilities = capabilities;

  private readonly logger: StructuredLogger;
  private readonly now: () => Date;

  constructor(runtime: ConnectorRuntime) {
    this.logger = runtime.logger.child({ platform: 'reddit' });
    this.now = runtime.now ?? (() => new Date());
  }

  // ---------------------------------------------------------------------
  // connect
  // ---------------------------------------------------------------------

  async connect(input: ConnectInput): Promise<ConnectResult> {
    if (!input.app.clientId) {
      throw new AuthError('Reddit connect requires app.clientId.', { platform: 'reddit', operation: 'connect' });
    }
    requireUserAgent(input.app.extra?.userAgent);

    if (input.token) {
      // GET /api/v1/me is the documented, cheap way to confirm the token is
      // live and reaches an authenticated identity — no scrape, no Helix-style
      // validate workaround needed.
      await redditRequest({
        path: 'api/v1/me',
        accessToken: input.token.accessToken,
        userAgent: requireUserAgent(input.app.extra?.userAgent),
        logger: this.logger,
        operation: 'connect.me',
      });
    }

    this.logger.info('reddit.connect', { accountId: input.accountId, hasToken: Boolean(input.token) });
    return { ready: true, platform: 'reddit', apiVersion: 'oauth-v1' };
  }

  // ---------------------------------------------------------------------
  // authenticate / refreshToken
  // ---------------------------------------------------------------------

  async authenticate(request: AuthRequest): Promise<AuthResult> {
    if (request.kind === 'authorize_url') {
      const url = new URL('/api/v1/authorize', WWW_BASE_URL);
      url.searchParams.set('client_id', request.app.clientId);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('state', request.state);
      url.searchParams.set('redirect_uri', request.app.redirectUri ?? '');
      url.searchParams.set('duration', 'permanent');
      url.searchParams.set('scope', request.scopes.join(' '));
      this.logger.info('reddit.authenticate.authorize_url', { scopes: request.scopes.length });
      return { authorizeUrl: url.toString() };
    }

    if (request.kind === 'exchange_code') {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: request.code,
        redirect_uri: request.app.redirectUri ?? '',
      });
      const token = await this.tokenRequest(body, request.app.clientId, request.app.clientSecret);
      const profile = await this.fetchOwnProfile(token, request.app);
      this.logger.info('reddit.authenticate.exchange_code', { hasRefreshToken: Boolean(token.refreshToken) });
      return { token, profile };
    }

    if (request.kind === 'password') {
      // "script" app type: username/password grant per
      // https://github.com/reddit-archive/reddit/wiki/OAuth2#password-flow.
      // `identifier`/`password` are the end-user's Reddit username/password,
      // NEVER the app's own clientSecret.
      const body = new URLSearchParams({
        grant_type: 'password',
        username: request.identifier,
        password: request.password,
      });
      if (request.scopes) body.set('scope', request.scopes.join(' '));
      const token = await this.tokenRequest(body, request.app.clientId, request.app.clientSecret);
      const profile = await this.fetchOwnProfile(token, request.app);
      this.logger.info('reddit.authenticate.password', { hasRefreshToken: Boolean(token.refreshToken) });
      return { token, profile };
    }

    // client_credentials — app-only token; read-only, cannot publish/edit/delete.
    const body = new URLSearchParams({ grant_type: 'client_credentials' });
    if (request.scopes) body.set('scope', request.scopes.join(' '));
    const token = await this.tokenRequest(body, request.app.clientId, request.app.clientSecret);
    this.logger.info('reddit.authenticate.client_credentials', { scopes: request.scopes.length });
    return { token };
  }

  async refreshToken(input: RefreshInput): Promise<TokenSet> {
    if (!input.token.refreshToken) {
      throw new TokenRevokedError('No refresh token available for this Reddit account; re-authentication required.', {
        platform: 'reddit',
        operation: 'refreshToken',
      });
    }
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: input.token.refreshToken });
    const token = await this.tokenRequest(body, input.app.clientId, input.app.clientSecret);
    this.logger.info('reddit.refreshToken.ok', { hasRefreshToken: Boolean(token.refreshToken) });
    return token;
  }

  // ---------------------------------------------------------------------
  // validatePost
  // ---------------------------------------------------------------------

  async validatePost(payload: PostPayload): Promise<ValidationResult> {
    return validate(payload);
  }

  // ---------------------------------------------------------------------
  // uploadMedia — unsupported (see file header)
  // ---------------------------------------------------------------------

  async uploadMedia(_media: MediaSource, _ctx: OperationContext): Promise<UploadedMedia> {
    assertSupported(this.capabilities, 'uploadMedia');
    throw new NotSupportedError('uploadMedia', 'reddit');
  }

  // ---------------------------------------------------------------------
  // publish
  // ---------------------------------------------------------------------

  async publish(payload: PostPayload, ctx: OperationContext): Promise<PublishResult> {
    assertSupported(this.capabilities, 'publish');
    const result = validate(payload);
    if (!result.ok) {
      throw new ValidationFailedError(result, { platform: 'reddit', operation: 'publish' });
    }

    const options = platformOptionsOf(payload);
    const subreddit = options.subreddit!;
    const userAgent = requireUserAgent(ctx.app.extra?.userAgent);
    const kind = payload.link ? 'link' : 'self';

    const form: Record<string, string | number | boolean | undefined> = {
      api_type: 'json',
      sr: subreddit,
      kind,
      title: payload.title,
      text: kind === 'self' ? payload.text ?? '' : undefined,
      url: kind === 'link' ? payload.link : undefined,
      nsfw: options.nsfw,
      spoiler: options.spoiler,
      flair_id: options.flairId,
      flair_text: options.flairText,
      sendreplies: true,
    };

    const response = await redditRequest<SubmitResponse>({
      method: 'POST',
      path: 'api/submit',
      accessToken: ctx.token.accessToken,
      userAgent,
      form,
      logger: ctx.logger,
      operation: 'publish.submit',
    });

    const apiErrors = response?.json?.errors ?? [];
    if (apiErrors.length > 0 || !response?.json?.data) {
      const message = apiErrors.map((e) => e.join(': ')).join('; ') || 'Reddit rejected the submission.';
      ctx.logger.warn('reddit.publish.rejected', { subreddit, errors: apiErrors });
      throw new ValidationFailedError(
        { ok: false, errors: [{ code: 'reddit_api_rejected', message, severity: 'error' }], warnings: [] },
        { platform: 'reddit', operation: 'publish', details: { apiErrors } },
      );
    }

    const data = response.json.data;
    const target: TargetContext = { extra: { subreddit } };
    ctx.logger.info('reddit.publish', { accountId: ctx.accountId, subreddit, kind, remoteId: data.name });

    return {
      remoteId: data.name,
      target,
      remoteUrl: data.url,
      publishedAt: this.now().toISOString(),
      raw: data,
    };
  }

  // ---------------------------------------------------------------------
  // delete
  // ---------------------------------------------------------------------

  async delete(request: DeleteRequest, ctx: OperationContext): Promise<DeleteResult> {
    assertSupported(this.capabilities, 'delete');
    const userAgent = requireUserAgent(ctx.app.extra?.userAgent);

    await redditRequest({
      method: 'POST',
      path: 'api/del',
      accessToken: ctx.token.accessToken,
      userAgent,
      form: { id: request.remoteId },
      logger: ctx.logger,
      operation: 'delete',
    });

    ctx.logger.info('reddit.delete', { accountId: ctx.accountId, remoteId: request.remoteId });
    return { removed: true };
  }

  // ---------------------------------------------------------------------
  // edit — self-post BODY only (see file header)
  // ---------------------------------------------------------------------

  async edit(request: EditRequest, ctx: OperationContext): Promise<EditResult> {
    assertSupported(this.capabilities, 'edit');

    const text = request.payload.text;
    if (!text || text.trim().length === 0) {
      throw new ValidationFailedError(
        {
          ok: false,
          errors: [
            {
              code: 'edit_requires_text',
              message:
                'Reddit can only edit a self post\'s BODY (POST /api/editusertext); ' +
                'request.payload.text is required. Title changes and link-post URL changes are not possible via the API.',
              severity: 'error',
              field: 'text',
            },
          ],
          warnings: [],
        },
        { platform: 'reddit', operation: 'edit' },
      );
    }

    if (request.payload.title) {
      ctx.logger.warn('reddit.edit.title_ignored', {
        reason: 'Reddit has no API to change a post title after creation; only the body text was updated.',
      });
    }

    const userAgent = requireUserAgent(ctx.app.extra?.userAgent);
    await redditRequest({
      method: 'POST',
      path: 'api/editusertext',
      accessToken: ctx.token.accessToken,
      userAgent,
      form: { api_type: 'json', thing_id: request.remoteId, text },
      logger: ctx.logger,
      operation: 'edit.editusertext',
    });

    ctx.logger.info('reddit.edit', { accountId: ctx.accountId, remoteId: request.remoteId });
    return { remoteId: request.remoteId, editedAt: this.now().toISOString() };
  }

  // ---------------------------------------------------------------------
  // getAnalytics
  // ---------------------------------------------------------------------

  async getAnalytics(query: AnalyticsQuery, ctx: OperationContext): Promise<AnalyticsSnapshot> {
    assertSupported(this.capabilities, 'getAnalytics');

    if (query.since || query.until) {
      ctx.logger.warn('reddit.getAnalytics.range_ignored', {
        reason: 'Reddit /api/info has no historical/windowed metrics; returning the current snapshot only.',
      });
    }

    const userAgent = requireUserAgent(ctx.app.extra?.userAgent);
    const response = await redditRequest<InfoListing>({
      path: 'api/info',
      accessToken: ctx.token.accessToken,
      userAgent,
      query: { id: query.remoteId },
      logger: ctx.logger,
      operation: 'getAnalytics.info',
    });

    const thing = response?.data?.children?.[0]?.data;
    if (!thing) {
      throw new AuthError(`Reddit post not found or not visible to this account: ${query.remoteId}`, {
        platform: 'reddit',
        operation: 'getAnalytics',
      });
    }

    const metrics: Record<string, number> = {
      // `score` is net upvotes (upvotes - downvotes), not a raw "likes" count —
      // it is the closest canonical-metric proxy Reddit's public API exposes.
      // No impressions/reach/view-count data is exposed by the official API;
      // never fabricate those fields.
      likes: thing.score,
      comments: thing.num_comments,
    };
    const raw: Record<string, unknown> = { permalink: thing.permalink };
    if (thing.upvote_ratio !== undefined) raw.upvoteRatio = thing.upvote_ratio;

    ctx.logger.info('reddit.getAnalytics', { accountId: ctx.accountId, remoteId: query.remoteId });
    return { remoteId: query.remoteId, collectedAt: this.now().toISOString(), metrics, raw };
  }

  // ---------------------------------------------------------------------
  // disconnect
  // ---------------------------------------------------------------------

  async disconnect(ctx: OperationContext): Promise<DisconnectResult> {
    // POST /api/v1/revoke_token — Basic-auth'd with the app's client
    // credentials (documented at
    // https://github.com/reddit-archive/reddit/wiki/OAuth2#revoking-a-token).
    const basic = Buffer.from(`${ctx.app.clientId}:${ctx.app.clientSecret ?? ''}`).toString('base64');
    const body = new URLSearchParams({ token: ctx.token.accessToken, token_type_hint: 'access_token' });
    try {
      const response = await fetch(new URL('/api/v1/revoke_token', TOKEN_BASE_URL), {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'User-Agent': requireUserAgent(ctx.app.extra?.userAgent),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
      ctx.logger.info('reddit.disconnect', { status: response.status });
      return { revoked: response.ok };
    } catch (cause) {
      ctx.logger.error('reddit.disconnect.failed', { error: (cause as Error).message });
      return { revoked: false };
    }
  }

  // ---------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------

  private async tokenRequest(body: URLSearchParams, clientId: string, clientSecret: string | undefined): Promise<TokenSet> {
    const basic = Buffer.from(`${clientId}:${clientSecret ?? ''}`).toString('base64');
    let response: Response;
    try {
      response = await fetch(new URL('/api/v1/access_token', TOKEN_BASE_URL), {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
    } catch (cause) {
      throw new TransientError('Network error obtaining a Reddit token.', { platform: 'reddit', cause });
    }

    if (response.status === 401 || response.status === 400) {
      const text = await response.text().catch(() => undefined);
      throw new AuthError(`Reddit token endpoint returned status ${response.status}.`, {
        platform: 'reddit',
        details: { status: response.status, body: text },
      });
    }
    if (!response.ok) {
      throw new TransientError(`Reddit token endpoint returned status ${response.status}.`, { platform: 'reddit' });
    }

    const json = (await response.json()) as OAuthTokenResponse;
    if (json.error) {
      throw new AuthError(`Reddit token endpoint returned an error: ${json.error}`, { platform: 'reddit' });
    }
    return this.toTokenSet(json);
  }

  private async fetchOwnProfile(token: TokenSet, app: { extra?: Record<string, string> }): Promise<AuthResult['profile']> {
    const me = await redditRequest<{ id: string; name: string; icon_img?: string }>({
      path: 'api/v1/me',
      accessToken: token.accessToken,
      userAgent: requireUserAgent(app.extra?.userAgent),
      logger: this.logger,
      operation: 'authenticate.me',
    });
    if (!me) return undefined;
    return {
      remoteId: me.id,
      handle: me.name,
      displayName: me.name,
      avatarUrl: me.icon_img,
      profileUrl: `https://www.reddit.com/user/${me.name}`,
      raw: me,
    };
  }

  private toTokenSet(json: OAuthTokenResponse): TokenSet {
    const obtainedAt = this.now();
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      tokenType: json.token_type ?? 'bearer',
      scopes: json.scope ? json.scope.split(' ') : [],
      expiresAt: json.expires_in ? new Date(obtainedAt.getTime() + json.expires_in * 1000).toISOString() : undefined,
      obtainedAt: obtainedAt.toISOString(),
    };
  }
}

// Re-exported so tests can reach the pure validator directly if desired.
export { OAUTH_API_BASE_URL };
