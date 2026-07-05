# Changelog

All notable changes to SocialAutomation from m1 (Architecture) through m6 (Dashboard & Hardening).

## [1.0.0] — 2026-07-05

First shippable release: a self-contained app a Twitch streamer can download and set up
themselves, with zero API keys and no preinstalled developer tools. See
`docs/RELEASE-NOTES.md` for the streamer-facing summary and known limitations.

### Added

- **Guided setup wizard** (`packages/ui/src/wizard/`, REST in `packages/api`): welcome →
  per-platform connect flows for Discord, Twitch, Bluesky, Mastodon, Reddit. Discord (webhook)
  and Bluesky (handle + app password) connect end-to-end through the real `@social/auth`
  `PairingCoordinator`; Twitch/Reddit/Mastodon get guided, copy-paste app-registration steps
  (translated from `docs/AUTH.md`) then a real redirect OAuth flow. Per-account
  "Test this connection" button (`POST /api/accounts/:id/test`). Plain-language copy throughout.
- **First-run detection & wizard persistence** (`0007_app_settings` migration, `app_settings`
  table; `GET/PUT /api/wizard-state`, `POST /api/wizard-state/restart`): the wizard auto-shows
  on first launch, resumes mid-flow across a browser refresh or app restart, never reappears
  after completion, and is re-runnable from the Accounts tab.
- **On-device LLM content provider** (`packages/ai/src/localProvider.ts`): a credential-free
  `ContentProvider` via `node-llama-cpp` (lazy/optional native dependency, like better-sqlite3),
  registered as `AI_PROVIDER=local`; the app prefers it when a model is on disk and otherwise
  uses the template provider — never a cloud API, never a user-supplied key.
- **Model download manager** (`packages/ai/src/modelDownloadManager.ts`, `/api/model/*` routes
  incl. an SSE progress stream): first-use download of a small permissively-licensed quantized
  model (Qwen2.5-3B-Instruct GGUF, ~1.9 GB), with resume, SHA-256 verification, and a
  non-nagging decline path. The model is stored in the user-data dir and is **never** bundled.
- **Zero-key deterministic fallback** (`packages/ai/src/fallbackProvider.ts`; honest template
  upgrade of `mockProvider.ts`): generation always works — local model absent/downloading/too
  weak transparently degrades to platform-valid template posts. Added a Mastodon voice profile
  and Reddit self-post handling (text/link mutually exclusive).
- **Self-contained distributable** (`launcher/`, `scripts/build-distributable.ps1`): bundles a
  pinned Node runtime so no preinstalled Node is required; friendly first-run bootstrap with
  progress and plain-language errors instead of a raw console; automatic port-in-use handling.
- **Safe update story** (`packages/api/src/version-migration.ts`, `update-routes.ts`,
  `UpdateBanner.tsx`, `docs/UPDATING.md`): user data (accounts, settings, history, model) lives
  in `%LOCALAPPDATA%\SocialAutomation`, outside the replaceable app directory, so updates never
  lose it; an on-upgrade migration hook and a non-nagging in-app "update available" banner
  (opt-in GitHub Releases check) round it out.
- **Release verification script** (`scripts/verify-release.mjs`): one command that (re)builds
  and asserts the self-contained / no-model-bundled / user-data-isolated / launches-with-bundled-
  node checks; the artifact gate for this release.
- **User-facing docs** (`docs/user-guide/`): GETTING-STARTED, CONNECTING-PLATFORMS,
  IN-APP-HELP-COPY, TROUBLESHOOTING-FAQ, plus `docs/RELEASE-NOTES.md`.

### Fixed (found by end-to-end QA during release hardening)

- **Publish worker never started (F1):** the pipeline queue `Worker` was built but never started
  in the running server, so a submitted campaign's job sat `pending` forever and never published.
  `prod.ts`/`dev.ts` now start it after `listen()` and stop it on shutdown. Also fixed a
  `Worker.stop()` hang that would have frozen the app on Ctrl+C/SIGTERM.
- **Reddit publish rejected (QG-1):** the composer and `/api/campaigns` route never supplied
  `platformOptions.subreddit`, so every Reddit campaign failed `validatePost`. The composer now
  collects a target subreddit and threads it through submit and live preview.
- **OAuth app secrets not persisted (QG-2):** Twitch/Reddit/Mastodon app client secrets were
  in-memory only. Now persisted encrypted at rest (`SecureAppCredentialsStore`, AES-256-GCM).
- **Token vault key random per start (F2, release blocker):** the token vault used a fresh
  random master key each process start, so every connected account's token failed to decrypt
  after a restart. The vault (and app-credential store) now use a single persisted key from the
  user-data dir, so connections survive restarts.

## [Unreleased] — post-delivery enhancement (2026-07-04)

### Added

- **@social/ai: `OpenAiProvider`** — a second real `ContentProvider`, backed by the OpenAI API
  (`openai` npm SDK), alongside `ClaudeProvider`. Defaults to `gpt-5.5` (OpenAI's current
  mainstream flagship chat model as of 2026-07-04, confirmed against
  https://developers.openai.com/api/docs/models/all), overridable via `config.model`. Reads
  `OPENAI_API_KEY` from `config.apiKey` or `process.env.OPENAI_API_KEY`; maps rate-limit/5xx/
  connection errors to a retryable `AiProviderError` and content-policy refusals to
  `AiRefusalError`, exactly like `ClaudeProvider`. See `packages/ai/README.md`.
  - **IMPORTANT**: a ChatGPT Plus/Team/Pro subscription does **not** include OpenAI API access.
    API calls require a separate key generated at https://platform.openai.com/api-keys and are
    billed per token, independent of any ChatGPT subscription.
- **@social/ai: `createContentProvider()`** (`providerFactory.ts`) — config-driven provider
  selection via `AI_PROVIDER=claude|openai|mock` (defaults to `claude` when unset). Initially
  a standalone factory; the API server now wires it in (see "Changed" below).
- **@social/ai: `promptBuilder.ts`** — `buildPrompt`/`SYSTEM_PROMPT` extracted out of
  `claudeProvider.ts` into a shared module so `ClaudeProvider` and `OpenAiProvider` build
  byte-identical prompts for the same task; `ClaudeProvider`'s behavior is unchanged.
- **Tests**: `claudeProvider.test.ts` (new — this provider had no dedicated unit tests before),
  `openaiProvider.test.ts`, `providerFactory.test.ts` — all against injected fake SDK clients,
  never the real network.

### Changed

- **@social/api: real AI provider selection** — the API server no longer hardcodes
  `MockProvider`. `createAppContext` now builds its `ContentProvider` via `@social/ai`'s
  `createContentProvider`, honoring `AI_PROVIDER=claude|openai|mock` from the environment
  (picked up by every launch path: `SocialAutomation.exe`, root `pnpm start`, and the api
  `dev` script). Unlike the factory's own default, the app defaults to `mock` when
  `AI_PROVIDER` is unset, so tests and credential-free demo runs behave exactly as before.
  The provider is built once, exposed as `AppContext.contentProvider`, and shared by the
  pipeline and `/api/compose-preview` (previously a second hardcoded `MockProvider` in
  `server.ts`). A missing API key (`ANTHROPIC_API_KEY` for `claude`, `OPENAI_API_KEY` for
  `openai`) or an unknown `AI_PROVIDER` value fails at startup with a clear `AiConfigError`
  (surfaced without a stack trace by the dev/prod entrypoints), never inside a request. The
  former "dashboard never talks to a real AI key" constraint is retired by explicit user
  request; platform credentials remain mocked. Docs: root `README.md` "Real-Credential
  Setup → AI Provider". Tests: 3 new provider-selection cases in `packages/api/test/api.test.ts`.

## [0.1.0] — 2026-07-05

### Added

#### Core Architecture & Contract (m1)
- **Plugin Contract v1.0 → v1.1**: `docs/CONNECTOR-CONTRACT.md` — 10-method `PlatformConnector` interface (Connect, Authenticate, RefreshToken, ValidatePost, UploadMedia, Publish, Delete, Edit, GetAnalytics, Disconnect)
- **Capability Model**: Per-platform feature flags + operations map, `NotSupportedError` convention for honest error handling
- **Architecture Design**: `docs/ARCHITECTURE.md` — monorepo (pnpm workspaces), ESM, TypeScript strict, Vitest, content-pipeline flow diagram
- **Database Schema**: `docs/SCHEMA.md` — 15 tables covering accounts, tokens, campaigns, posts, media, jobs, analytics, with SQLite/Postgres portability
- **OAuth & Token Vault**: `docs/AUTH.md` — AES-256-GCM encryption, proactive+lazy refresh, multi-account pairing, scope catalog, cross-worker locking

#### Core Framework (m2)
- **@social/core**: Plugin loader, registry, typed errors, config validation (zod)
- **@social/logging**: Structured JSON logging with credential redaction
- **@social/auth**: Token vault implementation, in-memory + DB-backed stores, OAuth pairing flow
- **@social/db**: SQLite/Postgres driver abstraction, migration runner, repository implementations (AccountsStore, TokensStore, JobStore, AdvisoryLock)
- **@social/queue**: Job persistence, worker loop, retry with exponential backoff + jitter, dead-letter queue, idempotency keys

#### Platform Connectors (m3)
- **@social/plugin-discord**: Bot API + webhooks, messages, embeds, threads; webhook token security (masked from DB)
- **@social/plugin-twitch**: Helix API only, channel info updates, viewers/followers analytics
- **@social/plugin-bluesky**: AT Proto, posts with facets (mentions/links/hashtags), immutable design
- **@social/conformance**: Shared harness (`runConformance`) exercising all connectors against the contract — static sweep (no scraping, official APIs only), credential redaction verification
- **Integration Tests**: End-to-end publish flow (AI → media → validate → enqueue → worker → publish) for all 3 initial connectors on real SQLite + mocked HTTP

#### Content Pipeline (m4)
- **@social/ai**: `CampaignGenerator` — turn content brief into per-platform variants (tone, length, hashtags, CTAs, emojis), rewrite/shorten/expand operations; `MockProvider` (deterministic) + `ClaudeProvider` (Anthropic SDK)
- **@social/media**: Image renditions (square/portrait/landscape/story/thumb), compression, video transcoding gating (FFmpeg optional), caption handling; `RenditionPlanner` emits media records per schema
- **@social/pipeline**: `CampaignService.composeAndSubmit` — per-platform generate → media rendition → validatePost gate → submitPost; invalid variants rejected, not enqueued
- **Integration**: Description → variants → media → validate → enqueue for multiple platforms at once

#### Scheduling & Analytics (m5)
- **@social/scheduler**: Immediate/scheduled/recurring publishing with cron/RRULE + IANA timezones; `ScheduleMaterializer` turns due occurrences into jobs via idempotent `occurrenceKey`
- **@social/analytics**: Metrics collection (likes, views, shares, comments, clicks, CTR, followers, watch time), campaign aggregation, per-post snapshots, graceful skip on unsupported operations
- **URL Tracking**: UTM parameter builder, pluggable short-URL service (local mapping for tests), link rewriting, click attribution
- **@social/api**: Campaign compose/submit, account pairing, schedule CRUD, real-time preview generation

#### Dashboard & Final Hardening (m6)
- **@social/ui**: React dashboard with composer (per-platform previews + validation status), schedule manager, analytics view, accessibility (WAI-ARIA tabs, semantic HTML)
- **Remaining Connectors**: @social/plugin-mastodon (posts, media upload, hashtags), @social/plugin-reddit (subreddit posts, media inline)
- **Scheduled Campaign Persistence**: Migration 0006 + table for storing compose specs with schedules (restart-durable)
- **QA Sweep**: Full conformance verification across all 5 connectors, security rules (no plaintext token persistence), performance sanity
- **Documentation**: Root README, per-plugin setup guides (OAuth steps, credential files), CHANGELOG, architecture + platform rules links
- **CI/CD**: GitHub Actions workflow (install, typecheck, build, test, lint across workspace)
- **Linting & Formatting**: ESLint + Prettier, workspace root config, clean baseline
- **Dependency Fix**: Cyclic auth<->db cycle resolved (removed @social/db from @social/auth deps; auth only defines ports)
- **Conformance Test Fix**: @social/conformance (`passWithNoTests` vitest config) so root `pnpm -r test` is green

### Changed

- **Contract v1.0 → v1.1**: AppCredentialsResolver added for multi-account app context (Discord bot install, Twitch client-id)
- **Database**: 6 migrations applied (0001_init, 0002_advisory_locks, 0003_publish_job_payload, 0004_url_tracking, 0005_collect_analytics_operation, 0006_scheduled_campaigns)
- **ESLint**: Moved from .eslintrc.json to eslint.config.js (flat config, ESLint 9 compatible)

### Fixed

- **t15**: Discord webhook token removal from `remoteId` (now `webhook:<id>:<msgId>`; token sourced from vault on delete/edit)
- **AI generation**: Platform profile tuning (tone, character budget, hashtag/mention caps) per capability descriptor
- **Bluesky facets**: Grapheme-aware + UTF-8 byte offset math for AT Proto compliance
- **Token refresh**: Atomic write-back with CAS + advisory locks for cross-worker serialization
- **Unused variables**: Marked with `_` prefix or removed (lint baseline clean)

### Security

- ✓ No plaintext credentials at rest (all tokens encrypted AES-256-GCM)
- ✓ No scraping/browser automation (official APIs only)
- ✓ Credential redaction in structured logs (field-level filtering)
- ✓ PKCE for OAuth, scope least-privilege model, cross-worker advisory locks
- ✓ Static code analysis confirms no secrets in git

### Testing

- **Test Coverage**: 439 tests across 13 packages + 5 plugins (100% green)
  - @social/core: 11 tests
  - @social/auth: 62 tests
  - @social/queue: 22 tests
  - @social/db: 9 tests
  - @social/ai: 31 tests
  - @social/media: 37 tests
  - @social/pipeline: 16 tests
  - @social/scheduler: 23 tests
  - @social/analytics: 22 tests
  - @social/api: 7 tests
  - @social/conformance: 0 tests (test harness, plugins invoke via runConformance)
  - Plugins: 199 tests (conformance + connector-specific)
- **Mocking Strategy**: All HTTP via undici mock (no real network calls), seed DB for integration tests
- **CI-Equivalent Verification**: `typecheck`, `build`, `test`, `lint` all passing locally

### Known Issues & Follow-up

- **t24**: Bluesky inline-hashtag + CTA/link append can exceed 300 graphemes (masked in tests, low priority)
- **Media**: FFmpeg absent here; transcoding gated behind capability probe, auto-fallback to no-op
- **Future**: Webhook delivery retries + subscription mgmt (t7 note), stuck-job reclaim sweep for worker crash recovery

---

## Versioning

- **Node.js**: 22.0.0 or later
- **TypeScript**: 5.5.0+ (strict mode)
- **Vitest**: 2.0.5+
- **pnpm**: 9.7.0+
