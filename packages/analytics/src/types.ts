/**
 * Shapes for the analytics collection + aggregation stage.
 *
 * Deliberately decoupled from both `@social/queue` and `@social/auth`:
 * `AnalyticsCollector` only needs a `PlatformConnector` (resolved via the
 * minimal `ConnectorResolverPort` below — structurally satisfied by
 * `@social/pipeline`'s `PluginConnectorResolver`, no import needed) and an
 * already-built `OperationContext` (token + logger) per target, which the
 * caller (the scheduler/pipeline wiring, per t23) is responsible for
 * constructing from the token vault. This keeps `@social/analytics` free of a
 * dependency on `@social/auth`.
 */

import type { OperationContext, PlatformConnector } from '@social/core';

/** Narrow resolver port — satisfied structurally by `PluginConnectorResolver.resolve`. */
export interface ConnectorResolverPort {
  resolve(platformId: string): PlatformConnector;
}

/** One published post to collect analytics for. */
export interface CollectionTarget {
  platform: string;
  /** Internal `accounts.id`. */
  accountId: string;
  /** Internal `post_variants.id` — the row a snapshot attaches to. */
  postVariantId: string;
  /** Platform-native post id, as recorded on `post_variants.remote_id` after publish. */
  remoteId: string;
  /** Context (decrypted token + logger) the connector needs to make the call. */
  ctx: OperationContext;
  /** Optional ISO-8601 window bounds forwarded to `AnalyticsQuery`. */
  since?: string;
  until?: string;
}

export type CollectionStatus = 'collected' | 'skipped_unsupported' | 'error';

export interface CollectionOutcome {
  status: CollectionStatus;
  target: CollectionTarget;
  /** Present when `status === 'collected'`. */
  snapshot?: NormalizedSnapshot;
  /** Present when `status === 'error'` (a non-NotSupported, non-retryable-exhausted failure). */
  error?: { code?: string; message: string };
}

export interface CollectionBatchResult {
  outcomes: CollectionOutcome[];
  collected: number;
  skippedUnsupported: number;
  errored: number;
}

/**
 * A persisted-shape analytics snapshot: the raw connector `AnalyticsSnapshot`
 * plus derived metrics (e.g. `ctr`) computed at collection time, and the
 * internal ids needed to persist/join it (`analytics_snapshots` columns).
 */
export interface NormalizedSnapshot {
  postVariantId: string;
  accountId: string;
  platform: string;
  remoteId: string;
  /** ISO-8601 collection time (from the connector, or collection wall-clock as fallback). */
  collectedAt: string;
  /** Canonical + platform-extra metric values, plus derived metrics (ctr, ...). */
  metrics: Record<string, number>;
  raw?: unknown;
}
