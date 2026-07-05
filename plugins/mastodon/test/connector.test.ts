/**
 * Mastodon-specific behaviour not covered by the shared conformance harness:
 * counted-URL character counting, media classification/limits, thread reply
 * chaining, edit, delete, and analytics (including the follower-count
 * best-effort call). Mocks `fetch` directly — no real credentials.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppCredentials, OperationContext, PostPayload, StructuredLogger, TokenSet } from '@social/core';

import { capabilities } from '../src/capabilities';
import { MastodonConnector } from '../src/connector';
import { countedLength, validateMastodonPost } from '../src/validate';

class TestLogger implements StructuredLogger {
  lines: Array<{ level: string; message: string }> = [];
  child(): StructuredLogger {
    return this;
  }
  trace(message: string): void {
    this.lines.push({ level: 'trace', message });
  }
  debug(message: string): void {
    this.lines.push({ level: 'debug', message });
  }
  info(message: string): void {
    this.lines.push({ level: 'info', message });
  }
  warn(message: string): void {
    this.lines.push({ level: 'warn', message });
  }
  error(message: string): void {
    this.lines.push({ level: 'error', message });
  }
}

const INSTANCE = 'https://social.example';

function makeCtx(): OperationContext {
  const app: AppCredentials = { clientId: 'client-1', clientSecret: 'secret-1', extra: { instanceUrl: INSTANCE } };
  const token: TokenSet = { accessToken: 'tok-abc', refreshToken: 'refresh-abc', scopes: ['write'], obtainedAt: '2026-07-04T00:00:00.000Z' };
  return { token, app, accountId: 'acct-1', logger: new TestLogger() };
}

describe('validate.ts: countedLength', () => {
  it('counts a URL as the fixed reserved length regardless of its real length', () => {
    const shortUrl = 'hello https://x.co more text';
    const longUrl = 'hello https://a-very-long-domain-name.example/with/a/long/path?and=query more text';
    expect(countedLength(shortUrl, 23)).toBe(countedLength(longUrl, 23));
  });

  it('falls back to raw character count when countedUrlLength is undefined', () => {
    expect(countedLength('hello', undefined)).toBe(5);
  });
});

describe('validate.ts: validateMastodonPost', () => {
  it('rejects more than one video/audio attachment', () => {
    const payload: PostPayload = {
      platform: 'mastodon',
      accountId: 'a',
      text: 'hi',
      media: [
        { assetId: '1', mimeType: 'video/mp4', uri: 'file:///a.mp4' },
        { assetId: '2', mimeType: 'video/mp4', uri: 'file:///b.mp4' },
      ],
    };
    const result = validateMastodonPost(payload, capabilities);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'too_many_videos')).toBe(true);
  });

  it('rejects an invalid visibility value', () => {
    const payload: PostPayload = { platform: 'mastodon', accountId: 'a', text: 'hi', platformOptions: { visibility: 'friends-only' } };
    const result = validateMastodonPost(payload, capabilities);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'invalid_visibility')).toBe(true);
  });

  it('rejects scheduledAt less than 5 minutes in the future', () => {
    const now = () => new Date('2026-07-04T12:00:00.000Z');
    const payload: PostPayload = { platform: 'mastodon', accountId: 'a', text: 'hi', scheduledAt: '2026-07-04T12:01:00.000Z' };
    const result = validateMastodonPost(payload, capabilities, now);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'scheduled_at_too_soon')).toBe(true);
  });
});

describe('MastodonConnector: publish/edit/delete/getAnalytics', () => {
  let calls: Array<{ url: string; method: string }> = [];

  beforeEach(() => {
    calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = (init?.method ?? 'GET').toUpperCase();
        calls.push({ url, method });
        const u = new URL(url);

        if (u.pathname === '/api/v1/statuses' && method === 'POST') {
          return new Response(
            JSON.stringify({
              id: 'status-1',
              uri: `${INSTANCE}/users/me/statuses/status-1`,
              url: `${INSTANCE}/@me/status-1`,
              created_at: '2026-07-04T12:00:00.000Z',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (u.pathname === '/api/v1/statuses/status-1' && method === 'PUT') {
          return new Response(
            JSON.stringify({ id: 'status-1', uri: `${INSTANCE}/x`, url: `${INSTANCE}/@me/status-1`, edited_at: '2026-07-04T12:05:00.000Z', created_at: '2026-07-04T12:00:00.000Z' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (u.pathname === '/api/v1/statuses/status-1' && method === 'DELETE') {
          return new Response(JSON.stringify({ id: 'status-1', uri: `${INSTANCE}/x`, created_at: '2026-07-04T12:00:00.000Z' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (u.pathname === '/api/v1/statuses/status-1' && method === 'GET') {
          return new Response(
            JSON.stringify({ id: 'status-1', uri: `${INSTANCE}/x`, created_at: '2026-07-04T12:00:00.000Z', favourites_count: 5, reblogs_count: 2, replies_count: 1 }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (u.pathname === '/api/v1/accounts/verify_credentials' && method === 'GET') {
          return new Response(JSON.stringify({ id: 'acct-remote-1', username: 'me', followers_count: 42 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw new Error(`unexpected request: ${method} ${url}`);
      }),
    );
  });

  it('publishes a two-post thread as sequential in_reply_to_id statuses', async () => {
    const connector = new MastodonConnector({ logger: new TestLogger(), now: () => new Date('2026-07-04T12:00:00.000Z') });
    const ctx = makeCtx();
    const payload: PostPayload = {
      platform: 'mastodon',
      accountId: 'acct-1',
      text: 'part one',
      thread: [{ platform: 'mastodon', accountId: 'acct-1', text: 'part two' }],
    };
    const result = await connector.publish(payload, ctx);
    expect(result.remoteId).toBe('status-1');
    expect(result.threadRemoteIds).toEqual(['status-1', 'status-1']);
    const statusCalls = calls.filter((c) => c.url.endsWith('/api/v1/statuses') && c.method === 'POST');
    expect(statusCalls).toHaveLength(2);
  });

  it('edits, deletes, and fetches analytics including best-effort follower count', async () => {
    const connector = new MastodonConnector({ logger: new TestLogger(), now: () => new Date('2026-07-04T12:05:00.000Z') });
    const ctx = makeCtx();

    const edited = await connector.edit({ remoteId: 'status-1', payload: { platform: 'mastodon', accountId: 'acct-1', text: 'updated text' } }, ctx);
    expect(edited.remoteId).toBe('status-1');

    const deleted = await connector.delete({ remoteId: 'status-1' }, ctx);
    expect(deleted.removed).toBe(true);

    const analytics = await connector.getAnalytics({ remoteId: 'status-1' }, ctx);
    expect(analytics.metrics).toMatchObject({ likes: 5, shares: 2, comments: 1, followersCount: 42 });
  });

  it('never logs the raw access or refresh token', async () => {
    const logger = new TestLogger();
    const connector = new MastodonConnector({ logger, now: () => new Date('2026-07-04T12:00:00.000Z') });
    const ctx = { ...makeCtx(), logger };
    await connector.publish({ platform: 'mastodon', accountId: 'acct-1', text: 'hi' }, ctx);
    const serialized = JSON.stringify(logger.lines);
    expect(serialized).not.toContain('tok-abc');
    expect(serialized).not.toContain('refresh-abc');
  });
});
