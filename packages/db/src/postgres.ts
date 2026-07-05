/**
 * Postgres adapter — INTERFACE STUB (SQLite is the verified path).
 *
 * A production Postgres deployment implements the SAME `SqlDriver` contract as
 * `SqliteDriver`, so every repository in this package (`SqliteAccountsStore`,
 * `SqliteTokensStore`, `SqliteJobStore`, `SqliteAdvisoryLock`) and the migration
 * runner work UNCHANGED against it. Only two dialect adjustments are required in
 * the driver, none above it:
 *
 *   1. Placeholders: rewrite positional `?` to `$1, $2, ...` (the repos use `?`
 *      exclusively). A simple left-to-right counter in `run/get/all` does this.
 *   2. Concurrency primitives:
 *        - `transaction()` uses plain `BEGIN` (Postgres `BEGIN` already takes
 *          row locks lazily; `SELECT ... FOR UPDATE SKIP LOCKED` is the natural
 *          claim strategy for `JobStore.claimDueJobs` and can be swapped in).
 *        - Advisory locks SHOULD prefer native `pg_advisory_xact_lock(hashtext(key))`
 *          (auto-released at transaction end) over the portable `advisory_locks`
 *          table, but the table-based `SqliteAdvisoryLock` logic is fully valid
 *          on Postgres too and needs no change.
 *
 * The schema DDL (0001–0003) was authored to be dialect-portable (TEXT UUID PKs,
 * ISO-8601 TEXT timestamps, INTEGER 0/1 booleans, JSON in TEXT). Postgres
 * deployments MAY later migrate TEXT->TIMESTAMPTZ / TEXT->JSONB, but that is an
 * optimization, not a correctness requirement.
 *
 * Implementation note: wire this against `pg` (node-postgres). Because the repos
 * call the driver synchronously from inside their own `async` methods, a
 * Postgres driver must either use a synchronous client shim or the whole
 * `SqlDriver` surface must be promoted to async — a mechanical change isolated to
 * `driver.ts` + the repo method bodies (their signatures are already `async`).
 */

import type { RunResult, SqlDriver, SqlParam, SqlValue } from './driver';

const NOT_IMPLEMENTED =
  'PostgresDriver is a documented interface stub; SQLite is the verified path in this milestone. Wire against `pg` per the notes in postgres.ts.';

export interface PostgresDriverOptions {
  connectionString: string;
}

/** Placeholder that throws until wired against `pg`. Shape matches `SqlDriver`. */
export class PostgresDriver implements SqlDriver {
  constructor(_options: PostgresDriverOptions) {
    throw new Error(NOT_IMPLEMENTED);
  }
  exec(_sql: string): void {
    throw new Error(NOT_IMPLEMENTED);
  }
  run(_sql: string, _params?: readonly SqlParam[]): RunResult {
    throw new Error(NOT_IMPLEMENTED);
  }
  get<T = Record<string, SqlValue>>(_sql: string, _params?: readonly SqlParam[]): T | undefined {
    throw new Error(NOT_IMPLEMENTED);
  }
  all<T = Record<string, SqlValue>>(_sql: string, _params?: readonly SqlParam[]): T[] {
    throw new Error(NOT_IMPLEMENTED);
  }
  transaction<T>(_fn: () => T): T {
    throw new Error(NOT_IMPLEMENTED);
  }
  close(): void {
    throw new Error(NOT_IMPLEMENTED);
  }
}
