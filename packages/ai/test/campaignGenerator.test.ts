import { describe, expect, it } from 'vitest';
import { CampaignGenerator } from '../src/campaignGenerator';
import { MockProvider } from '../src/mockProvider';
import { measureLength } from '../src/text';
import type { ContentBrief } from '../src/types';
import { testLogger } from './support';
import {
  blueskyCapabilities,
  discordCapabilities,
  mastodonCapabilities,
  redditCapabilities,
  syntheticInstagramCapabilities,
  syntheticXCapabilities,
  twitchCapabilities,
} from './fixtures';

const brief: ContentBrief = {
  description:
    'We just shipped a huge new feature: real-time multiplayer racing across ten new tracks, available today for everyone.',
  link: 'https://example.com/racing-update',
  tags: ['racing', 'multiplayer'],
  mentions: ['alice', 'bob'],
  cta: 'Try it now',
  campaign: 'racing-launch',
};

function makeGenerator() {
  return new CampaignGenerator(new MockProvider(), testLogger());
}

describe('CampaignGenerator.generateVariant — one description, per-platform variants', () => {
  it('generates a Discord variant within the character limit, no fabricated hashtags', async () => {
    const generator = makeGenerator();
    const { payload, textLength } = await generator.generateVariant(brief, {
      platform: 'discord',
      accountId: 'acct-discord',
      capabilities: discordCapabilities,
    });

    expect(payload.platform).toBe('discord');
    expect(payload.text).toBeDefined();
    expect(textLength).toBeLessThanOrEqual(discordCapabilities.characterLimit);
    expect(measureLength(payload.text ?? '')).toBeLessThanOrEqual(discordCapabilities.characterLimit);
    // Discord has no hashtag feature — content-ai must not fabricate tags.
    expect(payload.tags).toBeUndefined();
  });

  it('generates a Bluesky variant within the 300-grapheme limit', async () => {
    const generator = makeGenerator();
    const { payload, textLength } = await generator.generateVariant(brief, {
      platform: 'bluesky',
      accountId: 'acct-bsky',
      capabilities: blueskyCapabilities,
    });

    expect(payload.text).toBeDefined();
    expect(textLength).toBeLessThanOrEqual(blueskyCapabilities.characterLimit);
    expect(measureLength(payload.text ?? '', true)).toBeLessThanOrEqual(blueskyCapabilities.characterLimit);
    // Bluesky has no separate title field.
    expect(payload.title).toBeUndefined();
  });

  it('generates a Twitch variant as a title-only payload, respecting maxHashtags and maxMentions', async () => {
    const generator = makeGenerator();
    const { payload } = await generator.generateVariant(brief, {
      platform: 'twitch',
      accountId: 'acct-twitch',
      capabilities: twitchCapabilities,
    });

    expect(payload.title).toBeDefined();
    expect(payload.title!.length).toBeLessThanOrEqual(twitchCapabilities.characterLimit);
    // Twitch has no body — only the title field is used.
    expect(payload.text).toBeUndefined();
    // maxMentions: 0 — mentions must never be set for Twitch.
    expect(payload.mentions).toBeUndefined();
    // Tags conform to Twitch's strict channel-tag charset and count cap.
    expect(payload.tags).toBeDefined();
    expect(payload.tags!.length).toBeLessThanOrEqual(twitchCapabilities.maxHashtags!);
    for (const tag of payload.tags ?? []) {
      expect(tag).toMatch(/^[A-Za-z0-9][A-Za-z0-9_]*$/);
      expect(tag.length).toBeLessThanOrEqual(25);
    }
  });

  it('generates a variant for a platform with NO connector yet, from just a CapabilityDescriptor (X)', async () => {
    const generator = makeGenerator();
    const { payload } = await generator.generateVariant(brief, {
      platform: 'x',
      accountId: 'acct-x',
      capabilities: syntheticXCapabilities,
    });

    expect(payload.text).toBeDefined();
    expect(payload.text!.length).toBeLessThanOrEqual(syntheticXCapabilities.characterLimit);
    expect(payload.tags!.length).toBeLessThanOrEqual(syntheticXCapabilities.maxHashtags!);
  });

  it('respects a large hashtag cap (Instagram-style trailing block) without exceeding the character limit', async () => {
    const generator = makeGenerator();
    const { payload } = await generator.generateVariant(brief, {
      platform: 'instagram',
      accountId: 'acct-ig',
      capabilities: syntheticInstagramCapabilities,
    });

    expect(payload.text!.length).toBeLessThanOrEqual(syntheticInstagramCapabilities.characterLimit);
    expect(payload.tags!.length).toBeGreaterThan(0);
    expect(payload.tags!.length).toBeLessThanOrEqual(syntheticInstagramCapabilities.maxHashtags!);
  });

  it('generates a Mastodon variant within the 500-char budget, trailing hashtags kept minimal', async () => {
    const generator = makeGenerator();
    const { payload } = await generator.generateVariant(brief, {
      platform: 'mastodon',
      accountId: 'acct-masto',
      capabilities: mastodonCapabilities,
    });

    expect(payload.text).toBeDefined();
    // Mastodon counts every URL as a fixed 23 chars, so the raw length is a
    // conservative upper bound; asserting the raw length stays within the limit
    // guarantees the counted length does too.
    expect(measureLength(payload.text ?? '')).toBeLessThanOrEqual(mastodonCapabilities.characterLimit);
    expect(payload.title).toBeUndefined();
    // Fediverse norm: keep hashtags light.
    expect((payload.tags ?? []).length).toBeLessThanOrEqual(2);
    // Link survives verbatim in the body.
    expect(payload.text ?? '').toContain(brief.link!);
  });

  it('generates a Reddit variant as a self-post: title + body, NO separate link field', async () => {
    const generator = makeGenerator();
    const { payload } = await generator.generateVariant(brief, {
      platform: 'reddit',
      accountId: 'acct-reddit',
      capabilities: redditCapabilities,
    });

    // Title is a required, distinct field on Reddit (<= 300 chars, non-blank).
    expect(payload.title).toBeDefined();
    expect(payload.title!.trim().length).toBeGreaterThan(0);
    expect(payload.title!.length).toBeLessThanOrEqual(redditCapabilities.titleCharacterLimit!);
    // Body present and within the self-post cap.
    expect(payload.text).toBeDefined();
    expect(payload.text!.length).toBeLessThanOrEqual(redditCapabilities.characterLimit);
    // CRITICAL: a Reddit post is either a self post OR a link post, never both —
    // the link must live in the body, not the structured `link` field, or the
    // connector's validatePost rejects it (self_and_link_mutually_exclusive).
    expect(payload.link).toBeUndefined();
    expect(payload.text ?? '').toContain(brief.link!);
    // Reddit has no hashtag feature — none should be fabricated.
    expect(payload.tags).toBeUndefined();
  });

  it('generateCampaign fans a brief out to one variant per target platform', async () => {
    const generator = makeGenerator();
    const variants = await generator.generateCampaign(brief, [
      { platform: 'discord', accountId: 'a1', capabilities: discordCapabilities },
      { platform: 'bluesky', accountId: 'a2', capabilities: blueskyCapabilities },
      { platform: 'twitch', accountId: 'a3', capabilities: twitchCapabilities },
    ]);

    expect(variants).toHaveLength(3);
    expect(variants.map((v) => v.payload.platform)).toEqual(['discord', 'bluesky', 'twitch']);
  });
});

describe('CampaignGenerator rewrite/shorten/expand on an existing variant', () => {
  it('shorten() reduces length and stays under the limit', async () => {
    const generator = makeGenerator();
    const { payload } = await generator.generateVariant(brief, {
      platform: 'discord',
      accountId: 'acct-discord',
      capabilities: discordCapabilities,
    });
    const originalLength = measureLength(payload.text ?? '');

    const shortened = await generator.shorten(payload, discordCapabilities, 40);
    const shortenedLength = measureLength(shortened.text ?? '');

    expect(shortenedLength).toBeLessThan(originalLength);
    expect(shortenedLength).toBeLessThanOrEqual(discordCapabilities.characterLimit);
  });

  it('expand() grows length without exceeding the limit', async () => {
    const generator = makeGenerator();
    const { payload } = await generator.generateVariant(
      { description: 'Live now.' },
      { platform: 'discord', accountId: 'acct-discord', capabilities: discordCapabilities },
    );
    const originalLength = measureLength(payload.text ?? '');

    const expanded = await generator.expand(payload, discordCapabilities, originalLength + 60);
    const expandedLength = measureLength(expanded.text ?? '');

    expect(expandedLength).toBeGreaterThan(originalLength);
    expect(expandedLength).toBeLessThanOrEqual(discordCapabilities.characterLimit);
  });

  it('rewrite() stays within the platform limit', async () => {
    const generator = makeGenerator();
    const { payload } = await generator.generateVariant(brief, {
      platform: 'bluesky',
      accountId: 'acct-bsky',
      capabilities: blueskyCapabilities,
    });

    const rewritten = await generator.rewrite(payload, blueskyCapabilities);
    expect(measureLength(rewritten.text ?? '', true)).toBeLessThanOrEqual(blueskyCapabilities.characterLimit);
  });

  it('shorten() on a Twitch (title-only) variant transforms the title field', async () => {
    const generator = makeGenerator();
    const { payload } = await generator.generateVariant(brief, {
      platform: 'twitch',
      accountId: 'acct-twitch',
      capabilities: twitchCapabilities,
    });
    const originalLength = payload.title!.length;

    const shortened = await generator.shorten(payload, twitchCapabilities, 20);
    expect(shortened.title!.length).toBeLessThan(originalLength);
    expect(shortened.title!.length).toBeLessThanOrEqual(twitchCapabilities.characterLimit);
    expect(shortened.text).toBeUndefined();
  });
});
