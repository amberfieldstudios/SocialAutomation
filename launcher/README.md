# SocialAutomation.exe launcher (self-contained distributable)

Double-click launcher for the SocialAutomation app. Produces
`SocialAutomation.exe` at the repo root (sibling of `package.json`).

**Goal:** a non-technical streamer downloads a folder, double-clicks the exe,
and lands in the setup wizard — with no Node.js, pnpm, or anything else
preinstalled, and no raw console wall of install/build logs.

## What changed from the old launcher

The old launcher required Node.js >= 22 on `PATH` and ran a visible
`npx pnpm run start` (which does `pnpm install && pnpm build` on first run) in
a raw `cmd.exe` window. That's gone. Now:

- A **Node.js runtime is bundled** with the distributable
  (`runtime\node-win-x64\`, staged by `fetch-node-runtime.ps1`) — nothing
  needs to be preinstalled.
- The distributable ships **prebuilt** (`node_modules` + `packages/ui/dist`
  already staged by `scripts\build-distributable.ps1`), so first run does
  **not** install or build anything — it just starts the server. No more
  multi-minute wall of `pnpm` output on first launch.
- First-run bootstrap (`bootstrap.mjs`) shows **plain-language progress and
  errors** in a small window instead of a raw console (see below).
- **Port-in-use is handled automatically**: the app picks the next free port
  itself and tells the user, instead of crashing.

## Pieces

- **`Program.cs`** — the launcher exe source (C#, .NET Framework-compatible,
  no external NuGet packages). Resolves a Node runtime (bundled first, PATH
  as a dev fallback), runs `bootstrap.mjs` hidden, and shows a small
  WinForms progress window that parses `##STATUS##{json}` lines from
  `bootstrap.mjs`'s stdout to display plain-language status, opens the
  browser once ready, and shows a `MessageBox` with a plain-language message
  on failure. Closing the window (or its "Quit" button) kills the whole
  bootstrap+server process tree via `taskkill /T /F` (.NET's `Process.Kill()`
  alone doesn't kill child processes).
- **`bootstrap.mjs`** — run by the resolved node. Verifies the packaged
  build looks complete (fails with a plain-language message instead of
  attempting a silent install if not — see "Verifying the distributable"
  below), picks a free port (`scripts/lib/find-free-port.mjs`, shared with
  dev's `pnpm start`), points the server's user data (SQLite DB; the LLM
  model later, per the on-device-LLM milestone) at
  `%LOCALAPPDATA%\SocialAutomation\` — **outside** this app folder, so a
  future update that replaces the app folder never touches user data — and
  spawns the server directly via its `vite-node` entrypoint (no `pnpm`/`npx`
  needed at runtime at all).
- **`fetch-node-runtime.ps1`** — build-time step: downloads a pinned,
  checksum-verified Node.js Windows x64 build from nodejs.org and stages it
  at `<repo root>\runtime\node-win-x64\`. Idempotent (skips if already
  staged at the pinned version).
- **`build.ps1`** — compiles `Program.cs` into `<repo root>\SocialAutomation.exe`
  using the C# compiler that ships with every Windows install
  (`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`) — no SDK
  download required. Falls back to
  [ps2exe](https://github.com/MScholtes/PS2EXE) (installed from PSGallery on
  demand) if `csc.exe` isn't present.
- **`launch-wrapper.ps1`** — the PowerShell equivalent of `Program.cs`
  (bundled-runtime resolution + `bootstrap.mjs` + status parsing), compiled
  by the ps2exe fallback path in `build.ps1`. Not used by the primary
  (csc.exe) build.
- **`Launch-SocialAutomation.bat`** — worst-case fallback with no compilation
  at all: double-click it directly. Resolves the bundled runtime the same
  way and runs `bootstrap.mjs` with a visible console (plain status lines,
  not a raw install wall).
- **`../scripts/build-distributable.ps1`** — the one-command build: `pnpm
  install` + UI build + bundled runtime + exe compile + stage everything
  into `dist\SocialAutomation\`, ready to zip and ship. This is what a
  release-verification script (t8) should wrap.

## Building the distributable

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-distributable.ps1
```

Produces `dist\SocialAutomation\` — copy/zip that whole folder; it's the
release artifact. Rebuilding just the exe (e.g. after a `Program.cs` change,
without redoing the full install/build/stage):

```powershell
powershell -ExecutionPolicy Bypass -File launcher\build.ps1
```

## User data & the update story (t7 — see `docs/UPDATING.md` for the full story)

`bootstrap.mjs` sets `SOCIAL_AUTOMATION_USER_DATA_DIR` to
`%LOCALAPPDATA%\SocialAutomation\` before starting the server; `prod.ts`
defaults `SOCIAL_DB_FILE` to `<that dir>\data.sqlite` when it's set (and only
then — plain `pnpm start`/dev keeps the old `./data.sqlite` cwd-relative
default, so nothing about local dev changed). The downloaded LLM model is
stored under the same `SOCIAL_AUTOMATION_USER_DATA_DIR` for the same reason
(`packages/ai/src/modelDownloadManager.ts`). Because this directory lives
outside `dist\SocialAutomation\`, an update can replace that entire folder
wholesale without touching accounts, settings, history, or the downloaded
model — see `docs/UPDATING.md` for the full update story: distribution via
GitHub Releases, the in-app "update available" check
(`packages/api/src/update-routes.ts` + `packages/ui/src/components/UpdateBanner.tsx`),
the on-upgrade migration hook (`packages/api/src/version-migration.ts`), and
plain-language streamer-facing update steps.

## The LLM model is not bundled

`scripts/build-distributable.ps1` only stages `packages`, `scripts`,
`launcher`, `runtime`, `node_modules`, and a few root files — never a model
file. The model download manager (separate task) downloads to
`SOCIAL_AUTOMATION_USER_DATA_DIR` on first use, not at packaging time.

## Code signing

`SocialAutomation.exe` is **unsigned**. On a machine with no other reason to
trust it, Windows SmartScreen will show an "unrecognized app" warning on
first run (the user can still click "More info" → "Run anyway"). To remove
that warning, the project owner needs to supply:

- An Authenticode code-signing certificate (EV recommended — it gets
  SmartScreen reputation faster than OV/standard; a `.pfx` + password, or a
  hardware token for EV) from a CA (DigiCert, Sectigo, etc.) or an
  organization's existing signing infrastructure.
- Then sign with the in-box `signtool.exe`:
  ```powershell
  signtool sign /f cert.pfx /p <password> /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 SocialAutomation.exe
  ```
  This isn't wired into `build.ps1` because no certificate is available in
  this environment — add a `-CertPath`/`-CertPassword` param to `build.ps1`
  and the `signtool sign` call once one is supplied.

## Verifying the distributable

Checklist (see the `build-installer` skill):

1. **Self-contained**: `dist\SocialAutomation\SocialAutomation.exe` must
   launch to the wizard on a machine with no Node.js on `PATH` at all — it
   should use `runtime\node-win-x64\node.exe`, never touch `PATH`'s node.
2. **No raw console wall**: first run shows the progress window with
   plain-language status, not a wall of `pnpm install`/build output (that
   only happens for from-source dev checkouts via `pnpm start`, never for
   the packaged distributable).
3. **Port-in-use handled**: start a second copy (or occupy port 3000
   yourself) and confirm the app picks another port and still opens the
   right URL.
4. **No LLM model bundled**: `dist\SocialAutomation\` should contain no
   `.gguf`/model files; `%LOCALAPPDATA%\SocialAutomation\` should be created
   fresh on first run for the DB (and later, the model).
5. **Code signing**: currently unsigned — see above.

## What's owed real-world verification

This environment can build the exe (`csc.exe` is present), download and
checksum-verify a real Node.js runtime, and stage the distributable folder —
all of that was exercised for real, not just written. What this sandboxed,
non-interactive environment cannot do:

- Launch `SocialAutomation.exe` itself as a GUI app and see the WinForms
  progress window render (no interactive desktop session here). The
  bootstrap logic behind it (`bootstrap.mjs`) was run directly with the
  bundled node and verified to reach a ready state and serve the dashboard
  (see the build-installer skill run notes / task report).
- Verify behavior on a machine that has **zero** Node.js anywhere (this
  machine has a system Node on `PATH`, though the launcher/bootstrap were
  verified to prefer and successfully use the bundled runtime instead).
- Trigger and click through the actual `MessageBox.Show` error dialogs
  (missing runtime, corrupted install) — reviewed by reading the code path,
  not by triggering a real dialog.
- SmartScreen/Defender behavior on the unsigned exe, and everything under
  "Code signing" above (no certificate available here).

A clean Windows machine with no Node.js preinstalled should download the
zipped `dist\SocialAutomation\` folder, extract it, and double-click
`SocialAutomation.exe` before this is considered fully verified.
