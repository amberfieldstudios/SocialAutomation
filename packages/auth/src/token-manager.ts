/**
 * TokenManager — stores tokens, refreshes them (proactive + lazy) with skew,
 * and hands a decrypted `OperationContext` to connectors (docs/AUTH.md §3, §6).
 *
 * Refresh concurrency is guarded in two layers:
 *  1. in-process single-flight: a `Map<accountId, Promise>` coalesces concurrent
 *     callers in one worker onto a single refresh.
 *  2. cross-worker advisory lock: `refresh:<accountId>` serializes refreshes
 *     across processes; after acquiring it we RE-CHECK whether the token is
 *     still due (another worker may have already refreshed).
 *
 * Write-back is atomic: `TokensStore.rotateCurrent` flips the old row and inserts
 * the new current row under the partial unique index.
 *
 * SECURITY: every state change is logged with only safe fields (accountId,
 * platform, keyRef, scope NAMES, expiresAt). Token values are never passed to
 * the logger.
 */

import type {
  AppCredentials,
  OperationContext,
  RefreshInput,
  StructuredLogger,
  TokenSet,
} from '@social/core';
import { ConnectorError, TokenRevokedError } from '@social/core';
import { buildOperationContext } from './context';
import { AccountNotFoundError, NoCurrentTokenError, ReauthRequiredError } from './errors';
import type { AccountsStore, AdvisoryLock, TokensStore } from './store';
import { newId } from './store';
import type { TokenVault } from './vault';
import { TOKEN_FIELD } from './types';
import type {
  AccountTokenRecord,
  CreateContextOptions,
  RefreshSkewConfig,
  StoreTokenOptions,
} from './types';

/** Minimal connector seam the manager needs: only `refreshToken`. */
export interface TokenRefresher {
  refreshToken(input: RefreshInput): Promise<TokenSet>;
}

/** Resolves the connector (from the plugin registry) for a platform. */
export interface ConnectorResolver {
  get(platformId: string): TokenRefresher | Promise<TokenRefresher>;
}

/** Resolves the developer app credentials for a platform. */
export interface AppCredentialsResolver {
  get(platformId: string): AppCredentials | Promise<AppCredentials>;
}

export interface TokenManagerDeps {
  vault: TokenVault;
  accounts: AccountsStore;
  tokens: TokensStore;
  locks: AdvisoryLock;
  connectors: ConnectorResolver;
  appCredentials: AppCredentialsResolver;
  logger: StructuredLogger;
  now?: () => Date;
  skew?: RefreshSkewConfig;
  /** Advisory-lock hold time; a real DB uses this to reclaim a stale lock. Default 30s. */
  lockTtlMs?: number;
  /** Identifier for this worker/process (advisory-lock holder). */
  workerId?: string;
}

const DEFAULT_MIN_SKEW_MS = 60_000;
const DEFAULT_LIFETIME_FRACTION = 0.1;
const DEFAULT_LOCK_TTL_MS = 30_000;

export class TokenManager {
  private readonly deps: TokenManagerDeps;
  private readonly now: () => Date;
  private readonly minSkewMs: number;
  private readonly lifetimeFraction: number;
  private readonly lockTtlMs: number;
  private readonly workerId: string;
  private readonly inFlight = new Map<string, Promise<TokenSet>>();

  constructor(deps: TokenManagerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.minSkewMs = deps.skew?.minSkewMs ?? DEFAULT_MIN_SKEW_MS;
    this.lifetimeFraction = deps.skew?.lifetimeFraction ?? DEFAULT_LIFETIME_FRACTION;
    this.lockTtlMs = deps.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
    this.workerId = deps.workerId ?? `worker-${newId()}`;
  }

  // -------------------------------------------------------------------------
  // Store
  // -------------------------------------------------------------------------

  /**
   * Seal `token` and persist it. Default becomes the account's current token via
   * an atomic rotate; `isCurrent: false` inserts a non-current row (e.g. a
   * Bluesky app-password bootstrap secret).
   */
  async storeTokens(accountId: string, token: TokenSet, options: StoreTokenOptions = {}): Promise<AccountTokenRecord> {
    const account = await this.deps.accounts.getById(accountId);
    if (!account) throw new AccountNotFoundError(accountId);

    const isCurrent = options.isCurrent ?? true;
    const row = await this.buildTokenRow(accountId, token, options.tokenType, isCurrent);
    const saved = isCurrent ? await this.deps.tokens.rotateCurrent(row) : await this.deps.tokens.insert(row);

    this.logger(account.platformId, accountId).info('auth.token_stored', {
      accountId,
      platform: account.platformId,
      keyRef: saved.encryptionKeyRef,
      tokenType: saved.tokenType,
      isCurrent: saved.isCurrent,
      scopes: saved.scopes,
      expiresAt: saved.expiresAt ?? null,
    });
    return saved;
  }

  // -------------------------------------------------------------------------
  // Read + refresh
  // -------------------------------------------------------------------------

  /**
   * Load the account's current token, decrypt it, refresh if due/expired, and
   * return an `OperationContext` carrying the fresh (in-memory only) token. This
   * is the sole path by which a decrypted token reaches a connector.
   */
  async createContext(accountId: string, options: CreateContextOptions = {}): Promise<OperationContext> {
    const account = await this.deps.accounts.getById(accountId);
    if (!account) throw new AccountNotFoundError(accountId);

    const current = await this.deps.tokens.getCurrent(accountId);
    if (!current) throw new NoCurrentTokenError(accountId);

    let token = await this.openToken(accountId, current);
    if (this.isDue(token)) {
      token = await this.ensureFresh(accountId);
    }

    const logger = (options.logger ?? this.deps.logger).child({ accountId, platform: account.platformId });
    const app = await this.deps.appCredentials.get(account.platformId);
    return buildOperationContext({
      token,
      app,
      accountId,
      logger,
      ...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}),
    });
  }

  /**
   * Ensure the account's current token is fresh, refreshing if due. Concurrent
   * callers in this process coalesce onto one refresh (single-flight).
   */
  ensureFresh(accountId: string): Promise<TokenSet> {
    const existing = this.inFlight.get(accountId);
    if (existing) return existing;

    const run = this.doRefresh(accountId).finally(() => {
      this.inFlight.delete(accountId);
    });
    this.inFlight.set(accountId, run);
    return run;
  }

  private async doRefresh(accountId: string): Promise<TokenSet> {
    return this.deps.locks.withLock(`refresh:${accountId}`, this.workerId, this.lockTtlMs, async () => {
      const account = await this.deps.accounts.getById(accountId);
      if (!account) throw new AccountNotFoundError(accountId);

      const current = await this.deps.tokens.getCurrent(accountId);
      if (!current) throw new NoCurrentTokenError(accountId);

      const token = await this.openToken(accountId, current);
      // Re-check under the lock: another worker may have refreshed already.
      if (!this.isDue(token)) {
        return token;
      }
      if (!token.refreshToken) {
        // Nothing to refresh with; treat as needing re-auth rather than looping.
        await this.markReauth(accountId, 'error');
        throw new ReauthRequiredError(accountId, 'error', 'Token is due but no refresh token is available.');
      }

      const log = this.logger(account.platformId, accountId);
      const app = await this.deps.appCredentials.get(account.platformId);
      const connector = await this.deps.connectors.get(account.platformId);

      let fresh: TokenSet;
      try {
        fresh = await connector.refreshToken({ app, token });
      } catch (error) {
        if (this.isRevocation(error)) {
          const status = error instanceof TokenRevokedError ? 'revoked' : 'error';
          await this.markReauth(accountId, status);
          log.warn('auth.reauth_required', {
            accountId,
            platform: account.platformId,
            reason: status,
            errorCode: error instanceof ConnectorError ? error.code : 'unknown',
          });
          throw new ReauthRequiredError(accountId, status, 'Refresh failed; re-authentication required.', {
            cause: error,
          });
        }
        // Transient/other: let the caller (and the queue's backoff) retry.
        log.warn('auth.refresh_failed', {
          accountId,
          platform: account.platformId,
          errorCode: error instanceof ConnectorError ? error.code : 'unknown',
        });
        throw error;
      }

      const row = await this.buildTokenRow(accountId, fresh, fresh.tokenType ?? current.tokenType ?? undefined, true);
      const saved = await this.deps.tokens.rotateCurrent(row);

      log.info('auth.token_refreshed', {
        accountId,
        platform: account.platformId,
        keyRef: saved.encryptionKeyRef,
        scopes: saved.scopes,
        expiresAt: saved.expiresAt ?? null,
        rotated: fresh.refreshToken !== token.refreshToken,
      });
      return fresh;
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async openToken(accountId: string, row: AccountTokenRecord): Promise<TokenSet> {
    const bundle = await this.deps.vault.open(accountId, TOKEN_FIELD, {
      ciphertext: row.accessTokenCiphertext,
      nonce: row.nonce,
      authTag: row.authTag ?? '',
      keyRef: row.encryptionKeyRef,
      alg: row.encryptionAlg,
    });
    return {
      accessToken: bundle.access,
      ...(bundle.refresh ? { refreshToken: bundle.refresh } : {}),
      ...(row.tokenType ? { tokenType: row.tokenType } : {}),
      scopes: row.scopes,
      ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
      obtainedAt: row.obtainedAt,
    };
  }

  private async buildTokenRow(
    accountId: string,
    token: TokenSet,
    tokenType: string | undefined,
    isCurrent: boolean,
  ): Promise<AccountTokenRecord> {
    const sealed = await this.deps.vault.seal(accountId, TOKEN_FIELD, {
      access: token.accessToken,
      ...(token.refreshToken ? { refresh: token.refreshToken } : {}),
    });
    const nowIso = this.now().toISOString();
    return {
      id: newId(),
      accountId,
      accessTokenCiphertext: sealed.ciphertext,
      refreshTokenCiphertext: null, // single-blob: refresh rides inside the bundle
      encryptionKeyRef: sealed.keyRef,
      encryptionAlg: sealed.alg,
      nonce: sealed.nonce,
      authTag: sealed.authTag,
      tokenType: token.tokenType ?? tokenType ?? null,
      scopes: token.scopes,
      expiresAt: token.expiresAt ?? null,
      obtainedAt: token.obtainedAt ?? nowIso,
      rotatedAt: null,
      isCurrent,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
  }

  /** A token is due when now >= expiresAt - skew; skew = max(minSkew, fraction*lifetime). */
  private isDue(token: TokenSet): boolean {
    if (!token.expiresAt) return false; // non-expiring (bot/webhook) never refreshes
    const expiresAt = Date.parse(token.expiresAt);
    if (Number.isNaN(expiresAt)) return false;
    const obtainedAt = token.obtainedAt ? Date.parse(token.obtainedAt) : NaN;
    const lifetimeMs = Number.isNaN(obtainedAt) ? 0 : Math.max(0, expiresAt - obtainedAt);
    const skewMs = Math.max(this.minSkewMs, Math.floor(lifetimeMs * this.lifetimeFraction));
    return this.now().getTime() >= expiresAt - skewMs;
  }

  private isRevocation(error: unknown): boolean {
    if (error instanceof TokenRevokedError) return true;
    return error instanceof ConnectorError && (error.code === 'token_revoked' || error.code === 'auth_failed');
  }

  private async markReauth(accountId: string, status: 'revoked' | 'error'): Promise<void> {
    await this.deps.accounts.update(accountId, { status, updatedAt: this.now().toISOString() });
  }

  private logger(platformId: string, accountId: string): StructuredLogger {
    return this.deps.logger.child({ platform: platformId, accountId });
  }
}
