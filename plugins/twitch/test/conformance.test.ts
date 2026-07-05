/**
 * Twitch connector run through the SHARED conformance harness
 * (@social/conformance). Twitch-specific behaviour stays in connector.test.ts;
 * this file asserts contract-level conformance uniformly with every platform.
 */
import { runConformance, type ConformanceMockEnv } from '@social/conformance';
import type { PostPayload, TokenSet } from '@social/core';

import twitchManifest from '../src/index';

const ACCESS_TOKEN = 'super-secret-access-token';
const REFRESH_TOKEN = 'super-secret-refresh-token';

const token: TokenSet = {
  accessToken: ACCESS_TOKEN,
  refreshToken: REFRESH_TOKEN,
  tokenType: 'bearer',
  scopes: ['channel:manage:broadcast'],
  obtainedAt: '2026-07-04T11:00:00.000Z',
};

const validPayload: PostPayload = {
  platform: 'twitch',
  accountId: 'acct-conformance',
  title: 'Conformance ranked climb',
  tags: ['conformance'],
};

const invalidPayload: PostPayload = {
  platform: 'twitch',
  accountId: 'acct-conformance',
  // no title -> validatePost rejects with title_required
};

const mockEnv: ConformanceMockEnv = {
  allowedHosts: ['api.twitch.tv', 'id.twitch.tv'],
  token,
  validPayload,
  invalidPayload,
  secrets: [ACCESS_TOKEN, REFRESH_TOKEN],
  sampleRemoteId: 'broadcaster-1',
  route: (req, scenario) => {
    const url = new URL(req.url);
    if (url.pathname === '/oauth2/validate') {
      return new Response(
        JSON.stringify({ client_id: 'app-client-id', login: 'coolstreamer', user_id: 'broadcaster-1', scopes: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.pathname === '/helix/channels') {
      if (scenario === 'rateLimited') {
        const resetEpochSeconds = Math.floor(Date.now() / 1000) + 30;
        return new Response(JSON.stringify({ error: 'rate limited' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Ratelimit-Reset': String(resetEpochSeconds) },
        });
      }
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected Twitch request: ${req.method} ${req.url}`);
  },
};

runConformance(twitchManifest.createConnector, twitchManifest.capabilities, mockEnv);
