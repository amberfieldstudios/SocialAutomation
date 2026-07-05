/**
 * Shared request/result types for the PlatformConnector contract.
 *
 * This module has NO imports from `errors.ts`, `capabilities.ts`, or `contract.ts`
 * so it sits at the base of the dependency graph and can be imported anywhere.
 */

import type { StructuredLogger } from '../logging';

/** The ten operations every connector declares support for and may implement. */
export type ConnectorOperation =
  | 'connect'
  | 'authenticate'
  | 'refreshToken'
  | 'validatePost'
  | 'uploadMedia'
  | 'publish'
  | 'delete'
  | 'edit'
  | 'getAnalytics'
  | 'disconnect';

/** High-level media categories the pipeline understands. */
export type MediaType = 'image' | 'video' | 'gif' | 'audio' | 'document';

// ---------------------------------------------------------------------------
// Credentials & tokens
// ---------------------------------------------------------------------------

/**
 * The platform *application* credentials (the developer app registered with the
 * platform), NOT the end-user's tokens. Supplied by config / the auth layer.
 */
export interface AppCredentials {
  clientId: string;
  /** Omitted for public/PKCE clients. */
  clientSecret?: string;
  redirectUri?: string;
  /** Platform-specific extras (e.g. Discord bot token, Reddit user-agent). */
  extra?: Record<string, string>;
}

/**
 * A live OAuth token set for a single account.
 *
 * SECURITY: this is the *decrypted, in-memory* form. It is produced/consumed by
 * connectors and the auth layer only. It is NEVER persisted as-is — the token
 * vault (see docs/SCHEMA.md `account_tokens`) stores ciphertext + a key
 * reference, and it MUST NEVER be written to logs.
 */
export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** e.g. "Bearer". */
  tokenType?: string;
  scopes: string[];
  /** ISO-8601 expiry of the access token, if the platform issues one. */
  expiresAt?: string;
  /** ISO-8601 timestamp the token was obtained/refreshed. */
  obtainedAt: string;
}

/** Normalized platform account profile returned after authentication. */
export interface PlatformProfile {
  /** Platform-native account id (stable). */
  remoteId: string;
  handle?: string;
  displayName?: string;
  avatarUrl?: string;
  profileUrl?: string;
  /** Untyped platform payload, for debugging/audit. */
  raw?: unknown;
}

// ---------------------------------------------------------------------------
// Operation context
// ---------------------------------------------------------------------------

/**
 * Per-call context passed to every token-requiring operation. The connector
 * receives the decrypted token here rather than reading storage itself, keeping
 * connectors free of any database/vault dependency.
 *
 * `app` (Contract v1.1+) carries the platform *application* credentials
 * alongside the account token, so connectors that need `clientId` (or other
 * app-level config) on a per-call operation — e.g. a header every request
 * requires — can read it here instead of making an extra round trip to derive
 * it from the token itself (see Twitch's old `/oauth2/validate` workaround,
 * removed once this landed).
 */
export interface OperationContext {
  token: TokenSet;
  /** The developer app credentials this account was connected under. */
  app: AppCredentials;
  /** Internal `accounts.id` this call acts on (for logging/correlation). */
  accountId: string;
  logger: StructuredLogger;
  /** Optional soft deadline as epoch milliseconds. */
  deadlineMs?: number;
}

// ---------------------------------------------------------------------------
// connect / authenticate / refresh
// ---------------------------------------------------------------------------

export interface ConnectInput {
  app: AppCredentials;
  /** Internal `accounts.id`, when connecting for a known account. */
  accountId?: string;
  /** Existing token, if the account is already authenticated. */
  token?: TokenSet;
}

export interface ConnectResult {
  ready: boolean;
  platform: string;
  /** Platform API version the connector negotiated, if reported. */
  apiVersion?: string;
}

/**
 * `authenticate` is a small state machine covering the OAuth shapes connectors
 * need. The `kind` discriminant selects which fields are relevant.
 */
export type AuthRequest =
  | {
      kind: 'authorize_url';
      app: AppCredentials;
      state: string;
      scopes: string[];
      /** PKCE challenge, when the platform requires it. */
      codeChallenge?: string;
    }
  | {
      kind: 'exchange_code';
      app: AppCredentials;
      code: string;
      state?: string;
      /** PKCE verifier matching the earlier challenge. */
      codeVerifier?: string;
    }
  | {
      kind: 'client_credentials';
      app: AppCredentials;
      scopes: string[];
    }
  | {
      /**
       * Contract v1.1+: first-class password/direct-credential grant for
       * platforms with no OAuth2 "app" concept (e.g. Bluesky/AT Protocol app
       * passwords). Distinct from `client_credentials`, which is an OAuth2 app-
       * level grant — `password` exchanges a per-*account* identifier/secret
       * pair the end user supplies (never the platform app's own secret).
       */
      kind: 'password';
      app: AppCredentials;
      /** Account-level identifier, e.g. a handle, username, or email. */
      identifier: string;
      /** Account-level secret, e.g. an app password. Never the app's clientSecret. */
      password: string;
      scopes?: string[];
    };

export interface AuthResult {
  /** Populated for `kind: 'authorize_url'` — redirect the user here. */
  authorizeUrl?: string;
  /** Populated for code exchange / client credentials. */
  token?: TokenSet;
  /** Populated when the flow can resolve account identity. */
  profile?: PlatformProfile;
}

export interface RefreshInput {
  app: AppCredentials;
  token: TokenSet;
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

/**
 * Contract v1.1+: how a platform's `uploadMedia` behaves, declared on
 * `CapabilityDescriptor.mediaUploadMode`:
 *
 *  - `'staged'` — `uploadMedia` actually transfers bytes to the platform and
 *    returns a durable, platform-issued `remoteMediaId` (and often a
 *    `remoteUrl`/`expiresAt`) that a LATER, separate `publish`/`edit` call can
 *    reference without re-reading the source bytes (e.g. Bluesky's
 *    `com.atproto.repo.uploadBlob`).
 *  - `'inline'` — the platform has no stage-then-reference API; media can only
 *    be attached as part of the SAME request that creates/edits the post.
 *    `uploadMedia` on an `'inline'` connector only validates the media against
 *    `mediaConstraints` and returns a local, non-platform-issued pending
 *    handle (`remoteMediaId` is NOT usable against the platform); `publish`/
 *    `edit` re-read `MediaSource.uri` themselves and attach the bytes inline
 *    (e.g. Discord's multipart message-create call).
 *
 * Callers MUST check this before assuming `UploadedMedia.remoteMediaId`/
 * `remoteUrl` are meaningful outside of a connector's own `publish`/`edit`.
 */
export type MediaUploadMode = 'staged' | 'inline';

/**
 * A concrete media rendition the connector should upload. Points at bytes the
 * connector can read (`uri`), plus the metadata the platform upload API needs.
 * Maps to `media_renditions` in the schema.
 */
export interface MediaSource {
  /** Internal `media_assets.id`. */
  assetId: string;
  /** Internal `media_renditions.id` selected for this platform. */
  renditionId?: string;
  mimeType: string;
  /** Location the connector reads bytes from (file path or object-store URL). */
  uri: string;
  bytes?: number;
  width?: number;
  height?: number;
  durationMs?: number;
  altText?: string;
}

/** Result of staging media with the platform prior to publish. */
export interface UploadedMedia {
  source: MediaSource;
  /** Platform-issued handle to reference in `publish`. */
  remoteMediaId: string;
  remoteUrl?: string;
  /** Some platforms expire staged uploads (ISO-8601). */
  expiresAt?: string;
  raw?: unknown;
}

// ---------------------------------------------------------------------------
// Post payload
// ---------------------------------------------------------------------------

/**
 * The platform-specific, ready-to-publish representation of one post. Produced
 * by the AI-generation + formatting stages from a single content brief, and
 * persisted as a `post_variants` row. `thread[]` carries follow-on posts for
 * platforms that support threading.
 */
export interface PostPayload {
  platform: string;
  /** Internal `accounts.id`. */
  accountId: string;
  /** Internal `post_variants.id`, once persisted. */
  variantId?: string;
  text?: string;
  /** Title/headline for platforms that separate it (YouTube, Reddit, LinkedIn). */
  title?: string;
  media?: MediaSource[];
  /** Follow-on posts forming a thread; empty/undefined for single posts. */
  thread?: PostPayload[];
  /** Remote id of a post this replies to. */
  replyToRemoteId?: string;
  /** Remote id of a post this quotes. */
  quoteRemoteId?: string;
  link?: string;
  /** Hashtags WITHOUT the leading '#'. */
  tags?: string[];
  /** Mentions WITHOUT the leading '@'. */
  mentions?: string[];
  language?: string;
  sensitive?: boolean;
  /** ISO-8601 native-schedule time, only if the platform supports it. */
  scheduledAt?: string;
  /** Typed-per-plugin escape hatch for platform-only options. */
  platformOptions?: Record<string, unknown>;
  /** Dedupe key so retries never double-post (see publish_jobs.idempotency_key). */
  idempotencyKey?: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type IssueSeverity = 'error' | 'warning';

export interface ValidationIssue {
  /** Stable machine code, e.g. 'text_too_long', 'too_many_media'. */
  code: string;
  message: string;
  severity: IssueSeverity;
  /** Dotted/indexed path to the offending field, e.g. 'text', 'media[0]'. */
  field?: string;
  /** The applicable limit and the actual value, when numeric. */
  limit?: number;
  actual?: number;
}

export interface ValidationResult {
  /** True iff there are zero error-severity issues. */
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

// ---------------------------------------------------------------------------
// publish / delete / edit
// ---------------------------------------------------------------------------

/**
 * Contract v1.1+: typed addressing context beyond a bare `remoteId`, for
 * platforms where a post/message is only reachable in combination with a
 * container id (a channel, room, guild, or webhook) — e.g. Discord messages.
 * `PublishResult.target` carries whatever a later `delete`/`edit`/
 * `getAnalytics` call on the SAME post will need; callers persist it
 * alongside `remoteId` and pass it back on `DeleteRequest`/`EditRequest`/
 * `AnalyticsQuery`. This replaces per-connector composite-string `remoteId`
 * encodings (e.g. `"channel:<id>:<messageId>"`) with a typed field, so a
 * secret never has an incentive to hide inside `remoteId` (which is persisted
 * in plaintext, unlike the token vault) and no connector has to invent its own
 * parsing convention.
 */
export interface TargetContext {
  /** Channel/room id the post lives in, when the platform has that concept. */
  channelId?: string;
  /** Thread id, when the post lives inside a thread distinct from `channelId`. */
  threadId?: string;
  /** Guild/server/workspace id, for platforms with a server-grouping concept. */
  guildId?: string;
  /**
   * Non-secret platform-specific identifiers a connector needs to re-address
   * this post that don't fit the fields above (e.g. Discord's webhook id).
   * MUST NEVER contain a live credential/secret — those belong only in
   * `OperationContext.token`/`RefreshInput.token`.
   */
  extra?: Record<string, string>;
}

export interface PublishResult {
  /** Platform-native post id. */
  remoteId: string;
  /** Typed addressing context to pass back into delete/edit/getAnalytics on this post. */
  target?: TargetContext;
  remoteUrl?: string;
  /** ISO-8601. */
  publishedAt: string;
  /** For threads: remote ids of every post created, in order. */
  threadRemoteIds?: string[];
  raw?: unknown;
}

export interface DeleteRequest {
  remoteId: string;
  /** Typed addressing context; see `TargetContext`. Required by connectors that need it. */
  target?: TargetContext;
}

export interface DeleteResult {
  removed: boolean;
  raw?: unknown;
}

export interface EditRequest {
  remoteId: string;
  payload: PostPayload;
  /** Typed addressing context; see `TargetContext`. Required by connectors that need it. */
  target?: TargetContext;
}

export interface EditResult {
  remoteId: string;
  /** ISO-8601. */
  editedAt: string;
  remoteUrl?: string;
  raw?: unknown;
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

/**
 * Canonical, cross-platform metric names. Connectors map platform-native metric
 * names onto these so campaign aggregation compares like with like. Platform
 * extras may still appear in `AnalyticsSnapshot.raw`.
 */
export const CANONICAL_METRICS = [
  'impressions',
  'reach',
  'likes',
  'comments',
  'shares',
  'clicks',
  'views',
  'saves',
  'followersDelta',
  'engagementRate',
] as const;

export type CanonicalMetric = (typeof CANONICAL_METRICS)[number];

export interface AnalyticsQuery {
  remoteId: string;
  /** Typed addressing context; see `TargetContext`. Required by connectors that need it. */
  target?: TargetContext;
  /** Optional subset of metrics to fetch; omit for all available. */
  metrics?: CanonicalMetric[];
  /** ISO-8601 window bounds, for platforms that support ranged stats. */
  since?: string;
  until?: string;
}

export interface AnalyticsSnapshot {
  remoteId: string;
  /** ISO-8601 collection time. */
  collectedAt: string;
  /**
   * Normalized metric values. Keys SHOULD be `CanonicalMetric` values where a
   * platform-native metric maps onto one; platform-only extras may use any key.
   */
  metrics: Record<string, number>;
  raw?: unknown;
}

// ---------------------------------------------------------------------------
// disconnect
// ---------------------------------------------------------------------------

export interface DisconnectResult {
  /** True if the token was revoked at the platform (vs. locally discarded). */
  revoked: boolean;
  raw?: unknown;
}
