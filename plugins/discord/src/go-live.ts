/**
 * Convenience builder for a "stream is live" announcement.
 *
 * Discord's official API has NO distinct "go-live" message type — a go-live
 * announcement is an ordinary message with an embed (+ optional role ping and
 * a "Watch now" link button), so this is a plain PostPayload constructor, not
 * a separate connector operation. Exposed here so content-ai / the scheduler
 * doesn't have to hand-roll the embed shape per platform.
 */

import type { PostPayload } from '@social/core';
import type { DiscordPlatformOptions } from './types';

export interface GoLiveAnnouncementInput {
  accountId: string;
  streamerName: string;
  title: string;
  url: string;
  thumbnailUrl?: string;
  gameName?: string;
  /** Role snowflake IDs to ping (e.g. a "live-notify" role). */
  roleMentionIds?: string[];
  channelId?: string;
  webhookUrl?: string;
}

export function buildGoLiveAnnouncement(input: GoLiveAnnouncementInput): PostPayload {
  const platformOptions: DiscordPlatformOptions = {
    ...(input.channelId ? { channelId: input.channelId } : {}),
    ...(input.webhookUrl ? { webhookUrl: input.webhookUrl } : {}),
    ...(input.roleMentionIds && input.roleMentionIds.length > 0 ? { roleMentionIds: input.roleMentionIds } : {}),
    embeds: [
      {
        title: input.title,
        url: input.url,
        color: 0x9146ff,
        author: { name: `${input.streamerName} is now live!` },
        ...(input.thumbnailUrl ? { thumbnail: { url: input.thumbnailUrl } } : {}),
        ...(input.gameName ? { fields: [{ name: 'Playing', value: input.gameName, inline: true }] } : {}),
      },
    ],
    components: [
      {
        type: 1,
        components: [{ type: 2, style: 5, label: 'Watch now', url: input.url }],
      },
    ],
  };

  return {
    platform: 'discord',
    accountId: input.accountId,
    platformOptions: platformOptions as unknown as Record<string, unknown>,
  };
}
