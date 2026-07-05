/**
 * Bluesky / AT Protocol capability descriptor.
 *
 * Every numeric limit below is sourced from the official AT Protocol lexicons
 * and docs.bsky.app (checked 2026-07-04) — mirrored in docs/PLATFORM-RULES.md,
 * which generation code and this descriptor must stay in sync with:
 *
 *  - `app.bsky.feed.post` text: maxGraphemes 300, maxLength 3000 (UTF-8 bytes)
 *    https://raw.githubusercontent.com/bluesky-social/atproto/main/lexicons/app/bsky/feed/post.json
 *  - `app.bsky.embed.images`: maxLength 4 images, image/* accepted
 *    https://raw.githubusercontent.com/bluesky-social/atproto/main/lexicons/app/bsky/embed/images.json
 *  - `com.atproto.repo.uploadBlob` image blob size: we enforce the historical,
 *    still-conservative 1,000,000 byte (976.5 KiB) PDS limit documented at
 *    https://docs.bsky.app/docs/advanced-guides/posts (some PDS instances now
 *    allow up to 2,000,000 bytes per the images lexicon comment, but we stay
 *    at the documented-safe floor so posts never bounce on a stricter PDS).
 *  - `app.bsky.embed.video`: video/mp4, maxSize 100,000,000 bytes, alt text
 *    maxGraphemes 1000 / maxLength 10000
 *    https://raw.githubusercontent.com/bluesky-social/atproto/main/lexicons/app/bsky/embed/video.json
 *  - Images and video are mutually exclusive per post (one `embed` field of
 *    either `app.bsky.embed.images` or `app.bsky.embed.video`).
 *  - Rate limits: XRPC write endpoints are metered by a documented points
 *    budget of 5,000 pts/hour and 35,000 pts/day per account
 *    (https://docs.bsky.app/docs/advanced-guides/rate-limits); createRecord
 *    costs 3 pts, so the conservative per-hour create budget is ~1,666. We use
 *    a rounder, safely-under number as the advisory hint.
 *  - Posts are immutable in the official API/app — there is no supported way
 *    to edit `app.bsky.feed.post` content once published, so `edit` is
 *    declared unsupported.
 *  - The public AppView (`app.bsky.feed.getPosts`) exposes engagement counts
 *    (like/repost/reply/quote) for any post but no impressions/reach/view
 *    counts, so `getAnalytics` is supported with a partial canonical-metric
 *    set (see connector.ts).
 */

import type { CapabilityDescriptor } from '@social/core';

export const capabilities: CapabilityDescriptor = {
  platform: 'bluesky',
  displayName: 'Bluesky',
  apiBaseUrl: 'https://bsky.social',
  contractVersion: '1.1.0',

  operations: {
    connect: true,
    authenticate: true,
    refreshToken: true,
    validatePost: true,
    uploadMedia: true,
    publish: true,
    delete: true,
    edit: false,
    getAnalytics: true,
    disconnect: true,
  },

  supportsEdit: false,
  supportsDelete: true,
  supportsScheduling: false,
  supportsThreads: true,
  supportsAnalytics: true,
  supportsMediaUpload: true,

  characterLimit: 300, // graphemes, per app.bsky.feed.post maxGraphemes
  urlsCountTowardLimit: true, // URLs count toward the 300-grapheme cap; no t.co-style unwrap credit
  countedUrlLength: undefined,
  maxHashtags: undefined,
  maxMentions: undefined,
  altTextCharacterLimit: 1000, // graphemes; shared image/video alt-text cap

  maxMediaCount: 4,
  supportedMediaTypes: ['image', 'video'],
  // `com.atproto.repo.uploadBlob` genuinely stages bytes and returns a durable
  // blob ref usable in a LATER createRecord call — the textbook 'staged' case.
  mediaUploadMode: 'staged',
  mediaConstraints: [
    {
      type: 'image',
      mimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      maxBytes: 1_000_000,
    },
    {
      type: 'video',
      mimeTypes: ['video/mp4'],
      maxBytes: 100_000_000,
      maxDurationMs: 3 * 60 * 1000, // documented client-side cap enforced by the official app
    },
  ],

  maxThreadLength: 25, // advisory ceiling to bound sequential createRecord calls per publish

  nativeScheduleHorizonDays: undefined,
  rateLimit: {
    requestsPerWindow: 1500,
    windowMs: 60 * 60 * 1000,
    scope: 'account',
  },
};
