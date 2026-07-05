# Updating SocialAutomation (t7 — the update story)

This document covers two audiences: the **project owner** (how to cut a
release) and **the streamer** (how they get a new version without losing
anything). If you're writing user-facing docs (t11), translate the
"For streamers" section into plain language — this file is the
implementation reference.

## The guarantee

Updating SocialAutomation **never** loses accounts, settings, publish
history, or a downloaded LLM model, because none of that lives inside the
app folder that gets replaced:

- The app folder (wherever the user put `dist/SocialAutomation`, e.g.
  `SocialAutomation.exe` + `packages/` + `node_modules/` + the bundled
  `runtime/`) is **fully replaceable** — every file in it comes from the
  release zip and nothing user-specific is ever written there.
- All user data lives under `%LOCALAPPDATA%\SocialAutomation\` (Windows),
  set by the launcher's bootstrap (`launcher/bootstrap.mjs`) via the
  `SOCIAL_AUTOMATION_USER_DATA_DIR` environment variable, which
  `packages/api/src/prod.ts` uses to default `SOCIAL_DB_FILE` (the SQLite
  database — accounts, settings, wizard state, publish history, jobs,
  schedules) and which the model download manager (t4,
  `packages/ai/src/modelDownloadManager.ts`) uses to store the downloaded
  GGUF model. See `launcher/README.md` and `launcher/bootstrap.mjs`.
- Updating is therefore just: **delete the old app folder, unzip the new
  one in its place.** `%LOCALAPPDATA%\SocialAutomation\` is never touched.

## Distribution channel: GitHub Releases

Free, needs no infrastructure the owner has to run or pay for, and is what
the update-available check (below) already targets.

**Per release, the owner:**

1. Bump the `version` field in the root `package.json` (this is the single
   source of truth the app reads at runtime — see `packages/api/src/app-version.ts`
   — and what the update check compares against).
2. Add a `## [x.y.z]` section to `CHANGELOG.md` (move the relevant
   `[Unreleased]` entries under it).
3. Build and verify the distributable (t6/t8):
   ```powershell
   node scripts/verify-release.mjs
   ```
   This builds `dist\SocialAutomation\` and asserts self-contained launch, no
   bundled model, user-data isolation, etc. (see `launcher/README.md`).
4. Zip the staged folder:
   ```powershell
   Compress-Archive -Path dist\SocialAutomation -DestinationPath dist\SocialAutomation-vX.Y.Z-win-x64.zip -Force
   ```
5. Create a GitHub Release (via the repo's web UI, or `gh release create`)
   tagged `vX.Y.Z`, with `CHANGELOG.md`'s new section pasted into the release
   notes, and the zip attached as a release asset.
6. Set `SOCIAL_AUTOMATION_UPDATE_REPO=<owner>/<repo>` (see below) once, the
   first time this is set up — every future release after that is picked up
   automatically by the in-app check.

No CI/hosting/server is required — GitHub Releases hosts the zip for free,
and the in-app check hits GitHub's public REST API (no auth, no API key).

## In-app "update available" check

`packages/api/src/update-routes.ts` (`GET /api/update/status`,
`POST /api/update/dismiss`) + `packages/ui/src/components/UpdateBanner.tsx`.

- **Opt-in and silent by default.** Until the owner sets
  `SOCIAL_AUTOMATION_UPDATE_REPO=<owner>/<repo>` (e.g. as an environment
  variable set on the machine, or baked into a future installer step), the
  check reports `configured: false` and makes **zero** network calls — an
  unconfigured update source is a normal state, not an error.
- Once configured, the dashboard calls `GET /api/update/status` on load; the
  server hits `https://api.github.com/repos/<owner>/<repo>/releases/latest`
  (unauthenticated, cached in memory for 10 minutes so repeated dashboard
  loads don't hammer it) and compares the release's `vX.Y.Z` tag against the
  running app's version (`packages/api/src/semver-lite.ts`'s plain numeric
  compare — no pre-release/build-metadata support, this project doesn't use
  them).
- If a newer version exists, `UpdateBanner` shows one line — current version,
  new version, a link to the release page, and an explicit reminder that
  accounts/settings/history/model are kept — plus a **Dismiss** button.
  Dismissing calls `POST /api/update/dismiss` and is stored server-side (the
  same `app_settings` key/value store t2 uses for wizard state, not
  `localStorage`), keyed to that specific version — the banner won't nag
  again for it, but resurfaces for the next release.
- Any network failure (offline, GitHub down, DNS failure) never surfaces as
  an app error: `UpdateStatus.error` gets a plain-language message and the
  banner just doesn't render — checking for updates is a courtesy, never a
  requirement to use the app.

**This is a NOTIFY-AND-GUIDE flow, not silent auto-update.** The user still
manually downloads and swaps the folder (see below). Full silent
auto-download-and-relaunch was explicitly optional per the task; it isn't
implemented — see "Not done" below for what a future iteration would need.

## Migration hook (schema + user-data)

Two separate mechanisms run on every server startup
(`packages/api/src/prod.ts`'s `main()`):

1. **`@social/db`'s schema migrations** (`Database.migrate()`) — SQL
   `ALTER TABLE`/`CREATE TABLE` changes, already existed before t7, run
   unconditionally and are idempotent (each migration tracks whether it's
   applied).
2. **`packages/api/src/version-migration.ts`'s `runVersionMigrationIfNeeded`**
   (new, t7) — compares the previously-recorded app version (stored in
   `app_settings` under `installed_app_version`) against the version
   actually running. On the very first run against a given
   `SOCIAL_AUTOMATION_USER_DATA_DIR` (fresh install) or after an upgrade
   (different version than last recorded), it runs any registered
   `MIGRATION_STEPS` — the extensibility point for anything an upgrade needs
   to do to **existing** user data that isn't a SQL schema change (e.g.
   renaming a settings key, moving a file under the user-data dir,
   re-encoding something). `MIGRATION_STEPS` is empty today because no
   release has needed one yet — the hook itself is exercised on every real
   startup (verified in this task: it logs `app.version_detected` and
   writes `installed_app_version` on a fresh DB, and is a confirmed no-op on
   a second run at the same version), it just has nothing to do until a
   future release adds a step. **When you need one:** add an entry to
   `MIGRATION_STEPS` in that file, in the same PR that bumps `package.json`'s
   version.

## For streamers: how to update

1. You'll see a banner in the dashboard when a new version is out, with a
   link to the release page. (If you don't see one, updates aren't
   configured yet for this build, or you're already on the latest.)
2. Download the new version's zip from the release page and extract it
   somewhere (e.g. your Desktop).
3. Close SocialAutomation if it's running (click "Quit SocialAutomation" in
   its window).
4. Delete your old SocialAutomation folder, and put the newly-extracted one
   in its place (same location, or anywhere you like).
5. Double-click `SocialAutomation.exe` in the new folder. Your connected
   accounts, settings, publish history, and downloaded AI model are all
   still there — they were never inside the folder you just replaced.

## Not done / owed

- **Full silent auto-update** (download + swap + relaunch without the user
  manually extracting a zip) is explicitly optional per this task's bar and
  is **not implemented**. A future iteration could add a small updater
  script the launcher runs before starting the app: download the new
  release's zip to a temp dir, verify a checksum, extract over/beside the
  current app folder, relaunch — using the same "user data lives outside the
  app dir" property this task established as the safety net. Not started
  here; scoping it is future work.
- **Actually cutting a GitHub Release** (creating the repo, setting
  `SOCIAL_AUTOMATION_UPDATE_REPO`, running the release steps above end to
  end against a real public repo) is owed to the project owner — this
  environment has no GitHub repo/credentials to push a release to. The
  update-CHECK side was verified for real against a real public repo
  (`anthropics/claude-code`, chosen only because it's public and has
  releases) to prove the GitHub API integration works; it was not verified
  against this project's own (not-yet-created) release repo.
- **Real end-to-end update walkthrough on a clean machine** (install vOld,
  see the banner, follow the steps above, confirm data survives) is owed to
  qa-user-testing.
