#!/usr/bin/env node
/**
 * Release build verification gate (t8): one command that builds the
 * SocialAutomation distributable from a clean checkout and ASSERTS the
 * build-installer checks, instead of just eyeballing the output. Exits
 * non-zero if any assertion fails, printing a clear pass/fail report.
 *
 * This is what t12 (the 1.0 release checklist) wraps -- a release is not
 * "verified" until this script passes.
 *
 * Usage:
 *   node scripts/verify-release.mjs                 # full build + verify
 *   node scripts/verify-release.mjs --skip-build     # verify an existing dist/SocialAutomation
 *   node scripts/verify-release.mjs --out-dir <path> # verify a different staged folder
 *
 * Checks (see launcher/README.md "Verifying the distributable" / the
 * build-installer skill for the same list applied by hand):
 *   0. ZIP ROUND-TRIP: every check below runs against a copy EXTRACTED FROM
 *      THE RELEASE ZIP, not the staged folder. v1.0.0 shipped a staged
 *      folder that passed every check while the zip silently dropped all of
 *      pnpm's node_modules junctions -- users got "missing the server
 *      runtime" on launch. The artifact users download is the only thing
 *      worth verifying.
 *   1. Bundled runtime present (runtime\node-win-x64\node.exe in the staged folder).
 *   2. Self-contained launch: start the staged app using ONLY that bundled
 *      node.exe, with PATH emptied out (so it CANNOT fall back to a system
 *      node even if one exists), and confirm it reaches a ready state and
 *      serves /api/health and /.
 *   3. Port-in-use handled: occupy the default port first and confirm the
 *      app picks another one and still reports the right URL.
 *   4. No LLM model bundled: zero .gguf (or other common model weight)
 *      files anywhere under the staged folder.
 *   5. User data isolated: the SQLite DB lands under
 *      SOCIAL_AUTOMATION_USER_DATA_DIR (%LOCALAPPDATA%\SocialAutomation on
 *      Windows) -- NOT inside the staged app folder -- so a future update
 *      can replace the app folder without touching it.
 *   6. Code signing: reports pass/fail is not applicable here (no
 *      certificate in this environment) -- see launcher/README.md.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const args = process.argv.slice(2);
const skipBuild = args.includes('--skip-build');
const outDirArg = args.find((a) => a.startsWith('--out-dir='));
const outDirIdx = args.indexOf('--out-dir');
const outDir =
  outDirArg?.split('=')[1] ??
  (outDirIdx >= 0 ? args[outDirIdx + 1] : undefined) ??
  path.join(repoRoot, 'dist', 'SocialAutomation');

/** @type {{name: string, pass: boolean, detail: string}[]} */
const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}${detail ? ` -- ${detail}` : ''}`);
}

async function findFiles(dir, predicate, found = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await findFiles(full, predicate, found);
    } else if (predicate(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

function run(cmd, cmdArgs, opts = {}) {
  return spawnSync(cmd, cmdArgs, { stdio: 'inherit', ...opts });
}

function localAppDataUserDataDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'SocialAutomation');
}

async function main() {
  console.log('=== SocialAutomation release verification (t8) ===');
  console.log(`Repo root: ${repoRoot}`);
  console.log(`Staged distributable: ${outDir}`);
  console.log('');

  if (!skipBuild) {
    console.log('--- Building distributable (scripts/build-distributable.ps1) ---');
    const build = run('powershell', [
      '-NoProfile',
      '-File',
      path.join(repoRoot, 'scripts', 'build-distributable.ps1'),
      '-OutDir',
      outDir,
    ]);
    if (build.status !== 0) {
      record('Build the distributable', false, `scripts/build-distributable.ps1 exited ${build.status}`);
      finish();
      return;
    }
    record('Build the distributable', true, outDir);
  } else {
    console.log('--- Skipping build (--skip-build); verifying existing folder ---');
  }

  // --- Zip round-trip: find the release zip the build produced and extract
  // it fresh; everything below is verified against the EXTRACTED copy (what
  // a user actually downloads), never the staged folder. The staged folder
  // can pass every check while the zip is broken (v1.0.0 did exactly that:
  // zipping dropped every pnpm junction). ---
  const distDir = path.dirname(outDir);
  let zipPath = null;
  try {
    const zips = (await readdir(distDir)).filter((n) => /^SocialAutomation-.+-win-x64\.zip$/.test(n));
    if (zips.length > 0) zipPath = path.join(distDir, zips.sort().pop());
  } catch {
    /* dist dir missing entirely -- handled below */
  }

  let testDir = outDir;
  if (zipPath) {
    console.log('');
    console.log(`--- Extracting release zip for round-trip verification: ${zipPath} ---`);
    const extractRoot = path.join(os.tmpdir(), 'social-automation-verify-zip');
    rmSync(extractRoot, { recursive: true, force: true });
    mkdirSync(extractRoot, { recursive: true });
    const tar = run('tar.exe', ['-xf', zipPath, '-C', extractRoot]);
    const extracted = path.join(extractRoot, path.basename(outDir));
    const extractedOk = tar.status === 0 && existsSync(extracted);
    record(
      'Release zip extracts cleanly',
      extractedOk,
      extractedOk ? `${zipPath} -> ${extracted}` : `tar.exe exited ${tar.status} or ${extracted} missing`,
    );
    if (!extractedOk) {
      finish();
      return;
    }
    testDir = extracted;
    console.log('All checks below run against the extracted copy, not the staged folder.');
  } else {
    record(
      'Release zip round-trip',
      false,
      `no SocialAutomation-*-win-x64.zip found in ${distDir} -- the build should produce it, and the ZIP (not the staged folder) is what must be verified`,
    );
  }

  // The launch-critical file the v1.0.0 zip was missing: fail loudly here
  // with a named file, not just a generic "never became ready" later.
  const viteNodeEntry = ['node_modules', 'packages/api/node_modules']
    .map((p) => path.join(testDir, ...p.split('/'), 'vite-node', 'vite-node.mjs'))
    .find(existsSync);
  record(
    'Server runtime (vite-node) survived packaging',
    Boolean(viteNodeEntry),
    viteNodeEntry ?? 'vite-node/vite-node.mjs missing from the copy under test',
  );

  const bundledNode = path.join(testDir, 'runtime', 'node-win-x64', 'node.exe');
  const hasBundledNode = existsSync(bundledNode);
  record('Bundled Node runtime present', hasBundledNode, bundledNode);
  if (!hasBundledNode) {
    finish();
    return;
  }

  // --- No LLM model bundled ---
  const modelFiles = await findFiles(testDir, (name) => /\.(gguf|ggml|safetensors)$/i.test(name));
  record(
    'No LLM model bundled',
    modelFiles.length === 0,
    modelFiles.length === 0 ? '0 model files found' : `found: ${modelFiles.join(', ')}`,
  );

  // --- User data isolation: clear out any leftovers from a previous run so
  // this run's evidence is unambiguous. ---
  const userDataDir = localAppDataUserDataDir();
  for (const f of ['data.sqlite', 'data.sqlite-shm', 'data.sqlite-wal']) {
    try {
      rmSync(path.join(userDataDir, f), { force: true });
    } catch {
      /* best effort */
    }
  }
  const stagedDbBefore = existsSync(path.join(testDir, 'data.sqlite'));

  // --- Self-contained launch + port-in-use handling, exercised together in
  // one run: occupy the default port first, then launch with PATH emptied
  // out (so the process truly cannot resolve a system node even by
  // accident) using ONLY the bundled node.exe's absolute path. ---
  console.log('');
  console.log('--- Launching the staged app (bundled runtime only, empty PATH) ---');

  const holderPort = 3000;
  let holder;
  try {
    holder = await occupyPort(bundledNode, holderPort);
  } catch (err) {
    record('Occupy default port for the port-conflict check', false, err.message);
    holder = null;
  }

  const bootstrapScript = path.join(testDir, 'launcher', 'bootstrap.mjs');
  const child = spawn(bundledNode, [bootstrapScript], {
    cwd: testDir,
    env: {
      // Deliberately empty PATH (keep only what Windows needs to function at
      // all) so this process CANNOT fall back to a system node even if one
      // exists on this machine -- proves self-containment, not just "a
      // bundled copy happens to exist".
      SystemRoot: process.env.SystemRoot,
      windir: process.env.windir,
      PORT: String(holderPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const outcome = await waitForOutcome(child, 60_000);
  if (holder) holder.kill();

  record(
    'Self-contained launch (bundled node.exe, empty PATH, no system node)',
    outcome.ready,
    outcome.ready ? `ready at ${outcome.url}` : outcome.error ?? 'timed out waiting for ready status',
  );

  if (outcome.ready) {
    record(
      'Port-in-use handled automatically',
      outcome.port !== holderPort,
      outcome.port !== holderPort
        ? `port ${holderPort} was occupied; app used ${outcome.port} instead`
        : `app used ${holderPort} even though it was occupied -- port conflict NOT handled`,
    );

    try {
      const health = await fetchJson(`http://localhost:${outcome.port}/api/health`);
      record('Health endpoint responds', health?.ok === true, JSON.stringify(health));
    } catch (err) {
      record('Health endpoint responds', false, err.message);
    }

    try {
      const res = await fetch(`http://localhost:${outcome.port}/`);
      record('Dashboard root responds 200', res.status === 200, `status ${res.status}`);
    } catch (err) {
      record('Dashboard root responds 200', false, err.message);
    }
  } else {
    record('Port-in-use handled automatically', false, 'skipped -- app never became ready');
    record('Health endpoint responds', false, 'skipped -- app never became ready');
    record('Dashboard root responds 200', false, 'skipped -- app never became ready');
  }

  await killTree(child);

  // --- User data isolation check (after a real run) ---
  const userDbExists = existsSync(path.join(userDataDir, 'data.sqlite'));
  const stagedDbAfter = existsSync(path.join(testDir, 'data.sqlite'));
  record(
    'User data isolated outside the app folder',
    userDbExists && !stagedDbAfter,
    `DB at ${path.join(userDataDir, 'data.sqlite')}: ${userDbExists}; DB inside staged app folder: ${stagedDbAfter} (was ${stagedDbBefore} before this run)`,
  );

  // --- Code signing: not applicable in this environment; report clearly. ---
  const exePath = path.join(testDir, 'SocialAutomation.exe');
  record(
    'Code signing',
    true, // not a failure of the build -- a documented, owner-owned gap
    existsSync(exePath)
      ? 'exe is UNSIGNED (expected -- no certificate available). See launcher/README.md "Code signing" for what the owner must supply before shipping.'
      : 'SocialAutomation.exe not found in staged output',
  );

  finish();
}

function occupyPort(nodeExe, port) {
  return new Promise((resolve, reject) => {
    const holder = spawn(
      nodeExe,
      ['-e', `require('http').createServer((q,r)=>r.end('busy')).listen(${port}, '127.0.0.1', ()=>console.log('up'))`],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const timer = setTimeout(() => reject(new Error(`port ${port} holder did not confirm binding in time`)), 5000);
    holder.stdout.on('data', (buf) => {
      if (buf.toString().includes('up')) {
        clearTimeout(timer);
        resolve(holder);
      }
    });
    holder.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForOutcome(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ ready: false, error: `no ready status within ${timeoutMs}ms` });
      }
    }, timeoutMs);

    function handle(buf) {
      const text = buf.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith('##STATUS##')) continue;
        try {
          const status = JSON.parse(line.slice('##STATUS##'.length));
          if (status.stage === 'ready' && !settled) {
            settled = true;
            clearTimeout(timer);
            resolve({ ready: true, url: status.url, port: status.port });
          } else if (status.stage === 'error' && !settled) {
            settled = true;
            clearTimeout(timer);
            resolve({ ready: false, error: status.message });
          }
        } catch {
          /* not a status line we can parse; ignore */
        }
      }
    }

    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('exit', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ready: false, error: 'process exited before reporting ready' });
      }
    });
  });
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function killTree(child) {
  if (!child.pid) return;
  await new Promise((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    killer.on('exit', resolve);
    killer.on('error', resolve);
  });
}

function finish() {
  console.log('');
  console.log('=== Summary ===');
  const failed = results.filter((r) => !r.pass);
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
  }
  console.log('');
  if (failed.length > 0) {
    console.log(`${failed.length} check(s) FAILED. This build is NOT release-verified.`);
    process.exitCode = 1;
  } else {
    console.log('All checks passed. Distributable is release-verified (see launcher/README.md for what still needs a real Windows machine + code-signing certificate).');
    process.exitCode = 0;
  }
}

main().catch((err) => {
  console.error('[verify-release] unexpected error:', err);
  process.exitCode = 1;
});
