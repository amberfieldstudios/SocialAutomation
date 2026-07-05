/**
 * Mastodon connector run through the SHARED conformance harness
 * (@social/conformance). Mastodon-specific behaviour (counted-URL character
 * counting, media classification) stays in connector.test.ts; this asserts
 * contract-level conformance uniformly with every platform.
 */
import { runConformance, type ConformanceMockEnv } from '@social/conformance';
import type { AppCredentials, PostPayload, TokenSet } from '@social/core';

import mastodonManifest from '../src/index';

const ACCESS_TOKEN = 'conformance-mastodon-access-token';
const REFRESH_TOKEN = 'conformance-mastodon-refresh-token';
const INSTANCE_HOST = 'mastodon.example';

const token: TokenSet = {
  accessToken: ACCESS_TOKEN,
  refreshToken: REFRESH_TOKEN,
  tokenType: 'Bearer',
  scopes: ['read', 'write'],
  obtainedAt: '2026-07-04T11:00:00.000Z',
};

const app: AppCredentials = {
  clientId: 'conformance-client-id',
  clientSecret: 'conformance-client-secret',
  redirectUri: 'https://app.example/callback',
  extra: { instanceUrl: `https://${INSTANCE_HOST}` },
};

const validPayload: PostPayload = {
  platform: 'mastodon',
  accountId: 'acct-conformance',
  text: 'hello from the conformance harness',
};

const invalidPayload: PostPayload = {
  platform: 'mastodon',
  accountId: 'acct-conformance',
  text: 'x'.repeat(501), // over the default 500-character limit
};

const mockEnv: ConformanceMockEnv = {
  allowedHosts: [INSTANCE_HOST, 'mastodon.social'],
  token,
  app,
  validPayload,
  invalidPayload,
  secrets: [ACCESS_TOKEN, REFRESH_TOKEN, app.clientSecret!],
  sampleRemoteId: '110000000000000001',
  route: (req, scenario) => {
    const url = new URL(req.url);
    if (url.pathname === '/api/v1/statuses' && req.method === 'POST') {
      if (scenario === 'rateLimited') {
        return new Response(JSON.stringify({ error: 'Too many requests' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'retry-after': '2' },
        });
      }
      return new Response(
        JSON.stringify({
          id: '110000000000000001',
          uri: `https://${INSTANCE_HOST}/users/acct/statuses/110000000000000001`,
          url: `https://${INSTANCE_HOST}/@acct/110000000000000001`,
          created_at: '2026-07-04T12:00:00.000Z',
          favourites_count: 0,
          reblogs_count: 0,
          replies_count: 0,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error(`unexpected Mastodon request: ${req.method} ${req.url}`);
  },
};

runConformance(mastodonManifest.createConnector, mastodonManifest.capabilities, mockEnv);
