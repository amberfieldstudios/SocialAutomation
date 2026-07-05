/**
 * Migration runner.
 *
 * Applies the SQL migrations in `packages/db/migrations/` in filename order
 * (`0001_init.sql`, `0002_advisory_locks.sql`, ...) exactly once each, tracking
 * what has run in a `schema_migrations` table. Idempotent: re-running skips
 * already-applied migrations. Each migration is applied inside a single
 * transaction so a failure leaves the schema unchanged.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { StructuredLogger } from '@social/core';
import type { SqlDriver } from './driver';

export interface Migration {
  /** Ordering + identity key, e.g. `0001_init`. */
  id: string;
  sql: string;
}

export interface MigrateOptions {
  logger?: StructuredLogger;
  /** Override the directory migrations are read from (tests / custom deploys). */
  migrationsDir?: string;
}

const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id          TEXT PRIMARY KEY,
  applied_at  TEXT NOT NULL
);`;

/**
 * Resolve the bundled migrations directory. Works from both `src/` (dev, via the
 * workspace `main: ./src/index.ts`) and `dist/` (built): both are direct
 * children of `packages/db`, so `../migrations` resolves to the same folder.
 */
export function defaultMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'migrations');
}

/** Read + sort the `*.sql` migrations from a directory. */
export function loadMigrations(migrationsDir = defaultMigrationsDir()): Migration[] {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
  return files.map((file) => ({
    id: file.replace(/\.sql$/, ''),
    sql: readFileSync(join(migrationsDir, file), 'utf8'),
  }));
}

/** Ids of migrations already recorded as applied. */
export function appliedMigrationIds(driver: SqlDriver): Set<string> {
  driver.exec(SCHEMA_MIGRATIONS_DDL);
  const rows = driver.all<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id');
  return new Set(rows.map((r) => r.id));
}

/**
 * Apply every not-yet-applied migration in order. Returns the ids that were
 * applied by this call (empty if the schema was already current).
 */
export function migrate(driver: SqlDriver, options: MigrateOptions = {}): string[] {
  const { logger } = options;
  const migrations = loadMigrations(options.migrationsDir);
  driver.exec(SCHEMA_MIGRATIONS_DDL);
  const applied = appliedMigrationIds(driver);

  const ran: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.id)) {
      logger?.debug('db.migrate.skip', { migration: migration.id });
      continue;
    }
    driver.transaction(() => {
      driver.exec(migration.sql);
      driver.run('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', [
        migration.id,
        new Date().toISOString(),
      ]);
    });
    ran.push(migration.id);
    logger?.info('db.migrate.applied', { migration: migration.id });
  }

  if (ran.length === 0) {
    logger?.info('db.migrate.up_to_date', { count: migrations.length });
  } else {
    logger?.info('db.migrate.complete', { applied: ran.length, total: migrations.length });
  }
  return ran;
}
