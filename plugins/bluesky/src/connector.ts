/**
 * Bluesky / AT Protocol connector.
 *
 * Auth model (producer decision A / docs/AUTH.md §"Bluesky / AT Protocol"):
 * app-password session flow. `authenticate` exchanges a handle + app password
 * for a session via `com.atproto.server.createSession`; `refreshToken` rotates
 * it via `com.atproto.server.refreshSession`. The decrypted session lives only
 * inside `OperationContext.token` for the duration of one call — this
 * connector never stores it.
 *
 * Contract v1.1 added a first-class `AuthRequest.kind === 'password'` variant
 * (`identifier` + `password` fields) for exactly this shape, so
 * `authenticate` now takes that kind directly instead of overloading
 * `client_credentials` with `app.extra.handle`/`app.extra.appPassword` (the
 * old workaround, removed).
 *
 * Non-goals honored: no scraping, no undocumented endpoints, no browser
 * automation. Every network call targets a documented `com.atproto.*` /
 * `app.bsky.*` XRPC method on the account's PDS (`app.extra.serviceUrl`,
 * default `https://bsky.social`).
 */

import {
  AuthError,
  NotSupportedError,
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
  type TokenSet,
  type UploadedMedia,
  type ValidationResult,
} from '@social/core';

import { XrpcClient } from './atproto-client';
import { capabilities } from './capabilities';
import { decodeJwtSubject } from './jwt';
import { readMediaBytes } from './media-io';
import { assembleText, buildFacets, type Facet } from './richtext';
import { validateBlueskyPost } from './validate';

interface StrongRef {
  uri: string;
  cid: string;
}

interface CreateSessionResponse {
  accessJwt: string;
  refreshJwt: string;
  handle: string;
  did: string;
  didDoc?: unknown;
}

interface RefreshSessionResponse {
  accessJwt: string;
  refreshJwt: string;
  handle: string;
  did: string;
}

interface DescribeServerResponse {
  did?: string;
  availableUserDomains?: string[];
}

interface UploadBlobResponse {
  blob: { $type: 'blob'; ref: { $link: string }; mimeType: string; size: number };
}

interface CreateRecordResponse {
  uri: string;
  cid: string;
}

interface ResolveHandleResponse {
  did: string;
}

interface PostView {
  uri: string;
  cid: string;
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
  quoteCount?: number;
  record?: { reply?: { root: StrongRef; parent: StrongRef } };
}

interface GetPostsResponse {
  posts: PostView[];
}

interface GetPostThreadResponse {
  thread: { post?: PostView };
}

const DEFAULT_SERVICE_URL = 'https://bsky.social';

export class BlueskyConnector implements PlatformConnector {
  readonly capabilities = capabilities;

  private readonly logger: StructuredLogger;
  private readonly now: () => Date;
  private serviceUrl: string = DEFAULT_SERVICE_URL;

  constructor(runtime: ConnectorRuntime) {
    this.logger = runtime.logger.child({ platform: 'bluesky' });
    this.now = runtime.now ?? (() => new Date());
  }

  private client(): XrpcClient {
    return new XrpcClient({ serviceUrl: this.serviceUrl, logger: this.logger });
  }

  // ---------------------------------------------------------------------
  // connect
  // ---------------------------------------------------------------------

  async connect(input: ConnectInput): Promise<ConnectResult> {
    const op = 'connect' as const;
    const serviceUrl = (input.app.extra?.serviceUrl ?? DEFAULT_SERVICE_URL).replace(/\/+$/, '');
    this.serviceUrl = serviceUrl;
    const log = this.logger.child({ operation: op, accountId: input.accountId });
    log.info('bluesky.connect.start', { serviceUrl });

    try {
      const result = await this.client().call<DescribeServerResponse>({
        method: 'GET',
        nsid: 'com.atproto.server.describeServer',
      });
      log.info('bluesky.connect.ok', { did: result.did });
      return { ready: true, platform: 'bluesky' };
    } catch (cause) {
      log.error('bluesky.connect.failed', { error: (cause as Error).message });
      throw cause;
    }
  }

  // ---------------------------------------------------------------------
  // authenticate / refreshToken
  // ---------------------------------------------------------------------

  async authenticate(request: AuthRequest): Promise<AuthResult> {
    const log = this.logger.child({ operation: 'authenticate' as const });

    if (request.kind !== 'password') {
      throw new AuthError(
        `Bluesky uses app-password authentication (AuthRequest.kind "password"); ` +
          `kind "${request.kind}" has no redirect/authorize-URL step.`,
        { platform: 'bluesky', operation: 'authenticate' },
      );
    }

    const identifier = request.identifier;
    const password = request.password;
    if (!identifier || !password) {
      throw new AuthError('Bluesky authenticate requires a handle (identifier) and app password (password).', {
        platform: 'bluesky',
        operation: 'authenticate',
      });
    }

    const serviceUrl = (request.app.extra?.serviceUrl ?? this.serviceUrl ?? DEFAULT_SERVICE_URL).replace(/\/+$/, '');
    this.serviceUrl = serviceUrl;

    log.info('bluesky.authenticate.start', { identifier });
    const session = await this.client().call<CreateSessionResponse>({
      method: 'POST',
      nsid: 'com.atproto.server.createSession',
      jsonBody: { identifier, password },
    });

    const token: TokenSet = {
      accessToken: session.accessJwt,
      refreshToken: session.refreshJwt,
      tokenType: 'Bearer',
      scopes: ['atproto'],
      obtainedAt: this.now().toISOString(),
    };

    log.info('bluesky.authenticate.ok', { did: session.did, handle: session.handle });
    return {
      token,
      profile: {
        remoteId: session.did,
        handle: session.handle,
        profileUrl: `https://bsky.app/profile/${session.handle}`,
        raw: { did: session.did, handle: session.handle },
      },
    };
  }

  async refreshToken(input: RefreshInput): Promise<TokenSet> {
    const log = this.logger.child({ operation: 'refreshToken' as const });
    if (!input.token.refreshToken) {
      throw new AuthError('No refresh token available to renew the Bluesky session.', { platform: 'bluesky' });
    }
    const serviceUrl = (input.app.extra?.serviceUrl ?? this.serviceUrl ?? DEFAULT_SERVICE_URL).replace(/\/+$/, '');
    this.serviceUrl = serviceUrl;

    log.info('bluesky.refreshToken.start', {});
    const refreshed = await this.client().call<RefreshSessionResponse>({
      method: 'POST',
      nsid: 'com.atproto.server.refreshSession',
      token: input.token.refreshToken,
    });

    log.info('bluesky.refreshToken.ok', { did: refreshed.did });
    return {
      accessToken: refreshed.accessJwt,
      refreshToken: refreshed.refreshJwt,
      tokenType: 'Bearer',
      scopes: input.token.scopes,
      obtainedAt: this.now().toISOString(),
    };
  }

  // ---------------------------------------------------------------------
  // validatePost
  // ---------------------------------------------------------------------

  async validatePost(payload: PostPayload): Promise<ValidationResult> {
    return validateBlueskyPost(payload, this.capabilities);
  }

  // ---------------------------------------------------------------------
  // uploadMedia
  // ---------------------------------------------------------------------

  async uploadMedia(media: MediaSource, ctx: OperationContext): Promise<UploadedMedia> {
    const log = ctx.logger.child({ operation: 'uploadMedia' as const, platform: 'bluesky', accountId: ctx.accountId });
    log.info('bluesky.uploadMedia.start', { mimeType: media.mimeType, assetId: media.assetId });

    const bytes = await readMediaBytes(media.uri);
    const blobResp = await this.client().call<UploadBlobResponse>({
      method: 'POST',
      nsid: 'com.atproto.repo.uploadBlob',
      token: ctx.token.accessToken,
      binaryBody: { bytes, mimeType: media.mimeType },
    });

    log.info('bluesky.uploadMedia.ok', { cid: blobResp.blob.ref.$link, size: blobResp.blob.size });
    return {
      source: media,
      remoteMediaId: blobResp.blob.ref.$link,
      raw: blobResp.blob,
    };
  }

  // ---------------------------------------------------------------------
  // publish
  // ---------------------------------------------------------------------

  async publish(payload: PostPayload, ctx: OperationContext): Promise<PublishResult> {
    const log = ctx.logger.child({ operation: 'publish' as const, platform: 'bluesky', accountId: ctx.accountId });

    const validation = await this.validatePost(payload);
    if (!validation.ok) {
      log.warn('bluesky.publish.validation_failed', { errorCount: validation.errors.length });
      throw new ValidationFailedError(validation, { platform: 'bluesky', operation: 'publish' });
    }

    const did = decodeJwtSubject(ctx.token.accessToken);
    if (!did) {
      throw new AuthError('Could not determine the Bluesky DID from the session token.', { platform: 'bluesky', operation: 'publish' });
    }

    log.info('bluesky.publish.start', { did, hasMedia: (payload.media?.length ?? 0) > 0, hasThread: (payload.thread?.length ?? 0) > 0 });

    const chain: PostPayload[] = [payload, ...(payload.thread ?? [])];
    const threadRemoteIds: string[] = [];
    let rootRef: StrongRef | undefined;
    let parentRef: StrongRef | undefined;

    if (payload.replyToRemoteId) {
      const refs = await this.resolveReplyRefs(payload.replyToRemoteId, ctx.token.accessToken);
      rootRef = refs.root;
      parentRef = refs.parent;
    }

    let first: PublishResult | undefined;

    for (const post of chain) {
      const created = await this.createOnePost(post, did, ctx, rootRef, parentRef, log);
      threadRemoteIds.push(created.uri);
      const ref: StrongRef = { uri: created.uri, cid: created.cid };
      if (!rootRef) rootRef = ref;
      parentRef = ref;
      if (!first) {
        first = {
          remoteId: created.uri,
          remoteUrl: this.postUrlFromUri(created.uri),
          publishedAt: this.now().toISOString(),
          raw: created,
        };
      }
    }

    log.info('bluesky.publish.ok', { remoteId: first!.remoteId, threadLength: threadRemoteIds.length });
    return { ...first!, threadRemoteIds: threadRemoteIds.length > 1 ? threadRemoteIds : undefined };
  }

  private async createOnePost(
    post: PostPayload,
    did: string,
    ctx: OperationContext,
    rootRef: StrongRef | undefined,
    parentRef: StrongRef | undefined,
    log: StructuredLogger,
  ): Promise<CreateRecordResponse> {
    const accessToken = ctx.token.accessToken;
    const text = assembleText(post.text, post.tags, post.mentions);
    const facets: Facet[] = await buildFacets(text, (handle) => this.resolveHandleToDid(handle));

    let embed: unknown;
    if (post.media && post.media.length > 0) {
      const uploaded: UploadedMedia[] = [];
      for (const media of post.media) {
        uploaded.push(await this.uploadMedia(media, ctx));
      }
      const isVideo = post.media[0]?.mimeType.startsWith('video/');
      if (isVideo) {
        const m = uploaded[0]!;
        embed = {
          $type: 'app.bsky.embed.video',
          video: { $type: 'blob', ref: { $link: m.remoteMediaId }, mimeType: m.source.mimeType, size: m.source.bytes ?? 0 },
          alt: m.source.altText,
        };
      } else {
        embed = {
          $type: 'app.bsky.embed.images',
          images: uploaded.map((m) => ({
            image: { $type: 'blob', ref: { $link: m.remoteMediaId }, mimeType: m.source.mimeType, size: m.source.bytes ?? 0 },
            alt: m.source.altText ?? '',
          })),
        };
      }
    }

    const record: Record<string, unknown> = {
      $type: 'app.bsky.feed.post',
      text,
      createdAt: this.now().toISOString(),
    };
    if (facets.length > 0) record.facets = facets;
    if (embed) record.embed = embed;
    if (post.language) record.langs = [post.language];
    if (post.sensitive) {
      record.labels = { $type: 'com.atproto.label.defs#selfLabels', values: [{ val: 'graphic-media' }] };
    }
    if (rootRef && parentRef) {
      record.reply = { root: rootRef, parent: parentRef };
    }

    log.debug('bluesky.publish.createRecord', { textLength: text.length, hasEmbed: Boolean(embed), isReply: Boolean(rootRef) });

    return this.client().call<CreateRecordResponse>({
      method: 'POST',
      nsid: 'com.atproto.repo.createRecord',
      token: accessToken,
      jsonBody: { repo: did, collection: 'app.bsky.feed.post', record },
    });
  }

  private async resolveHandleToDid(handle: string): Promise<string | undefined> {
    try {
      const resp = await this.client().call<ResolveHandleResponse>({
        method: 'GET',
        nsid: 'com.atproto.identity.resolveHandle',
        query: { handle },
      });
      return resp.did;
    } catch {
      return undefined;
    }
  }

  private async resolveReplyRefs(replyToUri: string, accessToken: string): Promise<{ root: StrongRef; parent: StrongRef }> {
    const resp = await this.client().call<GetPostThreadResponse>({
      method: 'GET',
      nsid: 'app.bsky.feed.getPostThread',
      token: accessToken,
      query: { uri: replyToUri, depth: '0', parentHeight: '1000' },
    });
    const parentPost = resp.thread.post;
    if (!parentPost) {
      throw new AuthError(`Could not resolve the post being replied to: ${replyToUri}`, { platform: 'bluesky', operation: 'publish' });
    }
    const parent: StrongRef = { uri: parentPost.uri, cid: parentPost.cid };
    const root: StrongRef = parentPost.record?.reply?.root ?? parent;
    return { root, parent };
  }

  private postUrlFromUri(uri: string): string | undefined {
    const match = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(uri);
    if (!match) return undefined;
    const [, repo, rkey] = match;
    return `https://bsky.app/profile/${repo}/post/${rkey}`;
  }

  private rkeyFromUri(uri: string): string | undefined {
    const parts = uri.split('/');
    return parts[parts.length - 1];
  }

  // ---------------------------------------------------------------------
  // delete
  // ---------------------------------------------------------------------

  async delete(request: DeleteRequest, ctx: OperationContext): Promise<DeleteResult> {
    assertSupported(this.capabilities, 'delete');
    const log = ctx.logger.child({ operation: 'delete' as const, platform: 'bluesky', accountId: ctx.accountId });

    const did = decodeJwtSubject(ctx.token.accessToken);
    const rkey = this.rkeyFromUri(request.remoteId);
    if (!did || !rkey) {
      throw new AuthError('Could not derive repo/rkey to delete the Bluesky post.', { platform: 'bluesky', operation: 'delete' });
    }

    log.info('bluesky.delete.start', { remoteId: request.remoteId });
    await this.client().call({
      method: 'POST',
      nsid: 'com.atproto.repo.deleteRecord',
      token: ctx.token.accessToken,
      jsonBody: { repo: did, collection: 'app.bsky.feed.post', rkey },
    });

    log.info('bluesky.delete.ok', { remoteId: request.remoteId });
    return { removed: true };
  }

  // ---------------------------------------------------------------------
  // edit — unsupported: AT Proto posts are immutable in the official app
  // ---------------------------------------------------------------------

  async edit(_request: EditRequest, _ctx: OperationContext): Promise<EditResult> {
    assertSupported(this.capabilities, 'edit');
    throw new NotSupportedError('edit', 'bluesky');
  }

  // ---------------------------------------------------------------------
  // getAnalytics — partial: engagement counts only, no impressions/reach
  // ---------------------------------------------------------------------

  async getAnalytics(query: AnalyticsQuery, ctx: OperationContext): Promise<AnalyticsSnapshot> {
    assertSupported(this.capabilities, 'getAnalytics');
    const log = ctx.logger.child({ operation: 'getAnalytics' as const, platform: 'bluesky', accountId: ctx.accountId });

    log.info('bluesky.getAnalytics.start', { remoteId: query.remoteId });
    const resp = await this.client().call<GetPostsResponse>({
      method: 'GET',
      nsid: 'app.bsky.feed.getPosts',
      token: ctx.token.accessToken,
      query: { uris: [query.remoteId] },
    });

    const post = resp.posts[0];
    if (!post) {
      throw new AuthError(`Post not found: ${query.remoteId}`, { platform: 'bluesky', operation: 'getAnalytics' });
    }

    const metrics: Record<string, number> = {
      likes: post.likeCount ?? 0,
      comments: post.replyCount ?? 0,
      shares: post.repostCount ?? 0,
    };
    if (post.quoteCount !== undefined) metrics.quotes = post.quoteCount;

    log.info('bluesky.getAnalytics.ok', { remoteId: query.remoteId });
    return { remoteId: query.remoteId, collectedAt: this.now().toISOString(), metrics, raw: post };
  }

  // ---------------------------------------------------------------------
  // disconnect
  // ---------------------------------------------------------------------

  async disconnect(ctx: OperationContext): Promise<DisconnectResult> {
    const log = ctx.logger.child({ operation: 'disconnect' as const, platform: 'bluesky', accountId: ctx.accountId });

    if (!ctx.token.refreshToken) {
      log.warn('bluesky.disconnect.no_refresh_token', {});
      return { revoked: false };
    }

    log.info('bluesky.disconnect.start', {});
    try {
      await this.client().call({
        method: 'POST',
        nsid: 'com.atproto.server.deleteSession',
        token: ctx.token.refreshToken,
      });
      log.info('bluesky.disconnect.ok', {});
      return { revoked: true };
    } catch (cause) {
      // Best-effort: local account cleanup proceeds either way, so this never throws.
      log.warn('bluesky.disconnect.revoke_failed', { error: (cause as Error).message });
      return { revoked: false };
    }
  }
}
