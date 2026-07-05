/**
 * better-sqlite3 driver — the fastest embedded engine when its native binding
 * is available.
 *
 * NATIVE-BUILD NOTE: better-sqlite3 is a native addon. It normally installs a
 * prebuilt binary (no C toolchain needed), but in environments where no prebuild
 * matches the Node ABI it falls back to compiling with node-gyp, which needs a
 * C++ toolchain (on Windows: MSVC/ClangCL). That build is NOT available in every
 * environment. To keep the whole workspace installable, better-sqlite3 is an
 * OPTIONAL dependency, is loaded LAZILY here (so importing `@social/db` never
 * throws just because the binding is missing), and `Database.sqlite()` /
 * `createSqliteDriver()` automatically fall back to the `node:sqlite` driver
 * (see `node-sqlite.ts`) when this one can't load. Both back the identical
 * `SqlDriver` interface, so repositories are unaffected by the choice.
 */

import { createRequire } from 'node:module';
import type { Database as BetterSqlite3Database, Options } from 'better-sqlite3';
import { normalizeParams, type RunResult, type SqlDriver, type SqlParam, type SqlValue } from './driver';

export type SqliteEngine = 'better-sqlite3' | 'node' | 'auto';

export interface SqliteDriverOptions {
  /** File path, or `:memory:` for an ephemeral database. */
  filename?: string;
  /** Which SQLite engine to use. Default `'auto'` (better-sqlite3, else node:sqlite). */
  engine?: SqliteEngine;
  /** Enforce foreign keys (schema relies on this). Default true. */
  foreignKeys?: boolean;
  /**
   * Use WAL journal mode for on-disk databases (better concurrency for the
   * queue's claim/backoff writes). Ignored for `:memory:`. Default true.
   */
  wal?: boolean;
  /** Busy timeout in ms; lets `BEGIN IMMEDIATE` wait for a competing writer. */
  busyTimeoutMs?: number;
}

type BetterSqlite3Ctor = new (filename: string, options?: Options) => BetterSqlite3Database;

export class SqliteDriver implements SqlDriver {
  private readonly db: BetterSqlite3Database;
  private txDepth = 0;

  constructor(options: SqliteDriverOptions = {}) {
    const filename = options.filename ?? ':memory:';
    // Lazy require so a missing/unbuilt native binding only fails when this
    // driver is actually constructed, never at module import.
    const require = createRequire(import.meta.url);
    const Ctor = require('better-sqlite3') as BetterSqlite3Ctor;
    this.db = new Ctor(filename);
    this.db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
    if (options.foreignKeys !== false) {
      this.db.pragma('foreign_keys = ON');
    }
    if (options.wal !== false && filename !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
    }
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, params?: readonly SqlParam[]): RunResult {
    const info = this.db.prepare(sql).run(...normalizeParams(params));
    return { changes: Number(info.changes) };
  }

  get<T = Record<string, SqlValue>>(sql: string, params?: readonly SqlParam[]): T | undefined {
    return this.db.prepare(sql).get(...normalizeParams(params)) as T | undefined;
  }

  all<T = Record<string, SqlValue>>(sql: string, params?: readonly SqlParam[]): T[] {
    return this.db.prepare(sql).all(...normalizeParams(params)) as T[];
  }

  /**
   * `BEGIN IMMEDIATE` acquires the write lock up front, which is what makes the
   * advisory-lock check-then-insert and the token rotate-current flip atomic
   * against other writers. Re-entrant calls join the outer transaction.
   */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      this.txDepth += 1;
      try {
        return fn();
      } finally {
        this.txDepth -= 1;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.txDepth = 1;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.txDepth = 0;
    }
  }

  close(): void {
    this.db.close();
  }
}
