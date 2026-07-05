/**
 * Turns one `ContentBrief` into one optimized `PostPayload` per target
 * platform, tuned to that platform's voice (see `platformProfiles.ts`) and
 * CRITICALLY clamped to that platform's `CapabilityDescriptor` (character
 * limit, hashtag/mention caps) so the result is built to pass that
 * connector's `validatePost` — per `docs/PLATFORM-RULES.md` and the pipeline
 * contract in `docs/ARCHITECTURE.md` § 5 ("generated to ~90% of hard caps").
 *
 * Also exposes rewrite/shorten/expand on an already-generated variant.
 */

import type { CapabilityDescriptor, PostPayload, StructuredLogger } from '@social/core';
import type { ContentBrief, ContentGenerationTask, ContentProvider, ContentTaskKind } from './types';
import { voiceProfileFor } from './platformProfiles';
import {
  appendWithinLimit,
  assembledExtrasFootprint,
  measureLength,
  sanitizeHashtags,
  sanitizeMentions,
  splitCandidates,
  truncateToLimit,
} from './text';

/** Fraction of a hard limit generation targets, leaving headroom for
 * appended hashtags/links/CTAs and for connector-side URL wrapping. */
const HEADROOM = 0.9;

export interface GenerationTarget {
  platform: string;
  accountId: string;
  capabilities: CapabilityDescriptor;
}

export interface GeneratedVariant {
  payload: PostPayload;
  /** Which optimization operations ran, in order, for this variant. */
  opsApplied: ContentTaskKind[];
  /** Measured length of the primary text field (grapheme-aware where the
   * platform requires it), for logging/telemetry. */
  textLength: number;
}

export class CampaignGenerator {
  constructor(
    private readonly provider: ContentProvider,
    private readonly logger: StructuredLogger,
  ) {}

  /** Generate one variant for one platform/account. */
  async generateVariant(brief: ContentBrief, target: GenerationTarget): Promise<GeneratedVariant> {
    const { platform, accountId, capabilities } = target;
    const profile = voiceProfileFor(platform);
    const countGraphemes = profile.countUnit === 'grapheme';
    const opsApplied: ContentTaskKind[] = [];

    const bodyLimit = capabilities.characterLimit;
    const _bodyTarget = Math.max(10, Math.floor(bodyLimit * HEADROOM));

    const baseTask = (overrides: Partial<ContentGenerationTask>): ContentGenerationTask => ({
      kind: 'body',
      platform,
      brief,
      toneInstruction: profile.toneInstruction,
      maxLength: bodyLimit,
      countGraphemes,
      ...overrides,
    });

    let text: string | undefined;
    let title: string | undefined;

    // Mentions — sanitized and capped, populated as structured data only.
    // Inline @mention rendering is connector-specific (e.g. Discord requires
    // numeric snowflake IDs the content brief doesn't have), so we never
    // splice a raw '@handle' into the body text here. Computed up front
    // (before any body text exists) because some connectors — Bluesky's
    // `assembleText` in particular — unconditionally append any mention not
    // already present verbatim in the assembled text; the body/CTA budget
    // below must reserve room for that append, not discover it afterward.
    let mentions: string[] | undefined;
    if (brief.mentions && brief.mentions.length > 0 && capabilities.maxMentions !== 0) {
      mentions = sanitizeMentions(brief.mentions, capabilities.maxMentions);
      if (mentions.length === 0) mentions = undefined;
    }

    // Hashtags — always populate `tags[]` (the canonical field a connector's
    // validatePost checks against `maxHashtags`); additionally splice into
    // the body text for platforms whose idiom is inline/trailing hashtags.
    // Generated up front (hashtag generation never depends on the body text)
    // so its footprint can be reserved from the body/CTA budget below,
    // instead of being spliced in only to have a later CTA/truncation step
    // silently cut it back off the end of `text`.
    let tags: string[] | undefined;
    let hashtagInlineText = '';
    let hashtagSeparator = ' ';
    if (profile.usesHashtags) {
      const maxHashtags = capabilities.maxHashtags ?? profile.maxHashtagsDefault;
      if (maxHashtags > 0) {
        const raw = await this.provider.generate(
          baseTask({ kind: 'hashtags', maxHashtags, maxLength: 200 }),
        );
        const strict = profile.hashtagStyle === 'channel-tags';
        tags = sanitizeHashtags(splitCandidates(raw), maxHashtags, {
          strict,
          maxLength: strict ? 25 : 40,
        });
        if (tags.length > 0) {
          opsApplied.push('hashtags');
          if (profile.hashtagStyle === 'inline' || profile.hashtagStyle === 'trailing') {
            hashtagInlineText = tags.map((t) => `#${t}`).join(' ');
            hashtagSeparator = profile.hashtagStyle === 'trailing' ? '\n\n' : ' ';
          }
        }
      }
    }

    if (profile.titleOnly) {
      // Twitch-shaped platforms: the "title" field IS the whole post.
      const titleLimit = capabilities.titleCharacterLimit ?? capabilities.characterLimit;
      const titleTarget = Math.max(5, Math.floor(titleLimit * HEADROOM));
      const raw = await this.provider.generate(
        baseTask({ kind: 'title', maxLength: titleLimit, targetLength: titleTarget }),
      );
      title = truncateToLimit(raw, titleLimit, countGraphemes);
      opsApplied.push('title');
    } else {
      // Reserve room, up front, for whatever a connector will append AFTER
      // generation that this function itself never inlines into `text`:
      // mentions (never spliced, see above) and — as a defensive fallback —
      // hashtags, in case there isn't enough room to splice them in later.
      // A connector like Bluesky's `assembleText` re-adds any tag/mention
      // missing from the final text verbatim, so the budget for body/link/
      // CTA generation MUST already exclude that space, or the connector's
      // re-add can push the assembled post past the character limit even
      // though this function's own truncation reported success.
      const mentionReserve =
        mentions && mentions.length > 0
          ? measureLength(`\n\n${mentions.map((m) => `@${m}`).join(' ')}`, countGraphemes)
          : 0;
      const hashtagReserve =
        hashtagInlineText.length > 0
          ? measureLength(`${hashtagSeparator}${hashtagInlineText}`, countGraphemes)
          : 0;
      // Budget available for body + emoji + link + CTA (hashtags spliced in after).
      const preHashtagLimit = Math.max(10, bodyLimit - mentionReserve - hashtagReserve);
      // Budget available once hashtags are spliced in, before the mention footer.
      const postHashtagLimit = Math.max(preHashtagLimit, bodyLimit - mentionReserve);
      const effectiveBodyTarget = Math.max(10, Math.floor(preHashtagLimit * HEADROOM));

      const raw = await this.provider.generate(baseTask({ kind: 'body', maxLength: preHashtagLimit, targetLength: effectiveBodyTarget }));
      text = truncateToLimit(raw, preHashtagLimit, countGraphemes);
      opsApplied.push('body');

      if (profile.usesEmoji !== 'none') {
        const withEmoji = await this.provider.rewrite(
          baseTask({ kind: 'emoji', sourceText: text, maxLength: preHashtagLimit, targetLength: effectiveBodyTarget }),
        );
        text = truncateToLimit(withEmoji, preHashtagLimit, countGraphemes);
        opsApplied.push('emoji');
      }

      if (brief.link) {
        text = appendWithinLimit(text, brief.link, preHashtagLimit, countGraphemes);
      }

      // Title field on platforms that have one distinct from the body
      // (LinkedIn/YouTube/Reddit): AI-generate for SEO-aware profiles, or use
      // the author's own title verbatim (still clamped to the limit).
      if (capabilities.titleCharacterLimit) {
        const titleLimit = capabilities.titleCharacterLimit;
        if (profile.usesTitle) {
          const titleTarget = Math.max(5, Math.floor(titleLimit * HEADROOM));
          const raw2 = await this.provider.generate(
            baseTask({
              kind: 'title',
              maxLength: titleLimit,
              targetLength: titleTarget,
              seoKeywords: profile.seoAware ? brief.seoKeywords : undefined,
            }),
          );
          title = truncateToLimit(raw2, titleLimit, countGraphemes);
          opsApplied.push('title');
        } else if (brief.title) {
          title = truncateToLimit(brief.title, titleLimit, countGraphemes);
        }
      } else if (brief.title) {
        title = brief.title;
      }

      // CTA — only for platforms/briefs that want one, only if there's budget left.
      if (profile.ctaStyle !== 'none' && (brief.cta || brief.link)) {
        const remaining = preHashtagLimit - measureLength(text, countGraphemes);
        if (remaining > 6) {
          const ctaRaw = await this.provider.generate(
            baseTask({ kind: 'cta', sourceText: text, maxLength: remaining }),
          );
          if (ctaRaw.trim().length > 0) {
            text = appendWithinLimit(text, ctaRaw.trim(), preHashtagLimit, countGraphemes);
            opsApplied.push('cta');
          }
        }
      }

      // Splice hashtags in LAST (after body/emoji/link/CTA are all settled)
      // so nothing after this point can truncate them back off — they are
      // guaranteed to survive verbatim in the final `text`, which is exactly
      // what lets a connector's idempotent re-add (checking `text.includes`)
      // find them already there and add nothing further.
      if (hashtagInlineText.length > 0) {
        text = appendWithinLimit(text, hashtagInlineText, postHashtagLimit, countGraphemes, hashtagSeparator);
      }

      // Final safety net: never trust upstream truncation math alone.
      text = truncateToLimit(text, postHashtagLimit, countGraphemes);
    }

    if (title !== undefined) {
      const titleLimit = capabilities.titleCharacterLimit ?? capabilities.characterLimit;
      title = truncateToLimit(title, titleLimit, countGraphemes);
    }

    // Bulletproof final check: regardless of the reservation math above,
    // confirm that whatever a connector's `assembleText`-style re-add would
    // still append to the FINAL `text` (any tag/mention that didn't survive
    // verbatim, e.g. because of an edge-case truncation) can never push the
    // assembled post over `bodyLimit`. If it would, drop the extra structured
    // entries (never fabricated, only omitted) rather than ship a variant
    // that reports success here but fails the connector's own `validatePost`.
    if (text !== undefined && (profile.usesHashtags || mentions)) {
      let guard = 0;
      let footprint = assembledExtrasFootprint(text, tags, mentions);
      while (measureLength(text + footprint, countGraphemes) > bodyLimit && guard < 64) {
        guard += 1;
        if (mentions && mentions.length > 0) {
          mentions = mentions.slice(0, -1);
          if (mentions.length === 0) mentions = undefined;
        } else if (tags && tags.length > 0) {
          tags = tags.slice(0, -1);
          if (tags.length === 0) tags = undefined;
        } else {
          text = truncateToLimit(text, Math.max(0, measureLength(text, countGraphemes) - 1), countGraphemes);
        }
        footprint = assembledExtrasFootprint(text, tags, mentions);
      }
    }

    const payload: PostPayload = {
      platform,
      accountId,
      ...(text !== undefined ? { text } : {}),
      ...(title !== undefined ? { title } : {}),
      // The structured `link` field is populated only for platforms that carry
      // it separately from the body. Skipped for title-only platforms (Twitch:
      // no body/link field) and for platforms where text and link are mutually
      // exclusive (Reddit: the link is already woven into the self-post body
      // above, and setting both fields would fail validatePost).
      ...(brief.link && !profile.titleOnly && !profile.textLinkMutuallyExclusive ? { link: brief.link } : {}),
      ...(tags && tags.length > 0 ? { tags } : {}),
      ...(mentions && mentions.length > 0 ? { mentions } : {}),
      ...(brief.language ? { language: brief.language } : {}),
    };

    const textLength = measureLength(text ?? title ?? '', countGraphemes);
    this.logger.info('ai.generate_variant', {
      platform,
      accountId,
      textLength,
      titleLength: title ? measureLength(title, countGraphemes) : undefined,
      hashtagCount: tags?.length ?? 0,
      mentionCount: mentions?.length ?? 0,
      opsApplied,
    });

    return { payload, opsApplied, textLength };
  }

  /** Generate one variant per target (fanned out across platforms/accounts). */
  async generateCampaign(brief: ContentBrief, targets: GenerationTarget[]): Promise<GeneratedVariant[]> {
    return Promise.all(targets.map((target) => this.generateVariant(brief, target)));
  }

  /** Rewrite an existing variant's primary text field to a different phrasing. */
  async rewrite(variant: PostPayload, capabilities: CapabilityDescriptor): Promise<PostPayload> {
    return this.transform(variant, capabilities, (provider, task) => provider.rewrite(task));
  }

  /** Shorten an existing variant's primary text field. Always strictly shorter
   * than the input (unless already at the minimum), and always within the limit. */
  async shorten(
    variant: PostPayload,
    capabilities: CapabilityDescriptor,
    targetLength?: number,
  ): Promise<PostPayload> {
    return this.transform(
      variant,
      capabilities,
      (provider, task) => provider.shorten(task),
      targetLength,
    );
  }

  /** Expand an existing variant's primary text field, never exceeding the limit. */
  async expand(
    variant: PostPayload,
    capabilities: CapabilityDescriptor,
    targetLength?: number,
  ): Promise<PostPayload> {
    return this.transform(
      variant,
      capabilities,
      (provider, task) => provider.expand(task),
      targetLength,
    );
  }

  private async transform(
    variant: PostPayload,
    capabilities: CapabilityDescriptor,
    op: (provider: ContentProvider, task: ContentGenerationTask) => Promise<string>,
    targetLength?: number,
  ): Promise<PostPayload> {
    const profile = voiceProfileFor(variant.platform);
    const countGraphemes = profile.countUnit === 'grapheme';
    const field = profile.titleOnly ? 'title' : 'text';
    const limit = field === 'title' ? capabilities.titleCharacterLimit ?? capabilities.characterLimit : capabilities.characterLimit;
    const source = (field === 'title' ? variant.title : variant.text) ?? '';

    const task: ContentGenerationTask = {
      kind: field === 'title' ? 'title' : 'body',
      platform: variant.platform,
      brief: { description: source },
      toneInstruction: profile.toneInstruction,
      sourceText: source,
      maxLength: limit,
      targetLength,
      countGraphemes,
    };

    const result = truncateToLimit(await op(this.provider, task), limit, countGraphemes);

    this.logger.info('ai.transform_variant', {
      platform: variant.platform,
      accountId: variant.accountId,
      field,
      beforeLength: measureLength(source, countGraphemes),
      afterLength: measureLength(result, countGraphemes),
    });

    return { ...variant, [field]: result };
  }
}
