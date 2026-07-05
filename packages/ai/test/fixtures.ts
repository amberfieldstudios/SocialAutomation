import type { CapabilityDescriptor } from '@social/core';

/**
 * Test-local `CapabilityDescriptor` fixtures mirroring the real values
 * recorded in docs/PLATFORM-RULES.md and each plugin's capabilities.ts —
 * duplicated here (not imported from the plugin packages) so @social/ai's
 * tests don't take a dependency on connector packages. Numbers must stay in
 * sync with PLATFORM-RULES.md if it changes.
 */

const baseOperations = {
  connect: true,
  authenticate: true,
  refreshToken: true,
  validatePost: true,
  uploadMedia: true,
  publish: true,
  delete: true,
  edit: true,
  getAnalytics: true,
  disconnect: true,
};

export const discordCapabilities: CapabilityDescriptor = {
  platform: 'discord',
  displayName: 'Discord',
  apiBaseUrl: 'https://discord.com/api/v10',
  contractVersion: '1.0.0',
  operations: { ...baseOperations, getAnalytics: false },
  supportsEdit: true,
  supportsDelete: true,
  supportsScheduling: false,
  supportsThreads: true,
  supportsAnalytics: false,
  supportsMediaUpload: true,
  characterLimit: 2000,
  titleCharacterLimit: 256,
  altTextCharacterLimit: 1024,
  urlsCountTowardLimit: true,
  maxMediaCount: 10,
  supportedMediaTypes: ['image', 'video', 'gif', 'audio', 'document'],
  mediaConstraints: [],
  rateLimit: { requestsPerWindow: 5, windowMs: 5_000, scope: 'account' },
};

export const blueskyCapabilities: CapabilityDescriptor = {
  platform: 'bluesky',
  displayName: 'Bluesky',
  apiBaseUrl: 'https://bsky.social',
  contractVersion: '1.0.0',
  operations: { ...baseOperations, edit: false },
  supportsEdit: false,
  supportsDelete: true,
  supportsScheduling: false,
  supportsThreads: true,
  supportsAnalytics: true,
  supportsMediaUpload: true,
  characterLimit: 300, // graphemes
  altTextCharacterLimit: 1000,
  urlsCountTowardLimit: true,
  maxMediaCount: 4,
  supportedMediaTypes: ['image', 'video'],
  mediaConstraints: [],
  maxThreadLength: 25,
  rateLimit: { requestsPerWindow: 1500, windowMs: 60 * 60 * 1000, scope: 'account' },
};

export const twitchCapabilities: CapabilityDescriptor = {
  platform: 'twitch',
  displayName: 'Twitch',
  apiBaseUrl: 'https://api.twitch.tv/helix',
  contractVersion: '1.0.0',
  operations: { ...baseOperations, uploadMedia: false, delete: false },
  supportsEdit: true,
  supportsDelete: false,
  supportsScheduling: false,
  supportsThreads: false,
  supportsAnalytics: true,
  supportsMediaUpload: false,
  characterLimit: 140,
  titleCharacterLimit: 140,
  urlsCountTowardLimit: true,
  maxHashtags: 10,
  maxMentions: 0,
  maxMediaCount: 0,
  supportedMediaTypes: [],
  mediaConstraints: [],
  rateLimit: { requestsPerWindow: 800, windowMs: 60_000, scope: 'account' },
};

/**
 * Synthetic descriptor for a platform with NO connector in this repo yet
 * (X/Twitter) — proves `@social/ai` generates correctly-clamped copy for any
 * `CapabilityDescriptor` handed to it, not just the three platforms that
 * happen to have plugins today.
 */
export const syntheticXCapabilities: CapabilityDescriptor = {
  platform: 'x',
  displayName: 'X (synthetic test fixture)',
  apiBaseUrl: 'https://api.x.example/2',
  contractVersion: '1.0.0',
  operations: baseOperations,
  supportsEdit: false,
  supportsDelete: true,
  supportsScheduling: false,
  supportsThreads: true,
  supportsAnalytics: true,
  supportsMediaUpload: true,
  characterLimit: 280,
  urlsCountTowardLimit: true,
  maxHashtags: 3,
  maxMediaCount: 4,
  supportedMediaTypes: ['image', 'video', 'gif'],
  mediaConstraints: [],
};

/**
 * Reddit descriptor — mirrors `plugins/reddit/src/capabilities.ts`. Title is a
 * distinct, required field (300 chars); the body cap is 40,000; a post is
 * EITHER a self (text) post OR a link post, never both.
 */
export const redditCapabilities: CapabilityDescriptor = {
  platform: 'reddit',
  displayName: 'Reddit',
  apiBaseUrl: 'https://oauth.reddit.com',
  contractVersion: '1.1.0',
  operations: { ...baseOperations, uploadMedia: false },
  supportsEdit: true,
  supportsDelete: true,
  supportsScheduling: false,
  supportsThreads: false,
  supportsAnalytics: true,
  supportsMediaUpload: false,
  characterLimit: 40_000, // self-post body cap
  titleCharacterLimit: 300,
  urlsCountTowardLimit: true,
  maxHashtags: 0,
  maxMediaCount: 0,
  supportedMediaTypes: [],
  mediaConstraints: [],
};

/** Mastodon descriptor — mirrors `plugins/mastodon/src/capabilities.ts` (stock defaults). */
export const mastodonCapabilities: CapabilityDescriptor = {
  platform: 'mastodon',
  displayName: 'Mastodon',
  apiBaseUrl: 'https://mastodon.social',
  contractVersion: '1.1.0',
  operations: baseOperations,
  supportsEdit: true,
  supportsDelete: true,
  supportsScheduling: true,
  supportsThreads: true,
  supportsAnalytics: true,
  supportsMediaUpload: true,
  characterLimit: 500,
  urlsCountTowardLimit: true,
  countedUrlLength: 23, // every URL counts as a fixed 23 chars
  maxHashtags: undefined,
  maxMentions: undefined,
  altTextCharacterLimit: 1500,
  maxMediaCount: 4,
  supportedMediaTypes: ['image', 'video', 'gif', 'audio'],
  mediaConstraints: [],
  maxThreadLength: 25,
};

/** Synthetic descriptor for Instagram, to exercise the trailing-hashtag-block style. */
export const syntheticInstagramCapabilities: CapabilityDescriptor = {
  platform: 'instagram',
  displayName: 'Instagram (synthetic test fixture)',
  apiBaseUrl: 'https://graph.instagram.example',
  contractVersion: '1.0.0',
  operations: baseOperations,
  supportsEdit: true,
  supportsDelete: true,
  supportsScheduling: false,
  supportsThreads: false,
  supportsAnalytics: true,
  supportsMediaUpload: true,
  characterLimit: 2200,
  urlsCountTowardLimit: true,
  maxHashtags: 30,
  maxMediaCount: 10,
  supportedMediaTypes: ['image', 'video'],
  mediaConstraints: [],
};
