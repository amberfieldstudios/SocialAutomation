/**
 * SQLite-backed repository over `app_settings` (migration 0007): a generic
 * key/value store for small pieces of server-side app state that must survive
 * a browser refresh AND a process restart. `value` is opaque JSON as far as
 * this package is concerned — see that migration's comment for why this is a
 * generic table rather than a one-off `wizard_state` table.
 */

import type { StructuredLogger } from '@social/core';
import type { SqlDriver } from '../driver';
import { parseJson } from './rows';

interface AppSettingRow {
  key: string;
  value: string;
  updated_at: string;
}

/** Storage port for a single JSON-valued setting, keyed by string. */
export interface SettingsStore {
  /** Reads and JSON-parses the value for `key`, or `undefined` if never set. */
  get<TValue = unknown>(key: string): TValue | undefined;
  /** Upserts `value` (JSON-serialized) for `key`. */
  set<TValue = unknown>(key: string, value: TValue): void;
}

export class SqliteSettingsStore implements SettingsStore {
  constructor(
    private readonly driver: SqlDriver,
    private readonly logger?: StructuredLogger,
  ) {}

  get<TValue = unknown>(key: string): TValue | undefined {
    const row = this.driver.get<AppSettingRow>('SELECT * FROM app_settings WHERE key = ?', [key]);
    if (!row) return undefined;
    return parseJson<TValue>(row.value, undefined as TValue);
  }

  set<TValue = unknown>(key: string, value: TValue): void {
    const now = new Date().toISOString();
    const json = JSON.stringify(value);
    this.driver.run(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, json, now],
    );
    this.logger?.info('db.settings.set', { key });
  }
}
