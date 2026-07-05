/**
 * End-to-end publish through the real Twitch connector (`plugins/twitch`),
 * with all Helix/`id.twitch.tv` HTTP mocked via `vi.stubGlobal('fetch', ...)`
 * (same technique `plugins/twitch/test/connector.test.ts` uses).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PostPayload } from '@social/core';
import { buildHarness, farFutureToken, type TestHarness } from './support';

const ACCESS_TOKEN = 'super-secret-twitch-access-token';
const REFRESH_TOKEN = 'super-secret-twitch-refresh-token';

let harness: TestHarness;
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

beforeEach(async () => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  harness = await buildHarness();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('twitch end-to-end publish', () => {
  it('runs submitPost -> queue -> worker -> TwitchConnector.publish -> persisted PublishResult', async () => {
    const accountId = await harness.pairAccount({
      platformId: 'twitch',
      remoteId: 'broadcaster-1',
      token: farFutureToken(ACCESS_TOKEN, { refreshToken: REFRESH_TOKEN, scopes: ['channel:manage:broadcast'] }),
    });

    fetchMock.mockImplementation((url: string | URL) => {
      const u = new URL(url);
      if (u.pathname === '/oauth2/validate') {
        return Promise.resolve(jsonResponse(200, { client_id: 'app-client-id', login: 'coolstreamer', user_id: 'broadcaster-1', scopes: [] }));
      }
      if (u.pathname === '/helix/channels') {
        expect(u.searchParams.get('broadcaster_id')).toBe('broadcaster-1');
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      throw new Error(`Unexpected fetch to ${u.toString()}`);
    });

    const payload: PostPayload = {
      platform: 'twitch',
      accountId,
      title: 'Ranked climb, chat picks agent',
      tags: ['ranked', 'valorant'],
    };

    const submission = await harness.pipeline.publishService.submitPost({ platform: 'twitch', accountId, payload });
    expect(submission.validation.ok).toBe(true);

    const processed = await harness.pipeline.worker.runOnce();
    expect(processed).toBe(1);

    const job = await harness.db.jobs.getById(submission.jobId);
    expect(job?.status).toBe('succeeded');
    expect((job?.result as { remoteId?: string })?.remoteId).toBe('broadcaster-1');

    const variant = harness.pipeline.variants.getById(submission.postVariantId);
    expect(variant?.status).toBe('published');
    expect(variant?.remoteId).toBe('broadcaster-1');

    expect(await harness.db.jobs.listDeadLetters()).toHaveLength(0);
    const logs = harness.serializedLogs();
    expect(logs.includes(ACCESS_TOKEN)).toBe(false);
    expect(logs.includes(REFRESH_TOKEN)).toBe(false);
  });
});
