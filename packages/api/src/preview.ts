/**
 * Compose-preview: generate a per-platform variant (via `@social/ai`'s
 * `CampaignGenerator`, backed by the `AI_PROVIDER`-selected provider from
 * `AppContext.contentProvider` — mock by default, Claude/OpenAI when opted
 * in) and run the platform's real `validatePost` (pure, no network) against it,
 * WITHOUT persisting a post_variant or enqueuing a job. This mirrors
 * `CampaignService.processTarget`'s generate+validate steps one-for-one but
 * stops before `PublishService.submitPost`, so a preview has zero side
 * effects on the database or queue.
 */

import { CampaignGenerator, type ContentBrief, type ContentProvider } from '@social/ai';
import type { PluginConnectorResolver } from '@social/pipeline';
import type { PostPayload, StructuredLogger, ValidationResult } from '@social/core';

export interface PreviewTarget {
  platformId: string;
  accountId: string;
  /** Per-target platform-specific fields (e.g. Reddit's required `subreddit`, t14) — merged onto the generated payload before `validatePost`, mirroring `CampaignService.processTarget`'s merge. */
  platformOptions?: Record<string, unknown>;
}

export interface ComposePreviewInput extends ContentBrief {
  platforms: PreviewTarget[];
}

export type PreviewStatus = 'ok' | 'rejected' | 'error';

export interface PlatformPreviewResult {
  platform: string;
  accountId: string;
  status: PreviewStatus;
  payload?: PostPayload;
  textLength?: number;
  characterLimit?: number;
  validation?: ValidationResult;
  error?: string;
}

export async function composePreview(
  input: ComposePreviewInput,
  deps: { connectors: PluginConnectorResolver; provider: ContentProvider; logger: StructuredLogger },
): Promise<PlatformPreviewResult[]> {
  const generator = new CampaignGenerator(deps.provider, deps.logger);
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

  return Promise.all(
    input.platforms.map(async (target): Promise<PlatformPreviewResult> => {
      let connector;
      try {
        connector = deps.connectors.resolve(target.platformId);
      } catch (err) {
        return {
          platform: target.platformId,
          accountId: target.accountId,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        };
      }

      try {
        const generated = await generator.generateVariant(brief, {
          platform: target.platformId,
          accountId: target.accountId,
          capabilities: connector.capabilities,
        });
        // Merge per-target platformOptions (e.g. Reddit's `subreddit`) onto the
        // generated payload before validating, exactly like
        // `CampaignService.processTarget` does for a real submit (t14) — so a
        // live preview reflects the same accept/reject outcome a submit would.
        const payload = target.platformOptions
          ? { ...generated.payload, platformOptions: { ...generated.payload.platformOptions, ...target.platformOptions } }
          : generated.payload;
        const validation = await connector.validatePost(payload);
        return {
          platform: target.platformId,
          accountId: target.accountId,
          status: validation.ok ? 'ok' : 'rejected',
          payload,
          textLength: generated.textLength,
          characterLimit: connector.capabilities.characterLimit,
          validation,
        };
      } catch (err) {
        deps.logger.error('preview.generate_failed', {
          platform: target.platformId,
          accountId: target.accountId,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          platform: target.platformId,
          accountId: target.accountId,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}
