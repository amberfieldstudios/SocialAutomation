/**
 * Mastodon capability descriptor.
 *
 * Every numeric limit below is sourced from the official Mastodon API docs
 * (checked 2026-07-04) — mirrored in docs/PLATFORM-RULES.md § "Mastodon",
 * which generation code and this descriptor must stay in sync with:
 *
 *  - `POST/PUT /api/v1/statuses`: text, media_ids[], spoiler_text, visibility
 *    (public/unlisted/private/direct), language, in_reply_to_id, sensitive.
 *    https://docs.joinmastodon.org/methods/statuses/
 *  - Instance configuration defaults (`GET /api/v2/instance` →
 *    `configuration.statuses`/`configuration.media_attachments`), as
 *    documented at https://docs.joinmastodon.org/entities/Instance/ :
 *      statuses.max_characters = 500
 *      statuses.max_media_attachments = 4
 *      statuses.characters_reserved_per_url = 23
 *      media_attachments.image_size_limit = 16,777,216 bytes
 *      media_attachments.video_size_limit = 103,809,024 bytes
 *      media_attachments.video_frame_rate_limit = 120 fps
 *    These are the documented DEFAULTS on a stock instance (e.g.
 *    mastodon.social) — individual instances may configure different limits.
 *    Because `validatePost` is pure/no-network per the contract, this
 *    connector cannot special-case a specific instance's live config; it
 *    enforces the documented defaults as a safe floor. See README.md
 *    "Known limitation: per-instance limits".
 *  - `POST /api/v2/media`: accepts image/*, video/*, audio/* per the
 *    instance's `configuration.media_attachments.supported_mime_types`; we
 *    allow-list the common, broadly-supported set documented at
 *    https://docs.joinmastodon.org/methods/media/ and
 *    https://docs.joinmastodon.org/entities/Instance/#media_attachments.
 *  - `PUT /api/v1/statuses/:id` (edit) and `DELETE /api/v1/statuses/:id`
 *    (delete) are both documented, first-class official endpoints.
 *  - `GET /api/v1/statuses/:id` returns `favourites_count`/`reblogs_count`/
 *    `replies_count`; `GET /api/v1/accounts/:id` returns `followers_count`.
 *    No impressions/reach/views/clicks/saves exist in the public API, so
 *    those canonical metrics are never populated (see connector.ts).
 *  - OAuth2 authorization-code flow (`GET /oauth/authorize`,
 *    `POST /oauth/token`) per-instance, after one-time app registration via
 *    `POST /api/v1/apps`. `POST /oauth/revoke` is the documented disconnect
 *    endpoint. https://docs.joinmastodon.org/methods/oauth/
 *  - Rate limits: documented as a 300 requests / 5 minute default bucket per
 *    access token (https://docs.joinmastodon.org/api/rate-limits/); some
 *    instances configure their own values, so this is an advisory hint only —
 *    the connector always honors a live 429 regardless of this number.
 */

import type { CapabilityDescriptor } from '@social/core';

export const capabilities: CapabilityDescriptor = {
  platform: 'mastodon',
  displayName: 'Mastodon',
  // Mastodon has no single central API host — every account lives on its own
  // instance. This is the reference/default instance used only when a caller
  // doesn't yet know the account's instance; every real call targets
  // `AppCredentials.extra.instanceUrl` instead (see connector.ts / README.md).
  apiBaseUrl: 'https://mastodon.social',
  contractVersion: '1.1.0',

  operations: {
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
  },

  supportsEdit: true,
  supportsDelete: true,
  supportsScheduling: true,
  supportsThreads: true,
  supportsAnalytics: true,
  supportsMediaUpload: true,

  characterLimit: 500, // configuration.statuses.max_characters documented default
  urlsCountTowardLimit: true, // URLs count toward the character limit, but...
  countedUrlLength: 23, // ...every URL is counted as a fixed 23 chars regardless of actual length
  maxHashtags: undefined, // no documented hard cap distinct from the character limit
  maxMentions: undefined,
  altTextCharacterLimit: 1500, // documented `description` field practical cap (matches Mastodon web UI)

  maxMediaCount: 4, // configuration.statuses.max_media_attachments documented default
  supportedMediaTypes: ['image', 'video', 'gif', 'audio'],
  // POST /api/v2/media genuinely stages bytes and returns a durable
  // `id` usable in a LATER POST/PUT /api/v1/statuses call — the textbook
  // 'staged' case.
  mediaUploadMode: 'staged',
  mediaConstraints: [
    {
      type: 'image',
      mimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif', 'image/avif'],
      maxBytes: 16_777_216, // media_attachments.image_size_limit documented default
    },
    {
      type: 'gif',
      mimeTypes: ['image/gif'],
      maxBytes: 103_809_024, // animated GIFs are transcoded server-side under the video pipeline/limit
    },
    {
      type: 'video',
      mimeTypes: ['video/mp4', 'video/quicktime', 'video/webm', 'video/ogg'],
      maxBytes: 103_809_024, // media_attachments.video_size_limit documented default
      maxFrameRate: 120, // media_attachments.video_frame_rate_limit documented default
    },
    {
      type: 'audio',
      mimeTypes: ['audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/flac', 'audio/aac', 'audio/x-m4a'],
      maxBytes: 103_809_024,
    },
  ],

  maxThreadLength: 25, // advisory ceiling to bound sequential status-create calls per publish

  nativeScheduleHorizonDays: undefined, // scheduled_at has no documented max horizon (min 5 minutes ahead)
  rateLimit: {
    requestsPerWindow: 300,
    windowMs: 5 * 60 * 1000,
    scope: 'account',
  },
};
