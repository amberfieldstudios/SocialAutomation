/**
 * CampaignService — the m4 capstone: turns ONE content description + a list of
 * target platforms/accounts into validated, enqueued publish jobs across all
 * of them at once.
 *
 * Per target platform:
 *   1. Resolve the connector's `CapabilityDescriptor` from the plugin registry.
 *   2. Generate a platform-optimized variant via `@social/ai`'s
 *      `CampaignGenerator` (injected `ContentProvider` — tests use `MockProvider`,
 *      never a live API).
 *   3. If media sources were supplied, run `@social/media`'s `RenditionPlanner`
 *      once (shared across every platform) and attach the rendition each
 *      platform actually needs to that platform's `PostPayload.media`.
 *   4. Run the connector's `validatePost` on the assembled variant — THE GATE.
 *      Invalid content is recorded as `rejected` with its validation errors and
 *      is NEVER enqueued; the pipeline never hands a connector a payload its
 *      own rules would refuse.
 *   5. Valid variants are handed to the existing `PublishService.submitPost`
 *      (persist `post_variants` row + enqueue a job) — the exact same
 *      validate-before-publish choke point every other caller of `submitPost`
 *      goes through (see `publish-service.ts`).
 *
 * One platform's failure (unknown connector, generation error, media error)
 * never aborts the others — every target is processed independently and the
 * per-platform outcome is reported back to the caller.
 */

import os from 'node:os';
import path from 'node:path';

import type { MediaSource, PostPayload, StructuredLogger, ValidationResult } from '@social/core';
import type { JobOperation } from '@social/queue';
import type { ContentBrief, ContentProvider, GeneratedVariant, GenerationTarget } from '@social/ai';
import { CampaignGenerator } from '@social/ai';
import type { ExecutionResult, MediaPlan, MediaRenditionRecord, SourceMedia } from '@social/media';
import { RenditionPlanner } from '@social/media';
import type { LinkRewriter } from '@social/analytics';

import type { PluginConnectorResolver } from './connector-resolver';
import type { PublishService } from './publish-service';

export interface CampaignPlatformTarget {
  platformId: string;
  accountId: string;
  /** Platform-only options merged onto the generated payload (e.g. Discord's `channelId`). */
  platformOptions?: Record<string, unknown>;
}

export interface ComposeAndSubmitInput {
  /** The one content description every platform's variant is derived from. */
  description: string;
  title?: string;
  link?: string;
  tags?: string[];
  mentions?: string[];
  campaign?: string;
  /** Tracking code used by an injected `LinkRewriter` for UTM `utm_campaign` + short-URL click attribution.
   * Defaults to `campaign` (the free-text tone-continuity name) when omitted. Ignored if no `linkRewriter` is configured. */
  campaignId?: string;
  cta?: string;
  seoKeywords?: string[];
  language?: string;
  /** Source media (already staged to local disk) to derive per-platform renditions from. */
  mediaSources?: SourceMedia[];
  /** Where to write derived renditions; defaults to a shared temp dir. */
  mediaOutDir?: string;
  platforms: CampaignPlatformTarget[];
  operation?: JobOperation;
  maxAttempts?: number;
  /** Forwarded to `PublishService.submitPost` as `occurrenceKey` — see its doc comment.
   * Set by the scheduler wiring (t23) for each materialized schedule occurrence;
   * omitted by plain one-off campaign submits. */
  occurrenceKey?: string;
}

export type PlatformCampaignStatus = 'enqueued' | 'rejected' | 'error';

export interface PlatformCampaignResult {
  platform: string;
  accountId: string;
  status: PlatformCampaignStatus;
  /** Length of the generated primary text/title field, per `CampaignGenerator`'s measurement. */
  textLength?: number;
  renditionCount?: number;
  mediaAttached?: number;
  validation?: ValidationResult;
  postVariantId?: string;
  jobId?: string;
  /** True if an already-enqueued job with the same idempotency key was returned instead of a new one (only meaningful when `occurrenceKey` was supplied). */
  deduped?: boolean;
  /** Populated only when `status === 'error'` (generation/media/connector-resolution failure). */
  error?: string;
}

export interface CampaignResult {
  results: PlatformCampaignResult[];
  mediaPlans: MediaPlan[];
}

export interface CampaignServiceOptions {
  connectors: PluginConnectorResolver;
  publishService: PublishService;
  /** The content provider every generation call is routed through — inject `MockProvider` in tests. */
  provider: ContentProvider;
  logger: StructuredLogger;
  /** Overridable for tests; defaults to a real `RenditionPlanner` sharing `logger`. */
  planner?: RenditionPlanner;
  /** Overridable for tests; defaults to a real `CampaignGenerator` wrapping `provider`. */
  generator?: CampaignGenerator;
  mediaOutDir?: string;
  /** Optional (t21): when supplied, `input.link` is rewritten to a tracked (UTM-tagged, optionally
   * shortened) URL, per platform/account, BEFORE generation — so the text every connector publishes
   * already carries the tracked link. Omitted entirely by callers that don't need URL tracking
   * (e.g. existing m3/m4 tests) with zero behavior change. */
  linkRewriter?: LinkRewriter;
}

interface MediaExecution {
  plan: MediaPlan;
  execution: ExecutionResult;
}

/** Pick the rendition a given platform should attach, from one media source's execution. */
function pickRenditionForPlatform(entry: MediaExecution, platform: string): MediaRenditionRecord | undefined {
  const need = entry.plan.needs.find((n) => n.platforms.includes(platform));
  if (need) {
    const match = entry.execution.renditions.find((r) => r.kind === need.kind && r.status === 'ready');
    if (match) return match;
  }
  // No platform-specific rendition was needed (or it failed) — the original file is always ready-equivalent.
  return entry.execution.renditions.find((r) => r.kind === 'original' && r.status === 'ready');
}

export class CampaignService {
  private readonly planner: RenditionPlanner;
  private readonly generator: CampaignGenerator;
  private readonly mediaOutDir: string;

  constructor(private readonly options: CampaignServiceOptions) {
    this.planner = options.planner ?? new RenditionPlanner(options.logger);
    this.generator = options.generator ?? new CampaignGenerator(options.provider, options.logger);
    this.mediaOutDir = options.mediaOutDir ?? path.join(os.tmpdir(), 'social-campaign-media');
  }

  /** Generate, validate, and enqueue a variant for every target platform/account in `input`. */
  async composeAndSubmit(input: ComposeAndSubmitInput): Promise<CampaignResult> {
    const log = this.options.logger.child({ op: 'campaign.compose_and_submit' });
    const platformIds = input.platforms.map((p) => p.platformId);

    log.info('campaign.start', {
      platforms: platformIds,
      hasMedia: (input.mediaSources?.length ?? 0) > 0,
      mediaSourceCount: input.mediaSources?.length ?? 0,
    });

    const brief: ContentBrief = {
      description: input.description,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.link !== undefined ? { link: input.link } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.mentions !== undefined ? { mentions: input.mentions } : {}),
      ...(input.campaign !== undefined ? { campaign: input.campaign } : {}),
      ...(input.cta !== undefined ? { cta: input.cta } : {}),
      ...(input.seoKeywords !== undefined ? { seoKeywords: input.seoKeywords } : {}),
      ...(input.language !== undefined ? { language: input.language } : {}),
    };

    // Resolve every connector up front so an unknown platform fails fast for
    // just that target (caught per-target below), not the whole batch.
    const targets: Array<{ target: CampaignPlatformTarget; generation?: GenerationTarget; resolveError?: unknown }> =
      input.platforms.map((target) => {
        try {
          const connector = this.options.connectors.resolve(target.platformId);
          return {
            target,
            generation: { platform: target.platformId, accountId: target.accountId, capabilities: connector.capabilities },
          };
        } catch (err) {
          return { target, resolveError: err };
        }
      });

    // Media: plan + execute ONCE per source against the full platform list, reused by every platform below.
    const mediaExecutions: MediaExecution[] = [];
    if (input.mediaSources && input.mediaSources.length > 0) {
      const outDir = input.mediaOutDir ?? this.mediaOutDir;
      for (const source of input.mediaSources) {
        const plan = this.planner.plan(source, platformIds);
        const execution = await this.planner.execute(source, plan, outDir);
        mediaExecutions.push({ plan, execution });
        log.info('campaign.media_executed', {
          assetId: execution.asset.id,
          mediaType: source.mediaType,
          renditionCount: execution.renditions.length,
          renditionKinds: execution.renditions.map((r) => r.kind),
          readyCount: execution.renditions.filter((r) => r.status === 'ready').length,
        });
      }
    }

    const results = await Promise.all(
      targets.map(({ target, generation, resolveError }) =>
        resolveError !== undefined
          ? Promise.resolve(this.errorResult(target, resolveError))
          : this.processTarget(brief, target, generation!, mediaExecutions, input),
      ),
    );

    log.info('campaign.done', {
      enqueued: results.filter((r) => r.status === 'enqueued').length,
      rejected: results.filter((r) => r.status === 'rejected').length,
      errored: results.filter((r) => r.status === 'error').length,
    });

    return { results, mediaPlans: mediaExecutions.map((m) => m.plan) };
  }

  private errorResult(target: CampaignPlatformTarget, err: unknown): PlatformCampaignResult {
    return {
      platform: target.platformId,
      accountId: target.accountId,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  private async processTarget(
    brief: ContentBrief,
    target: CampaignPlatformTarget,
    generation: GenerationTarget,
    mediaExecutions: MediaExecution[],
    input: ComposeAndSubmitInput,
  ): Promise<PlatformCampaignResult> {
    const log = this.options.logger.child({
      op: 'campaign.process_target',
      platform: target.platformId,
      accountId: target.accountId,
    });

    const campaignId = input.campaignId ?? input.campaign;

    let effectiveBrief = brief;
    if (this.options.linkRewriter && brief.link) {
      try {
        const trackedLink = await this.options.linkRewriter.rewriteLink(brief.link, {
          platform: target.platformId,
          accountId: target.accountId,
          ...(campaignId !== undefined ? { campaignId } : {}),
        });
        effectiveBrief = { ...brief, link: trackedLink };
        log.info('campaign.link_rewritten', { hasTrackedLink: true });
      } catch (err) {
        // Tracking is best-effort: never block a campaign because URL tracking failed -- publish
        // with the original, untracked link instead.
        log.warn('campaign.link_rewrite_failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    let generated: GeneratedVariant;
    try {
      generated = await this.generator.generateVariant(effectiveBrief, generation);
    } catch (err) {
      log.error('campaign.generation_failed', { error: err instanceof Error ? err.message : String(err) });
      return this.errorResult(target, err);
    }

    let payload: PostPayload = generated.payload;
    let mediaAttached = 0;

    if (mediaExecutions.length > 0 && generation.capabilities.maxMediaCount > 0) {
      const media: MediaSource[] = [];
      for (const entry of mediaExecutions) {
        const rendition = pickRenditionForPlatform(entry, target.platformId);
        if (!rendition) continue;
        media.push({
          assetId: entry.execution.asset.id,
          renditionId: rendition.id,
          mimeType: rendition.mimeType,
          uri: rendition.storageUri,
          ...(rendition.bytes !== null ? { bytes: rendition.bytes } : {}),
          ...(rendition.width !== null ? { width: rendition.width } : {}),
          ...(rendition.height !== null ? { height: rendition.height } : {}),
          ...(rendition.durationMs !== null ? { durationMs: rendition.durationMs } : {}),
        });
      }
      if (media.length > 0) {
        payload = { ...payload, media: media.slice(0, generation.capabilities.maxMediaCount) };
        mediaAttached = payload.media?.length ?? 0;
      }
    }

    if (target.platformOptions) {
      payload = { ...payload, platformOptions: { ...payload.platformOptions, ...target.platformOptions } };
    }

    log.info('campaign.variant_generated', {
      textLength: generated.textLength,
      opsApplied: generated.opsApplied,
      mediaAttached,
    });

    let validation: ValidationResult;
    try {
      const connector = this.options.connectors.resolve(target.platformId);
      validation = await connector.validatePost(payload);
    } catch (err) {
      log.error('campaign.validate_failed', { error: err instanceof Error ? err.message : String(err) });
      return this.errorResult(target, err);
    }

    log.info('campaign.validation_outcome', {
      ok: validation.ok,
      errorCount: validation.errors.length,
      warningCount: validation.warnings.length,
    });

    if (!validation.ok) {
      log.warn('campaign.variant_rejected', { errors: validation.errors });
      return {
        platform: target.platformId,
        accountId: target.accountId,
        status: 'rejected',
        textLength: generated.textLength,
        mediaAttached,
        validation,
      };
    }

    try {
      const submission = await this.options.publishService.submitPost({
        platform: target.platformId,
        accountId: target.accountId,
        payload,
        ...(campaignId !== undefined ? { campaignId } : {}),
        ...(input.occurrenceKey !== undefined ? { occurrenceKey: input.occurrenceKey } : {}),
        ...(input.operation !== undefined ? { operation: input.operation } : {}),
        ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
      });

      log.info('campaign.enqueued', { postVariantId: submission.postVariantId, jobId: submission.jobId, deduped: submission.deduped });

      return {
        platform: target.platformId,
        accountId: target.accountId,
        status: 'enqueued',
        textLength: generated.textLength,
        mediaAttached,
        validation: submission.validation,
        postVariantId: submission.postVariantId,
        jobId: submission.jobId,
        deduped: submission.deduped,
      };
    } catch (err) {
      // ValidationFailedError here would mean submitPost's own (redundant)
      // re-validation disagrees with ours above -- treat as rejected, not a
      // hard error, since it's still "never published invalid content".
      log.error('campaign.submit_failed', { error: err instanceof Error ? err.message : String(err) });
      return {
        platform: target.platformId,
        accountId: target.accountId,
        status: 'error',
        textLength: generated.textLength,
        mediaAttached,
        validation,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
