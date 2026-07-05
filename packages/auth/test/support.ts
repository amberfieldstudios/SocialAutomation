/**
 * Shared test harness: in-memory stores + a local key provider wired into a
 * TokenManager/AccountManager, plus token factories.
 */

import type { AppCredentials, TokenSet } from '@social/core';
import { createLogger } from '@social/logging';
import { AccountManager } from '../src/account-manager';
import { LocalKeyProvider } from '../src/crypto/keyring';
import {
  InMemoryAccountsStore,
  InMemoryAdvisoryLock,
  InMemoryTokensStore,
} from '../src/store';
import { TokenManager } from '../src/token-manager';
import type { TokenRefresher } from '../src/token-manager';
import { TokenVault } from '../src/vault';

export const TEST_KEY = Buffer.alloc(32, 7);

export function makeVault(): TokenVault {
  return new TokenVault(new LocalKeyProvider({ v1: TEST_KEY }, 'v1'));
}

export interface HarnessParams {
  connector: TokenRefresher;
  now?: () => Date;
  app?: AppCredentials;
  sink?: (line: string) => void;
}

export function newHarness(params: HarnessParams) {
  const accounts = new InMemoryAccountsStore();
  const tokens = new InMemoryTokensStore();
  const locks = new InMemoryAdvisoryLock();
  const vault = makeVault();
  const logger = createLogger({ level: 'trace', sink: params.sink ?? (() => {}) });
  const app = params.app ?? { clientId: 'test-client' };

  const tokenManager = new TokenManager({
    vault,
    accounts,
    tokens,
    locks,
    connectors: { get: () => params.connector },
    appCredentials: { get: () => app },
    logger,
    ...(params.now ? { now: params.now } : {}),
  });
  const accountManager = new AccountManager({
    accounts,
    tokens,
    tokenManager,
    logger,
    ...(params.now ? { now: params.now } : {}),
  });

  return { accounts, tokens, locks, vault, logger, tokenManager, accountManager };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A token that is already past its skew window (due for refresh). */
export function dueToken(overrides: Partial<TokenSet> = {}): TokenSet {
  const now = Date.now();
  return {
    accessToken: 'SECRET-ACCESS-OLD',
    refreshToken: 'SECRET-REFRESH-OLD',
    scopes: ['channel:manage:broadcast'],
    tokenType: 'Bearer',
    obtainedAt: new Date(now - 3_600_000).toISOString(),
    expiresAt: new Date(now - 60_000).toISOString(), // expired a minute ago
    ...overrides,
  };
}

/** A token comfortably in the future (not due). */
export function freshToken(overrides: Partial<TokenSet> = {}): TokenSet {
  const now = Date.now();
  return {
    accessToken: 'SECRET-ACCESS-FRESH',
    refreshToken: 'SECRET-REFRESH-FRESH',
    scopes: ['channel:manage:broadcast'],
    tokenType: 'Bearer',
    obtainedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
    ...overrides,
  };
}
