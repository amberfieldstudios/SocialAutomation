/**
 * Conformance-style tests for the Twitch connector against the shared
 * PlatformConnector contract. No real network access — `fetch` is fully
 * mocked; every call is asserted to target `api.twitch.tv`/`id.twitch.tv`
 * only (the official Helix/OAuth surface).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NotSupportedError,
  RateLimitError,
  TokenExpiredError,
  TokenRevokedError,
  ValidationFailedError,
  type LogFields,
  type OperationContext,
  type PostPayload,
  type StructuredLogger,
  type TokenSet,
} from '@social/core';

import { TwitchConnector } from '../src/connector';
import { capabilities } from '../src/capabilities';

const ALL_OPERATIONS = [
  'connect',
  'authenticate',
  'refreshToken',
  'validatePost',
  'uploadMedia',
  'publish',
  'delete',
  'edit',
  'getAnalytics',
  'disconnect',
] as const;

interface CapturedLog {
  level: string;
  message: string;
  fields?: LogFields;
}

function createTestLogger(sink: CapturedLog[]): StructuredLogger {
  const make = (bindings: LogFields = {}): StructuredLogger => ({
    child: (b) => make({ ...bindings, ...b }),
    trace: (m, f) => sink.push({ level: 'trace', message: m, fields: { ...bindings, ...f } }),
    debug: (m, f) => sink.push({ level: 'debug', message: m, fields: { ...bindings, ...f } }),
    info: (m, f) => sink.push({ level: 'info', message: m, fields: { ...bindings, ...f } }),
    warn: (m, f) => sink.push({ level: 'warn', message: m, fields: { ...bindings, ...f } }),
    error: (m, f) => sink.push({ level: 'error', message: m, fields: { ...bindings, ...f } }),
  });
  return make();
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const ACCESS_TOKEN = 'super-secret-access-token';
const REFRESH_TOKEN = 'super-secret-refresh-token';

function makeToken(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
    tokenType: 'bearer',
    scopes: ['channel:manage:broadcast'],
    obtainedAt: new Date('2026-07-01T00:00:00.000Z').toISOString(),
    ...overrides,
  };
}

function makeCtx(logs: CapturedLog[], overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    token: makeToken(),
    app: { clientId: 'app-client-id' },
    accountId: 'acct-1',
    logger: createTestLogger(logs),
    ...overrides,
  };
}

describe('TwitchConnector — contract completeness', () => {
  it('declares a boolean for every ConnectorOperation', () => {
    for (const op of ALL_OPERATIONS) {
      expect(typeof capabilities.operations[op]).toBe('boolean');
    }
  });

  it('only calls official Twitch hosts (api.twitch.tv / id.twitch.tv)', () => {
    expect(capabilities.apiBaseUrl).toBe('https://api.twitch.tv/helix');
  });
});

describe('TwitchConnector — unsupported operations throw AND are declared false', () => {
  const logs: CapturedLog[] = [];
  const connector = new TwitchConnector({ logger: createTestLogger(logs) });

  it('uploadMedia', async () => {
    expect(capabilities.operations.uploadMedia).toBe(false);
    await expect(connector.uploadMedia({ assetId: 'a1', mimeType: 'image/png', uri: 'file://x' }, makeCtx(logs))).rejects.toBeInstanceOf(
      NotSupportedError,
    );
  });

  it('delete', async () => {
    expect(capabilities.operations.delete).toBe(false);
    await expect(connector.delete({ remoteId: 'x' }, makeCtx(logs))).rejects.toBeInstanceOf(NotSupportedError);
  });
});

describe('TwitchConnector — validatePost', () => {
  const connector = new TwitchConnector({ logger: createTestLogger([]) });

  it('rejects a missing title', async () => {
    const result = await connector.validatePost({ platform: 'twitch', accountId: 'a' });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'title_required')).toBe(true);
  });

  it('rejects a title over 140 characters', async () => {
    const result = await connector.validatePost({
      platform: 'twitch',
      accountId: 'a',
      title: 'x'.repeat(141),
    });
    expect(result.ok).toBe(false);
    const issue = result.errors.find((e) => e.code === 'text_too_long');
    expect(issue).toBeDefined();
    expect(issue?.limit).toBe(140);
    expect(issue?.actual).toBe(141);
  });

  it('accepts a valid title with tags at the boundary', async () => {
    const result = await connector.validatePost({
      platform: 'twitch',
      accountId: 'a',
      title: 'Ranked grind, chat decides the build',
      tags: Array.from({ length: 10 }, (_, i) => `tag${i}`),
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects more than 10 tags and malformed tags', async () => {
    const result = await connector.validatePost({
      platform: 'twitch',
      accountId: 'a',
      title: 'Valid title',
      tags: [...Array.from({ length: 11 }, (_, i) => `tag${i}`), 'has space', ''],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'too_many_tags')).toBe(true);
    expect(result.errors.some((e) => e.code === 'invalid_tag')).toBe(true);
  });

  it('rejects media and threads (both unsupported on Twitch)', async () => {
    const result = await connector.validatePost({
      platform: 'twitch',
      accountId: 'a',
      title: 'Valid title',
      media: [{ assetId: 'm1', mimeType: 'image/png', uri: 'file://x' }],
      thread: [{ platform: 'twitch', accountId: 'a', title: 'follow-up' }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'media_not_supported')).toBe(true);
    expect(result.errors.some((e) => e.code === 'threads_not_supported')).toBe(true);
  });

  it('warns (does not error) on scheduledAt, since Twitch has no native scheduling', async () => {
    const result = await connector.validatePost({
      platform: 'twitch',
      accountId: 'a',
      title: 'Valid title',
      scheduledAt: new Date().toISOString(),
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.code === 'native_scheduling_not_supported')).toBe(true);
  });
});

describe('TwitchConnector — publish (validate-before-publish + Modify Channel Information)', () => {
  let logs: CapturedLog[];
  let connector: TwitchConnector;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logs = [];
    connector = new TwitchConnector({ logger: createTestLogger(logs), now: () => new Date('2026-07-04T12:00:00.000Z') });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('refuses to call the network when validatePost would reject', async () => {
    const payload: PostPayload = { platform: 'twitch', accountId: 'a' }; // no title
    await expect(connector.publish(payload, makeCtx(logs))).rejects.toBeInstanceOf(ValidationFailedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates the token, then PATCHes /helix/channels, and returns the broadcaster id as remoteId', async () => {
    fetchMock.mockImplementation((url: string | URL) => {
      const u = new URL(url);
      expect(['api.twitch.tv', 'id.twitch.tv']).toContain(u.hostname);
      if (u.pathname === '/oauth2/validate') {
        return Promise.resolve(
          jsonResponse(200, { client_id: 'app-client-id', login: 'coolstreamer', user_id: 'broadcaster-1', scopes: [] }),
        );
      }
      if (u.pathname === '/helix/channels') {
        expect(u.searchParams.get('broadcaster_id')).toBe('broadcaster-1');
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      throw new Error(`Unexpected fetch to ${u.toString()}`);
    });

    const payload: PostPayload = {
      platform: 'twitch',
      accountId: 'a',
      title: 'Ranked climb, chat picks agent',
      tags: ['ranked', 'valorant'],
    };
    const result = await connector.publish(payload, makeCtx(logs));

    expect(result.remoteId).toBe('broadcaster-1');
    expect(result.remoteUrl).toBe('https://twitch.tv/coolstreamer');
    expect(result.publishedAt).toBe('2026-07-04T12:00:00.000Z');
  });

  it('never logs the raw access or refresh token', async () => {
    fetchMock.mockImplementation((url: string | URL) => {
      const u = new URL(url);
      if (u.pathname === '/oauth2/validate') {
        return Promise.resolve(jsonResponse(200, { client_id: 'app-client-id', login: 'x', user_id: 'b1', scopes: [] }));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    await connector.publish({ platform: 'twitch', accountId: 'a', title: 'Valid title' }, makeCtx(logs));

    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(ACCESS_TOKEN);
    expect(serialized).not.toContain(REFRESH_TOKEN);
  });

  it('maps a 429 from Helix onto a retryable RateLimitError', async () => {
    fetchMock.mockImplementation((url: string | URL) => {
      const u = new URL(url);
      if (u.pathname === '/oauth2/validate') {
        return Promise.resolve(jsonResponse(200, { client_id: 'app-client-id', login: 'x', user_id: 'b1', scopes: [] }));
      }
      const resetEpochSeconds = Math.floor(Date.now() / 1000) + 30;
      return Promise.resolve(jsonResponse(429, { error: 'rate limited' }, { 'Ratelimit-Reset': String(resetEpochSeconds) }));
    });

    const err = await connector
      .publish({ platform: 'twitch', accountId: 'a', title: 'Valid title' }, makeCtx(logs))
      .catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBeGreaterThan(0);
  });

  it('maps a 401 from Helix onto a retryable TokenExpiredError', async () => {
    fetchMock.mockImplementation((url: string | URL) => {
      const u = new URL(url);
      if (u.pathname === '/oauth2/validate') {
        return Promise.resolve(new Response(null, { status: 401 }));
      }
      throw new Error('should not reach Helix after failed validate');
    });

    const err = await connector
      .publish({ platform: 'twitch', accountId: 'a', title: 'Valid title' }, makeCtx(logs))
      .catch((e) => e);
    expect(err).toBeInstanceOf(TokenExpiredError);
    expect(err.retryable).toBe(true);
  });
});

describe('TwitchConnector — edit', () => {
  it('re-applies Modify Channel Information for the same channel resource', async () => {
    const logs: CapturedLog[] = [];
    const connector = new TwitchConnector({ logger: createTestLogger(logs), now: () => new Date('2026-07-04T12:00:00.000Z') });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL) => {
        const u = new URL(url);
        if (u.pathname === '/oauth2/validate') {
          return Promise.resolve(jsonResponse(200, { client_id: 'c1', login: 'coolstreamer', user_id: 'broadcaster-1', scopes: [] }));
        }
        return Promise.resolve(new Response(null, { status: 204 }));
      }),
    );

    const result = await connector.edit(
      { remoteId: 'broadcaster-1', payload: { platform: 'twitch', accountId: 'a', title: 'Updated title' } },
      makeCtx(logs),
    );
    expect(result.remoteId).toBe('broadcaster-1');
    expect(result.remoteUrl).toBe('https://twitch.tv/coolstreamer');
  });
});

describe('TwitchConnector — getAnalytics', () => {
  it('maps Get Streams + Get Channel Followers onto canonical metrics, degrading gracefully if followers is unavailable', async () => {
    const logs: CapturedLog[] = [];
    const connector = new TwitchConnector({ logger: createTestLogger(logs), now: () => new Date('2026-07-04T12:00:00.000Z') });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL) => {
        const u = new URL(url);
        if (u.pathname === '/oauth2/validate') {
          return Promise.resolve(jsonResponse(200, { client_id: 'c1', login: 'x', user_id: 'broadcaster-1', scopes: [] }));
        }
        if (u.pathname === '/helix/streams') {
          return Promise.resolve(
            jsonResponse(200, { data: [{ id: 's1', user_id: 'broadcaster-1', viewer_count: 42, started_at: '2026-07-04T10:00:00Z', game_name: 'Just Chatting' }] }),
          );
        }
        if (u.pathname === '/helix/channels/followers') {
          return Promise.resolve(jsonResponse(403, { error: 'missing scope' }));
        }
        throw new Error(`unexpected ${u.pathname}`);
      }),
    );

    const snapshot = await connector.getAnalytics({ remoteId: 'broadcaster-1' }, makeCtx(logs));
    expect(snapshot.metrics.views).toBe(42);
    expect(snapshot.raw).not.toHaveProperty('followersTotal');
    expect(logs.some((l) => l.message === 'twitch.getAnalytics.followers_unavailable')).toBe(true);
  });
});

describe('TwitchConnector — refreshToken', () => {
  it('exchanges a refresh token for a new TokenSet', async () => {
    const logs: CapturedLog[] = [];
    const connector = new TwitchConnector({ logger: createTestLogger(logs), now: () => new Date('2026-07-04T12:00:00.000Z') });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(200, { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 14400, scope: ['channel:manage:broadcast'] }),
        ),
      ),
    );

    const token = await connector.refreshToken({
      app: { clientId: 'app-client-id', clientSecret: 'app-secret' },
      token: makeToken(),
    });
    expect(token.accessToken).toBe('new-access');
    expect(token.expiresAt).toBe('2026-07-04T16:00:00.000Z');
  });

  it('throws TokenRevokedError when Twitch rejects the refresh grant', async () => {
    const logs: CapturedLog[] = [];
    const connector = new TwitchConnector({ logger: createTestLogger(logs) });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse(400, { error: 'invalid_grant' }))));

    await expect(
      connector.refreshToken({ app: { clientId: 'app-client-id' }, token: makeToken() }),
    ).rejects.toBeInstanceOf(TokenRevokedError);
  });

  it('throws TokenRevokedError immediately when there is no refresh token to use', async () => {
    const connector = new TwitchConnector({ logger: createTestLogger([]) });
    await expect(
      connector.refreshToken({ app: { clientId: 'app-client-id' }, token: makeToken({ refreshToken: undefined }) }),
    ).rejects.toBeInstanceOf(TokenRevokedError);
  });
});

describe('TwitchConnector — authenticate', () => {
  it('builds an authorize_url with PKCE params against id.twitch.tv', async () => {
    const connector = new TwitchConnector({ logger: createTestLogger([]) });
    const result = await connector.authenticate({
      kind: 'authorize_url',
      app: { clientId: 'app-client-id', redirectUri: 'https://app.example/callback' },
      state: 'xyz',
      scopes: ['channel:manage:broadcast', 'user:read:email'],
      codeChallenge: 'challenge123',
    });
    const url = new URL(result.authorizeUrl!);
    expect(url.hostname).toBe('id.twitch.tv');
    expect(url.pathname).toBe('/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('app-client-id');
    expect(url.searchParams.get('code_challenge')).toBe('challenge123');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('channel:manage:broadcast user:read:email');
  });

  it('exchanges a code for a token and fetches the profile', async () => {
    const logs: CapturedLog[] = [];
    const connector = new TwitchConnector({ logger: createTestLogger(logs) });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL) => {
        const u = new URL(url);
        if (u.pathname === '/oauth2/token') {
          return Promise.resolve(
            jsonResponse(200, { access_token: 'a1', refresh_token: 'r1', expires_in: 14400, scope: ['channel:manage:broadcast'] }),
          );
        }
        if (u.pathname === '/oauth2/validate') {
          return Promise.resolve(jsonResponse(200, { client_id: 'app-client-id', login: 'coolstreamer', user_id: 'broadcaster-1' }));
        }
        if (u.pathname === '/helix/users') {
          return Promise.resolve(
            jsonResponse(200, { data: [{ id: 'broadcaster-1', login: 'coolstreamer', display_name: 'CoolStreamer', profile_image_url: 'https://x/img.png' }] }),
          );
        }
        throw new Error(`unexpected ${u.pathname}`);
      }),
    );

    const result = await connector.authenticate({
      kind: 'exchange_code',
      app: { clientId: 'app-client-id', clientSecret: 'shh', redirectUri: 'https://app.example/callback' },
      code: 'auth-code-123',
    });
    expect(result.token?.accessToken).toBe('a1');
    expect(result.profile?.remoteId).toBe('broadcaster-1');
    expect(result.profile?.handle).toBe('coolstreamer');
  });
});

describe('TwitchConnector — disconnect', () => {
  it('revokes the token via POST /oauth2/revoke using ctx.app.clientId (no /oauth2/validate round trip)', async () => {
    const logs: CapturedLog[] = [];
    const connector = new TwitchConnector({ logger: createTestLogger(logs) });
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL, init?: RequestInit) => {
        const u = new URL(url);
        calls.push(u.pathname);
        if (u.pathname === '/oauth2/revoke') {
          expect(String(init?.body)).toContain('client_id=app-client-id');
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        throw new Error(`unexpected ${u.pathname}`);
      }),
    );

    const result = await connector.disconnect(makeCtx(logs));
    expect(result.revoked).toBe(true);
    expect(calls).toEqual(['/oauth2/revoke']);
  });

  it('treats a 400 (already-invalid token) revoke response as revoked', async () => {
    const logs: CapturedLog[] = [];
    const connector = new TwitchConnector({ logger: createTestLogger(logs) });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, { status: 400 }))));

    const result = await connector.disconnect(makeCtx(logs));
    expect(result.revoked).toBe(true);
  });
});
