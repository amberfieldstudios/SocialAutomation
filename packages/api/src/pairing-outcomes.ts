/**
 * In-memory outcome tracker for redirect (`authorize_url`) pairing flows.
 *
 * `PairingCoordinator.completePairing` runs on the platform's redirect back to
 * THIS server (`GET /api/accounts/pair/callback/:platformId`), not in the
 * wizard's browser tab/window — so the wizard UI has nothing to await
 * directly. It instead polls `GET /api/accounts/pair/poll/:state`, which reads
 * from this store. Keyed by the same CSRF `state` the pairing session uses;
 * entries are short-lived (cleared on read of a terminal status, and swept
 * after `ttlMs`) since `state` values are otherwise single-use.
 *
 * Secret-free by construction: only ever holds a plain-language `message`, the
 * secret-free `AccountSummary` on success, or an error message — never a
 * token/code/verifier.
 */

import type { AccountSummary } from '@social/auth';

export type PairingOutcome =
  | { status: 'pending' }
  | { status: 'succeeded'; account: AccountSummary }
  | { status: 'failed'; message: string };

export interface PairingOutcomeStore {
  begin(state: string): void;
  succeed(state: string, account: AccountSummary): void;
  fail(state: string, message: string): void;
  /** Reads the outcome without clearing it — the wizard polls repeatedly while `pending`. */
  peek(state: string): PairingOutcome;
}

export function createPairingOutcomeStore(options: { now?: () => Date; ttlMs?: number } = {}): PairingOutcomeStore {
  const now = options.now ?? (() => new Date());
  const ttlMs = options.ttlMs ?? 15 * 60_000;
  const rows = new Map<string, { outcome: PairingOutcome; expiresAt: number }>();

  function prune(): void {
    const cutoff = now().getTime();
    for (const [state, row] of rows) {
      if (row.expiresAt <= cutoff) rows.delete(state);
    }
  }

  return {
    begin(state) {
      prune();
      rows.set(state, { outcome: { status: 'pending' }, expiresAt: now().getTime() + ttlMs });
    },
    succeed(state, account) {
      rows.set(state, { outcome: { status: 'succeeded', account }, expiresAt: now().getTime() + ttlMs });
    },
    fail(state, message) {
      rows.set(state, { outcome: { status: 'failed', message }, expiresAt: now().getTime() + ttlMs });
    },
    peek(state) {
      prune();
      return rows.get(state)?.outcome ?? { status: 'pending' };
    },
  };
}
