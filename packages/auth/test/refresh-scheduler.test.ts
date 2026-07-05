import type { RefreshInput, TokenSet } from '@social/core';
import { TokenRevokedError } from '@social/core';
import { describe, expect, it } from 'vitest';
import { RefreshScheduler } from '../src/refresh-scheduler';
import { newHarness } from './support';

/** A refresher counting calls, returning a far-future token each time. */
function countingRefresher(): { connector: { refreshToken(i: RefreshInput): Promise<TokenSet> }; calls: () => number } {
  let calls = 0;
  return {
    connector: {
      refreshToken(input: RefreshInput): Promise<TokenSet> {
        calls += 1;
        const seq = calls;
        const now = Date.now();
        return Promise.resolve({
          accessToken: `SECRET-ACCESS-NEW-${seq}`,
          refreshToken: `SECRET-REFRESH-NEW-${seq}`,
          tokenType: 'Bearer',
          scopes: input.token.scopes,
          obtainedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 3_600_000).toISOString(),
        });
      },
    },
    calls: () => calls,
  };
}

/** A token expiring soon (within the 15-min horizon) and due per skew. */
function nearExpiryToken(overrides: Partial<TokenSet> = {}): TokenSet {
  const now = Date.now();
  return {
    accessToken: 'SECRET-ACCESS-OLD',
    refreshToken: 'SECRET-REFRESH-OLD',
    tokenType: 'Bearer',
    scopes: ['channel:manage:broadcast'],
    obtainedAt: new Date(now - 3_600_000).toISOString(),
    expiresAt: new Date(now + 5 * 60_000).toISOString(), // 5 min from now
    ...overrides,
  };
}

function buildScheduler(h: ReturnType<typeof newHarness>) {
  return new RefreshScheduler({
    accounts: h.accounts,
    tokens: h.tokens,
    tokenManager: h.tokenManager,
    logger: h.logger,
  });
}

describe('RefreshScheduler.scanOnce', () => {
  it('picks up a near-expiry token and refreshes it exactly once', async () => {
    const { connector, calls } = countingRefresher();
    const h = newHarness({ connector });
    const acct = await h.accountManager.addAccount({ platformId: 'twitch', remoteId: 'r1' }, nearExpiryToken());
    const scheduler = buildScheduler(h);

    const first = await scheduler.scanOnce();
    expect(first.scanned).toBe(1);
    expect(first.due).toBe(1);
    expect(first.refreshed).toBe(1);
    expect(calls()).toBe(1);

    // The refreshed token was written back as the current row.
    const current = await h.tokens.getCurrent(acct.id);
    expect(current?.isCurrent).toBe(true);

    // A second pass finds the (now far-future) token not due -> no extra refresh.
    const second = await scheduler.scanOnce();
    expect(second.due).toBe(0);
    expect(second.refreshed).toBe(0);
    expect(calls()).toBe(1); // still exactly one refresh overall
  });

  it('skips a non-expiring token (Discord bot/webhook)', async () => {
    const { connector, calls } = countingRefresher();
    const h = newHarness({ connector });
    await h.accountManager.addAccount(
      { platformId: 'discord', remoteId: 'guild-1' },
      { accessToken: 'SECRET-BOT', scopes: [], tokenType: 'bot', obtainedAt: new Date().toISOString() },
      { tokenType: 'bot' },
    );
    const scheduler = buildScheduler(h);

    const result = await scheduler.scanOnce();
    expect(result.due).toBe(0);
    expect(calls()).toBe(0);
  });

  it('leaves a comfortably-fresh token alone', async () => {
    const { connector, calls } = countingRefresher();
    const h = newHarness({ connector });
    await h.accountManager.addAccount(
      { platformId: 'twitch', remoteId: 'r1' },
      nearExpiryToken({ expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
    );
    const scheduler = buildScheduler(h);

    const result = await scheduler.scanOnce();
    expect(result.due).toBe(0);
    expect(calls()).toBe(0);
  });

  it('isolates an account needing re-auth without failing the pass', async () => {
    const connector = {
      refreshToken(): Promise<TokenSet> {
        return Promise.reject(new TokenRevokedError());
      },
    };
    const h = newHarness({ connector });
    await h.accountManager.addAccount({ platformId: 'twitch', remoteId: 'r1' }, nearExpiryToken());
    const scheduler = buildScheduler(h);

    const result = await scheduler.scanOnce();
    expect(result.due).toBe(1);
    expect(result.refreshed).toBe(0);
    expect(result.reauthRequired).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('refreshes multiple due accounts in one pass', async () => {
    const { connector, calls } = countingRefresher();
    const h = newHarness({ connector });
    await h.accountManager.addAccount({ platformId: 'twitch', remoteId: 'r1' }, nearExpiryToken());
    await h.accountManager.addAccount({ platformId: 'twitch', remoteId: 'r2' }, nearExpiryToken());
    await h.accountManager.addAccount({ platformId: 'twitch', remoteId: 'r3' }, nearExpiryToken());
    const scheduler = buildScheduler(h);

    const result = await scheduler.scanOnce();
    expect(result.due).toBe(3);
    expect(result.refreshed).toBe(3);
    expect(calls()).toBe(3);
  });
});
