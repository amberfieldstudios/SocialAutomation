/**
 * SQLite-backed `AdvisoryLock` (the port declared in `@social/auth/src/store.ts`)
 * over the portable `advisory_locks` table (migration 0002). Drop-in replacement
 * for `InMemoryAdvisoryLock`, but the guarantee holds ACROSS processes, not just
 * within one event loop.
 *
 * Contract (migration 0002):
 *   acquire = check-then-INSERT (or take over an expired row) under a single
 *             `BEGIN IMMEDIATE` write transaction, so two writers can't both
 *             believe they hold `key`.
 *   release = DELETE the row iff `holder` matches (never release someone else's
 *             lock).
 * A holder that outlives its `ttlMs` MUST treat the lock as lost; a competing
 * acquirer may take over the stale row.
 *
 * Because `fn` is async and may run for a while, the lock is NOT held inside an
 * open SQLite transaction (that would block every other writer). Instead acquire
 * commits a short transaction that records the lock row, and release deletes it;
 * contenders poll until the row is free or stale.
 */

import type { StructuredLogger } from '@social/core';
import type { AdvisoryLock } from '@social/auth';
import type { SqlDriver } from '../driver';

export interface SqliteAdvisoryLockOptions {
  logger?: StructuredLogger;
  /** How long to wait to acquire before throwing. Default 30_000 ms. */
  acquireTimeoutMs?: number;
  /** Poll interval while a live lock is held by someone else. Default 25 ms. */
  pollIntervalMs?: number;
  /** Injectable clock for tests. */
  now?: () => Date;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

interface LockRow {
  lock_key: string;
  holder: string;
  acquired_at: string;
  expires_at: string;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class SqliteAdvisoryLock implements AdvisoryLock {
  private readonly logger?: StructuredLogger;
  private readonly acquireTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly driver: SqlDriver,
    options: SqliteAdvisoryLockOptions = {},
  ) {
    this.logger = options.logger;
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 25;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Atomic check-then-take. Returns true if `holder` now owns `key`. */
  private tryAcquire(key: string, holder: string, ttlMs: number): boolean {
    const now = this.now();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const expiresIso = new Date(nowMs + ttlMs).toISOString();
    return this.driver.transaction<boolean>(() => {
      const existing = this.driver.get<LockRow>(
        'SELECT * FROM advisory_locks WHERE lock_key = ?',
        [key],
      );
      if (existing) {
        const live = new Date(existing.expires_at).getTime() > nowMs;
        if (live) return false;
        // Stale row -> take over.
        this.driver.run(
          'UPDATE advisory_locks SET holder = ?, acquired_at = ?, expires_at = ? WHERE lock_key = ?',
          [holder, nowIso, expiresIso, key],
        );
        return true;
      }
      this.driver.run(
        'INSERT INTO advisory_locks (lock_key, holder, acquired_at, expires_at) VALUES (?, ?, ?, ?)',
        [key, holder, nowIso, expiresIso],
      );
      return true;
    });
  }

  private release(key: string, holder: string): void {
    const result = this.driver.run(
      'DELETE FROM advisory_locks WHERE lock_key = ? AND holder = ?',
      [key, holder],
    );
    if (result.changes > 0) {
      this.logger?.debug('db.lock.released', { lockKey: key, holder });
    }
  }

  async withLock<T>(key: string, holder: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const deadline = this.now().getTime() + this.acquireTimeoutMs;
    let acquired = false;
    while (!acquired) {
      acquired = this.tryAcquire(key, holder, ttlMs);
      if (acquired) break;
      if (this.now().getTime() >= deadline) {
        throw new Error(
          `advisory lock '${key}' not acquired within ${this.acquireTimeoutMs}ms (held by another worker)`,
        );
      }
      await this.sleep(this.pollIntervalMs);
    }
    this.logger?.debug('db.lock.acquired', { lockKey: key, holder, ttlMs });
    try {
      return await fn();
    } finally {
      this.release(key, holder);
    }
  }

  /** Best-effort sweep of expired rows (optional maintenance helper). */
  sweepExpired(): number {
    const result = this.driver.run('DELETE FROM advisory_locks WHERE expires_at <= ?', [
      this.now().toISOString(),
    ]);
    return result.changes;
  }
}
