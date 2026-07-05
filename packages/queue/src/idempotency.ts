/**
 * Idempotency-key derivation.
 *
 * `publish_jobs.idempotency_key` is `UNIQUE` (see `docs/SCHEMA.md`), so once a
 * key is used it can never be reused for a different logical job — this is
 * what prevents double-publishing across retries and process restarts: if the
 * worker crashes after publishing but before marking the job `succeeded`, the
 * re-enqueue attempt on restart resolves to the *same* row instead of creating
 * a duplicate.
 *
 * Derivation:
 *   `${postVariantId}:${operation}` when no `occurrenceKey` is supplied — one
 *   variant can only ever have one outstanding `publish` (or `edit`, or
 *   `delete`) job.
 *
 *   `${postVariantId}:${operation}:${occurrenceKey}` when an `occurrenceKey` is
 *   supplied. Recurring campaigns MUST pass one per fire (typically the
 *   schedule's computed occurrence time in UTC, e.g. the ISO-8601 instant), or
 *   every occurrence after the first would dedupe against the one already
 *   queued and recurring posts would silently stop after their first run.
 *
 * Callers may also pass a fully explicit `idempotencyKey` to `enqueue()`,
 * bypassing derivation entirely (e.g. to key off an externally supplied
 * request id for at-most-once API semantics).
 */

import type { JobOperation } from './types';

export interface IdempotencyKeyInput {
  postVariantId: string;
  operation: JobOperation;
  /** e.g. the ISO-8601 scheduled occurrence instant, for recurring campaigns. */
  occurrenceKey?: string;
}

export function deriveIdempotencyKey(input: IdempotencyKeyInput): string {
  const base = `${input.postVariantId}:${input.operation}`;
  return input.occurrenceKey ? `${base}:${input.occurrenceKey}` : base;
}
