/**
 * @social/plugin-mastodon — plugin manifest, discovered by the core
 * `PluginLoader` via the `socialPlugin` marker in package.json.
 */
import { defineManifest } from '@social/core';
import { capabilities } from './capabilities';
import { MastodonConnector } from './connector';

export default defineManifest({
  name: '@social/plugin-mastodon',
  platform: 'mastodon',
  version: '0.1.0',
  contractVersion: '1.1.0',
  capabilities,
  createConnector: (runtime) => new MastodonConnector(runtime),
});

export { MastodonConnector } from './connector';
export { capabilities } from './capabilities';
