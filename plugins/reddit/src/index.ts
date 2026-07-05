import { defineManifest } from '@social/core';

import { capabilities } from './capabilities';
import { RedditConnector } from './connector';

export default defineManifest({
  name: '@social/plugin-reddit',
  platform: 'reddit',
  version: '0.1.0',
  contractVersion: '1.1.0',
  capabilities,
  createConnector: (runtime) => new RedditConnector(runtime),
});

export { RedditConnector } from './connector';
export { capabilities } from './capabilities';
