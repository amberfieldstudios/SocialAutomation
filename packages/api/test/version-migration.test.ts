import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppContext, type AppContext } from '../src/context';
import { runVersionMigrationIfNeeded } from '../src/version-migration';
import { getAppVersion } from '../src/app-version';

let ctx: AppContext;

beforeEach(async () => {
  ctx = await createAppContext({ dbFile: ':memory:' });
});

afterEach(() => {
  ctx.close();
});

describe('runVersionMigrationIfNeeded', () => {
  it('records the current version on the very first run (previousVersion undefined) and reports migrated:true', async () => {
    const result = await runVersionMigrationIfNeeded(ctx);
    expect(result.previousVersion).toBeUndefined();
    expect(result.currentVersion).toBe(getAppVersion());
    expect(result.migrated).toBe(true);
    expect(ctx.db.settings.get('installed_app_version')).toBe(getAppVersion());
  });

  it('is a no-op (migrated:false) on a second run at the same version', async () => {
    await runVersionMigrationIfNeeded(ctx);
    const second = await runVersionMigrationIfNeeded(ctx);
    expect(second.migrated).toBe(false);
    expect(second.previousVersion).toBe(getAppVersion());
  });

  it('detects an upgrade from an older recorded version and re-records the new one', async () => {
    ctx.db.settings.set('installed_app_version', '0.0.1');
    const result = await runVersionMigrationIfNeeded(ctx);
    expect(result.previousVersion).toBe('0.0.1');
    expect(result.currentVersion).toBe(getAppVersion());
    expect(result.migrated).toBe(true);
    expect(ctx.db.settings.get('installed_app_version')).toBe(getAppVersion());
  });

  it('survives a full context restart (same db file), matching t2s persistence pattern', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const dbFile = path.join(os.tmpdir(), `version-migration-restart-${Date.now()}.sqlite`);
    // A real (non-`:memory:`) dbFile makes createAppContext persist OAuth
    // app credentials to a real on-disk key under the user-data dir (t15,
    // QG-2, landed after this test was written) — isolated to a throwaway
    // temp dir here so this test never writes a stray key file into the
    // real developer/CI machine's profile.
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-migration-restart-userdata-'));
    const originalUserDataDir = process.env.SOCIAL_AUTOMATION_USER_DATA_DIR;
    process.env.SOCIAL_AUTOMATION_USER_DATA_DIR = userDataDir;
    try {
      const ctxA = await createAppContext({ dbFile });
      const first = await runVersionMigrationIfNeeded(ctxA);
      expect(first.migrated).toBe(true);
      ctxA.close();

      const ctxB = await createAppContext({ dbFile });
      const second = await runVersionMigrationIfNeeded(ctxB);
      expect(second.migrated).toBe(false);
      expect(second.previousVersion).toBe(getAppVersion());
      ctxB.close();
    } finally {
      fs.rmSync(dbFile, { force: true });
      fs.rmSync(userDataDir, { recursive: true, force: true });
      if (originalUserDataDir === undefined) delete process.env.SOCIAL_AUTOMATION_USER_DATA_DIR;
      else process.env.SOCIAL_AUTOMATION_USER_DATA_DIR = originalUserDataDir;
    }
  });
});
