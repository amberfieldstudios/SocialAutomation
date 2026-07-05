/**
 * Storage ports over `accounts` / `account_tokens`, plus an advisory-lock port
 * for cross-worker refresh serialization (docs/AUTH.md §3), and in-memory
 * implementations used in tests and dev.
 *
 * All methods are async so a real `@social/db`-backed implementation (SQLite via
 * `BEGIN IMMEDIATE`, Postgres via a transaction) is a drop-in replacement.
 * `AdvisoryLock` maps to `pg_advisory_xact_lock` in Postgres and to the portable
 * `advisory_locks` table (migration 0002) elsewhere.
 */

import { randomUUID } from 'node:crypto';
import type { AccountRecord, AccountTokenRecord, ListAccountsFilter } from './types';

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface AccountsStore {
  insert(account: AccountRecord): Promise<AccountRecord>;
  update(id: string, patch: Partial<Omit<AccountRecord, 'id' | 'createdAt'>>): Promise<AccountRecord>;
  getById(id: string): Promise<AccountRecord | undefined>;
  getByRemote(platformId: string, remoteId: string): Promise<AccountRecord | undefined>;
  list(filter?: ListAccountsFilter): Promise<AccountRecord[]>;
  delete(id: string): Promise<void>;
}

export interface TokensStore {
  /** Insert a token row exactly as given (used for non-current rows). */
  insert(token: AccountTokenRecord): Promise<AccountTokenRecord>;
  /** The `is_current = 1` row for the account, if any. */
  getCurrent(accountId: string): Promise<AccountTokenRecord | undefined>;
  /** All rows for the account (current + rotation history + bootstrap secrets). */
  listByAccount(accountId: string): Promise<AccountTokenRecord[]>;
  /**
   * Atomic write-back (docs/AUTH.md §3): flip the existing current row to
   * `is_current = 0` (stamping `rotated_at`) and insert `newRow` as the sole
   * `is_current = 1` row. Under the partial unique index there is always exactly
   * one current row. Backed by `BEGIN IMMEDIATE` (SQLite) / a transaction (PG).
   */
  rotateCurrent(newRow: AccountTokenRecord): Promise<AccountTokenRecord>;
  /** Delete every row for the account (on disconnect/remove). */
  deleteByAccount(accountId: string): Promise<void>;
}

/**
 * Cross-worker advisory lock. `withLock` runs `fn` while holding `key`; other
 * holders of the same key block until it is released.
 */
export interface AdvisoryLock {
  withLock<T>(key: string, holder: string, ttlMs: number, fn: () => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// In-memory implementations
// ---------------------------------------------------------------------------

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryAccountsStore implements AccountsStore {
  private readonly rows = new Map<string, AccountRecord>();

  insert(account: AccountRecord): Promise<AccountRecord> {
    this.rows.set(account.id, clone(account));
    return Promise.resolve(clone(account));
  }

  update(id: string, patch: Partial<Omit<AccountRecord, 'id' | 'createdAt'>>): Promise<AccountRecord> {
    const existing = this.rows.get(id);
    if (!existing) {
      return Promise.reject(new Error(`account ${id} not found`));
    }
    const updated: AccountRecord = { ...existing, ...patch, id: existing.id, createdAt: existing.createdAt };
    this.rows.set(id, clone(updated));
    return Promise.resolve(clone(updated));
  }

  getById(id: string): Promise<AccountRecord | undefined> {
    const row = this.rows.get(id);
    return Promise.resolve(row ? clone(row) : undefined);
  }

  getByRemote(platformId: string, remoteId: string): Promise<AccountRecord | undefined> {
    for (const row of this.rows.values()) {
      if (row.platformId === platformId && row.remoteId === remoteId) {
        return Promise.resolve(clone(row));
      }
    }
    return Promise.resolve(undefined);
  }

  list(filter?: ListAccountsFilter): Promise<AccountRecord[]> {
    const out: AccountRecord[] = [];
    for (const row of this.rows.values()) {
      if (filter?.platformId && row.platformId !== filter.platformId) continue;
      if (filter?.status && row.status !== filter.status) continue;
      out.push(clone(row));
    }
    return Promise.resolve(out);
  }

  delete(id: string): Promise<void> {
    this.rows.delete(id);
    return Promise.resolve();
  }
}

export class InMemoryTokensStore implements TokensStore {
  private readonly rows = new Map<string, AccountTokenRecord>();

  insert(token: AccountTokenRecord): Promise<AccountTokenRecord> {
    this.rows.set(token.id, clone(token));
    return Promise.resolve(clone(token));
  }

  getCurrent(accountId: string): Promise<AccountTokenRecord | undefined> {
    for (const row of this.rows.values()) {
      if (row.accountId === accountId && row.isCurrent) {
        return Promise.resolve(clone(row));
      }
    }
    return Promise.resolve(undefined);
  }

  listByAccount(accountId: string): Promise<AccountTokenRecord[]> {
    const out: AccountTokenRecord[] = [];
    for (const row of this.rows.values()) {
      if (row.accountId === accountId) out.push(clone(row));
    }
    return Promise.resolve(out);
  }

  rotateCurrent(newRow: AccountTokenRecord): Promise<AccountTokenRecord> {
    const rotatedAt = newRow.obtainedAt;
    for (const row of this.rows.values()) {
      if (row.accountId === newRow.accountId && row.isCurrent) {
        row.isCurrent = false;
        row.rotatedAt = rotatedAt;
        row.updatedAt = rotatedAt;
      }
    }
    const inserted: AccountTokenRecord = { ...clone(newRow), isCurrent: true };
    this.rows.set(inserted.id, inserted);
    return Promise.resolve(clone(inserted));
  }

  deleteByAccount(accountId: string): Promise<void> {
    for (const [id, row] of this.rows) {
      if (row.accountId === accountId) this.rows.delete(id);
    }
    return Promise.resolve();
  }
}

/**
 * In-process advisory lock: a per-key promise chain (FIFO mutex). Sufficient for
 * dev/tests and to serialize refreshes within a single process; a `@social/db`
 * implementation extends the guarantee across processes via the `advisory_locks`
 * table. `holder`/`ttlMs` are honored by the DB-backed version (stale-lock
 * takeover); the in-memory version does not expire locks because it cannot
 * outlive the process.
 */
export class InMemoryAdvisoryLock implements AdvisoryLock {
  private readonly tails = new Map<string, Promise<void>>();

  async withLock<T>(key: string, _holder: string, _ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(
      key,
      prev.then(() => next),
    );
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** Generate a UUID for a new row primary key (matches the schema's TEXT PKs). */
export function newId(): string {
  return randomUUID();
}
