/**
 * On-upgrade migration hook (t7 "update story"): runs once per app startup,
 * compares the installed app version (stored in `app_settings`, the same
 * generic key/value store t2 uses for wizard state) against the running
 * code's version (`app-version.ts`), and — if this is the first run of a
 * NEWER version than what last ran against this user-data folder — runs any
 * registered migration steps before recording the new version.
 *
 * This is deliberately separate from `@social/db`'s schema migrations
 * (`Database.migrate()`, already run unconditionally on every boot): that
 * mechanism handles SQL schema changes. This one is the extensibility point
 * for anything else an upgrade might need to do to EXISTING user data
 * (rename a settings key, move a file under `SOCIAL_AUTOMATION_USER_DATA_DIR`,
 * re-key something) — see docs/UPDATING.md. `MIGRATION_STEPS` is empty today
 * because no release has ever needed one yet; the hook is exercised for real
 * on every startup regardless (first-run write, no-op on repeat runs at the
 * same version), it just has nothing to do until a future release adds a step.
 */
import type { AppContext } from './context';
import { getAppVersion } from './app-version';
import { compareVersions } from './semver-lite';

const INSTALLED_VERSION_KEY = 'installed_app_version';

export interface VersionMigrationStep {
  /** Runs the first time a version >= this one starts up after a lower (or no) version was previously recorded. */
  sinceVersion: string;
  description: string;
  run(ctx: AppContext): void | Promise<void>;
}

/**
 * Add an entry here in the release that introduces a breaking user-data
 * change. Keep steps idempotent where practical — `runVersionMigrationIfNeeded`
 * already only runs a step once (comparing `sinceVersion` against the
 * previously-recorded version), but a step that's safe to re-run is cheap
 * insurance against a crash between "step ran" and "version recorded".
 */
const MIGRATION_STEPS: VersionMigrationStep[] = [];

export interface VersionMigrationResult {
  previousVersion: string | undefined;
  currentVersion: string;
  /** True if this is the first run of a version different from the last recorded one (including the very first run ever). */
  migrated: boolean;
  stepsApplied: string[];
}

export async function runVersionMigrationIfNeeded(ctx: AppContext): Promise<VersionMigrationResult> {
  const currentVersion = getAppVersion();
  const previousVersion = ctx.db.settings.get<string>(INSTALLED_VERSION_KEY);

  if (previousVersion === currentVersion) {
    return { previousVersion, currentVersion, migrated: false, stepsApplied: [] };
  }

  ctx.logger.info('app.version_detected', {
    previousVersion: previousVersion ?? '(first run for this data folder)',
    currentVersion,
  });

  const stepsApplied: string[] = [];
  for (const step of MIGRATION_STEPS) {
    // Skip a step already covered by whatever version last ran: if the
    // previously-recorded version is already >= this step's sinceVersion,
    // it was either applied on a prior startup or was never needed because
    // the data was already in the post-migration shape at that version.
    if (previousVersion !== undefined && compareVersions(previousVersion, step.sinceVersion) >= 0) {
      continue;
    }
    await step.run(ctx);
    stepsApplied.push(step.description);
    ctx.logger.info('app.version_migration_step_applied', { step: step.description, sinceVersion: step.sinceVersion });
  }

  ctx.db.settings.set(INSTALLED_VERSION_KEY, currentVersion);
  return { previousVersion, currentVersion, migrated: true, stepsApplied };
}
