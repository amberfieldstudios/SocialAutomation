/**
 * Production entrypoint: single-port mode. Boots the same Fastify app as
 * `dev.ts` (real SQLite DB + wired Pipeline), but also serves the built
 * @social/ui static bundle (`packages/ui/dist`) with an SPA fallback, so one
 * process on one port serves both the dashboard and the `/api/*` routes.
 *
 * Run via the root `pnpm start` script (see root package.json / scripts/start.mjs),
 * which builds the UI's static bundle first if it's missing. Can also be run
 * directly (this workspace's packages are TS-native — every `@social/*`
 * package's `main` points at `src/index.ts`, so this is run with `vite-node`,
 * the same TS-aware runtime `dev.ts` uses, rather than plain `node` on
 * precompiled output):
 *
 *   npx --yes pnpm@9.7.0 --filter @social/api run start
 *
 * Config (env vars):
 *   PORT                          - preferred port to listen on (default 3000).
 *                                   If it's already in use, the server picks the
 *                                   next free port automatically (see
 *                                   `scripts/lib/find-free-port.mjs`) instead of
 *                                   crashing with a raw EADDRINUSE stack trace.
 *   HOST                          - host to bind (default 0.0.0.0)
 *   SOCIAL_DB_FILE                - SQLite file path. Defaults to
 *                                   `<SOCIAL_AUTOMATION_USER_DATA_DIR>/data.sqlite`
 *                                   when that's set, else `./data.sqlite` next to cwd.
 *   SOCIAL_AUTOMATION_USER_DATA_DIR - directory for user data that must survive an
 *                                   app update (DB, downloaded LLM model, settings).
 *                                   Set by the packaged launcher's bootstrap to a
 *                                   per-user folder OUTSIDE the app/install directory
 *                                   (see launcher/bootstrap.mjs). Unset in plain
 *                                   `pnpm start`/dev usage, where cwd-relative paths
 *                                   are fine.
 *   UI_DIST                       - override path to the built UI's dist dir (default
 *                                   resolved relative to this file: ../../ui/dist)
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { AiConfigError } from '@social/ai';
import { createAppContext } from './context';
import { createServer } from './server';
import { findFreePort } from '../../../scripts/lib/find-free-port.mjs';
import { runVersionMigrationIfNeeded } from './version-migration';

const REQUESTED_PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

function resolveUiDist(): string {
  if (process.env.UI_DIST) return path.resolve(process.env.UI_DIST);
  const here = path.dirname(fileURLToPath(import.meta.url));
  // This file lives at packages/api/src/prod.ts — the UI's dist dir is a
  // sibling package: packages/api/src/../../ui/dist.
  return path.resolve(here, '../../ui/dist');
}

/** Default DB path: inside the user-data dir if one was provided, else cwd-relative (dev). */
function resolveDbFile(): string {
  if (process.env.SOCIAL_DB_FILE) return process.env.SOCIAL_DB_FILE;
  const userDataDir = process.env.SOCIAL_AUTOMATION_USER_DATA_DIR;
  if (userDataDir) {
    fs.mkdirSync(userDataDir, { recursive: true });
    return path.join(userDataDir, 'data.sqlite');
  }
  return './data.sqlite';
}

async function main(): Promise<void> {
  const uiDist = resolveUiDist();
  if (!fs.existsSync(path.join(uiDist, 'index.html'))) {
    console.error(
      `[api.prod] Built UI not found at ${uiDist} (missing index.html).\n` +
        `Run "pnpm --filter @social/ui run build" first, or use the root "pnpm start" script.`,
    );
    process.exit(1);
  }

  const ctx = await createAppContext({ dbFile: resolveDbFile() });

  // Update story (t7): detect an upgrade (or first-ever run) against this
  // user-data folder and run any registered migration steps before the
  // server starts serving requests. See version-migration.ts.
  const versionCheck = await runVersionMigrationIfNeeded(ctx);
  if (versionCheck.migrated) {
    console.log(
      `[api.prod] ${versionCheck.previousVersion ? `Upgraded from v${versionCheck.previousVersion} to` : 'First run of'} v${versionCheck.currentVersion}` +
        (versionCheck.stepsApplied.length ? ` (applied: ${versionCheck.stepsApplied.join(', ')})` : ''),
    );
  }

  const app = await createServer(ctx, { uiDist });

  let port: number;
  try {
    port = await findFreePort(REQUESTED_PORT, { host: HOST });
  } catch (err) {
    console.error(`[api.prod] ${(err as Error).message}`);
    process.exit(1);
    return;
  }
  if (port !== REQUESTED_PORT) {
    console.log(
      `[api.prod] Port ${REQUESTED_PORT} was already in use — using ${port} instead.`,
    );
  }

  await app.listen({ port, host: HOST });
  const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${port}`;
  ctx.logger.info('api.prod_server_started', { port, host: HOST, uiDist });
  // A machine-readable line the packaged launcher's bootstrap (see
  // launcher/bootstrap.mjs) greps for, in addition to polling /api/health —
  // gives it the actual port immediately without guessing.
  console.log(`[api.prod] SOCIAL_AUTOMATION_READY port=${port} url=${url}`);
  console.log(`[api.prod] SocialAutomation is running at ${url}`);

  // Start the publish/analytics queue worker's continuous poller now that the
  // server is listening. Without this, `PublishService.submitPost` enqueues a
  // job that is composed/validated but NEVER drained — it sits `pending`
  // forever (see QA finding F1 / t13). `runOnce()` (used by seed.ts and
  // tests) is a single manual sweep; `start()` is the real always-on poller
  // this running server needs. Deliberately NOT started inside
  // `createAppContext`/`buildPipeline` — tests and seed.ts must keep driving
  // `runOnce()` explicitly without a background poller racing them.
  ctx.pipeline.worker.start();
  console.log('[api.prod] Publish/analytics queue worker started — jobs will now be drained continuously.');

  const shutdown = async (): Promise<void> => {
    await ctx.pipeline.worker.stop();
    await app.close();
    ctx.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  if (err instanceof AiConfigError) {
    // Misconfigured AI provider (unknown AI_PROVIDER, missing API key):
    // print the actionable message without a stack trace — this is a config
    // problem, not a crash.
    console.error(`[api.prod] AI provider configuration error: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
