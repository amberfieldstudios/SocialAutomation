/**
 * node:sqlite driver — the zero-native-build fallback engine.
 *
 * Uses Node's built-in `node:sqlite` (`DatabaseSync`, available since Node
 * 22.5). It requires NO compilation and NO extra dependency, so it works in
 * environments where better-sqlite3's native binding can't be built (see
 * `sqlite.ts`). It exposes the same synchronous `prepare/run/get/all/exec`
 * surface, so it backs the identical `SqlDriver` interface.
 *
 * RUNTIME FLAG: on Node 22.5–23.x, `node:sqlite` is behind `--experimental-sqlite`
 * (and emits an ExperimentalWarning); on Node >= 24 it is available without a
 * flag. The package's `vitest.config.ts` adds the flag automatically on Node <
 * 24. A production app using this engine must launch with the flag on those
 * versions (or prefer the better-sqlite3 engine).
 *
 * Loaded LAZILY (via `createRequire`) so importing `@social/db` never triggers
 * the experimental module unless this driver is actually constructed.
 */

import { createRequire } from 'node:module';
import { normalizeParams, type RunResult, type SqlDriver, type SqlParam, type SqlValue } from './driver';
import type { SqliteDriverOptions } from './sqlite';

// Minimal structural types for the subset of node:sqlite we use, so this file
// does not depend on @types/node shipping the (experimental) node:sqlite types.
interface NodeStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface NodeDatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): NodeStatement;
  close(): void;
}
type NodeDatabaseSyncCtor = new (path: string) => NodeDatabaseSync;

export class NodeSqliteDriver implements SqlDriver {
  private readonly db: NodeDatabaseSync;
  private txDepth = 0;

  constructor(options: SqliteDriverOptions = {}) {
    const filename = options.filename ?? ':memory:';
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: NodeDatabaseSyncCtor };
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
    if (options.foreignKeys !== false) {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
    if (options.wal !== false && filename !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL');
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
