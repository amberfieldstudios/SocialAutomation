/**
 * PublishService — the "submit a post" entrypoint: resolve the connector,
 * run `validatePost` (pure, no network — every connector guarantees this),
 * persist a `post_variants` row, and enqueue a publish job. The worker
 * (`publish-worker.ts`) does the actual `connector.publish()` call later.
 *
 * Validation happens here, before the job ever exists, so an invalid payload
 * never occupies a queue slot or burns a retry — matching every connector's
 * own "validate-before-publish" test coverage.
 */

import type { JobStore, JobOperation } from '@social/queue';
import { deriveIdempotencyKey } from '@social/queue';
import type { PostPayload, ValidationResult } from '@social/core';
import { ValidationFailedError } from '@social/core';
import type { PluginConnectorResolver } from './connector-resolver';
import type { PostVariantsRepo } from './post-variants-repo';

export interface SubmitPostInput {
  platform: string;
  accountId: string;
  payload: PostPayload;
  operation?: JobOperation;
  scheduleId?: string | null;
  maxAttempts?: number;
  /** Tracking code tagged onto the persisted `posts.campaign_id` (see `PostVariantsRepo`). */
  campaignId?: string | null;
  /**
   * Stable per-occurrence identity (the scheduler's occurrence UTC instant,
   * ISO-8601) — when supplied, folded into the enqueued job's idempotency key
   * (`${postVariantId}:${operation}:${occurrenceKey}`, see
   * `@social/queue/src/idempotency.ts`) so a scheduled/recurring occurrence
   * that calls `submitPost` more than once for the same fire (e.g. a retried
   * submit at a layer above this one) never double-enqueues. Omitted for
   * plain one-off submits, which fall back to the queue's own default
   * (`${postVariantId}:${operation}`) derivation — unchanged behavior.
   */
  occurrenceKey?: string;
}

export interface SubmitPostResult {
  postVariantId: string;
  jobId: string;
  deduped: boolean;
  validation: ValidationResult;
}

export interface PublishJobPayload {
  [key: string]: unknown;
  platform: string;
  accountId: string;
  postPayload: PostPayload;
}

export interface PublishServiceOptions {
  connectors: PluginConnectorResolver;
  jobs: JobStore;
  variants: PostVariantsRepo;
  /**
   * Injectable clock (defaults to wall-clock). Used to stamp the enqueued job's
   * `availableAt` so it is measured on the SAME clock the `Worker` uses to claim
   * due jobs (`available_at <= now`). Threading a shared clock through the whole
   * pipeline — including this enqueue boundary — is what lets a clock-injected
   * run (tests, replay) actually process the jobs it submits; otherwise a job
   * enqueued at wall-clock time is never "due" to a worker running on a fixed
   * logical clock in the past.
   */
  now?: () => Date;
}

export class PublishService {
  private readonly now: () => Date;

  constructor(private readonly options: PublishServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Validate + persist + enqueue. Throws `ValidationFailedError` and enqueues nothing if the payload is invalid. */
  async submitPost(input: SubmitPostInput): Promise<SubmitPostResult> {
    const connector = this.options.connectors.resolve(input.platform);
    const validation = await connector.validatePost(input.payload);
    if (!validation.ok) {
      throw new ValidationFailedError(validation, { platform: input.platform });
    }

    const { id: postVariantId } = this.options.variants.createVariant({
      accountId: input.accountId,
      platformId: input.platform,
      payload: input.payload,
      validationResult: validation,
      campaignId: input.campaignId,
    });

    const jobPayload: PublishJobPayload = {
      platform: input.platform,
      accountId: input.accountId,
      postPayload: input.payload,
    };

    const operation = input.operation ?? 'publish';
    const idempotencyKey = input.occurrenceKey
      ? deriveIdempotencyKey({ postVariantId, operation, occurrenceKey: input.occurrenceKey })
      : undefined;

    const { job, deduped } = await this.options.jobs.enqueue({
      postVariantId,
      operation,
      payload: jobPayload,
      scheduleId: input.scheduleId ?? null,
      availableAt: this.now(),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
    });

    return { postVariantId, jobId: job.id, deduped, validation };
  }
}
