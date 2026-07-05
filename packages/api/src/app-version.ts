/**
 * The app's own version, read from the root `package.json` (single source
 * of truth — bump it there when cutting a release, see
 * `docs/UPDATING.md`/`launcher/README.md`). Used by the update-available
 * check (`update-routes.ts`) and the on-upgrade migration hook
 * (`version-migration.ts`).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | undefined;

/** This file lives at packages/api/src/app-version.ts — the root package.json is 3 levels up. */
function resolveRootPackageJsonPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../package.json');
}

export function getAppVersion(): string {
  if (cached) return cached;
  try {
    const raw = readFileSync(resolveRootPackageJsonPath(), 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    cached = pkg.version ?? '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}
