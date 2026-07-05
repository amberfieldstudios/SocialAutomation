/**
 * @social/plugin-discord — plugin manifest entry.
 *
 * Discovered by @social/core's FileSystemPluginLoader via the `socialPlugin`
 * marker in package.json; this module's default export is the PluginManifest.
 */

import { defineManifest } from '@social/core';
import { discordCapabilities } from './capabilities';
import { DiscordConnector } from './connector';

export default defineManifest({
  name: '@social/plugin-discord',
  platform: 'discord',
  version: '0.1.0',
  contractVersion: '1.1.0',
  capabilities: discordCapabilities,
  createConnector: (runtime) => new DiscordConnector(runtime),
});

export { DiscordConnector } from './connector';
export { discordCapabilities } from './capabilities';
export * from './types';
export { buildGoLiveAnnouncement } from './go-live';
export type { GoLiveAnnouncementInput } from './go-live';
