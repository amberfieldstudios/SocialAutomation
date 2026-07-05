/**
 * Reddit-specific behavior tests (self vs link posts, edit-body-only
 * constraint, analytics mapping, auth grants). Contract-level conformance
 * lives in conformance.test.ts. No real network access — `fetch` is fully
 * mocked; every call targets `oauth.reddit.com`/`www.reddit.com` only.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthError,
  NotSupportedError,
  TokenRevokedError,
  ValidationFailedError,
  type LogFields,
  type OperationContext,
  type PostPayload,
  type StructuredLogger,
  type TokenSet,
} from '@social/core';

import { RedditConnector } from '../src/connector';
import { capabilities } from '../src/capabilities';

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

const ACCESS_TOKEN = 'super-secret-reddit-access-token';
const REFRESH_TOKEN = 'super-secret-reddit-refresh-token';
const USER_AGENT = 'test:social-automation:1.0.0 (by /u/tester)';

function makeToken(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
    tokenType: 'bearer',
    scopes: ['submit', 'edit', 'read'],
    obtainedAt: new Date('2026-07-01T00:00:00.000Z').toISOString(),
    ...overrides,
  };
}

function makeCtx(logs: CapturedLog[], overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    token: makeToken(),
    app: { clientId: 'app-client-id', clientSecret: 'app-secret', extra: { userAgent: USER_AGENT } },
    accountId: 'acct-1',
    logger: createTestLogger(logs),
    ...overrides,
  };
}

describe('RedditConnector', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let logs: CapturedLog[];
  let connector: RedditConnector;

  beforeEach(() => {
    logs = [];
    connector = new RedditConnector({ logger: createTestLogger(logs), now: () => new Date('2026-07-04T12:00:00.000Z') });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  describe('validatePost', () => {
    it('accepts a valid self post', async () => {
      const payload: PostPayload = {
        platform: 'reddit',
        accountId: 'acct-1',
        title: 'A valid title',
        text: 'body text',
        platformOptions: { subreddit: 'test' },
      };
      const result = await connector.validatePost(payload);
      expect(result.ok).toBe(true);
    });

    it('accepts a valid link post', async () => {
      const payload: PostPayload = {
        platform: 'reddit',
        accountId: 'acct-1',
        title: 'A valid title',
        link: 'https://example.com/article',
        platformOptions: { subreddit: 'test' },
      };
      const result = await connector.validatePost(payload);
      expect(result.ok).toBe(true);
    });

    it('rejects a missing title', async () => {
      const payload: PostPayload = { platform: 'reddit', accountId: 'acct-1', platformOptions: { subreddit: 'test' } };
      const result = await connector.validatePost(payload);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === 'title_required')).toBe(true);
    });

    it('rejects a title over 300 characters', async () => {
      const payload: PostPayload = {
        platform: 'reddit',
        accountId: 'acct-1',
        title: 'x'.repeat(301),
        text: 'body',
        platformOptions: { subreddit: 'test' },
      };
      const result = await connector.validatePost(payload);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === 'text_too_long' && e.field === 'title')).toBe(true);
    });

    it('rejects a missing subreddit', async () => {
      const payload: PostPayload = { platform: 'reddit', accountId: 'acct-1', title: 'title', text: 'body' };
      const result = await connector.validatePost(payload);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === 'subreddit_required')).toBe(true);
    });

    it('rejects both text and link set together', async () => {
      const payload: PostPayload = {
        platform: 'reddit',
        accountId: 'acct-1',
        title: 'title',
        text: 'body',
        link: 'https://example.com',
        platformOptions: { subreddit: 'test' },
      };
      const result = await connector.validatePost(payload);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === 'self_and_link_mutually_exclusive')).toBe(true);
    });

    it('rejects media attachments (unsupported upload path)', async () => {
      const payload: PostPayload = {
        platform: 'reddit',
        accountId: 'acct-1',
        title: 'title',
        text: 'body',
        platformOptions: { subreddit: 'test' },
        media: [{ assetId: 'a1', mimeType: 'image/png', uri: 'file:///x.png' }],
      };
      const result = await connector.validatePost(payload);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === 'media_not_supported')).toBe(true);
    });

    it('warns (not errors) on tags — Reddit has no hashtag feature', async () => {
      const payload: PostPayload = {
        platform: 'reddit',
        accountId: 'acct-1',
        title: 'title',
        text: 'body',
        platformOptions: { subreddit: 'test' },
        tags: ['foo'],
      };
      const result = await connector.validatePost(payload);
      expect(result.ok).toBe(true);
      expect(result.warnings.some((w) => w.code === 'hashtags_cosmetic_only')).toBe(true);
    });
  });

  describe('publish', () => {
    it('submits a self post and returns the fullname as remoteId + subreddit in target', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        expect(new URL(url).hostname).toBe('oauth.reddit.com');
        return jsonResponse(200, { json: { errors: [], data: { id: 'abc123', name: 't3_abc123', url: 'https://reddit.com/r/test/abc123' } } });
      });
      const payload: PostPayload = {
        platform: 'reddit',
        accountId: 'acct-1',
        title: 'Hello',
        text: 'world',
        platformOptions: { subreddit: 'test' },
      };
      const result = await connector.publish(payload, makeCtx(logs));
      expect(result.remoteId).toBe('t3_abc123');
      expect(result.target?.extra?.subreddit).toBe('test');
      expect(result.remoteUrl).toBe('https://reddit.com/r/test/abc123');
    });

    it('submits a link post with kind=link and url set', async () => {
      let capturedBody = '';
      fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
        capturedBody = String(init.body);
        return jsonResponse(200, { json: { errors: [], data: { id: 'l1', name: 't3_l1', url: 'https://reddit.com/r/test/l1' } } });
      });
      const payload: PostPayload = {
        platform: 'reddit',
        accountId: 'acct-1',
        title: 'A link',
        link: 'https://example.com/article',
        platformOptions: { subreddit: 'test' },
      };
      await connector.publish(payload, makeCtx(logs));
      const params = new URLSearchParams(capturedBody);
      expect(params.get('kind')).toBe('link');
      expect(params.get('url')).toBe('https://example.com/article');
      expect(params.get('text')).toBeNull();
    });

    it('refuses an invalid payload without any network call', async () => {
      const payload: PostPayload = { platform: 'reddit', accountId: 'acct-1' };
      await expect(connector.publish(payload, makeCtx(logs))).rejects.toBeInstanceOf(ValidationFailedError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('surfaces a Reddit-side rejection (e.g. banned subreddit) as ValidationFailedError', async () => {
      fetchMock.mockImplementation(async () =>
        jsonResponse(200, { json: { errors: [['SUBREDDIT_NOEXIST', 'that subreddit does not exist', 'sr']] } }),
      );
      const payload: PostPayload = {
        platform: 'reddit',
        accountId: 'acct-1',
        title: 'Hello',
        text: 'world',
        platformOptions: { subreddit: 'doesnotexist' },
      };
      await expect(connector.publish(payload, makeCtx(logs))).rejects.toBeInstanceOf(ValidationFailedError);
    });

    it('sends the required descriptive User-Agent header', async () => {
      let headers: Record<string, string> = {};
      fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
        headers = init.headers as Record<string, string>;
        return jsonResponse(200, { json: { errors: [], data: { id: 'x', name: 't3_x', url: 'https://reddit.com/x' } } });
      });
      const payload: PostPayload = {
        platform: 'reddit',
        accountId: 'acct-1',
        title: 'Hello',
        text: 'world',
        platformOptions: { subreddit: 'test' },
      };
      await connector.publish(payload, makeCtx(logs));
      expect(headers['User-Agent']).toBe(USER_AGENT);
    });

    it('throws AuthError when no User-Agent is configured', async () => {
      const payload: PostPayload = {
        platform: 'reddit',
        accountId: 'acct-1',
        title: 'Hello',
        text: 'world',
        platformOptions: { subreddit: 'test' },
      };
      const ctx = makeCtx(logs, { app: { clientId: 'app-client-id' } });
      await expect(connector.publish(payload, ctx)).rejects.toBeInstanceOf(AuthError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('uploadMedia — unsupported', () => {
    it('throws NotSupportedError without any network call', async () => {
      await expect(
        connector.uploadMedia({ assetId: 'a1', mimeType: 'image/png', uri: 'file:///x.png' }, makeCtx(logs)),
      ).rejects.toBeInstanceOf(NotSupportedError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('edit — self-post body only', () => {
    it('edits the body via /api/editusertext', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        expect(new URL(url).pathname).toBe('/api/editusertext');
        return jsonResponse(200, { json: { errors: [] } });
      });
      const result = await connector.edit(
        { remoteId: 't3_abc123', payload: { platform: 'reddit', accountId: 'acct-1', text: 'updated body' } },
        makeCtx(logs),
      );
      expect(result.remoteId).toBe('t3_abc123');
    });

    it('rejects an edit with no text (title/link changes are impossible via the API)', async () => {
      await expect(
        connector.edit({ remoteId: 't3_abc123', payload: { platform: 'reddit', accountId: 'acct-1', title: 'new title' } }, makeCtx(logs)),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('logs a warning (not an error) if a title is also supplied alongside text', async () => {
      fetchMock.mockImplementation(async () => jsonResponse(200, { json: { errors: [] } }));
      await connector.edit(
        { remoteId: 't3_abc123', payload: { platform: 'reddit', accountId: 'acct-1', title: 'ignored', text: 'updated body' } },
        makeCtx(logs),
      );
      expect(logs.some((l) => l.message === 'reddit.edit.title_ignored')).toBe(true);
    });
  });

  describe('delete', () => {
    it('deletes via /api/del with the fullname', async () => {
      let capturedBody = '';
      fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
        expect(new URL(url).pathname).toBe('/api/del');
        capturedBody = String(init.body);
        return jsonResponse(200, {});
      });
      const result = await connector.delete({ remoteId: 't3_abc123' }, makeCtx(logs));
      expect(result.removed).toBe(true);
      expect(new URLSearchParams(capturedBody).get('id')).toBe('t3_abc123');
    });
  });

  describe('getAnalytics', () => {
    it('maps score/num_comments/upvote_ratio from /api/info', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        expect(new URL(url).pathname).toBe('/api/info');
        return jsonResponse(200, {
          data: {
            children: [
              { data: { id: 'abc123', name: 't3_abc123', score: 42, upvote_ratio: 0.87, num_comments: 5, permalink: '/r/test/abc123' } },
            ],
          },
        });
      });
      const snapshot = await connector.getAnalytics({ remoteId: 't3_abc123' }, makeCtx(logs));
      expect(snapshot.metrics.likes).toBe(42);
      expect(snapshot.metrics.comments).toBe(5);
      expect(snapshot.raw).toMatchObject({ upvoteRatio: 0.87 });
    });

    it('throws AuthError when the thing is not found', async () => {
      fetchMock.mockImplementation(async () => jsonResponse(200, { data: { children: [] } }));
      await expect(connector.getAnalytics({ remoteId: 't3_missing' }, makeCtx(logs))).rejects.toBeInstanceOf(AuthError);
    });
  });

  describe('authenticate', () => {
    it('builds an authorize_url pointing at www.reddit.com/api/v1/authorize', async () => {
      const result = await connector.authenticate({
        kind: 'authorize_url',
        app: { clientId: 'app-client-id', redirectUri: 'https://app.example/callback' },
        state: 'xyz',
        scopes: ['submit', 'identity'],
      });
      expect(result.authorizeUrl).toContain('https://www.reddit.com/api/v1/authorize');
      expect(result.authorizeUrl).toContain('client_id=app-client-id');
      expect(result.authorizeUrl).toContain('state=xyz');
    });

    it('exchanges a password grant for a token (script apps)', async () => {
      fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/api/v1/access_token') {
          expect(parsed.hostname).toBe('www.reddit.com');
          expect((init.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
          return jsonResponse(200, { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, scope: 'submit identity' });
        }
        expect(parsed.pathname).toBe('/api/v1/me');
        return jsonResponse(200, { id: 'user1', name: 'my_username' });
      });
      const result = await connector.authenticate({
        kind: 'password',
        app: { clientId: 'app-client-id', clientSecret: 'app-secret', extra: { userAgent: USER_AGENT } },
        identifier: 'my_username',
        password: 'my_password',
      });
      expect(result.token?.accessToken).toBe('new-access');
      expect(result.token?.scopes).toEqual(['submit', 'identity']);
    });

    it('never logs the password/secret during a password-grant exchange', async () => {
      fetchMock.mockImplementation(async () => jsonResponse(200, { access_token: 'new-access', scope: 'submit' }));
      await connector.authenticate({
        kind: 'password',
        app: { clientId: 'app-client-id', clientSecret: 'app-secret', extra: { userAgent: USER_AGENT } },
        identifier: 'my_username',
        password: 'super-secret-password',
      });
      const serialized = JSON.stringify(logs);
      expect(serialized).not.toContain('super-secret-password');
      expect(serialized).not.toContain('app-secret');
    });
  });

  describe('refreshToken', () => {
    it('throws TokenRevokedError when there is no refresh token', async () => {
      await expect(connector.refreshToken({ app: { clientId: 'c' }, token: makeToken({ refreshToken: undefined }) })).rejects.toBeInstanceOf(
        TokenRevokedError,
      );
    });

    it('exchanges the refresh token for a fresh access token', async () => {
      fetchMock.mockImplementation(async () => jsonResponse(200, { access_token: 'refreshed-access', scope: 'submit' }));
      const result = await connector.refreshToken({ app: { clientId: 'app-client-id', clientSecret: 'app-secret' }, token: makeToken() });
      expect(result.accessToken).toBe('refreshed-access');
    });
  });

  describe('disconnect', () => {
    it('revokes the token via /api/v1/revoke_token', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        expect(new URL(url).pathname).toBe('/api/v1/revoke_token');
        return new Response(null, { status: 204 });
      });
      const result = await connector.disconnect(makeCtx(logs));
      expect(result.revoked).toBe(true);
    });
  });

  describe('capability descriptor', () => {
    it('declares uploadMedia and only uploadMedia as the sole unsupported operation', () => {
      const unsupported = Object.entries(capabilities.operations).filter(([, v]) => v === false);
      expect(unsupported).toEqual([['uploadMedia', false]]);
    });
  });
});
