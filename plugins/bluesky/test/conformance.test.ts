/**
 * Bluesky connector run through the SHARED conformance harness
 * (@social/conformance). Bluesky-specific behaviour (facets, grapheme counting,
 * thread refs) stays in connector.test.ts; this asserts contract-level
 * conformance uniformly with every platform.
 */
import { runConformance, type ConformanceMockEnv } from '@social/conformance';
import type { PostPayload, TokenSet } from '@social/core';

import blueskyManifest from '../src/index';
import { fakeJwt } from './support';

const ACCESS_JWT = fakeJwt('did:plc:testaccount');
const REFRESH_JWT = 'super-secret-refresh-jwt-value';

const token: TokenSet = {
  accessToken: ACCESS_JWT,
  refreshToken: REFRESH_JWT,
  tokenType: 'Bearer',
  scopes: ['atproto'],
  obtainedAt: '2026-07-04T11:00:00.000Z',
};

const validPayload: PostPayload = {
  platform: 'bluesky',
  accountId: 'acct-conformance',
  text: 'hello from the conformance harness',
};

const invalidPayload: PostPayload = {
  platform: 'bluesky',
  accountId: 'acct-conformance',
  text: 'x'.repeat(301), // over the 300-grapheme limit
};

const mockEnv: ConformanceMockEnv = {
  allowedHosts: ['bsky.social'],
  token,
  validPayload,
  invalidPayload,
  secrets: [ACCESS_JWT, REFRESH_JWT],
  sampleRemoteId: 'at://did:plc:testaccount/app.bsky.feed.post/abc123',
  route: (req, scenario) => {
    const url = new URL(req.url);
    if (url.pathname === '/xrpc/com.atproto.repo.createRecord' && req.method === 'POST') {
      if (scenario === 'rateLimited') {
        return new Response(JSON.stringify({ error: 'RateLimitExceeded' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'retry-after': '2' },
        });
      }
      return new Response(
        JSON.stringify({ uri: 'at://did:plc:testaccount/app.bsky.feed.post/abc123', cid: 'bafyconformancecid' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error(`unexpected Bluesky request: ${req.method} ${req.url}`);
  },
};

runConformance(blueskyManifest.createConnector, blueskyManifest.capabilities, mockEnv);
