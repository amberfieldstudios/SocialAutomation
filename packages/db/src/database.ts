/**
 * `Database` — the package entry point that ties a `SqlDriver` to the migration
 * runner and the repository implementations.
 *
 * Typical use:
 *   const db = Database.sqlite({ filename: 'social.db' }, { logger });
 *   db.migrate();                       // applies 0001, 0002, 0003 as needed
 *   const auth = db.accounts;           // AccountsStore (drop-in for in-memory)
 *   const tokens = db.tokens;           // TokensStore
 *   const jobs = db.jobs;               // JobStore
 *   const locks = db.advisoryLock;      // AdvisoryLock
 *
 * The repos are lazily constructed singletons sharing the one driver/connection.
 */

import type { StructuredLogger } from '@social/core';
import type { SqlDriver } from './driver';
import type { SqliteDriverOptions } from './sqlite';
import { createSqliteDriver } from './sqlite-factory';
import { migrate, type MigrateOptions } from './migrator';
import { SqliteAccountsStore } from './repositories/accounts';
import { SqliteTokensStore } from './repositories/tokens';
import { SqliteJobStore, type SqliteJobStoreOptions } from './repositories/jobs';
import { SqliteAdvisoryLock, type SqliteAdvisoryLockOptions } from './repositories/advisory-lock';
import { SqlitePlatformsRepo } from './repositories/platforms';
import { SqliteAnalyticsSnapshotsStore } from './repositories/analytics';
import { SqliteSchedulesRepo } from './repositories/schedules';
import { SqliteShortUrlsStore } from './repositories/short-urls';
import { SqliteScheduledCampaignsRepo } from './repositories/scheduled-campaigns';
import { SqliteSettingsStore } from './repositories/settings';

export interface DatabaseOptions {
  logger?: StructuredLogger;
  /** Forwarded to the SQLite JobStore (default max attempts). */
  jobStore?: SqliteJobStoreOptions;
  /** Forwarded to the advisory-lock repo (acquire timeout / poll interval). */
  advisoryLock?: SqliteAdvisoryLockOptions;
}

export class Database {
  private _accounts?: SqliteAccountsStore;
  private _tokens?: SqliteTokensStore;
  private _jobs?: SqliteJobStore;
  private _advisoryLock?: SqliteAdvisoryLock;
  private _platforms?: SqlitePlatformsRepo;
  private _analyticsSnapshots?: SqliteAnalyticsSnapshotsStore;
  private _schedules?: SqliteSchedulesRepo;
  private _shortUrls?: SqliteShortUrlsStore;
  private _scheduledCampaigns?: SqliteScheduledCampaignsRepo;
  private _settings?: SqliteSettingsStore;

  constructor(
    private readonly driver: SqlDriver,
    private readonly options: DatabaseOptions = {},
  ) {}

  /**
   * Open a SQLite-backed database. Uses better-sqlite3 when its native binding
   * is available, otherwise falls back to the built-in `node:sqlite` engine
   * (override with `sqliteOptions.engine`).
   */
  static sqlite(sqliteOptions: SqliteDriverOptions = {}, options: DatabaseOptions = {}): Database {
    return new Database(createSqliteDriver(sqliteOptions), options);
  }

  /** The raw driver — for advanced use, seeding parent rows in tests, etc. */
  raw(): SqlDriver {
    return this.driver;
  }

  /** Apply pending migrations. Returns the ids applied by this call. */
  migrate(migrateOptions: MigrateOptions = {}): string[] {
    return migrate(this.driver, { logger: this.options.logger, ...migrateOptions });
  }

  get accounts(): SqliteAccountsStore {
    return (this._accounts ??= new SqliteAccountsStore(this.driver, this.options.logger));
  }

  get tokens(): SqliteTokensStore {
    return (this._tokens ??= new SqliteTokensStore(this.driver, this.options.logger));
  }

  get jobs(): SqliteJobStore {
    return (this._jobs ??= new SqliteJobStore(this.driver, {
      logger: this.options.logger,
      ...this.options.jobStore,
    }));
  }

  get advisoryLock(): SqliteAdvisoryLock {
    return (this._advisoryLock ??= new SqliteAdvisoryLock(this.driver, {
      logger: this.options.logger,
      ...this.options.advisoryLock,
    }));
  }

  /** Support repo for the `platforms` FK parent (not a swap-in port). */
  get platforms(): SqlitePlatformsRepo {
    return (this._platforms ??= new SqlitePlatformsRepo(this.driver));
  }

  /** `analytics_snapshots` repo — owned conceptually by `@social/analytics`. */
  get analyticsSnapshots(): SqliteAnalyticsSnapshotsStore {
    return (this._analyticsSnapshots ??= new SqliteAnalyticsSnapshotsStore(
      this.driver,
      this.options.logger,
    ));
  }

  /** `schedules` repo — immediate/scheduled/recurring publish schedules (owned by `@social/scheduler`). */
  get schedules(): SqliteSchedulesRepo {
    return (this._schedules ??= new SqliteSchedulesRepo(this.driver, this.options.logger));
  }

  /** `short_urls` repo — UTM/short-URL tracking + click attribution (owned by `@social/analytics`). */
  get shortUrls(): SqliteShortUrlsStore {
    return (this._shortUrls ??= new SqliteShortUrlsStore(this.driver, this.options.logger));
  }

  /** `scheduled_campaigns` repo — persisted `ComposeAndSubmitInput` per schedule (owned by `@social/pipeline`), restart-durable. */
  get scheduledCampaigns(): SqliteScheduledCampaignsRepo {
    return (this._scheduledCampaigns ??= new SqliteScheduledCampaignsRepo(this.driver, this.options.logger));
  }

  /** `app_settings` repo (migration 0007) — generic key/value app state (t2: wizard first-run/resume state). */
  get settings(): SqliteSettingsStore {
    return (this._settings ??= new SqliteSettingsStore(this.driver, this.options.logger));
  }

  close(): void {
    this.driver.close();
  }
}
