#!/usr/bin/env node
/**
 * Root `pnpm start`: production launcher.
 *
 * Builds the UI's static bundle (`packages/ui/dist`) if missing, then runs
 * `@social/api`'s production entrypoint (`packages/api/src/prod.ts`), which
 * serves the built UI + all `/api/*` routes on one port (default 3000,
 * override with `PORT`).
 *
 * Note on "building" the API: every `@social/*` workspace package's `main`
 * points at its `src/index.ts` (see e.g. `packages/db/package.json`) — this
 * is a TS-native monorepo where nothing actually runs from precompiled JS
 * at runtime, dev or prod. `pnpm --filter @social/api run build` (tsc emit)
 * exists for typechecking/CI, but the API is *run* the same way in both
 * modes: via `vite-node` (see `dev`/`start` scripts in
 * `packages/api/package.json`), which resolves workspace deps straight from
 * source. So there's no "api dist" artifact to build before starting here.
 *
 * Used both by `pnpm start` directly and by the Windows launcher exe
 * (see `launcher/`), so it must be idempotent and safe to re-run.
 */
import { spawnSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const uiDistIndex = path.join(rootDir, 'packages', 'ui', 'dist', 'index.html');
const pnpmCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const pnpmArgs = ['--yes', 'pnpm@9.7.0'];

// On Windows, `npx.cmd` is a shell script wrapper — spawning it without
// `shell: true` throws EINVAL (Node can't exec a .cmd file directly).
const useShell = process.platform === 'win32';

function run(args, label) {
  console.log(`[start] ${label}: npx ${pnpmArgs.concat(args).join(' ')}`);
  const result = spawnSync(pnpmCmd, [...pnpmArgs, ...args], { stdio: 'inherit', cwd: rootDir, shell: useShell });
  if (result.status !== 0) {
    console.error(`[start] ${label} failed (exit ${result.status}).`);
    process.exit(result.status ?? 1);
  }
}

// node_modules missing entirely -> install first (covers first-time bootstrap
// for the launcher exe as well as bare `pnpm start`).
if (!existsSync(path.join(rootDir, 'node_modules'))) {
  run(['install'], 'Installing dependencies (first run)');
}

if (!existsSync(uiDistIndex)) {
  run(['--filter=@social/ui', 'run', 'build'], 'Building UI (dist missing)');
}

const port = process.env.PORT ?? '3000';
console.log(`[start] Starting SocialAutomation on port ${port} ...`);
const server = spawn(pnpmCmd, [...pnpmArgs, '--filter=@social/api', 'run', 'start'], {
  stdio: 'inherit',
  cwd: rootDir,
  env: { ...process.env, PORT: port },
  shell: useShell,
});

server.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.kill(sig));
}
