/**
 * End-to-end publish through the real Bluesky connector (`plugins/bluesky`),
 * with all AT Proto XRPC HTTP mocked via `vi.stubGlobal('fetch', ...)` (same
 * technique `plugins/bluesky/test/connector.test.ts` uses).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PostPayload } from '@social/core';
import { buildHarness, type TestHarness } from './support';

/** Builds an unsigned but structurally-valid AT Proto session JWT (mirrors plugins/bluesky/test/support.ts). */
function fakeJwt(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub, scope: 'com.atproto.access' })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function mockFetchSequence(handlers: Array<(url: string, init?: RequestInit) => Response | Promise<Response>>) {
  let i = 0;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    calls.push({ url, init });
    const handler = handlers[i];
    i += 1;
    if (!handler) throw new Error(`No mock handler configured for call #${i} (${url})`);
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const ACCESS_TOKEN = fakeJwt('did:plc:testaccount');
const REFRESH_TOKEN = 'super-secret-bluesky-refresh-jwt';

let harness: TestHarness;

beforeEach(async () => {
  harness = await buildHarness();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('bluesky end-to-end publish', () => {
  it('runs submitPost -> queue -> worker -> BlueskyConnector.publish -> persisted PublishResult', async () => {
    const accountId = await harness.pairAccount({
      platformId: 'bluesky',
      remoteId: 'did:plc:testaccount',
      token: {
        accessToken: ACCESS_TOKEN,
        refreshToken: REFRESH_TOKEN,
        tokenType: 'Bearer',
        scopes: ['atproto'],
        obtainedAt: new Date('2026-07-04T00:00:00.000Z').toISOString(),
        // No expiresAt: AT Proto sessions here are treated as non-expiring for
        // this test (createContext never triggers a refresh network call).
      },
    });

    const { fn, calls } = mockFetchSequence([
      async () => jsonResponse({ uri: 'at://did:plc:testaccount/app.bsky.feed.post/abc123', cid: 'bafycid1' }),
    ]);
    vi.stubGlobal('fetch', fn);

    const payload: PostPayload = { platform: 'bluesky', accountId, text: 'hello from the integration test' };

    const submission = await harness.pipeline.publishService.submitPost({ platform: 'bluesky', accountId, payload });
    expect(submission.validation.ok).toBe(true);

    const processed = await harness.pipeline.worker.runOnce();
    expect(processed).toBe(1);

    expect(calls[0]?.url).toContain('com.atproto.repo.createRecord');

    const job = await harness.db.jobs.getById(submission.jobId);
    expect(job?.status).toBe('succeeded');
    expect((job?.result as { remoteId?: string })?.remoteId).toBe('at://did:plc:testaccount/app.bsky.feed.post/abc123');

    const variant = harness.pipeline.variants.getById(submission.postVariantId);
    expect(variant?.status).toBe('published');
    expect(variant?.remoteId).toBe('at://did:plc:testaccount/app.bsky.feed.post/abc123');

    expect(await harness.db.jobs.listDeadLetters()).toHaveLength(0);
    const logs = harness.serializedLogs();
    expect(logs.includes(REFRESH_TOKEN)).toBe(false);
    // The raw access JWT itself must not appear verbatim in a log line either.
    expect(logs.includes(ACCESS_TOKEN)).toBe(false);
  });
});
