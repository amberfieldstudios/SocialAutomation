/**
 * Twitch capability descriptor.
 *
 * Twitch's Helix API is not a "post" network: there is no per-post create/edit/
 * delete/analytics primitive. Every number and mapping below is sourced from
 * Twitch's official Helix API reference (checked 2026-07-04):
 *
 *  - Modify Channel Information: https://dev.twitch.tv/docs/api/reference/#modify-channel-information
 *  - Get Channel Information:    https://dev.twitch.tv/docs/api/reference/#get-channel-information
 *  - Get Streams:                https://dev.twitch.tv/docs/api/reference/#get-streams
 *  - Get Channel Followers:      https://dev.twitch.tv/docs/api/reference/#get-channel-followers
 *  - OAuth token endpoints:      https://dev.twitch.tv/docs/authentication/
 *  - Rate limits (Helix):        https://dev.twitch.tv/docs/api/guide/#twitch-rate-limits
 *
 * See plugins/twitch/README.md for the full method-by-method mapping rationale.
 */

import type { CapabilityDescriptor } from '@social/core';

export const TWITCH_TITLE_CHARACTER_LIMIT = 140;
export const TWITCH_MAX_TAGS = 10;
export const TWITCH_TAG_MAX_LENGTH = 25;

export const capabilities: CapabilityDescriptor = {
  platform: 'twitch',
  displayName: 'Twitch',
  apiBaseUrl: 'https://api.twitch.tv/helix',
  contractVersion: '1.1.0',

  operations: {
    connect: true,
    authenticate: true,
    refreshToken: true,
    validatePost: true,
    // No official Helix endpoint accepts arbitrary post-media (image/video)
    // uploads for channel content. Clips/screenshots are derived server-side
    // from an already-live stream, not uploaded by a client. Declared
    // unsupported; see README "Capability mapping" table.
    uploadMedia: false,
    // "publish" maps to Modify Channel Information (title/category/tags).
    publish: true,
    // There is no delete primitive for channel information — it can only be
    // overwritten, never removed. Declared unsupported.
    delete: false,
    // "edit" re-applies Modify Channel Information against the same
    // (singleton) channel resource.
    edit: true,
    // Maps to Get Streams (live viewer count) + Get Channel Followers (total
    // follower count) for the channel identified by AnalyticsQuery.remoteId.
    getAnalytics: true,
    disconnect: true,
  },

  supportsEdit: true,
  supportsDelete: false,
  // Twitch has no native "schedule this channel update for later" API.
  supportsScheduling: false,
  // No thread concept.
  supportsThreads: false,
  supportsAnalytics: true,
  supportsMediaUpload: false,

  // Modify Channel Information: "title" must not be blank and cannot exceed
  // 140 characters.
  characterLimit: TWITCH_TITLE_CHARACTER_LIMIT,
  titleCharacterLimit: TWITCH_TITLE_CHARACTER_LIMIT,
  altTextCharacterLimit: undefined,
  urlsCountTowardLimit: true,
  countedUrlLength: undefined,
  // Modify Channel Information: tags is an array of up to 10 strings.
  maxHashtags: TWITCH_MAX_TAGS,
  maxMentions: 0,

  maxMediaCount: 0,
  supportedMediaTypes: [],
  mediaConstraints: [],
  // uploadMedia is unsupported (see `operations.uploadMedia` above); this
  // value is inert but required for a uniform descriptor shape.
  mediaUploadMode: 'staged',

  maxThreadLength: undefined,

  nativeScheduleHorizonDays: undefined,
  // Helix default app rate limit bucket: 800 points/minute per access token
  // (most GET/PATCH calls cost 1 point). See "Twitch rate limits" guide.
  rateLimit: {
    requestsPerWindow: 800,
    windowMs: 60_000,
    scope: 'account',
  },
};
