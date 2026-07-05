import type { RefreshInput, TokenSet } from '@social/core';
import { TokenRevokedError, TransientError } from '@social/core';
import { createLogger } from '@social/logging';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountManager } from '../src/account-manager';
import { ReauthRequiredError } from '../src/errors';
import {
  InMemoryAccountsStore,
  InMemoryAdvisoryLock,
  InMemoryTokensStore,
} from '../src/store';
import { TokenManager } from '../src/token-manager';
import type { TokenRefresher } from '../src/token-manager';
import { delay, dueToken, freshToken, makeVault, newHarness } from './support';

/** A counting refresher that returns a fresh, far-future token each call. */
function countingRefresher(delayMs = 5): { connector: TokenRefresher; calls: () => number } {
  let calls = 0;
  const connector: TokenRefresher = {
    async refreshToken(input: RefreshInput): Promise<TokenSet> {
      calls += 1;
      const seq = calls;
      if (delayMs > 0) await delay(delayMs);
      const now = Date.now();
      return {
        accessToken: `SECRET-ACCESS-NEW-${seq}`,
        refreshToken: `SECRET-REFRESH-NEW-${seq}`,
        scopes: input.token.scopes,
        tokenType: 'Bearer',
        obtainedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 3_600_000).toISOString(),
      };
    },
  };
  return { connector, calls: () => calls };
}

describe('TokenManager createContext / refresh', () => {
  it('returns the current token without refreshing when it is fresh', async () => {
    const { connector, calls } = countingRefresher();
    const h = newHarness({ connector });
    const acct = await h.accountManager.addAccount({ platformId: 'twitch', remoteId: 'r1' }, freshToken());

    const ctx = await h.tokenManager.createContext(acct.id);
    expect(ctx.token.accessToken).toBe('SECRET-ACCESS-FRESH');
    expect(ctx.accountId).toBe(acct.id);
    expect(calls()).toBe(0);
  });

  it('lazily refreshes a due token before handing back a context', async () => {
    const { connector, calls } = countingRefresher();
    const h = newHarness({ connector });
    const acct = await h.accountManager.addAccount({ platformId: 'twitch', remoteId: 'r1' }, dueToken());

    const ctx = await h.tokenManager.createContext(acct.id);
    expect(calls()).toBe(1);
    expect(ctx.token.accessToken).toBe('SECRET-ACCESS-NEW-1');
    // The new token was written back as the current row.
    const current = await h.tokens.getCurrent(acct.id);
    expect(current?.isCurrent).toBe(true);
    const history = await h.tokens.listByAccount(acct.id);
    expect(history.filter((r) => r.isCurrent)).toHaveLength(1);
    expect(history.filter((r) => !r.isCurrent)).toHaveLength(1); // old row retained, flipped
  });

  it('coalesces concurrent createContext calls onto a single refresh (single-flight)', async () => {
    const { connector, calls } = countingRefresher(20);
    const h = newHarness({ connector });
    const acct = await h.accountManager.addAccount({ platformId: 'twitch', remoteId: 'r1' }, dueToken());

    const results = await Promise.all(Array.from({ length: 6 }, () => h.tokenManager.createContext(acct.id)));

    expect(calls()).toBe(1);
    for (const ctx of results) {
      expect(ctx.token.accessToken).toBe('SECRET-ACCESS-NEW-1');
    }
  });

  it('serializes refresh across workers via the advisory lock (re-check finds it fresh)', async () => {
    // Two managers = two processes sharing one store + one lock.
    const accounts = new InMemoryAccountsStore();
    const tokens = new InMemoryTokensStore();
    const locks = new InMemoryAdvisoryLock();
    const vault = makeVault();
    const logger = createLogger({ level: 'trace', sink: () => {} });
    const { connector, calls } = countingRefresher(20);

    const commonDeps = {
      vault,
      accounts,
      tokens,
      locks,
      connectors: { get: () => connector },
      appCredentials: { get: () => ({ clientId: 'c' }) },
      logger,
    };
    const tmA = new TokenManager(commonDeps);
    const tmB = new TokenManager(commonDeps);
    const am = new AccountManager({ accounts, tokens, tokenManager: tmA, logger });
    const acct = await am.addAccount({ platformId: 'twitch', remoteId: 'r1' }, dueToken());

    const [a, b] = await Promise.all([tmA.ensureFresh(acct.id), tmB.ensureFresh(acct.id)]);

    // Only one worker actually calls the platform; the other re-checks under the
    // lock, sees a fresh token, and returns it.
    expect(calls()).toBe(1);
    expect(a.accessToken).toBe('SECRET-ACCESS-NEW-1');
    expect(b.accessToken).toBe('SECRET-ACCESS-NEW-1');
  });

  it('maps a revoked refresh to ReauthRequiredError and marks the account revoked', async () => {
    const connector: TokenRefresher = {
      refreshToken() {
        return Promise.reject(new TokenRevokedError());
      },
    };
    const h = newHarness({ connector });
    const acct = await h.accountManager.addAccount({ platformId: 'twitch', remoteId: 'r1' }, dueToken());

    await expect(h.tokenManager.createContext(acct.id)).rejects.toBeInstanceOf(ReauthRequiredError);
    const after = await h.accountManager.getAccount(acct.id);
    expect(after?.status).toBe('revoked');
  });

  it('propagates a transient refresh error without marking the account (queue retries)', async () => {
    const connector: TokenRefresher = {
      refreshToken() {
        return Promise.reject(new TransientError('network blip'));
      },
    };
    const h = newHarness({ connector });
    const acct = await h.accountManager.addAccount({ platformId: 'twitch', remoteId: 'r1' }, dueToken());

    await expect(h.tokenManager.createContext(acct.id)).rejects.toBeInstanceOf(TransientError);
    const after = await h.accountManager.getAccount(acct.id);
    expect(after?.status).toBe('active');
  });

  it('never refreshes a non-expiring token (e.g. Discord bot/webhook)', async () => {
    const { connector, calls } = countingRefresher();
    const h = newHarness({ connector });
    const acct = await h.accountManager.addAccount(
      { platformId: 'discord', remoteId: 'guild-1' },
      { accessToken: 'SECRET-BOT-TOKEN', scopes: [], tokenType: 'bot', obtainedAt: new Date().toISOString() },
      { tokenType: 'bot' },
    );

    const ctx = await h.tokenManager.createContext(acct.id);
    expect(calls()).toBe(0);
    expect(ctx.token.accessToken).toBe('SECRET-BOT-TOKEN');
  });
});

describe('TokenManager logging redaction', () => {
  let lines: string[];

  beforeEach(() => {
    lines = [];
  });

  it('emits state-change logs with NO plaintext token values', async () => {
    const { connector } = countingRefresher(0);
    const h = newHarness({ connector, sink: (l) => lines.push(l) });

    const acct = await h.accountManager.addAccount({ platformId: 'twitch', remoteId: 'r1' }, dueToken());
    await h.tokenManager.createContext(acct.id); // triggers a refresh -> token_refreshed log

    expect(lines.length).toBeGreaterThan(0);
    const blob = lines.join('\n');
    // No secret material from any token (old, refresh, or newly-minted) appears.
    for (const secret of [
      'SECRET-ACCESS-OLD',
      'SECRET-REFRESH-OLD',
      'SECRET-ACCESS-NEW-1',
      'SECRET-REFRESH-NEW-1',
    ]) {
      expect(blob).not.toContain(secret);
    }
    // But safe correlation fields ARE present.
    expect(blob).toContain('auth.token_refreshed');
    expect(blob).toContain(acct.id);
    expect(blob).toContain('local:v1'); // keyRef is safe to log
  });

  it('does not place token values in the log even when the sink sees the refresh', async () => {
    // Extra guard: spy the sink and assert the JSON never carries a token field value.
    const sink = vi.fn((_line: string) => {});
    const { connector } = countingRefresher(0);
    const h = newHarness({ connector, sink });
    const acct = await h.accountManager.addAccount({ platformId: 'twitch', remoteId: 'r1' }, dueToken());
    await h.tokenManager.createContext(acct.id);

    for (const [line] of sink.mock.calls) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed.accessToken).toBeUndefined();
      expect(parsed.refreshToken).toBeUndefined();
    }
  });
});
