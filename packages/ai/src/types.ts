/**
 * Shared types for the `@social/ai` content-generation stage.
 *
 * Nothing here imports a concrete provider (mock or Claude) so both can depend
 * on this module without a cycle.
 */

/**
 * A single content brief: the ONE input an author supplies. Everything the
 * pipeline generates (per-platform `PostPayload`s) is derived from this.
 */
export interface ContentBrief {
  /** The core message — what the post is about. Required. */
  description: string;
  /** Optional author-supplied title/headline; used verbatim where a platform
   * has a title field and no AI-generated title is warranted (see
   * `PlatformVoiceProfile.usesTitle`). */
  title?: string;
  /** A link to attach/mention (already shortened/UTM-tagged upstream by
   * `@social/analytics` — this package does not shorten or rewrite URLs). */
  link?: string;
  /** Seed hashtags/keywords (WITHOUT '#') the author wants considered. */
  tags?: string[];
  /** Seed mentions (WITHOUT '@') the author wants considered. */
  mentions?: string[];
  /** Free-text campaign name, echoed into generation instructions for tone
   * continuity across a multi-post campaign. */
  campaign?: string;
  /** Desired call-to-action intent, e.g. "drive signups", "watch the VOD". */
  cta?: string;
  /** Keywords search-visibility should favor (YouTube/LinkedIn/blog-style
   * platforms only; ignored by profiles with `seoAware: false`). */
  seoKeywords?: string[];
  /** BCP-47 language tag; defaults to the provider's own default (English). */
  language?: string;
}

/** The four primitives every `ContentProvider` implements. */
export type ContentTaskKind = 'body' | 'title' | 'hashtags' | 'cta' | 'emoji';

/**
 * One unit of work handed to a `ContentProvider`. Deliberately plain data
 * (no platform-profile object) so a provider implementation never needs to
 * import `platformProfiles.ts` — all tone/style guidance is pre-baked into
 * `toneInstruction` by the caller (normally `CampaignGenerator`).
 */
export interface ContentGenerationTask {
  kind: ContentTaskKind;
  platform: string;
  brief: ContentBrief;
  /** Pre-built natural-language guidance on voice/tone/format for this platform. */
  toneInstruction: string;
  /** Existing text to transform — required for rewrite/shorten/expand and for
   * the 'cta' and 'emoji' kinds (which operate on an already-generated body). */
  sourceText?: string;
  /** Soft target length (in the unit `countGraphemes` selects). Advisory. */
  targetLength?: number;
  /** Hard ceiling the provider must not exceed. `CampaignGenerator` also
   * enforces this after the call as a safety net — never trust a provider's
   * self-reported length. */
  maxLength: number;
  /** Count Unicode grapheme clusters instead of UTF-16 code units (Bluesky). */
  countGraphemes?: boolean;
  /** Max number of hashtags to return, for `kind: 'hashtags'`. */
  maxHashtags?: number;
  /** SEO keywords to favor, for 'title'/'body' kinds on SEO-aware platforms. */
  seoKeywords?: string[];
}

/**
 * The generate/rewrite/shorten/expand primitives every content provider
 * (real or mock) implements. Every method returns plain text — hashtag
 * generation, emoji placement, CTA and title generation, and SEO phrasing
 * are all expressed as `generate`/`rewrite` calls with a specific `kind` and
 * `toneInstruction`, not as separate methods, so the provider surface stays
 * exactly these four operations.
 */
export interface ContentProvider {
  /** Stable id for logging, e.g. 'mock', 'claude'. */
  readonly name: string;
  /** Produce new text from scratch (task.sourceText is ignored). */
  generate(task: ContentGenerationTask): Promise<string>;
  /** Rewrite `task.sourceText` to a different tone/wording, same meaning. */
  rewrite(task: ContentGenerationTask): Promise<string>;
  /** Shorten `task.sourceText` toward `task.targetLength`/`task.maxLength`. */
  shorten(task: ContentGenerationTask): Promise<string>;
  /** Expand `task.sourceText` toward `task.targetLength`, up to `task.maxLength`. */
  expand(task: ContentGenerationTask): Promise<string>;
}
