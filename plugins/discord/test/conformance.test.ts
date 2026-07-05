/**
 * Discord connector run through the SHARED conformance harness
 * (@social/conformance). This asserts contract-level conformance uniformly with
 * every other platform; Discord-specific behaviour stays in connector.test.ts.
 */
import { runConformance, type ConformanceMockEnv } from '@social/conformance';
import type { PostPayload, TokenSet } from '@social/core';

import discordManifest from '../src/index';

const BOT_TOKEN = 'super-secret-bot-token-value';

const token: TokenSet = {
  accessToken: BOT_TOKEN,
  tokenType: 'bot',
  scopes: [],
  obtainedAt: '2026-07-04T11:00:00.000Z',
};

const validPayload: PostPayload = {
  platform: 'discord',
  accountId: 'acct-conformance',
  text: 'hello from the conformance harness',
  platformOptions: { channelId: '555' },
};

const invalidPayload: PostPayload = {
  platform: 'discord',
  accountId: 'acct-conformance',
  text: 'x'.repeat(2001), // over the 2000-char content limit
};

const mockEnv: ConformanceMockEnv = {
  allowedHosts: ['discord.com'],
  token,
  validPayload,
  invalidPayload,
  secrets: [BOT_TOKEN],
  sampleRemoteId: 'channel:555:msg-1',
  route: (req, scenario) => {
    const url = new URL(req.url);
    if (url.pathname === '/api/v10/channels/555/messages' && req.method === 'POST') {
      if (scenario === 'rateLimited') {
        return new Response(JSON.stringify({ message: 'rate limited', retry_after: 1.5 }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'retry-after': '1.5' },
        });
      }
      return new Response(
        JSON.stringify({ id: 'msg-1', channel_id: '555', timestamp: '2026-07-04T12:00:00.000Z' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error(`unexpected Discord request: ${req.method} ${req.url}`);
  },
};

runConformance(discordManifest.createConnector, discordManifest.capabilities, mockEnv);
