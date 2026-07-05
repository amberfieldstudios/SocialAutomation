import { defineManifest } from '@social/core';

import { capabilities } from './capabilities';
import { TwitchConnector } from './connector';

export default defineManifest({
  name: '@social/plugin-twitch',
  platform: 'twitch',
  version: '0.1.0',
  contractVersion: '1.1.0',
  capabilities,
  createConnector: (runtime) => new TwitchConnector(runtime),
});

export { TwitchConnector } from './connector';
export { capabilities } from './capabilities';
