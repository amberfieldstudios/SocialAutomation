/**
 * Engine-agnostic SQL driver abstraction.
 *
 * The repositories in this package are written against `SqlDriver`, never
 * against a concrete engine. The verified/default implementation is
 * `SqliteDriver` (better-sqlite3, synchronous — see `sqlite.ts`). A Postgres
 * deployment implements this SAME interface with a thin async-to-sync-shaped
 * wrapper (see `postgres.ts` for the interface stub + notes); because every
 * repository method is already `async` at the port boundary (`AccountsStore`,
 * `TokensStore`, `JobStore`, `AdvisoryLock`), swapping the driver requires no
 * changes above this file.
 *
 * Binding rules enforced by every driver:
 *   * Positional `?` placeholders only (portable across SQLite/Postgres via a
 *     param rewriter in the PG adapter).
 *   * `undefined` params are coerced to SQL NULL.
 *   * `boolean` params are coerced to INTEGER 0/1 (the schema stores booleans as
 *     `INTEGER ... CHECK (x IN (0,1))`).
 *   * `Date` params are coerced to ISO-8601 UTC strings.
 * `normalizeParams` centralizes these coercions so callers can pass natural
 * JS values.
 */

export type SqlValue = string | number | bigint | Buffer | null;
export type SqlParam = SqlValue | boolean | Date | undefined;

/** Result of a mutating statement. */
export interface RunResult {
  /** Rows affected. */
  changes: number;
}

/**
 * A synchronous, single-connection SQL driver. SQLite (better-sqlite3) is
 * natively synchronous; a Postgres adapter would front a connection/pool and
 * expose the same synchronous-looking surface to the repositories, which only
 * ever call it from inside their own `async` methods.
 */
export interface SqlDriver {
  /** Execute one or more statements with no bound parameters (DDL, PRAGMA). */
  exec(sql: string): void;
  /** Run a mutating statement (INSERT/UPDATE/DELETE). */
  run(sql: string, params?: readonly SqlParam[]): RunResult;
  /** Fetch the first matching row, or `undefined`. */
  get<T = Record<string, SqlValue>>(sql: string, params?: readonly SqlParam[]): T | undefined;
  /** Fetch all matching rows. */
  all<T = Record<string, SqlValue>>(sql: string, params?: readonly SqlParam[]): T[];
  /**
   * Run `fn` inside a write transaction started with `BEGIN IMMEDIATE`
   * (SQLite) / `BEGIN` (Postgres). Commits on return, rolls back on throw.
   * Nested calls join the outer transaction (no-op begin/commit).
   */
  transaction<T>(fn: () => T): T;
  /** Close the underlying connection. */
  close(): void;
}

/** Coerce one JS value into a driver-bindable SQL value. */
export function normalizeParam(value: SqlParam): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  return value;
}

/** Coerce a list of JS values for binding. */
export function normalizeParams(params: readonly SqlParam[] | undefined): SqlValue[] {
  if (!params) return [];
  return params.map(normalizeParam);
}
