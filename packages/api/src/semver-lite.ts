/**
 * Minimal dotted-numeric version compare (no pre-release/build-metadata
 * support — this app's versions are plain `MAJOR.MINOR.PATCH`). Shared by
 * the update-available check (`update-routes.ts`) and the on-upgrade
 * migration hook (`version-migration.ts`) so both agree on what "newer"
 * means without pulling in a full semver dependency for three integers.
 *
 * Returns <0 if a<b, 0 if equal, >0 if a>b. Missing/non-numeric segments
 * are treated as 0, so "1.2" == "1.2.0" and "" == "0.0.0".
 */
export function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map((n) => parseInt(n, 10) || 0);
  const partsB = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
