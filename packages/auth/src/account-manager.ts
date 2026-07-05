/**
 * AccountManager — multi-account CRUD with profile metadata (docs/AUTH.md §6).
 *
 * Several accounts per platform are first-class (two Twitch channels, company +
 * personal Twitter). Each distinct platform account is one `accounts` row keyed
 * by (platformId, remoteId); re-pairing the same remote account UPDATES the row
 * rather than creating a duplicate.
 *
 * `createContext` delegates to `TokenManager`, which decrypts and refreshes as
 * needed. This manager never touches ciphertext or key material directly.
 */

import type { OperationContext, PlatformProfile, StructuredLogger, TokenSet } from '@social/core';
import { AccountNotFoundError } from './errors';
import type { AccountsStore, TokensStore } from './store';
import { newId } from './store';
import type { TokenManager } from './token-manager';
import type {
  AccountRecord,
  AccountStatus,
  AccountSummary,
  AddAccountInput,
  CreateContextOptions,
  ListAccountsFilter,
  StoreTokenOptions,
} from './types';

export interface AccountManagerDeps {
  accounts: AccountsStore;
  tokens: TokensStore;
  tokenManager: TokenManager;
  logger: StructuredLogger;
  now?: () => Date;
}

/** Map a `PlatformProfile` (from a connector) onto account-row profile fields. */
export function profileToAccountInput(platformId: string, profile: PlatformProfile): AddAccountInput {
  return {
    platformId,
    remoteId: profile.remoteId,
    ...(profile.handle !== undefined ? { handle: profile.handle } : {}),
    ...(profile.displayName !== undefined ? { displayName: profile.displayName } : {}),
    ...(profile.avatarUrl !== undefined ? { avatarUrl: profile.avatarUrl } : {}),
    ...(profile.profileUrl !== undefined ? { profileUrl: profile.profileUrl } : {}),
  };
}

export class AccountManager {
  private readonly now: () => Date;

  constructor(private readonly deps: AccountManagerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Add or update an account (upsert on platformId+remoteId), optionally storing
   * an initial token. Returns a secret-free summary. Status is set to `active`
   * and `connected_at` stamped when a token is provided.
   */
  async addAccount(
    input: AddAccountInput,
    token?: TokenSet,
    tokenOptions?: StoreTokenOptions,
  ): Promise<AccountSummary> {
    const nowIso = this.now().toISOString();
    const existing = await this.deps.accounts.getByRemote(input.platformId, input.remoteId);

    let account: AccountRecord;
    if (existing) {
      account = await this.deps.accounts.update(existing.id, {
        handle: input.handle ?? existing.handle ?? null,
        displayName: input.displayName ?? existing.displayName ?? null,
        avatarUrl: input.avatarUrl ?? existing.avatarUrl ?? null,
        profileUrl: input.profileUrl ?? existing.profileUrl ?? null,
        profileMetadata: input.profileMetadata ?? existing.profileMetadata ?? null,
        ...(token ? { status: 'active', connectedAt: nowIso } : {}),
        updatedAt: nowIso,
      });
    } else {
      account = await this.deps.accounts.insert({
        id: newId(),
        platformId: input.platformId,
        remoteId: input.remoteId,
        handle: input.handle ?? null,
        displayName: input.displayName ?? null,
        avatarUrl: input.avatarUrl ?? null,
        profileUrl: input.profileUrl ?? null,
        profileMetadata: input.profileMetadata ?? null,
        status: 'active',
        connectedAt: token ? nowIso : null,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    }

    if (token) {
      await this.deps.tokenManager.storeTokens(account.id, token, tokenOptions);
    }

    this.deps.logger.child({ platform: account.platformId, accountId: account.id }).info('auth.account_added', {
      accountId: account.id,
      platform: account.platformId,
      remoteId: account.remoteId,
      status: account.status,
      upsert: Boolean(existing),
    });
    return this.toSummary(account);
  }

  /** List accounts (optionally filtered by platform/status). */
  async listAccounts(filter?: ListAccountsFilter): Promise<AccountSummary[]> {
    const rows = await this.deps.accounts.list(filter);
    return Promise.all(rows.map((row) => this.toSummary(row)));
  }

  /** Get one account summary, or `undefined` if it does not exist. */
  async getAccount(accountId: string): Promise<AccountSummary | undefined> {
    const row = await this.deps.accounts.getById(accountId);
    return row ? this.toSummary(row) : undefined;
  }

  /** Update mutable profile metadata on an existing account. */
  async updateProfile(accountId: string, profile: Partial<AddAccountInput>): Promise<AccountSummary> {
    const existing = await this.deps.accounts.getById(accountId);
    if (!existing) throw new AccountNotFoundError(accountId);
    const updated = await this.deps.accounts.update(accountId, {
      ...(profile.handle !== undefined ? { handle: profile.handle } : {}),
      ...(profile.displayName !== undefined ? { displayName: profile.displayName } : {}),
      ...(profile.avatarUrl !== undefined ? { avatarUrl: profile.avatarUrl } : {}),
      ...(profile.profileUrl !== undefined ? { profileUrl: profile.profileUrl } : {}),
      ...(profile.profileMetadata !== undefined ? { profileMetadata: profile.profileMetadata } : {}),
      updatedAt: this.now().toISOString(),
    });
    return this.toSummary(updated);
  }

  /** Set an account's status (e.g. `disconnected`, `error`). */
  async setStatus(accountId: string, status: AccountStatus): Promise<AccountSummary> {
    const existing = await this.deps.accounts.getById(accountId);
    if (!existing) throw new AccountNotFoundError(accountId);
    const updated = await this.deps.accounts.update(accountId, { status, updatedAt: this.now().toISOString() });
    return this.toSummary(updated);
  }

  /**
   * Remove an account: purge all its token rows (source of truth for "we no
   * longer hold this credential") then delete the account row. Platform-side
   * revocation via the connector's `disconnect` is a separate, best-effort step.
   */
  async removeAccount(accountId: string): Promise<void> {
    await this.deps.tokens.deleteByAccount(accountId);
    await this.deps.accounts.delete(accountId);
    this.deps.logger.child({ accountId }).info('auth.account_removed', { accountId });
  }

  /** Build a decrypted `OperationContext` for a connector (delegates to TokenManager). */
  createContext(accountId: string, options?: CreateContextOptions): Promise<OperationContext> {
    return this.deps.tokenManager.createContext(accountId, options);
  }

  private async toSummary(account: AccountRecord): Promise<AccountSummary> {
    const current = await this.deps.tokens.getCurrent(account.id);
    return {
      id: account.id,
      platformId: account.platformId,
      remoteId: account.remoteId,
      handle: account.handle ?? null,
      displayName: account.displayName ?? null,
      avatarUrl: account.avatarUrl ?? null,
      profileUrl: account.profileUrl ?? null,
      profileMetadata: account.profileMetadata ?? null,
      status: account.status,
      connectedAt: account.connectedAt ?? null,
      ...(current ? { scopes: current.scopes, tokenExpiresAt: current.expiresAt ?? null } : {}),
    };
  }
}
