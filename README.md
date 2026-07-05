# SocialAutomation

A plugin-based TypeScript/Node.js framework for universal social distribution and automation. Write one content description, generate platform-optimized posts with AI, validate media, publish across multiple accounts via official platform APIs, and track analytics — all without touching the core system when adding new platforms.

## For streamers: using the app

If you just want to download and use SocialAutomation (no coding), start
here:
- [Getting started](docs/user-guide/GETTING-STARTED.md) — download to first published campaign.
- [Connecting your platforms](docs/user-guide/CONNECTING-PLATFORMS.md) — Discord, Bluesky, Twitch, Reddit, Mastodon.
- [Troubleshooting FAQ](docs/user-guide/TROUBLESHOOTING-FAQ.md)
- [Release notes](docs/RELEASE-NOTES.md)

## Architecture Overview

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for a detailed walkthrough of:
- The monorepo structure and module dependency graph
- The content pipeline from input → AI generation → media processing → validation → publish
- TypeScript strict mode, Vitest, and testing strategy
- SQLite (dev) and PostgreSQL (prod) database design

## Core Packages (13)

| Package | Purpose |
|---------|---------|
| `@social/core` | Platform-agnostic types, PlatformConnector contract, plugin registry |
| `@social/logging` | Structured JSON logging with credential redaction |
| `@social/auth` | Encrypted token vault, OAuth flows, multi-account management |
| `@social/db` | Schema, migrations, driver abstraction (SQLite/Postgres), repositories |
| `@social/queue` | Persisted job queue, retry + backoff, dead-letter queue, idempotency |
| `@social/scheduler` | Cron/RRULE scheduling, timezone handling, schedule materialization |
| `@social/ai` | Content generation per platform, tone/length/hashtag tuning, rewrite ops |
| `@social/media` | Image renditions, video transcoding gating, caption handling |
| `@social/pipeline` | Campaign service: AI → media → validate → enqueue orchestration |
| `@social/analytics` | Metrics collection, campaign aggregation, UTM/short-URL tracking |
| `@social/api` | REST API: account pairing, campaign compose/submit, schedule CRUD |
| `@social/ui` | React dashboard: composer, schedule manager, analytics view |
| `@social/conformance` | Shared connector conformance harness for testing |

## Plugins (5) — Contract v1.1

All plugins implement the `PlatformConnector` contract and declare supported operations, required scopes, and rate limits. See [`docs/CONNECTOR-CONTRACT.md`](docs/CONNECTOR-CONTRACT.md).

| Plugin | Module | Status |
|--------|--------|--------|
| **Discord** | `@social/plugin-discord` | Messages, embeds, webhooks, threads (no media upload) |
| **Twitch** | `@social/plugin-twitch` | Channel info updates, viewers/followers analytics (read-only) |
| **Bluesky** | `@social/plugin-bluesky` | Posts with facets (mentions/links/hashtags), immutable |
| **Mastodon** | `@social/plugin-mastodon` | Posts, media upload, hashtags, mentions |
| **Reddit** | `@social/plugin-reddit` | Subreddit posts, media inline (image/video/gallery) |

Platform-specific rules (character limits, media specs, tone) are documented per plugin:
- Discord: `plugins/discord/README.md`
- Twitch: `plugins/twitch/README.md`
- Bluesky: `plugins/bluesky/README.md`
- Mastodon: `plugins/mastodon/README.md`
- Reddit: `plugins/reddit/README.md`

## Getting Started

### Prerequisites

- **Node.js** 22 or later (v24 recommended)
- **pnpm** 9.7.0 or later

### Install Dependencies

```bash
npx --yes pnpm@9.7.0 install
```

### Database Setup

Migrations run automatically on first API/test run. To manually apply migrations:

```bash
npx --yes pnpm@9.7.0 -r run migrate
```

Seed development data (optional):

```bash
npx --yes pnpm@9.7.0 -r run seed
```

### Run API + UI (Development)

In one terminal:

```bash
npx --yes pnpm@9.7.0 --filter=@social/api run dev
```

In another:

```bash
npx --yes pnpm@9.7.0 --filter=@social/ui run dev
```

API: `http://localhost:4000` (see `packages/api/src/dev.ts`'s default `PORT`)
UI: `http://localhost:5173` (proxies `/api/*` to the API, see `packages/ui/vite.config.ts`)

## Launching the app

### Double-click (Windows) — self-contained distributable

The **released distributable** (`dist\SocialAutomation\`, produced by
`scripts\build-distributable.ps1`; see `launcher/README.md`) needs **no
preinstalled Node.js** — it ships with its own bundled Node runtime and its
dependencies already installed:

1. Double-click `SocialAutomation.exe`.
2. A small progress window shows plain-language status ("Starting
   SocialAutomation...", "Checking for a free port...", etc.) — not a raw
   console — while the server starts, which takes a couple of seconds since
   the distributable ships prebuilt (no install/build happens at launch).
3. Once ready, your default browser opens automatically at the app's URL
   (normally `http://localhost:3000` — if that port's busy, it picks the next
   free one automatically and opens the right URL either way).
4. To stop the app, close the progress window (or click its "Quit"
   button) — this shuts down the whole server process tree, nothing is left
   running in the background.

Your settings/data live in `%LOCALAPPDATA%\SocialAutomation\`, outside the
app folder, so the app folder can be replaced by an update without losing
them. See `launcher/README.md` for the full architecture, how to build the
distributable, and what's owed real-world verification (a clean Windows
machine with no Node.js at all, and code signing); see `docs/UPDATING.md`
for how updates are distributed (GitHub Releases), the in-app
"update available" banner, and the exact steps a streamer follows to update
without losing anything.

If you're running from a **source checkout** instead of the packaged
distributable (no `runtime\node-win-x64\` staged), `SocialAutomation.exe`
falls back to a `node` on `PATH` (22+) and `launcher\bootstrap.mjs`; if
`node_modules`/the built UI are missing it'll tell you to run
`pnpm install` yourself rather than silently doing it for you.

Don't have the exe, or need to rebuild it after changing `launcher/Program.cs`?

```powershell
powershell -ExecutionPolicy Bypass -File launcher\build.ps1
```

This compiles it with the C# compiler that ships with every Windows install
(`csc.exe`, no extra toolchain needed), falling back to
[ps2exe](https://github.com/MScholtes/PS2EXE) if that's unavailable. Worst
case, `launcher\Launch-SocialAutomation.bat` does the same thing without
needing a compiled exe at all. See `launcher/README.md` for details, and
`scripts\build-distributable.ps1` for the one-command full distributable
build (bundled runtime + prebuilt deps + compiled exe, staged and ready to
zip).

### Manual: single-port production mode

Equivalent to the exe, without the double-click/browser-opening parts — builds
whatever's missing (the UI's static bundle) and starts one server that serves
both the dashboard and the `/api/*` routes on one port:

```bash
npx --yes pnpm@9.7.0 run start
```

Then open `http://localhost:3000` (override the port with `PORT=8080 npx --yes pnpm@9.7.0 run start`).

### Manual: dev mode (two servers, hot reload)

See [Run API + UI (Development)](#run-api--ui-development) above — the API's
Fastify server and the UI's Vite dev server run separately with hot reload,
which is more convenient when actively changing UI or API code. The
single-port production mode above is better for just running/demoing the app.

## Verification Commands

Run these to verify the system is healthy:

```bash
# Type-check all packages (TypeScript strict mode)
npx --yes pnpm@9.7.0 -r run typecheck

# Build all packages
npx --yes pnpm@9.7.0 -r run build

# Run all tests across the workspace (439 tests)
npx --yes pnpm@9.7.0 -r run test

# Lint code (ESLint + Prettier)
npx --yes pnpm@9.7.0 run lint
npx --yes pnpm@9.7.0 run format
```

## Real-Credential Setup

**This repo runs fully on mocked platform APIs and seeded test data. NO real credentials exist in the environment.**

However, to use the system with real accounts, you must set up credentials for each platform and the AI provider:

### Platform Credentials

Each platform uses a standard OAuth flow (or equivalent pairing mechanism) configured in the dashboard:

1. **Discord Bot Setup**: See [`plugins/discord/README.md`](plugins/discord/README.md) for bot token + webhook setup steps
2. **Twitch OAuth**: See [`plugins/twitch/README.md`](plugins/twitch/README.md) for OAuth app registration
3. **Bluesky App Password**: See [`plugins/bluesky/README.md`](plugins/bluesky/README.md) for app-password pairing
4. **Mastodon Instance**: See [`plugins/mastodon/README.md`](plugins/mastodon/README.md) for OAuth app creation
5. **Reddit App Credentials**: See [`plugins/reddit/README.md`](plugins/reddit/README.md) for app registration

Detailed OAuth flows and scope requirements are in [`docs/AUTH.md`](docs/AUTH.md).

### AI Provider

The running app (API server + dashboard) selects its content-generation provider from the
`AI_PROVIDER` environment variable at startup:

| `AI_PROVIDER` | Provider | Required key env var |
| --- | --- | --- |
| _(unset)_ or `mock` | `MockProvider` — deterministic, network-free (default) | none |
| `claude` | `ClaudeProvider` — Anthropic Claude API | `ANTHROPIC_API_KEY` |
| `openai` | `OpenAiProvider` — OpenAI API | `OPENAI_API_KEY` |

```bash
# Real generation with Claude
export AI_PROVIDER=claude
export ANTHROPIC_API_KEY="sk-ant-..."

# ...or with OpenAI
export AI_PROVIDER=openai
export OPENAI_API_KEY="sk-..."
```

All launch paths pick these up from the process environment: the `SocialAutomation.exe`
launcher, root `pnpm start` (single-port prod server), and `pnpm --filter @social/api run dev`.
Set the variables before launching (e.g. in the shell/console you start the app from, or via
Windows environment variables for the exe). If `AI_PROVIDER` names a real provider but its key
is missing — or the value is not one of `claude|openai|mock` — the server refuses to start
with a clear `AiConfigError` message instead of failing later inside a request. When
`AI_PROVIDER` is unset the app runs exactly as before on the mock provider, with no keys needed.

See [`packages/ai/README.md`](packages/ai/README.md) for model defaults, error taxonomy, and
the note that a ChatGPT subscription does not include OpenAI API access.

### Media Processing

FFmpeg is optional (gated behind capability checks). Video transcoding is skipped if unavailable.

## Documentation

- **`docs/ARCHITECTURE.md`** — System design, module layout, content pipeline flow
- **`docs/CONNECTOR-CONTRACT.md`** — PlatformConnector interface, capabilities, errors
- **`docs/AUTH.md`** — OAuth flows, token vault, encryption, scope model, multi-account UX
- **`docs/SCHEMA.md`** — Database schema (accounts, tokens, campaigns, jobs, analytics)
- **`docs/PLATFORM-RULES.md`** — Per-platform constraints (character limits, media specs, tone)
- **`plugins/*/README.md`** — Per-plugin setup, API usage, conformance notes

## Development

### Project Layout

```
packages/
  core/          # Contract, types, errors
  logging/       # Structured logging + redaction
  auth/          # Token vault, OAuth, account management
  db/            # Driver abstraction, repos, migrations
  queue/         # Job persistence, retry/DLQ
  scheduler/     # Cron/RRULE scheduling, materialization
  ai/            # Content generation, variants
  media/         # Renditions, compression, captions
  pipeline/      # Campaign service, orchestration
  analytics/     # Metrics collection, aggregation, tracking
  api/           # REST API server
  ui/            # React dashboard
  conformance/   # Shared test harness

plugins/
  discord/       # Discord connector
  twitch/        # Twitch connector
  bluesky/       # Bluesky connector
  mastodon/      # Mastodon connector
  reddit/        # Reddit connector
```

### TypeScript Configuration

- **Root `tsconfig.base.json`** — Shared compiler options, path aliases
- **Per-package `tsconfig.json`** — Inherits from base, strict mode enabled
- **Project references** — `tsc -p tsconfig.json --build --force` for incremental builds

### Testing

Tests use **Vitest** with mocked HTTP via `undici` or `@social/conformance`.

Run tests for a single package:

```bash
npx --yes pnpm@9.7.0 --filter=@social/core run test
```

Run conformance suite for a plugin:

```bash
npx --yes pnpm@9.7.0 --filter=@social/plugin-discord run test
```

## CI/CD

See `.github/workflows/ci.yml` for the GitHub Actions pipeline:
- Install Node 22 + pnpm
- Run `typecheck`, `build`, `test`, and `lint` across the entire workspace
- All commands use the `npx --yes pnpm@9.7.0` invocation pattern

## Known Limitations

- **Bluesky**: Post length/facet truncation can overflow under certain emoji+CTA combinations (t24 masked in tests)
- **Media**: FFmpeg optional; video transcoding skipped if unavailable
- **Conformance**: @social/conformance is a test harness library; plugin tests invoke its suite

## License

Unlicensed — demo/educational project.
