/**
 * Discord-specific types layered on top of the generic PlatformConnector
 * contract. These live in `PostPayload.platformOptions` (the "typed-per-plugin
 * escape hatch" the contract reserves for platform-only options — see
 * packages/core/src/connector/types.ts `PostPayload.platformOptions`).
 *
 * Sources (checked 2026-07-04):
 *  - https://docs.discord.com/developers/resources/message (message/embed shape + limits)
 *  - https://docs.discord.com/developers/resources/channel (threads)
 *  - https://docs.discord.com/developers/interactions/message-components (buttons)
 *  - https://docs.discord.com/developers/resources/webhook (webhooks)
 */

/** Embed object, trimmed to the fields we support constructing (camelCase; mapped to Discord's snake_case on the wire). */
export interface DiscordEmbedInput {
  title?: string;
  description?: string;
  url?: string;
  /** Decimal color value (e.g. 0x5865f2). */
  color?: number;
  /** ISO-8601. */
  timestamp?: string;
  footer?: { text: string; iconUrl?: string };
  image?: { url: string };
  thumbnail?: { url: string };
  author?: { name: string; url?: string; iconUrl?: string };
  fields?: { name: string; value: string; inline?: boolean }[];
}

/** Button style per the Message Components docs (2=button). */
export type DiscordButtonStyle = 1 | 2 | 3 | 4 | 5; // Primary/Secondary/Success/Danger/Link

export interface DiscordButtonComponent {
  type: 2;
  style: DiscordButtonStyle;
  label?: string;
  /** Required unless style === 5 (Link). Used to correlate the interaction webhook. */
  customId?: string;
  /** Required when style === 5 (Link button) — no interaction event fires for these. */
  url?: string;
  disabled?: boolean;
  emoji?: { name: string; id?: string; animated?: boolean };
}

export interface DiscordActionRow {
  type: 1;
  components: DiscordButtonComponent[];
}

export type DiscordThreadAutoArchive = 60 | 1440 | 4320 | 10080;

/**
 * Discord-only options a caller attaches to `PostPayload.platformOptions`.
 * Exactly one of `channelId` (bot API) or `webhookUrl` (webhook API) selects
 * how the message is sent — see README.md "Credential flow".
 */
export interface DiscordPlatformOptions {
  /** Bot-API target: send via POST /channels/{channelId}/messages. */
  channelId?: string;
  /** Webhook-API target: send via POST {webhookUrl}. Overrides channelId if both given. */
  webhookUrl?: string;
  /** Informational only (logging/cross-server correlation); not sent to Discord. */
  guildId?: string;
  embeds?: DiscordEmbedInput[];
  /** Role snowflake IDs to ping. Rendered as `<@&id>` and allow-listed in `allowed_mentions`. */
  roleMentionIds?: string[];
  /** User snowflake IDs to ping. Rendered as `<@id>` and allow-listed in `allowed_mentions`. */
  userMentionIds?: string[];
  /** Explicit opt-in required to allow an @everyone/@here in the content to actually ping. */
  everyoneMention?: boolean;
  /** Post into an existing thread (thread IDs are channel IDs on Discord's side). */
  threadId?: string;
  /** Start a new thread off the message this publish() call creates. */
  createThread?: { name: string; autoArchiveMinutes?: DiscordThreadAutoArchive };
  components?: DiscordActionRow[];
  tts?: boolean;
  /** Webhook-only: per-message identity override. */
  webhookUsername?: string;
  webhookAvatarUrl?: string;
  suppressEmbeds?: boolean;
}

/** Wire shapes for what we actually send/receive — intentionally snake_case to match Discord's API. */
export interface DiscordApiMessage {
  id: string;
  channel_id: string;
  content?: string;
  timestamp: string;
  attachments?: { id: string; filename: string; size: number; url?: string }[];
}

export interface DiscordApiErrorBody {
  code?: number;
  message?: string;
  errors?: unknown;
}
