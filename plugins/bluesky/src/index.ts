/**
 * @social/plugin-bluesky — plugin manifest, discovered by the core
 * `PluginLoader` via the `socialPlugin` marker in package.json.
 */
import { defineManifest } from '@social/core';
import { capabilities } from './capabilities';
import { BlueskyConnector } from './connector';

export default defineManifest({
  name: '@social/plugin-bluesky',
  platform: 'bluesky',
  version: '0.1.0',
  contractVersion: '1.1.0',
  capabilities,
  createConnector: (runtime) => new BlueskyConnector(runtime),
});

export { BlueskyConnector } from './connector';
export { capabilities } from './capabilities';
