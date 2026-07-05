# Auth & Token Vault — SocialAutomation

Owner: **auth-security**. This is the design that `@social/auth` (package `packages/auth/`)
implements in **t6**. It specifies per-platform OAuth flow choices, encryption at rest, the
refresh strategy, expiry/revocation handling, the scope model, the multi-account pairing UX, and
the security rules every worker must honor when code touches credentials.

Companion docs (locked decisions this doc builds on):

- `docs/ARCHITECTURE.md` — module layout; `@social/auth` sits above `core`/`db`, below the pipeline.
- `docs/CONNECTOR-CONTRACT.md` + `packages/core/src/connector/` — the `PlatformConnector` methods
  and the shared types (`TokenSet`, `OperationContext`, `AuthRequest`, `AppCredentials`,
  `PlatformProfile`) and typed errors (`TokenExpiredError`, `TokenRevokedError`, `AuthError`).
- `docs/SCHEMA.md` + `packages/db/migrations/0001_init.sql` — the `accounts` and `account_tokens`
  tables. **The vault columns are locked**; this doc says exactly what goes in each.

If this doc and the compiling source ever disagree, the source (`@social/core`) wins for types —
update this doc.

---

## 0. Division of responsibility (who does what)

The platform HTTP handshakes already live in the connector contract. `@social/auth` **orchestrates
and persists**; the connector **talks to the platform**. This split is deliberate and keeps
connectors free of any storage/crypto dependency (per contract rule #4).

| Concern | Owner | How |
|---|---|---|
| Build authorize URL / exchange code / client-credentials / refresh HTTP call | **connector** | `authenticate(AuthRequest)`, `refreshToken(RefreshInput)` |
| Revoke at platform | **connector** | `disconnect(ctx)` |
| PKCE verifier/challenge, CSRF `state`, pairing session | **auth** | `oauth/pkce.ts`, `oauth/state-store.ts` |
| Encryption/decryption of tokens, key management | **auth** | `crypto/*`, `vault.ts` |
| Storing/reading/rotating `account_tokens`, `accounts` CRUD | **auth** | `vault.ts`, `account-manager.ts` (via `@social/db`) |
| Proactive refresh, scheduling, cross-worker locking, write-back | **auth** | `token-manager.ts`, `refresh-scheduler.ts` |
| Building the decrypted `OperationContext` handed to a connector | **auth** | `context.ts` |
| Declaring & validating required scopes (least privilege) | **auth** | `scopes.ts` |

`@social/auth` reaches connectors through the `PluginRegistry` (`registry.get(platform)`), never by
importing a plugin package. It reaches storage through `@social/db` repositories, never raw SQL in
callers.

---

## 1. Per-platform OAuth flow choice

### General rule (applies to every platform not called out below)

1. **Default: OAuth 2.0 Authorization Code + PKCE** (RFC 7636). Use PKCE on every platform that
   supports it — treat our clients as **public clients** where possible so a leaked `clientSecret`
   is not sufficient to complete a flow. Where the platform is a confidential client, still send
   PKCE *and* the secret.
2. **Client Credentials** only for app-level, no-user-context calls (e.g. fetching public data or
   an app token). Never used to act on a user's behalf.
3. **Device Authorization Grant** (RFC 8628) as an alternate entry point for headless/CLI or
   input-constrained setups, where the platform supports it (Twitch, Google/YouTube).
4. **Platform-specific credential** where the platform does not do standard OAuth for our use case
   (Discord bot token/webhook, AT Protocol app password). These are still credentials → still
   sealed in the vault, never plaintext.

The grant a platform uses is declared once in a **flow descriptor** (`oauth/registry.ts`,
§ per-platform table below) so pairing code stays platform-agnostic.

### Discord (m3)

- **Posting path = bot token + webhooks.** Channel messages/embeds/threads are published with the
  application's **bot token** (a static, non-expiring secret) or an **incoming webhook URL** (the
  URL *contains* a secret token). Neither refreshes; both are sealed in the vault like any token
  (`token_type = 'bot'` / `'webhook'`, `expires_at = NULL`, no refresh token).
- **User-context OAuth (auth-code + PKCE)** is used when we must act as a user — e.g. the
  `webhook.incoming` scope to have the user create a webhook for us, or `bot` + `applications.commands`
  to add the bot to a guild. Discord issues an access token (expires, ~7 days) **and** a refresh
  token here, so this path uses the normal refresh machinery.
- Grant: `auth_code_pkce` for the OAuth path; `platform_token` for the bot/webhook path.

### Twitch (m3)

- **OAuth 2.0 Authorization Code + PKCE.** Twitch supports PKCE. User/channel operations require
  scoped user access tokens (e.g. `channel:manage:broadcast`, `channel:read:subscriptions`,
  `user:read:email`). Access tokens are short-lived (~4h) and Twitch issues a **refresh token** →
  normal refresh machinery.
- **Device Code Grant** offered as an alternate for headless pairing.
- **Client Credentials** app token available for public/read endpoints with no user context.
- Twitch expects periodic token validation; `TokenManager` treats a Twitch 401 as
  `TokenExpiredError` (refresh) unless the body indicates revocation → `TokenRevokedError`.
- Grant: `auth_code_pkce` (primary), `device_code` (alt), `client_credentials` (app-level).

### Bluesky / AT Protocol (m3)

- **App-password session flow.** The user creates an **app password** in Bluesky settings and
  supplies it with their handle. `com.atproto.server.createSession` exchanges
  handle + app password for a session: **`accessJwt`** (short-lived, minutes) + **`refreshJwt`**
  (long-lived, rotates on each refresh). Refresh via `com.atproto.server.refreshSession`.
- Mapping onto `TokenSet`: `accessToken = accessJwt`, `refreshToken = refreshJwt`. The refresh
  machinery works as normal (the connector's `refreshToken` calls `refreshSession`).
- The **app password is itself a long-lived credential** and must be sealed if we keep it. We keep
  it so the session can be re-created if the `refreshJwt` chain fully expires, avoiding forcing the
  user to re-enter it. Storage without a schema change (see § open question A): a **non-current**
  `account_tokens` row (`is_current = 0`, `token_type = 'atproto_app_password'`, `expires_at = NULL`)
  holds the sealed app password; the live session is the `is_current = 1` row. The partial unique
  index only constrains `is_current = 1`, so this coexists cleanly.
- Grant: `platform_password`. (AT Protocol OAuth exists; app-password is the locked m3 choice.)

### Per-platform table (extend as connectors land)

| Platform | Grant (`oauth/registry.ts`) | Refresh? | Notes |
|---|---|---|---|
| discord | `auth_code_pkce` (user) / `platform_token` (bot, webhook) | user: yes / token: no | bot token + webhooks are static secrets |
| twitch | `auth_code_pkce`, `device_code` (alt), `client_credentials` (app) | yes | ~4h access tokens, refresh rotates |
| bluesky | `platform_password` (AT Proto session) | yes | app password sealed as bootstrap credential |
| x / twitter | `auth_code_pkce` | yes | v2 OAuth2, PKCE required |
| reddit | `auth_code` (confidential) | yes | `duration=permanent` for a refresh token |
| youtube / google | `auth_code_pkce`, `device_code` (alt) | yes | offline access for refresh token |
| linkedin | `auth_code` | yes (member) | |
| facebook / instagram | `auth_code` | long-lived token exchange | Graph API long-lived tokens |
| tiktok | `auth_code_pkce` | yes | |
| mastodon | `auth_code_pkce` | yes | per-instance app registration first |

---

## 2. Encryption at rest

### Algorithm — **AES-256-GCM** (AEAD) via Node `node:crypto`

- 256-bit key, `createCipheriv('aes-256-gcm', key, nonce)` / `createDecipheriv`.
- **Nonce/IV**: 96-bit (12-byte) value from `crypto.randomBytes(12)`, **fresh and unique per
  seal**. Never reuse a nonce under the same key — this is the one rule that, if broken, breaks
  GCM. Stored base64 in `account_tokens.nonce`.
- **Auth tag**: 128-bit (16-byte) GCM tag from `cipher.getAuthTag()`. Stored base64 in
  `account_tokens.auth_tag`. On open, `decipher.setAuthTag(tag)`; a tag mismatch throws → we treat
  it as tamper/ corruption and fail closed (never return a partial/plaintext).
- **AAD (additional authenticated data)**: bind each ciphertext to its context so a row/field can't
  be swapped: `aad = utf8("${accountId}|${field}|${keyRef}|${alg}")`. Mismatched AAD fails the tag
  check. `field` ∈ `{"tokenbundle"}` (see below).

### What is sealed, and where each column goes

Because `account_tokens` has a **single** `nonce` and a **single** `auth_tag` per row, we seal the
secret material as **one AEAD unit** (one seal → one ciphertext, one nonce, one tag). The plaintext
is a compact JSON secret bundle:

```jsonc
// plaintext BEFORE sealing — exists only in memory, never written, never logged
{ "accessToken": "…", "refreshToken": "…" /* omitted if none */ }
```

| `account_tokens` column | Content |
|---|---|
| `access_token_ciphertext` | base64 ciphertext of the sealed secret **bundle** (access + refresh) |
| `refresh_token_ciphertext` | `NULL` under the single-blob scheme (kept nullable per schema; see open question B) |
| `encryption_alg` | `'aes-256-gcm'` (records the scheme; a KMS-managed provider records e.g. `'kms:aws'`) |
| `encryption_key_ref` | the **key version / KMS key id** — a *reference*, **never** key material |
| `nonce` | base64 of the 12-byte GCM nonce for this seal |
| `auth_tag` | base64 of the 16-byte GCM tag for this seal |
| `token_type` | e.g. `'Bearer'`, `'bot'`, `'webhook'`, `'atproto_app_password'` |
| `scopes` | JSON array of granted scope strings |
| `expires_at`, `obtained_at`, `rotated_at`, `is_current` | plaintext metadata (non-secret) |

Rationale for the single-blob seal: it fits the locked one-nonce/one-tag columns **and** removes
any chance of nonce reuse across two independent field encryptions. The plaintext `TokenSet`
(`accessToken`, `refreshToken`, `scopes`, `expiresAt`, …) is reconstructed in memory on open — the
non-secret fields (`scopes`, `expiresAt`, `tokenType`, `obtainedAt`) come from the row columns, the
secret fields from the sealed bundle.

### Key management model — active key + versioned `key_ref`, behind a `KeyProvider`

`encryption_key_ref` names a key **version**, not the key. A `KeyProvider` (`crypto/keyring.ts`)
resolves a ref to key material or delegates crypto to a KMS. Two implementations ship:

- **`LocalKeyProvider`** (dev/self-host): master key from env `SOCIAL_MASTER_KEY` (32 bytes,
  base64). `key_ref` = a version label (e.g. `"local:v1"`). Supports multiple versions in a keyring
  map so rotation works. Key material lives only in process memory.
- **`KmsKeyProvider`** (prod option): `key_ref` = the KMS key id/ARN + version. Either (a) fetch &
  cache a data key from KMS/secret-manager and do AES-256-GCM locally, or (b) let KMS perform
  encrypt/decrypt directly (token bytes are well under KMS's 4 KB limit) and record
  `encryption_alg = 'kms:<provider>'`. The master key never enters our process in mode (b).

**Rotation**: introduce a new active version; new seals use the new `key_ref`. Old rows keep their
own `key_ref` and still open with the correct historical key (the keyring retains prior versions).
Re-encryption is **lazy** — the next refresh/rotation writes a fresh row under the active key
(`rotated_at` set) — with an optional batch **rewrap** job (`token-manager.ts#rewrapAll`) to force
migration. A missing/undecryptable `key_ref` fails closed and marks the account
`status = 'error'` (needs reconnect), never silently downgrades.

We use a single **active** data key with versioning rather than per-record wrapped data keys because
the locked schema has no column to store a per-record wrapped DEK; the versioned-ref model gives us
rotation without a schema change.

---

## 3. Refresh strategy

### When to refresh (proactive, before expiry)

A token is "due" when `now >= expiresAt - skew`, where `skew = max(60s, 10% of the token's
lifetime)`. Tokens with no `expires_at` (Discord bot/webhook) are never refreshed.

Two triggers, same code path (`token-manager.ts#ensureFresh(accountId)`):

1. **Lazy, at use time.** `createContext(accountId)` checks the current token; if due (or already
   expired), it refreshes **before** handing the `OperationContext` to a connector. This guarantees
   a publish never starts with a stale token.
2. **Proactive, ahead of use.** `refresh-scheduler.ts` periodically scans
   `idx_account_tokens_expires` for `is_current = 1` rows expiring within a horizon (default 15 min)
   and refreshes them off the hot path, so the queue rarely blocks on a refresh.

### Concurrency / locking (two workers must not refresh the same account at once)

Refreshing twice is harmful: platforms that **rotate** refresh tokens (Twitch, Bluesky `refreshJwt`)
invalidate the first refresh token when the second refresh runs, so a racing worker can wedge the
account. We guard with two layers:

- **In-process single-flight**: a `Map<accountId, Promise<TokenSet>>` in `TokenManager` coalesces
  concurrent callers in one worker onto one refresh.
- **Cross-process advisory lock** — modeled by the `AdvisoryLock` port in `@social/auth`
  (`store.ts`), which `TokenManager.doRefresh` wraps around the read-check-write as
  `withLock('refresh:<accountId>', …)`. After acquiring the lock we **re-check** whether the token is
  still due, because another worker may have refreshed while we waited. Backends:
  - **Postgres**: `pg_advisory_xact_lock(hashtext('refresh:'||account_id))` (auto-released at txn end).
  - **SQLite** dev (single writer): a `BEGIN IMMEDIATE` transaction around the read-check-write.
  - **Portable fallback (locked, decision C)**: the `advisory_locks` table added in
    **`packages/db/migrations/0002_advisory_locks.sql`** — `lock_key` PK, `holder`, `acquired_at`,
    `expires_at`. `acquire` = INSERT (or takeover of a row whose `expires_at` has passed); `release`
    = DELETE where `holder` matches; a holder that outlives its TTL treats its lock as lost. The
    scheduler-queue worker reuses the same table for occurrence/claim guards. The in-memory
    `InMemoryAdvisoryLock` used in dev/tests is a per-key FIFO mutex with the same `withLock` shape.

### The refresh transaction (write-back)

```mermaid
sequenceDiagram
  participant W as Worker/Scheduler
  participant TM as TokenManager
  participant DB as account_tokens
  participant C as Connector (registry)
  W->>TM: ensureFresh(accountId)
  TM->>TM: single-flight + acquire advisory lock
  TM->>DB: read current token (is_current=1)
  Note over TM: re-check due? (another worker may have refreshed)
  TM->>C: refreshToken({ app, token }) -- platform HTTP
  C-->>TM: fresh TokenSet (may rotate refresh token)
  TM->>TM: seal bundle (new nonce/tag, active key_ref)
  TM->>DB: BEGIN; set old row is_current=0, rotated_at=now; INSERT new row is_current=1; COMMIT
  TM->>TM: release lock
  TM-->>W: decrypted fresh TokenSet
```

The insert/flip is atomic under the partial unique index `uq_account_tokens_current` — there is
always exactly one current row. On `refreshToken` throwing `TokenRevokedError`, we do **not** write
a new token; we mark the account for re-auth (§4).

---

## 4. Expiry & revocation handling

- **`TokenExpiredError`** (retryable) from any connector op → `TokenManager.ensureFresh` refreshes,
  the queue retries the operation with the fresh token. Because the contract marks this
  `retryable = true`, the queue's backoff already re-runs the job; auth just makes the next
  `createContext` return a fresh token.
- **`TokenRevokedError`** / **`AuthError('auth_failed')`** (not retryable) → the grant is dead;
  refresh cannot help. `account-manager.ts` sets `accounts.status = 'revoked'` (or `'error'` for
  ambiguous auth failures), marks the token row so it will not be used, emits a structured
  `auth.reauth_required` event, and the queue stops retrying (fails/DLQs the job with
  `last_error_code`).
- **Re-auth prompt**: the UI's Accounts view surfaces any account whose `status` ∈
  `{revoked, error, disconnected}` with a **Reconnect** action that re-runs the pairing flow (§6).
  Re-pairing the same platform account (same `remote_id`) **updates** the existing `accounts` row
  and writes a new current token — no duplicate account.
- **Revocation on disconnect**: `account-manager.ts#disconnect(accountId)` calls
  `connector.disconnect(ctx)` (best-effort revoke at the platform — Twitch `/oauth2/revoke`, Google
  revoke, Discord token revocation). Regardless of whether the platform confirmed revocation
  (`DisconnectResult.revoked`), we **always purge locally**: delete the account's `account_tokens`
  rows (cascade-safe) and set `accounts.status = 'disconnected'`. Local purge is the source of truth
  for "we no longer hold this credential."

---

## 5. Scope model (least privilege)

- A **scope catalog** (`packages/auth/src/scopes.ts`) is the single source of required scopes:

  ```ts
  // shape only — concrete values filled per platform in t6 / as connectors land
  interface PlatformScopeSpec {
    base: string[];                                   // always requested
    byOperation: Partial<Record<ConnectorOperation, string[]>>; // publish/getAnalytics/...
  }
  const SCOPES: Record<string /*platform*/, PlatformScopeSpec>;
  ```

- **Request** the *union* of `base` + the scopes for the operations the user enables on that
  account (e.g. don't request analytics scopes if the account is publish-only). This is how we keep
  requests minimal.
- **Validate at pairing**: after code exchange, compare `AuthResult.token.scopes` (granted) against
  the required set. Missing scopes → block/prompt with the exact missing scope names (no secrets).
  Granted scopes are stored in `account_tokens.scopes`.
- **Pre-check at use**: `TokenManager` verifies stored `scopes` cover the operation's required
  scopes before a call, throwing `AuthError` (`insufficient_scope` in `details.reason`) instead of
  wasting a platform round-trip and a 403.
- **Security-review hook (my standing duty)**: the catalog makes over-broad requests visible. When
  reviewing any connector, I diff the scopes it drives against the features it actually ships and
  **flag any connector requesting broader scopes than its features need**. Connectors do not invent
  scopes inline; they come from the catalog.

---

## 6. Multi-account pairing UX

Several accounts per platform are first-class: two Twitch channels, a company + a personal
Twitter/X, multiple Discord servers. Each distinct platform account is one `accounts` row, keyed by
`UNIQUE(platform_id, remote_id)`.

```mermaid
sequenceDiagram
  participant UI
  participant API as @social/api
  participant Auth as @social/auth
  participant SS as pairing session store
  participant C as Connector
  participant Plat as Platform
  UI->>API: Add account (platform, enabled ops)
  API->>Auth: beginPairing(platform, ops)
  Auth->>Auth: gen state (CSRF) + PKCE verifier/challenge; resolve scopes
  Auth->>SS: save {state, codeVerifier, platform, scopes} (TTL ~10m)
  Auth->>C: authenticate({kind:'authorize_url', app, state, scopes, codeChallenge})
  C-->>Auth: authorizeUrl
  Auth-->>UI: authorizeUrl (open/redirect)
  UI->>Plat: user consents
  Plat->>API: redirect to callback (code, state)
  API->>Auth: completePairing(state, code)
  Auth->>SS: load by state; verify CSRF + not expired; take codeVerifier
  Auth->>C: authenticate({kind:'exchange_code', app, code, state, codeVerifier})
  C-->>Auth: { token, profile }
  Auth->>Auth: validate scopes; seal token
  Auth->>Auth: upsert accounts (remote_id, handle, display_name, avatar_url, profile_url, profile_metadata); status=active; connected_at=now
  Auth->>Auth: write account_tokens (new is_current=1)
  Auth-->>UI: account summary (no secrets)
```

- **Profile metadata** comes from `AuthResult.profile` (`PlatformProfile`): `remoteId → remote_id`,
  `handle`, `displayName → display_name`, `avatarUrl → avatar_url`, `profileUrl → profile_url`, and
  `raw`/extras → `profile_metadata` (JSON, **non-secret only**). This drives the account picker in
  the composer (name + avatar).
- **Device/password variants**: `device_code` platforms swap the authorize-URL step for a
  device-code poll (`oauth/device-flow.ts`); `platform_password` platforms (Bluesky) collect handle
  + app password in the UI and call `authenticate` with those (the app password never leaves the
  auth layer in plaintext beyond the immediate sealing step).
- **`accountId` → `OperationContext`**: downstream code (queue worker, api) holds a
  `post_variants.account_id`. It calls `TokenManager.createContext(accountId, logger, { deadlineMs })`
  → the manager loads the account + current token, **decrypts**, refreshes if due (§3), and returns
  `{ token, accountId, logger, deadlineMs }`. The connector reads `ctx.token`; the context is
  in-memory only, never persisted, never logged. This is the sole path by which a decrypted token
  reaches a connector.

---

## 7. Security rules (restated — enforced in review)

1. **No plaintext at rest.** `account_tokens` holds ciphertext + `encryption_key_ref` + `nonce` +
   `auth_tag` only. Decryption happens in memory in `@social/auth` at call time. The decrypted
   `TokenSet` lives only inside an `OperationContext` for the duration of a call.
2. **No secrets in logs.** The `StructuredLogger` (`@social/logging`) must redact a denylist:
   `accessToken`, `refreshToken`, `access_token_ciphertext`… no — **values**: access/refresh tokens,
   `clientSecret`, `Authorization` headers, OAuth `code`, PKCE `codeVerifier`, app passwords, Discord
   **webhook URLs** (they embed a token), device `device_code`, and the master key. Auth log fields
   use `accountId`, `platform`, `keyRef`, scope **names**, `expiresAt`, `status` — never token
   values. `ConnectorError.details` must already be secret-free (contract rule) — auth verifies this
   in review.
3. **Key material never logged, never persisted in a row.** Only the `key_ref` is stored/logged.
   Key bytes exist only in process memory; buffers are zeroed after use where practical.
4. **Fail closed.** A GCM tag mismatch, an unresolvable `key_ref`, or a decrypt error never yields a
   partial or plaintext token — it errors and marks the account `error`.
5. **Least privilege.** Scopes come from the catalog (§5); over-broad scope requests are flagged in
   review.

---

## 8. Module layout (`packages/auth/`) — the map t6 implements

```
packages/auth/
  package.json                 # @social/auth; deps: @social/core, @social/db (workspace:*)
  tsconfig.json
  src/
    index.ts                   # barrel: TokenVault, TokenManager, AccountManager, beginPairing/completePairing, scopes
    types.ts                   # auth-layer types (PairingSession, RefreshOutcome, KeyRef, SealedToken)
    errors.ts                  # ReauthRequiredError, VaultError, KeyUnavailableError, InsufficientScopeError
    crypto/
      aead.ts                  # seal(plaintext, aad) / open(ciphertext, nonce, tag, aad) — AES-256-GCM (node:crypto)
      keyring.ts               # KeyProvider interface + LocalKeyProvider + KmsKeyProvider; key_ref -> key, active version, rotation
    vault.ts                   # TokenVault: put/get/rotate/purge a TokenSet <-> account_tokens (uses aead + keyring + @social/db)
    token-manager.ts           # createContext(accountId), ensureFresh, single-flight + advisory lock, refresh write-back, rewrapAll
    refresh-scheduler.ts       # periodic scan of expiring is_current tokens -> ensureFresh (proactive)
    account-manager.ts         # multi-account CRUD, profile metadata, status transitions, disconnect (+ platform revoke)
    context.ts                 # builds OperationContext { token, accountId, logger, deadlineMs }
    scopes.ts                  # SCOPES catalog + resolveRequestedScopes(platform, ops) + validateGranted()
    oauth/
      registry.ts              # per-platform flow descriptor (grant kind, endpoints-via-connector, scope defaults)
      flow.ts                  # beginPairing / completePairing orchestration (auth-code + PKCE)
      pkce.ts                  # createVerifier() / challengeFor(verifier) (S256)
      state-store.ts           # CSRF state + PKCE verifier persistence for a pairing session (TTL)
      device-flow.ts           # device-code grant helper (poll loop)
  test/
    vault.test.ts              # round-trip seal/open, tamper -> fail closed, rotation, wrong key_ref
    token-manager.test.ts      # proactive/lazy refresh, single-flight, rotation write-back, revoke handling
    pairing.test.ts            # state/PKCE, scope validation, multi-account upsert
```

t6 implements the modules above against these interfaces; connectors already exist for the HTTP
handshakes. `@social/auth` depends only on `@social/core` (types/errors) and `@social/db`
(repositories) and reaches connectors via the plugin registry.

---

## 9. Open questions — RESOLVED by the producer (2026-07-04)

- **A. Bluesky app-password storage — RESOLVED: store as a non-current `account_tokens` row**
  (`is_current = 0`, `token_type = 'atproto_app_password'`, `expires_at = NULL`) alongside the live
  session's current row. Implemented via `TokenManager.storeTokens(accountId, token, { tokenType:
  'atproto_app_password', isCurrent: false })`.
- **B. `refresh_token_ciphertext` column — RESOLVED: single-blob seal, column stays `NULL`.** The
  refresh token rides inside the sealed bundle in `access_token_ciphertext`; no second nonce/tag and
  no migration to 0001. `buildTokenRow` always writes `refresh_token_ciphertext = NULL`.
- **C. Advisory locks for cross-worker refresh — RESOLVED: portable `advisory_locks` table added**
  in migration 0002 (see §3). Postgres deployments may still prefer native `pg_advisory_xact_lock`;
  scheduler-queue reuses the same table.
- **D. Profile-metadata refresh — DEFERRED (non-blocking).** No "get profile" contract method in t6.
  Display name/avatar are captured at pairing and on re-auth only. Revisit with core-architect if
  periodic profile refresh is wanted later.
```

---

## 10. Pairing flow, scope catalog & refresh scheduler — implemented (t10)

t10 built the account-pairing side connectors need, on top of the t6 vault/TokenManager/
AccountManager. All in `packages/auth/src/`.

### 10.1 Module map (as built)

```
oauth/
  pkce.ts          # createVerifier() (32B→43-char base64url), challengeFor() (S256), createState(), PKCE_METHOD='S256'
  state-store.ts   # PairingSession + PairingSessionStore port + InMemoryPairingSessionStore (TTL, SINGLE-USE take())
  registry.ts      # FlowDescriptor per platform (FLOW_REGISTRY) + PairingConnector seam (PairingAuthRequest/Result)
  device-flow.ts   # pollForDeviceToken() — RFC 8628 poll loop, honours interval + slow_down, injectable clock/sleep
  flow.ts          # PairingCoordinator: beginPairing / completePairing / pollDevicePairing / pairWithPassword / pairWithToken
  index.ts         # barrel
scopes.ts          # SCOPES catalog + resolveRequestedScopes() + validateGranted() (+ requiredScopesForOperation/missingScopes/hasScopesForOperation)
refresh-scheduler.ts # RefreshScheduler.scanOnce()/start()/stop() — proactive expiry scan → TokenManager.ensureFresh
```

### 10.2 The three flows, concrete per platform

| Platform | Primary grant (`FLOW_REGISTRY`) | Pairing entry point | Refresh | Notes |
|---|---|---|---|---|
| **twitch** | `auth_code_pkce` | `beginPairing('twitch', ops)` → authorize URL; `completePairing(state, code)` | yes | PKCE verifier held in the session, S256 challenge in the URL. Alternates: `device_code` (`beginPairing(…, { grant:'device_code' })` → `pollDevicePairing(state)`), `client_credentials`. |
| **bluesky** | `platform_password` | `pairWithPassword('bluesky', { identifier, password, operations })` | yes | Exchanges handle + app password for `accessJwt`/`refreshJwt`; the app password is then sealed as a **non-current bootstrap row** (`token_type='atproto_app_password'`, decision A). |
| **discord** | `platform_token` | `pairWithToken('discord', { token, tokenType:'bot'\|'webhook', profile })` | no | Bot token / webhook URL is a static secret — sealed directly, no code exchange, `expires_at = NULL` so it never refreshes. User-context OAuth (`auth_code_pkce`, `webhook.incoming`) is an **alternate** for the redirect path. |

CSRF-safety: `state` is 256-bit random; the callback's `state` must match a stored session or the
exchange is rejected (`PairingStateError`). `take(state)` is single-use, so a replayed callback is
rejected. Sessions carry a 10-minute TTL. The PKCE `codeVerifier`, device `deviceCode`, and app
password live only in the (server-side) session/secret path and are never logged or returned to the UI.

### 10.3 Scope catalog (least privilege)

`resolveRequestedScopes(platform, ops)` requests `base` ∪ the scopes of exactly the enabled
operations — a publish-only Twitch account never requests analytics scopes. `validateGranted` runs at
pairing (granted vs. requested) and is available pre-use (stored vs. the single op). Concrete m3
entries:

- **twitch** — base `user:read:email`; `publish` → `channel:manage:broadcast`; `getAnalytics` →
  `analytics:read:games`, `channel:read:subscriptions`.
- **discord** — base `identify`, `guilds`; `publish` (user OAuth path) → `webhook.incoming`. The
  bot-token/webhook posting path is not OAuth-scoped, so `pairWithToken` skips scope validation.
- **bluesky** — no OAuth scopes (an app password grants a fixed capability set); validation is a
  no-op.

### 10.4 Refresh scheduler

`RefreshScheduler.scanOnce()` lists active accounts, reads each current token's **plaintext**
`expires_at` (never decrypts to check), selects those within the horizon (default 15 min), and calls
`TokenManager.ensureFresh(accountId)` with bounded concurrency (default 4). Because `ensureFresh`
already single-flights in-process and re-checks under the advisory lock, a token is refreshed **at
most once** even if the lazy path fires simultaneously. Per-account failures are isolated
(`ReauthRequiredError` → surfaced as `reauthRequired`, transient → `failed`, retried next pass).
`start()`/`stop()` run it on an interval (default 60s, `unref`'d, non-overlapping); tests drive
`scanOnce()` directly with an injectable clock.

### 10.5 Real app registration + redirect URI setup (no real credentials exist in this repo)

App credentials are supplied at runtime via config / `AppCredentialsResolver` (never committed). The
`SOCIAL_MASTER_KEY` env var (base64 32-byte) seals tokens (§2). Register each platform app as below
and set its **redirect URI** to our callback (default `https://<host>/auth/callback/<platform>`; must
match byte-for-byte).

- **Twitch** — register at <https://dev.twitch.tv/console/apps>. Create an application, set the
  **OAuth Redirect URL** to the callback above, choose client type **Public** to use PKCE without a
  secret (or Confidential and also send the secret). Copy the **Client ID** (and secret if
  confidential) into config. Authorize URL `https://id.twitch.tv/oauth2/authorize`, token URL
  `https://id.twitch.tv/oauth2/token`, device URL `https://id.twitch.tv/oauth2/device`, revoke
  `https://id.twitch.tv/oauth2/revoke` (official endpoints only). Request only the scopes from the
  catalog.
- **Bluesky / AT Protocol** — no app registration for the app-password flow. In Bluesky
  **Settings → App Passwords**, the user creates an app password and supplies it with their handle;
  we call `com.atproto.server.createSession` on their PDS (default `https://bsky.social`) and refresh
  via `com.atproto.server.refreshSession`. No redirect URI. The app password is stored sealed as a
  bootstrap secret (§1).
- **Discord** — register at <https://discord.com/developers/applications>. For the **posting path**,
  add a **Bot** to the application and copy the **bot token**, or have the user create an **incoming
  webhook** on their channel and paste the webhook URL — pair either via `pairWithToken` (no redirect
  URI needed). For the **user-context OAuth path** (e.g. `webhook.incoming`), add the callback above
  under **OAuth2 → Redirects**; authorize URL `https://discord.com/api/oauth2/authorize`, token URL
  `https://discord.com/api/oauth2/token`.

Tests never touch these: the pairing tests inject a `PairingConnector` mock that returns canned
authorize URLs / tokens / device authorizations, and the scheduler tests inject a counting refresher.
