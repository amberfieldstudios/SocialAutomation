/**
 * Reddit connector run through the SHARED conformance harness
 * (@social/conformance). Reddit-specific behaviour stays in connector.test.ts;
 * this file asserts contract-level conformance uniformly with every platform.
 */
import { runConformance, type ConformanceMockEnv } from '@social/conformance';
import type { AppCredentials, PostPayload, TokenSet } from '@social/core';

import redditManifest from '../src/index';

const ACCESS_TOKEN = 'super-secret-reddit-access-token';
const REFRESH_TOKEN = 'super-secret-reddit-refresh-token';

const token: TokenSet = {
  accessToken: ACCESS_TOKEN,
  refreshToken: REFRESH_TOKEN,
  tokenType: 'bearer',
  scopes: ['submit', 'edit', 'read', 'identity'],
  obtainedAt: '2026-07-04T11:00:00.000Z',
};

const app: AppCredentials = {
  clientId: 'conformance-client',
  clientSecret: 'conformance-secret',
  extra: { userAgent: 'test:social-automation-conformance:1.0.0 (by /u/conformance_bot)' },
};

const validPayload: PostPayload = {
  platform: 'reddit',
  accountId: 'acct-conformance',
  title: 'Conformance harness test post',
  text: 'Body text for the conformance self post.',
  platformOptions: { subreddit: 'test' },
};

const invalidPayload: PostPayload = {
  platform: 'reddit',
  accountId: 'acct-conformance',
  // no title, no subreddit -> validatePost rejects with title_required + subreddit_required
};

const mockEnv: ConformanceMockEnv = {
  allowedHosts: ['oauth.reddit.com', 'www.reddit.com'],
  token,
  app,
  validPayload,
  invalidPayload,
  secrets: [ACCESS_TOKEN, REFRESH_TOKEN, 'conformance-secret'],
  sampleRemoteId: 't3_abc123',
  route: (req, scenario) => {
    const url = new URL(req.url);
    if (url.pathname === '/api/v1/me') {
      return new Response(JSON.stringify({ id: 'user123', name: 'conformance_bot' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.pathname === '/api/submit') {
      if (scenario === 'rateLimited') {
        return new Response(JSON.stringify({ message: 'Too Many Requests' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'X-Ratelimit-Reset': '30' },
        });
      }
      return new Response(
        JSON.stringify({ json: { errors: [], data: { id: 'abc123', name: 't3_abc123', url: 'https://reddit.com/r/test/abc123' } } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.pathname === '/api/del') {
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/api/editusertext') {
      return new Response(JSON.stringify({ json: { errors: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/api/info') {
      return new Response(
        JSON.stringify({
          data: { children: [{ data: { id: 'abc123', name: 't3_abc123', score: 10, upvote_ratio: 0.9, num_comments: 2, permalink: '/r/test/abc123' } }] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.pathname === '/api/v1/revoke_token') {
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected Reddit request: ${req.method} ${req.url}`);
  },
};

runConformance(redditManifest.createConnector, redditManifest.capabilities, mockEnv);
