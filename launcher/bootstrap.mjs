#!/usr/bin/env node
/**
 * Friendly first-run bootstrap for the packaged distributable.
 *
 * This replaces the old behavior of opening a raw `cmd.exe` window and
 * running `npx pnpm install && pnpm run start` in front of the user (a wall
 * of install/build log lines with no context). Instead:
 *
 *   - In a PACKAGED build (the normal case: shipped by `scripts/build-distributable.ps1`,
 *     see that file), `node_modules` and `packages/ui/dist` are already built in at
 *     packaging time, so this script does NOT install or build anything at
 *     startup — it just starts the server. Startup goes from "minutes of visible
 *     pnpm spam" to "a couple of seconds of plain status lines".
 *   - If it's missing pieces (e.g. someone deleted `node_modules`, or this is a
 *     from-source checkout being run outside of `pnpm start`), it prints one
 *     plain-language message telling the user/developer what to do, instead of
 *     trying — and probably failing partway through — a silent background
 *     install. It does NOT fall back to a surprise `pnpm install` at app
 *     startup; that belongs to `pnpm start` (`scripts/start.mjs`) for
 *     developers, not to the shipped app.
 *   - Emits machine-readable `##STATUS##{json}` lines on stdout that the
 *     launcher exe (`launcher/Program.cs`) parses to drive a small progress
 *     window, alongside a plain-language line on the line right after it (for
 *     anyone reading raw output — e.g. via `Launch-SocialAutomation.bat`).
 *   - Picks a free port itself (via `scripts/lib/find-free-port.mjs`) before
 *     the server even tries to bind, so "port already in use" becomes "picked
 *     3001 instead of 3000" rather than a crash.
 *   - Points the server's user data (SQLite DB now; the downloaded LLM model
 *     later, per t4) at a per-user folder OUTSIDE the app directory
 *     (`%LOCALAPPDATA%\SocialAutomation` on Windows), so a future update that
 *     replaces the app folder (t7) never touches user data.
 *
 * Usage: node launcher/bootstrap.mjs
 * (invoked by the launcher exe with the bundled/PATH node — see Program.cs)
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { findFreePort } from '../scripts/lib/find-free-port.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

/** Emit a status line for the launcher's progress window, plus a plain-text line for humans. */
function status(stage, message, extra = {}) {
  process.stdout.write(`##STATUS##${JSON.stringify({ stage, message, ...extra })}\n`);
  process.stdout.write(`[bootstrap] ${message}\n`);
}

function fail(message, extra = {}) {
  process.stdout.write(`##STATUS##${JSON.stringify({ stage: 'error', message, ...extra })}\n`);
  process.stderr.write(`[bootstrap] ERROR: ${message}\n`);
  process.exitCode = 1;
}

/** Per-user data directory, outside the (replaceable) app folder. Created if missing. */
function resolveUserDataDir() {
  const base =
    process.env.SOCIAL_AUTOMATION_USER_DATA_DIR ||
    (process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : path.join(os.homedir(), '.local', 'share'));
  const dir =
    process.env.SOCIAL_AUTOMATION_USER_DATA_DIR ? base : path.join(base, 'SocialAutomation');
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function main() {
  status('starting', 'Starting SocialAutomation...');

  const nodeModulesPresent = existsSync(path.join(repoRoot, 'node_modules'));
  const uiDistPresent = existsSync(path.join(repoRoot, 'packages', 'ui', 'dist', 'index.html'));
  // The packaged distributable uses a hoisted (flat) node_modules, so
  // vite-node lives at the root; a dev checkout's default pnpm layout puts it
  // under packages/api. Accept either.
  const apiViteNode = [
    path.join(repoRoot, 'node_modules', 'vite-node', 'vite-node.mjs'),
    path.join(repoRoot, 'packages', 'api', 'node_modules', 'vite-node', 'vite-node.mjs'),
  ].find(existsSync);

  if (!nodeModulesPresent || !uiDistPresent || !apiViteNode) {
    // A packaged distributable ships prebuilt; if pieces are missing, this
    // copy is either corrupted/incomplete or is a bare source checkout that
    // hasn't been set up for development yet. Either way, don't silently
    // kick off a multi-minute install/build behind a spinner — say so.
    fail(
      'This copy of SocialAutomation looks incomplete (missing ' +
        [
          !nodeModulesPresent && 'dependencies',
          !uiDistPresent && 'the built dashboard',
          !apiViteNode && 'the server runtime',
        ]
          .filter(Boolean)
          .join(', ') +
        '). If you downloaded this from the release page, please re-download it — the download ' +
        'may not have finished, or a file was deleted. If you are a developer running from source, ' +
        'run "pnpm install" and "pnpm run start" from a terminal instead of this launcher.',
    );
    return;
  }

  status('port', 'Checking for a free port...');
  const requestedPort = Number(process.env.PORT ?? 3000);
  let port;
  try {
    port = await findFreePort(requestedPort, { host: '127.0.0.1' });
  } catch (err) {
    fail(err.message);
    return;
  }
  if (port !== requestedPort) {
    status('port', `Port ${requestedPort} was busy — using ${port} instead.`, { port });
  }

  const userDataDir = resolveUserDataDir();
  status('userdata', `Your settings and data will be kept in ${userDataDir}`, { userDataDir });

  status('server', 'Starting the SocialAutomation server...');

  const child = spawn(
    process.execPath,
    [apiViteNode, 'src/prod.ts'],
    {
      cwd: path.join(repoRoot, 'packages', 'api'),
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        SOCIAL_AUTOMATION_USER_DATA_DIR: userDataDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let readyReported = false;
  let lastServerLine = '';

  function handleServerOutput(buf, isErr) {
    const text = buf.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      lastServerLine = line;
      // Forward server output as plain text for anyone watching raw logs
      // (e.g. Launch-SocialAutomation.bat, or a developer's terminal).
      (isErr ? process.stderr : process.stdout).write(`[server] ${line}\n`);
      if (!readyReported && line.includes('SOCIAL_AUTOMATION_READY')) {
        readyReported = true;
        status('ready', `SocialAutomation is ready at http://localhost:${port}/`, {
          port,
          url: `http://localhost:${port}/`,
        });
      }
    }
  }

  child.stdout.on('data', (buf) => handleServerOutput(buf, false));
  child.stderr.on('data', (buf) => handleServerOutput(buf, true));

  child.on('exit', (code) => {
    if (!readyReported) {
      fail(
        'The server stopped before it finished starting up. ' +
          (lastServerLine ? `Last message: ${lastServerLine}` : 'No output was captured.') +
          ' If this keeps happening, please report it along with this message.',
      );
    }
    process.exitCode = code ?? (readyReported ? 0 : 1);
  });

  const shutdown = () => {
    if (!child.killed) child.kill();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  fail(err && err.message ? err.message : String(err));
});
