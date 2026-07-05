/**
 * Minimal `posts` / `post_variants` writer.
 *
 * `@social/db` (t9) intentionally did not build repositories for `posts` /
 * `post_variants` — those are content-pipeline (m4) entities, out of that
 * task's scope. But `publish_jobs.post_variant_id` is a `NOT NULL` FK into
 * `post_variants` (which itself FKs into `posts`/`accounts`/`platforms`), so a
 * real `JobStore.enqueue()` call requires a genuine row to exist — the
 * in-memory `JobStore` port doesn't enforce this, but `SqliteJobStore` does
 * (foreign keys are ON), which is exactly the persistence discipline this task
 * is supposed to exercise.
 *
 * This is the minimal seam needed to drive that FK honestly without taking
 * over m4's job of designing the real content pipeline: enough to create one
 * post + one variant per submitted `PostPayload`, and to record the
 * publish/edit/delete outcome back onto the variant row afterwards
 * (`remote_id` / `remote_url` / `published_at` / `status` — the
 * "analytics-ready ids" persisted alongside the job's own `result` JSON).
 */

import { randomUUID } from 'node:crypto';
import type { PostPayload, PublishResult, ValidationResult } from '@social/core';
import type { SqlDriver } from '@social/db';

export interface PostVariantSeed {
  id: string;
  postId: string;
}

export interface PostVariantsRepoOptions {
  now?: () => Date;
}

/** Raw-SQL writer for the two content-pipeline tables the publish path needs to satisfy FKs. */
export class PostVariantsRepo {
  private readonly now: () => Date;

  constructor(
    private readonly driver: SqlDriver,
    options: PostVariantsRepoOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Ensure a `campaigns` row exists for `campaignId` (a no-op if `campaignId`
   * is nullish, or if a row already exists — `INSERT OR IGNORE`). The
   * campaign tracking code (`LinkRewriter`'s `campaignId`, per t21) doubles as
   * the `campaigns.id`/`tracking_code` so `posts.campaign_id` FKs cleanly and
   * `CampaignAggregator.aggregate(campaignId)` (t20/t23) can join straight
   * through without a separate campaign-creation step.
   */
  private ensureCampaign(campaignId: string | null | undefined): void {
    if (!campaignId) return;
    const nowIso = this.now().toISOString();
    this.driver.run(
      `INSERT OR IGNORE INTO campaigns (id, name, status, tracking_code, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?, ?)`,
      [campaignId, campaignId, campaignId, nowIso, nowIso],
    );
  }

  /**
   * Create a standalone `posts` row (no variant yet) — used by the scheduler
   * wiring (t23) to anchor a `schedules.post_id` FK to a real row representing
   * the recurring/scheduled campaign's brief, before any occurrence has
   * generated its per-platform variants.
   */
  createPost(input: { campaignId?: string | null; title?: string | null; brief: string; linkUrl?: string | null }): string {
    this.ensureCampaign(input.campaignId);
    const nowIso = this.now().toISOString();
    const postId = randomUUID();
    this.driver.run(
      `INSERT INTO posts (id, campaign_id, title, brief, link_url, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'ready', NULL, ?, ?)`,
      [postId, input.campaignId ?? null, input.title ?? null, input.brief, input.linkUrl ?? null, nowIso, nowIso],
    );
    return postId;
  }

  /**
   * Create a `posts` row and a single `post_variants` row for `payload`,
   * validated with `validationResult` (recorded so a reviewer can see why a
   * variant was queued). Returns the ids needed to enqueue a job.
   */
  createVariant(params: {
    accountId: string;
    platformId: string;
    payload: PostPayload;
    validationResult?: ValidationResult;
    brief?: string;
    /** Tracking code (per t21's `campaignId`) — tagged onto `posts.campaign_id` so
     * `CampaignAggregator` can roll this variant's future analytics up by campaign. */
    campaignId?: string | null;
  }): PostVariantSeed {
    const postId = this.createPost({
      campaignId: params.campaignId,
      title: params.payload.title ?? null,
      brief: params.brief ?? params.payload.text ?? '(no brief)',
      linkUrl: params.payload.link ?? null,
    });
    const nowIso = this.now().toISOString();
    const variantId = randomUUID();

    const validationState = params.validationResult ? (params.validationResult.ok ? (params.validationResult.warnings.length > 0 ? 'warnings' : 'valid') : 'invalid') : 'unvalidated';

    this.driver.run(
      `INSERT INTO post_variants
         (id, post_id, account_id, platform_id, text, title, payload, generated_by,
          validation_state, validation_result, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, 'queued', ?, ?)`,
      [
        variantId,
        postId,
        params.accountId,
        params.platformId,
        params.payload.text ?? null,
        params.payload.title ?? null,
        JSON.stringify(params.payload),
        validationState,
        params.validationResult ? JSON.stringify(params.validationResult) : null,
        nowIso,
        nowIso,
      ],
    );

    return { id: variantId, postId };
  }

  /** Record a successful publish's remote identifiers back onto the variant. */
  markPublished(variantId: string, result: PublishResult): void {
    this.driver.run(
      `UPDATE post_variants SET status = 'published', remote_id = ?, remote_url = ?, published_at = ?, updated_at = ? WHERE id = ?`,
      [result.remoteId, result.remoteUrl ?? null, result.publishedAt, this.now().toISOString(), variantId],
    );
  }

  /** Record a dead-lettered/failed publish so the variant reflects final state. */
  markFailed(variantId: string): void {
    this.driver.run(`UPDATE post_variants SET status = 'failed', updated_at = ? WHERE id = ?`, [this.now().toISOString(), variantId]);
  }

  getById(variantId: string): { id: string; status: string; remoteId: string | null; remoteUrl: string | null; publishedAt: string | null } | undefined {
    const row = this.driver.get<{ id: string; status: string; remote_id: string | null; remote_url: string | null; published_at: string | null }>(
      'SELECT id, status, remote_id, remote_url, published_at FROM post_variants WHERE id = ?',
      [variantId],
    );
    if (!row) return undefined;
    return { id: row.id, status: row.status, remoteId: row.remote_id, remoteUrl: row.remote_url, publishedAt: row.published_at };
  }
}
