/**
 * Proactive refresh scheduler (docs/AUTH.md §3, trigger 2).
 *
 * Periodically scans current (`is_current = 1`) tokens whose `expires_at` falls
 * within a horizon (default 15 min) and refreshes them off the hot path via
 * `TokenManager.ensureFresh`, so the publish queue rarely blocks on a refresh.
 * Selection reads the plaintext `expires_at` column only — it never decrypts a
 * token just to check expiry.
 *
 * Concurrency is delegated to `TokenManager`: `ensureFresh` already coalesces
 * concurrent callers (in-process single-flight) and serializes across workers
 * (advisory lock), then RE-CHECKS whether the token is actually due under the
 * lock. So a scheduler pass is idempotent and safe to overlap with lazy refresh
 * — a token is refreshed at most once even if several triggers fire together.
 *
 * The clock (`now`) is injectable for tests; `scanOnce()` runs a single pass
 * deterministically without timers.
 */

import type { StructuredLogger } from '@social/core';
import { ReauthRequiredError } from './errors';
import type { AccountsStore, TokensStore } from './store';
import type { TokenManager } from './token-manager';

export interface RefreshSchedulerDeps {
  accounts: AccountsStore;
  tokens: TokensStore;
  tokenManager: TokenManager;
  logger: StructuredLogger;
  now?: () => Date;
  /** Refresh tokens expiring within this window. Default 15 min (docs/AUTH.md §3). */
  horizonMs?: number;
  /** Scan cadence when `start()`ed. Default 60s. */
  intervalMs?: number;
  /** Max concurrent refreshes per pass. Default 4. */
  concurrency?: number;
  /** Restrict the scan to one platform (optional). */
  platformId?: string;
}

/** Outcome of a single scan pass. */
export interface RefreshScanResult {
  /** Active accounts examined. */
  scanned: number;
  /** Accounts whose current token was within the horizon (candidates). */
  due: number;
  /** Accounts successfully refreshed (or confirmed fresh) this pass. */
  refreshed: number;
  /** Accounts that need re-auth (revoked/auth_failed) — surfaced, not fatal. */
  reauthRequired: number;
  /** Accounts whose refresh failed transiently (will be retried next pass). */
  failed: number;
}

const DEFAULT_HORIZON_MS = 15 * 60_000;
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_CONCURRENCY = 4;

export class RefreshScheduler {
  private readonly now: () => Date;
  private readonly horizonMs: number;
  private readonly intervalMs: number;
  private readonly concurrency: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private scanning = false;

  constructor(private readonly deps: RefreshSchedulerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.horizonMs = deps.horizonMs ?? DEFAULT_HORIZON_MS;
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.concurrency = Math.max(1, deps.concurrency ?? DEFAULT_CONCURRENCY);
  }

  /**
   * Begin periodic scanning. Overlapping passes are skipped (a slow pass never
   * stacks). The interval timer is `unref`'d so it never keeps the process
   * alive on its own.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.scanOnce().catch((error) => {
        this.deps.logger.error('auth.refresh_scan_failed', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  /** Stop periodic scanning. In-flight refreshes complete on their own. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Run one scan pass: find active accounts whose current token expires within
   * the horizon and `ensureFresh` each (bounded concurrency). Per-account errors
   * are isolated — one account needing re-auth or blipping never fails the pass.
   */
  async scanOnce(): Promise<RefreshScanResult> {
    if (this.scanning) {
      return { scanned: 0, due: 0, refreshed: 0, reauthRequired: 0, failed: 0 };
    }
    this.scanning = true;
    try {
      const candidates = await this.findDueAccounts();
      const result: RefreshScanResult = {
        scanned: candidates.scanned,
        due: candidates.due.length,
        refreshed: 0,
        reauthRequired: 0,
        failed: 0,
      };
      if (candidates.due.length === 0) return result;

      this.deps.logger.info('auth.refresh_scan_started', {
        due: candidates.due.length,
        horizonMs: this.horizonMs,
      });

      await this.runBounded(candidates.due, async (accountId) => {
        try {
          await this.deps.tokenManager.ensureFresh(accountId);
          result.refreshed += 1;
        } catch (error) {
          if (error instanceof ReauthRequiredError) {
            result.reauthRequired += 1;
            this.deps.logger.warn('auth.refresh_scan_reauth_required', {
              accountId,
              status: error.accountStatus,
            });
          } else {
            result.failed += 1;
            this.deps.logger.warn('auth.refresh_scan_item_failed', {
              accountId,
              reason: error instanceof Error ? error.name : 'unknown',
            });
          }
        }
      });

      this.deps.logger.info('auth.refresh_scan_completed', {
        scanned: result.scanned,
        due: result.due,
        refreshed: result.refreshed,
        reauthRequired: result.reauthRequired,
        failed: result.failed,
      });
      return result;
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Accounts whose current token expires within the horizon. Reads only the
   * plaintext `expires_at` column; non-expiring tokens (bot/webhook) are skipped.
   */
  private async findDueAccounts(): Promise<{ scanned: number; due: string[] }> {
    const filter = this.deps.platformId
      ? { platformId: this.deps.platformId, status: 'active' as const }
      : { status: 'active' as const };
    const accounts = await this.deps.accounts.list(filter);
    const cutoffMs = this.now().getTime() + this.horizonMs;
    const due: string[] = [];
    for (const account of accounts) {
      const current = await this.deps.tokens.getCurrent(account.id);
      if (!current?.expiresAt) continue; // non-expiring never refreshes
      const expiresMs = Date.parse(current.expiresAt);
      if (!Number.isNaN(expiresMs) && expiresMs <= cutoffMs) {
        due.push(account.id);
      }
    }
    return { scanned: accounts.length, due };
  }

  /** Run `worker` over `items` with at most `concurrency` in flight. */
  private async runBounded(items: string[], worker: (item: string) => Promise<void>): Promise<void> {
    let index = 0;
    const runNext = async (): Promise<void> => {
      while (index < items.length) {
        const current = items[index];
        index += 1;
        if (current !== undefined) await worker(current);
      }
    };
    const runners = Array.from({ length: Math.min(this.concurrency, items.length) }, () => runNext());
    await Promise.all(runners);
  }
}
