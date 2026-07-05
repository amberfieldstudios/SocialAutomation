/**
 * Update-available check (t7 "update story"). Deliberately minimal and
 * non-nagging:
 *
 *   - Fully OPT-IN in the sense that it never phones home unless
 *     `SOCIAL_AUTOMATION_UPDATE_REPO` (a "owner/repo" GitHub repo slug) is
 *     configured — unconfigured is a normal, silent state (`configured:
 *     false`), not an error, since the project owner may not have cut a
 *     GitHub Releases repo yet. See docs/UPDATING.md for how to set it.
 *   - When configured, checks GitHub's public (unauthenticated) "latest
 *     release" API — free, no API key, generous rate limit for a
 *     once-per-session per-user check — and caches the result in memory for
 *     10 minutes so repeated dashboard loads don't hammer it.
 *   - Never throws and never blocks the dashboard: any network failure comes
 *     back as a plain-language `error` field with `updateAvailable: false`,
 *     exactly like the launcher's other error paths (t6) — a stale/offline
 *     update check must never look like an app failure.
 *   - `dismiss` persists the dismissed version SERVER-SIDE via the same
 *     `app_settings` store t2 uses for wizard state (not localStorage,
 *     matching this app's "server-side, survives browser/profile changes"
 *     convention) so the banner doesn't nag again for a version the user
 *     already acknowledged, but resurfaces for the next one.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from './context';
import { getAppVersion } from './app-version';
import { compareVersions } from './semver-lite';

const DISMISSED_VERSION_KEY = 'update_dismissed_version';
const CHECK_CACHE_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

interface GithubLatestRelease {
  tag_name?: string;
  html_url?: string;
  name?: string;
}

export interface UpdateCheckResult {
  configured: boolean;
  currentVersion: string;
  latestVersion?: string;
  releaseName?: string;
  releaseUrl?: string;
  updateAvailable: boolean;
  error?: string;
}

let cached: { at: number; result: UpdateCheckResult } | undefined;

/** Exposed for tests: clears the in-memory cache between cases. */
export function resetUpdateCheckCacheForTests(): void {
  cached = undefined;
}

async function fetchLatestRelease(repo: string): Promise<UpdateCheckResult> {
  const currentVersion = getAppVersion();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        'User-Agent': 'SocialAutomation-update-check',
        Accept: 'application/vnd.github+json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        configured: true,
        currentVersion,
        updateAvailable: false,
        error: `Couldn't check for updates right now (GitHub responded with status ${res.status}). This doesn't affect using the app.`,
      };
    }
    const release = (await res.json()) as GithubLatestRelease;
    const latestVersion = (release.tag_name ?? '').replace(/^v/i, '').trim();
    const updateAvailable = latestVersion.length > 0 && compareVersions(latestVersion, currentVersion) > 0;
    return {
      configured: true,
      currentVersion,
      updateAvailable,
      ...(latestVersion ? { latestVersion } : {}),
      ...(release.name ? { releaseName: release.name } : {}),
      ...(release.html_url ? { releaseUrl: release.html_url } : {}),
    };
  } catch {
    return {
      configured: true,
      currentVersion,
      updateAvailable: false,
      error: "Couldn't reach the update server (you may be offline). This doesn't affect using the app.",
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = getAppVersion();
  const repo = process.env.SOCIAL_AUTOMATION_UPDATE_REPO;
  if (!repo) {
    return { configured: false, currentVersion, updateAvailable: false };
  }
  if (cached && Date.now() - cached.at < CHECK_CACHE_MS) {
    return cached.result;
  }
  const result = await fetchLatestRelease(repo);
  cached = { at: Date.now(), result };
  return result;
}

export function registerUpdateRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/update/status', async () => {
    const check = await checkForUpdate();
    const dismissedVersion = ctx.db.settings.get<string>(DISMISSED_VERSION_KEY);
    const dismissed = check.latestVersion !== undefined && dismissedVersion === check.latestVersion;
    return { ...check, dismissed };
  });

  app.post('/api/update/dismiss', async (req, reply) => {
    const body = req.body as { version?: string };
    if (!body?.version) {
      return reply.status(400).send({ error: 'version is required' });
    }
    ctx.db.settings.set(DISMISSED_VERSION_KEY, body.version);
    return { ok: true };
  });
}
