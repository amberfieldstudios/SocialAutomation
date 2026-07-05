/**
 * SQLite driver selection: prefer better-sqlite3 (fast native), fall back to the
 * built-in `node:sqlite` when the native binding is unavailable. Callers can
 * force an engine via `options.engine`.
 */

import type { SqlDriver } from './driver';
import { SqliteDriver, type SqliteDriverOptions } from './sqlite';
import { NodeSqliteDriver } from './node-sqlite';

export function createSqliteDriver(options: SqliteDriverOptions = {}): SqlDriver {
  const engine = options.engine ?? 'auto';
  if (engine === 'better-sqlite3') return new SqliteDriver(options);
  if (engine === 'node') return new NodeSqliteDriver(options);

  // auto: try the native engine, then the built-in one.
  try {
    return new SqliteDriver(options);
  } catch (nativeErr) {
    try {
      return new NodeSqliteDriver(options);
    } catch (nodeErr) {
      throw new Error(
        'No SQLite engine available. better-sqlite3 failed to load ' +
          `(${(nativeErr as Error).message}) and node:sqlite failed to load ` +
          `(${(nodeErr as Error).message}). Fix: install better-sqlite3 with a ` +
          'prebuilt binary or a C++ toolchain, OR run Node >= 22.5 with ' +
          '--experimental-sqlite (no flag needed on Node >= 24).',
      );
    }
  }
}
