/**
 * @social/db — database driver abstraction, migration runner, and repository
 * implementations that persist the storage ports declared by `@social/auth`
 * (`AccountsStore`, `TokensStore`, `AdvisoryLock`) and `@social/queue`
 * (`JobStore`). SQLite is the verified path — via better-sqlite3 when its native
 * binding is available, else the built-in `node:sqlite` engine (auto-selected by
 * `Database.sqlite()` / `createSqliteDriver`). A Postgres adapter implements the
 * same `SqlDriver` interface (see `postgres.ts`).
 *
 * SECURITY: the token repository persists ONLY sealed ciphertext + key
 * references and NEVER logs plaintext or ciphertext (sealing lives in the auth
 * vault). All repos emit redacted structured logs via the injected logger.
 */

export * from './driver';
export * from './sqlite';
export * from './node-sqlite';
export * from './sqlite-factory';
export * from './postgres';
export * from './migrator';
export * from './database';
export * from './repositories/accounts';
export * from './repositories/tokens';
export * from './repositories/jobs';
export * from './repositories/advisory-lock';
export * from './repositories/platforms';
export * from './repositories/analytics';
export * from './repositories/schedules';
export * from './repositories/short-urls';
export * from './repositories/scheduled-campaigns';
export * from './repositories/settings';
export * from './repositories/rows';
