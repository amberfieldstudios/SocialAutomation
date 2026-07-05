/**
 * Discord CapabilityDescriptor.
 *
 * Every numeric limit below is sourced from Discord's official developer docs
 * (checked 2026-07-04) and mirrored in docs/PLATFORM-RULES.md:
 *  - Message content: https://docs.discord.com/developers/resources/message
 *    ("content" field, up to 2000 characters; stable since the Message object
 *    was documented and unchanged as of this check).
 *  - Embed limits: https://docs.discord.com/developers/resources/message
 *    (title 256, description 4096, field.name 256, field.value 1024, up to 25
 *    fields, footer.text 2048, author.name 256, combined total across ALL
 *    embeds on a message <= 6000 characters). Max 10 embeds per message.
 *  - Attachment `description` (alt text): 1024 characters.
 *  - Attachments: up to 10 files per message. Base upload size 25 MiB per file
 *    for all apps (raised from 8 MiB in 2024); boosted guilds allow more, but
 *    we declare the guaranteed floor since boost level isn't known here.
 *  - Rate limits: https://docs.discord.com/developers/topics/rate-limits —
 *    global ceiling 50 requests/second per bot token; additionally each route
 *    (e.g. a channel's message-create route) has its own bucket, commonly
 *    ~5 requests / 5 seconds. We declare the more specific per-route figure
 *    since that's what a single channel/webhook actually hits first; the
 *    connector still parses live `X-RateLimit-*` / `Retry-After` headers.
 *  - getAnalytics: Discord's bot API exposes no message-level analytics
 *    (impressions/reach/engagement). Declared UNSUPPORTED — see connector.ts.
 */

import type { CapabilityDescriptor, TokenSet } from '@social/core';

export const discordCapabilities: CapabilityDescriptor = {
  platform: 'discord',
  displayName: 'Discord',
  apiBaseUrl: 'https://discord.com/api/v10',
  contractVersion: '1.1.0',

  // This is the MOST PERMISSIVE descriptor across every credential shape this
  // connector accepts (bot token / webhook URL / OAuth2 user token) — see
  // `discordCapabilitiesFor` below for the per-credential-shape narrowing of
  // `refreshToken`/`disconnect` (Contract v1.1 `capabilitiesFor`).
  operations: {
    connect: true,
    authenticate: true,
    refreshToken: true,
    validatePost: true,
    uploadMedia: true,
    publish: true,
    delete: true,
    edit: true,
    getAnalytics: false,
    disconnect: true,
  },

  supportsEdit: true,
  supportsDelete: true,
  supportsScheduling: false,
  supportsThreads: true,
  supportsAnalytics: false,
  supportsMediaUpload: true,

  characterLimit: 2000,
  titleCharacterLimit: 256, // maps to embed.title when PostPayload.title is set
  altTextCharacterLimit: 1024, // attachment.description
  urlsCountTowardLimit: true, // Discord does not shorten/weight URLs specially
  maxHashtags: undefined,
  maxMentions: undefined, // no platform-imposed count; practical limits come from message length only

  maxMediaCount: 10,
  supportedMediaTypes: ['image', 'video', 'gif', 'audio', 'document'],
  mediaConstraints: [
    { type: 'image', mimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'], maxBytes: 25 * 1024 * 1024 },
    { type: 'gif', mimeTypes: ['image/gif'], maxBytes: 25 * 1024 * 1024 },
    { type: 'video', mimeTypes: ['video/mp4', 'video/quicktime', 'video/webm'], maxBytes: 25 * 1024 * 1024 },
    { type: 'audio', mimeTypes: ['audio/mpeg', 'audio/ogg', 'audio/wav'], maxBytes: 25 * 1024 * 1024 },
    { type: 'document', mimeTypes: ['*/*'], maxBytes: 25 * 1024 * 1024 },
  ],
  // Discord's bot/webhook message APIs only accept attachments INLINE, as
  // multipart parts of the same POST that creates/edits the message — there is
  // no stage-then-reference upload endpoint (see uploadMedia() in connector.ts).
  mediaUploadMode: 'inline',

  maxThreadLength: undefined, // Discord threads are channel-like containers, not a bounded chain

  nativeScheduleHorizonDays: undefined,
  rateLimit: { requestsPerWindow: 5, windowMs: 5_000, scope: 'account' },
};

/**
 * Contract v1.1 `capabilitiesFor`: bot tokens and webhook URLs are long-lived
 * static secrets with no refresh/revoke grant in Discord's documented API;
 * only OAuth2 user/app tokens (`tokenType` anything other than `'bot'`/
 * `'webhook'`) support `refreshToken`/`disconnect`. This narrows the
 * static (most-permissive) `discordCapabilities` above to what's actually
 * true for `token`'s shape, so `refreshToken`/`disconnect` can throw
 * `NotSupportedError` — paired with a `false` declaration, per the contract's
 * "declare it AND throw" rule — instead of the plain `AuthError` this
 * connector used before Contract v1.1 added per-credential capabilities.
 */
export function discordCapabilitiesFor(token: TokenSet): CapabilityDescriptor {
  const type = (token.tokenType ?? '').toLowerCase();
  const isStaticCredential = type === 'bot' || type === 'webhook';
  if (!isStaticCredential) return discordCapabilities;

  return {
    ...discordCapabilities,
    operations: { ...discordCapabilities.operations, refreshToken: false, disconnect: false },
  };
}

/** Discord-only: max embeds attached to a single message. Not part of the generic descriptor shape. */
export const DISCORD_MAX_EMBEDS = 10;
/** Combined character budget across all embed text fields on one message. */
export const DISCORD_EMBED_TOTAL_CHAR_BUDGET = 6000;
export const DISCORD_EMBED_TITLE_LIMIT = 256;
export const DISCORD_EMBED_DESCRIPTION_LIMIT = 4096;
export const DISCORD_EMBED_FIELD_NAME_LIMIT = 256;
export const DISCORD_EMBED_FIELD_VALUE_LIMIT = 1024;
export const DISCORD_EMBED_MAX_FIELDS = 25;
export const DISCORD_EMBED_FOOTER_LIMIT = 2048;
export const DISCORD_EMBED_AUTHOR_NAME_LIMIT = 256;
