/**
 * Per-platform voice/style profiles: tone guidance and formatting habits that
 * turn one content brief into copy that reads as native to each platform.
 *
 * These are generation-time *style* defaults, distinct from — and always
 * subordinate to — the numeric limits in a connector's `CapabilityDescriptor`
 * (`docs/PLATFORM-RULES.md` is the source of truth for the numbers; this file
 * only decides tone, emoji/hashtag/CTA habits, and whether a title exists).
 * `CampaignGenerator` always clamps against the passed-in `CapabilityDescriptor`
 * regardless of what's declared here, so a profile below for a platform with
 * no connector yet (x, tiktok, instagram, facebook, linkedin, ...) is safe to
 * use the moment that connector's descriptor exists — nothing here needs to
 * change.
 *
 * Profiles backed by a real connector today (checked against
 * `docs/PLATFORM-RULES.md`, 2026-07-04): `discord`, `bluesky`, `twitch`.
 * The rest are illustrative defaults for platforms named in the content-ai
 * brief (TikTok, X/Twitter, Instagram, Facebook, LinkedIn, ...) — adjust them
 * against that platform's own PLATFORM-RULES.md section once a connector
 * lands, per the `platform-content-rules` skill.
 */

export type CountUnit = 'utf16' | 'grapheme';
export type HashtagStyle = 'inline' | 'trailing' | 'channel-tags' | 'none';
export type EmojiAffinity = 'heavy' | 'light' | 'none';
export type CtaStyle = 'direct' | 'soft' | 'none';

export interface PlatformVoiceProfile {
  platform: string;
  /** Human-readable tone/format guidance fed into every generation task. */
  toneInstruction: string;
  /** Bluesky counts graphemes, not UTF-16 code units — see PLATFORM-RULES.md. */
  countUnit: CountUnit;
  usesHashtags: boolean;
  hashtagStyle: HashtagStyle;
  /** Used when the connector's `CapabilityDescriptor.maxHashtags` is undefined. */
  maxHashtagsDefault: number;
  usesEmoji: EmojiAffinity;
  ctaStyle: CtaStyle;
  /** Platform has a genuine title/headline field distinct from the body. */
  usesTitle: boolean;
  /** Platform has NO body field at all — the "title" text IS the whole post
   * (Twitch: `PostPayload.title`, falls back from `text`, is the only field). */
  titleOnly: boolean;
  /** Favor keyword-rich, search-friendly phrasing (YouTube, LinkedIn, blogs). */
  seoAware: boolean;
  /**
   * Platform rejects a post that carries BOTH a body text field and a
   * structured `link` field — the two are mutually exclusive (Reddit: a
   * submission is EITHER a self/text post OR a link post, never both; see
   * docs/PLATFORM-RULES.md § Reddit `self_and_link_mutually_exclusive`). When
   * true, `CampaignGenerator` weaves the link into the body text (a self post)
   * and does NOT populate the separate `PostPayload.link` field, so the
   * generated variant passes that connector's `validatePost`. Defaults to
   * false (the normal case: the link travels as its own structured field). */
  textLinkMutuallyExclusive?: boolean;
}

const DEFAULT_PROFILE: PlatformVoiceProfile = {
  platform: 'default',
  toneInstruction:
    'Write clear, friendly, platform-neutral social copy. Keep sentences short and direct.',
  countUnit: 'utf16',
  usesHashtags: true,
  hashtagStyle: 'trailing',
  maxHashtagsDefault: 3,
  usesEmoji: 'light',
  ctaStyle: 'soft',
  usesTitle: false,
  titleOnly: false,
  seoAware: false,
};

const PROFILES: Record<string, PlatformVoiceProfile> = {
  discord: {
    platform: 'discord',
    toneInstruction:
      'Write a punchy Discord community announcement: casual, high-energy, gets to the point in the first line, ends with a clear link/CTA. Hashtags render as inert literal text on Discord, so do not invent hashtags.',
    countUnit: 'utf16',
    // Discord has no hashtag feature — inline '#tags' render as inert literal text
    // (docs/PLATFORM-RULES.md § Discord: `hashtags_cosmetic_only`). Don't fabricate them.
    usesHashtags: false,
    hashtagStyle: 'none',
    maxHashtagsDefault: 0,
    usesEmoji: 'light',
    ctaStyle: 'direct',
    usesTitle: false,
    titleOnly: false,
    seoAware: false,
  },
  bluesky: {
    platform: 'bluesky',
    toneInstruction:
      'Write a concise, conversational Bluesky post. Get the point across in one or two short sentences — the 300-character budget is tight.',
    countUnit: 'grapheme',
    usesHashtags: true,
    hashtagStyle: 'inline',
    maxHashtagsDefault: 2,
    usesEmoji: 'light',
    ctaStyle: 'soft',
    usesTitle: false,
    titleOnly: false,
    seoAware: false,
  },
  twitch: {
    platform: 'twitch',
    toneInstruction:
      'Write a stream title: short, punchy, and specific about what viewers will see right now. This is the ONLY text field — there is no separate post body.',
    countUnit: 'utf16',
    // Twitch "tags" are channel tags (strict charset), not inline hashtags.
    usesHashtags: true,
    hashtagStyle: 'channel-tags',
    maxHashtagsDefault: 5,
    usesEmoji: 'none',
    ctaStyle: 'none',
    usesTitle: true,
    titleOnly: true,
    seoAware: false,
  },
  x: {
    platform: 'x',
    toneInstruction:
      'Write a tight, high-signal X/Twitter post. One idea, active voice, no throat-clearing preamble.',
    countUnit: 'utf16',
    usesHashtags: true,
    hashtagStyle: 'inline',
    maxHashtagsDefault: 2,
    usesEmoji: 'light',
    ctaStyle: 'soft',
    usesTitle: false,
    titleOnly: false,
    seoAware: false,
  },
  threads: {
    platform: 'threads',
    toneInstruction: 'Write a casual, conversational Threads post — first-person, low-polish, inviting replies.',
    countUnit: 'utf16',
    usesHashtags: true,
    hashtagStyle: 'inline',
    maxHashtagsDefault: 2,
    usesEmoji: 'light',
    ctaStyle: 'soft',
    usesTitle: false,
    titleOnly: false,
    seoAware: false,
  },
  tiktok: {
    platform: 'tiktok',
    toneInstruction:
      'Write a POV-style TikTok caption: first-person, hooky first line, playful tone, liberal emoji use.',
    countUnit: 'utf16',
    usesHashtags: true,
    hashtagStyle: 'trailing',
    maxHashtagsDefault: 5,
    usesEmoji: 'heavy',
    ctaStyle: 'soft',
    usesTitle: false,
    titleOnly: false,
    seoAware: false,
  },
  instagram: {
    platform: 'instagram',
    toneInstruction:
      'Write an Instagram caption: warm, visual, a hook in the first line (it is the only part shown before "more"), heavy on hashtags at the end.',
    countUnit: 'utf16',
    usesHashtags: true,
    hashtagStyle: 'trailing',
    maxHashtagsDefault: 8,
    usesEmoji: 'heavy',
    ctaStyle: 'soft',
    usesTitle: false,
    titleOnly: false,
    seoAware: false,
  },
  facebook: {
    platform: 'facebook',
    toneInstruction:
      'Write a slightly longer, warm Facebook post — a sentence or two of context is welcome, conversational tone, light hashtag use.',
    countUnit: 'utf16',
    usesHashtags: true,
    hashtagStyle: 'trailing',
    maxHashtagsDefault: 2,
    usesEmoji: 'light',
    ctaStyle: 'soft',
    usesTitle: false,
    titleOnly: false,
    seoAware: false,
  },
  linkedin: {
    platform: 'linkedin',
    toneInstruction:
      'Write a professional LinkedIn post: value-first, no hype language, a brief takeaway, minimal emoji, hashtags only as 3-5 topical tags at the end.',
    countUnit: 'utf16',
    usesHashtags: true,
    hashtagStyle: 'trailing',
    maxHashtagsDefault: 4,
    usesEmoji: 'none',
    ctaStyle: 'direct',
    usesTitle: true,
    titleOnly: false,
    seoAware: true,
  },
  youtube: {
    platform: 'youtube',
    toneInstruction:
      'Write a search-friendly YouTube description: front-load the key terms viewers would search for, then a short human summary.',
    countUnit: 'utf16',
    usesHashtags: true,
    hashtagStyle: 'trailing',
    maxHashtagsDefault: 3,
    usesEmoji: 'none',
    ctaStyle: 'direct',
    usesTitle: true,
    titleOnly: false,
    seoAware: true,
  },
  reddit: {
    platform: 'reddit',
    toneInstruction:
      'Write a plain, community-appropriate Reddit title and body: no marketing language, no emoji, straightforward and specific.',
    countUnit: 'utf16',
    usesHashtags: false,
    hashtagStyle: 'none',
    maxHashtagsDefault: 0,
    usesEmoji: 'none',
    ctaStyle: 'none',
    usesTitle: true,
    titleOnly: false,
    seoAware: false,
    // A Reddit post is either a self (text) post or a link post, never both —
    // so the link is woven into the self-post body, not emitted as a separate
    // `link` field, or the connector rejects it (self_and_link_mutually_exclusive).
    textLinkMutuallyExclusive: true,
  },
  mastodon: {
    platform: 'mastodon',
    toneInstruction:
      'Write a warm, conversational Mastodon (fediverse) post: genuine and community-minded, one or two short sentences within the 500-character budget. A couple of trailing hashtags are fine; keep them minimal.',
    countUnit: 'utf16',
    usesHashtags: true,
    hashtagStyle: 'trailing',
    // Mastodon has no documented hard hashtag cap distinct from the character
    // limit (PLATFORM-RULES § Mastodon); keep it to the platform's light norm.
    maxHashtagsDefault: 2,
    usesEmoji: 'light',
    ctaStyle: 'soft',
    usesTitle: false,
    titleOnly: false,
    seoAware: false,
  },
};

/** Look up the voice profile for `platform`, falling back to a neutral default. */
export function voiceProfileFor(platform: string): PlatformVoiceProfile {
  return PROFILES[platform] ?? { ...DEFAULT_PROFILE, platform };
}
