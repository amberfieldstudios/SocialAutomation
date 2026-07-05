/**
 * Regression test for the t24 bug (m4 capstone follow-up): `CampaignGenerator`
 * must never hand back a Bluesky variant that its own truncation reports as
 * "within the 300-grapheme limit" but that FAILS once `BlueskyConnector`
 * actually assembles the post — i.e. `assembleText(text, tags, mentions)`
 * re-adding any hashtag/mention not found verbatim in `text`, pushing the
 * final grapheme count past `capabilities.characterLimit`.
 *
 * This exercises the EXACT scenario t18 had to work around (a Bluesky
 * variant with hashtags + a CTA + a link, near the character limit) against
 * the REAL `BlueskyConnector.validatePost` (pure, no network calls) — not a
 * re-implementation of its assembly logic — so a regression here can't hide
 * behind a stale copy of the algorithm.
 */
import { describe, expect, it } from 'vitest';
import { BlueskyConnector, capabilities as blueskyCapabilities } from '@social/plugin-bluesky';
import { CampaignGenerator } from '../src/campaignGenerator';
import { MockProvider } from '../src/mockProvider';
import { measureLength } from '../src/text';
import type { ContentBrief } from '../src/types';
import { testLogger } from './support';

function makeConnector(): BlueskyConnector {
  return new BlueskyConnector({ logger: testLogger(), now: () => new Date('2026-07-05T00:00:00.000Z') });
}

describe('CampaignGenerator x BlueskyConnector — generation/validation boundary (t24)', () => {
  it('a Bluesky variant with description + hashtags + CTA + link near the limit passes the REAL connector.validatePost', async () => {
    const generator = new CampaignGenerator(new MockProvider(), testLogger());
    const connector = makeConnector();

    // Deliberately near the 300-grapheme limit: a long description, seed
    // hashtags/mentions, a CTA intent, and a link — exactly the combination
    // t18 had to omit link/cta to work around.
    const brief: ContentBrief = {
      description:
        'We just shipped a huge new feature: real-time multiplayer racing across ten brand new tracks, available today for everyone who plays, right now, on every supported device and region worldwide.',
      link: 'https://example.com/racing-update-with-a-fairly-long-tracking-path',
      tags: ['racing', 'multiplayer'],
      mentions: ['alice', 'bob'],
      cta: 'Try it now',
      campaign: 'racing-launch',
    };

    const { payload, textLength } = await generator.generateVariant(brief, {
      platform: 'bluesky',
      accountId: 'acct-bsky',
      capabilities: blueskyCapabilities,
    });

    // CampaignGenerator's own report must be honest...
    expect(textLength).toBeLessThanOrEqual(blueskyCapabilities.characterLimit);
    expect(measureLength(payload.text ?? '', true)).toBeLessThanOrEqual(blueskyCapabilities.characterLimit);

    // ...AND the REAL connector — which independently re-assembles text from
    // payload.text + payload.tags + payload.mentions — must accept it too.
    const validation = await connector.validatePost(payload);
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  it('holds even with very tight seed content that maximizes hashtag/mention/link/CTA pressure', async () => {
    const generator = new CampaignGenerator(new MockProvider(), testLogger());
    const connector = makeConnector();

    const brief: ContentBrief = {
      description: 'Live now.',
      link: 'https://example.com/x',
      tags: ['a', 'b'],
      mentions: ['someverylonghandlelikelyname', 'anotherquitelonghandlename'],
      cta: 'Watch live',
    };

    const { payload } = await generator.generateVariant(brief, {
      platform: 'bluesky',
      accountId: 'acct-bsky-2',
      capabilities: blueskyCapabilities,
    });

    const validation = await connector.validatePost(payload);
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);
  });
});
