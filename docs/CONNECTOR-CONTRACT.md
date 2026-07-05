# Connector Contract — `PlatformConnector`

This is the human-readable spec for the contract **every** platform plugin implements and the
conformance suite tests against. The authoritative, compiling source lives in `@social/core`:

| Concern | Source file |
|---------|-------------|
| The `PlatformConnector` interface + runtime/factory | `packages/core/src/connector/contract.ts` |
| Request/result types (`PostPayload`, `PublishResult`, …) | `packages/core/src/connector/types.ts` |
| `CapabilityDescriptor` + `supportsOperation` | `packages/core/src/connector/capabilities.ts` |
| Typed errors (`NotSupportedError`, `RateLimitError`, …) | `packages/core/src/connector/errors.ts` |
| Plugin manifest / registry / loader | `packages/core/src/plugin/manifest.ts` |
| Logging shape | `packages/core/src/logging.ts` |
| Barrel export | `packages/core/src/index.ts` |

If this document and the source ever disagree, **the source wins** — update the doc.

---

## 0. Contract v1.1 — what changed from v1.0

Five accumulated gap reports from the m3/m4 connector implementations (Discord, Twitch, Bluesky)
landed together as Contract v1.1:

1. **App identity on `OperationContext`.** `OperationContext` now carries `app: AppCredentials`
   alongside `token`, so a connector that needs app-level config (e.g. a `Client-Id` header every
   call requires) on a per-call operation no longer has to make an extra round trip to derive it
   from the token itself. Removed Twitch's `/oauth2/validate`-just-for-the-client-id workaround in
   `getAnalytics`/`disconnect`/`authenticate`'s profile fetch (its `publish`/`edit` still call
   `/oauth2/validate` once, but only to resolve the broadcaster's Twitch user id, which
   `OperationContext` genuinely has no field for).
2. **Password-grant `AuthRequest` kind.** Added `{ kind: 'password', app, identifier, password,
   scopes? }` for app-password / direct-credential platforms. Removed Bluesky's workaround of
   mapping app-password auth onto `kind: 'client_credentials'` with `app.extra.handle`/
   `app.extra.appPassword`.
3. **`uploadMedia` stage-vs-inline semantics.** Added `CapabilityDescriptor.mediaUploadMode:
   'staged' | 'inline'` (§3) so "does `uploadMedia` actually transfer bytes to a durable,
   platform-issued handle, or does the platform only accept media inline with `publish`/`edit`?"
   is a declared, typed convention instead of a per-connector prose workaround. Discord declares
   `'inline'`; Bluesky declares `'staged'`.
4. **Per-credential-shape capability.** Added the optional `PlatformConnector.capabilitiesFor(token)`
   method (§3.1) so a connector whose support for an operation depends on the SHAPE of the
   credential (e.g. Discord: `refreshToken`/`disconnect` work for an OAuth2 user token but not a
   static bot token or webhook URL) can declare that precisely, and the "declare `false` AND throw
   `NotSupportedError`" pairing now applies per credential shape too. Discord's `refreshToken`/
   `disconnect` throw `NotSupportedError` for bot/webhook credentials instead of the ad hoc
   `AuthError` they threw before this existed.
5. **Richer `Delete`/`Edit`/`AnalyticsQuery` target context.** Added `TargetContext`
   (`channelId`/`threadId`/`guildId`/`extra`) on `PublishResult.target`, `DeleteRequest.target`,
   `EditRequest.target`, and `AnalyticsQuery.target` (§2) so connectors addressing a post that
   needs more than a bare id (a channel, thread, or webhook) have a typed field instead of
   inventing a composite-string `remoteId` convention. Discord's `publish` now returns a bare
   message id in `remoteId` plus a typed `target`; `delete`/`edit` read `request.target` (with a
   compatibility fallback that still parses the pre-v1.1
   `"channel:<id>:<messageId>"`/`"webhook:<id>:<messageId>"` composite form).

`CONTRACT_VERSION` moved from `1.0.0` to `1.1.0` (§5.3); the plugin loader still requires an exact
match, so every plugin's `package.json` `socialPlugin.contractVersion` and manifest
`contractVersion` were bumped alongside it.

---

## 1. Design rules

1. **Official APIs only.** Every call targets the platform's documented API base URL. No scraping,
   no undocumented endpoints, no browser automation.
2. **Ten methods, always present.** Every connector implements all ten. Ones the platform can't
   support throw `NotSupportedError` **and** are declared `false` in the capability descriptor —
   never a silent no-op.
3. **Validate before publish.** `publish`/`edit` must reject anything `validatePost` would reject.
4. **No credential leakage.** Connectors receive a decrypted `TokenSet` per call via
   `OperationContext`; they never read storage, never persist tokens, never log them.
5. **Retryable failures are typed.** Rate limits and transient errors set `retryable = true` (with
   optional `retryAfterMs`) so the queue's backoff acts on them instead of crashing.

---

## 2. The interface

```ts
interface PlatformConnector {
  readonly capabilities: CapabilityDescriptor;
  /** Contract v1.1, OPTIONAL: capability descriptor for one specific credential shape. */
  capabilitiesFor?(token: TokenSet): CapabilityDescriptor;

  connect(input: ConnectInput): Promise<ConnectResult>;
  authenticate(request: AuthRequest): Promise<AuthResult>;
  refreshToken(input: RefreshInput): Promise<TokenSet>;
  validatePost(payload: PostPayload): Promise<ValidationResult>;
  uploadMedia(media: MediaSource, ctx: OperationContext): Promise<UploadedMedia>;
  publish(payload: PostPayload, ctx: OperationContext): Promise<PublishResult>;
  delete(request: DeleteRequest, ctx: OperationContext): Promise<DeleteResult>;
  edit(request: EditRequest, ctx: OperationContext): Promise<EditResult>;
  getAnalytics(query: AnalyticsQuery, ctx: OperationContext): Promise<AnalyticsSnapshot>;
  disconnect(ctx: OperationContext): Promise<DisconnectResult>;
}
```

### Method contracts

| Method | Purpose | Key inputs | Result | Notes |
|--------|---------|-----------|--------|-------|
| `connect` | Prepare the connector for an account context; validate app config, verify API reachability. Non-interactive. | `ConnectInput` (`app`, optional `accountId`, optional `token`) | `ConnectResult` (`ready`, `platform`, `apiVersion?`) | Idempotent; no user interaction. |
| `authenticate` | Drive OAuth: produce an authorize URL, exchange a code, or client-credentials grant. | `AuthRequest` (discriminated by `kind`) | `AuthResult` (`authorizeUrl?`, `token?`, `profile?`) | The profile normalizes account identity into `PlatformProfile`. |
| `refreshToken` | Exchange a refresh token for a fresh `TokenSet`. | `RefreshInput` (`app`, `token`) | `TokenSet` | Throw `TokenRevokedError` when the grant is dead (re-auth needed); `TokenExpiredError` is retryable-refreshable. |
| `validatePost` | Pure check against platform rules (limits, media specs, threading). | `PostPayload` | `ValidationResult` (`ok`, `errors[]`, `warnings[]`) | **No** network calls or side effects. `ok === (errors.length === 0)`. |
| `uploadMedia` | Stage one rendition with the platform. | `MediaSource`, `OperationContext` | `UploadedMedia` (`remoteMediaId`, …) | Some platforms expire staged uploads (`expiresAt`). |
| `publish` | Publish a post (+ its `thread`). | `PostPayload`, `OperationContext` | `PublishResult` (`remoteId`, `remoteUrl?`, `publishedAt`, `threadRemoteIds?`) | Must re-validate; throw `ValidationFailedError` on failure. Honor `idempotencyKey`. |
| `delete` | Delete a published post. | `DeleteRequest` (`remoteId`, `target?`), `OperationContext` | `DeleteResult` (`removed`) | Optional — `NotSupportedError` if undeclared. |
| `edit` | Edit a published post. | `EditRequest` (`remoteId`, `payload`, `target?`), `OperationContext` | `EditResult` (`remoteId`, `editedAt`) | Optional — `NotSupportedError` if undeclared. |
| `getAnalytics` | Fetch a normalized snapshot for a published post. | `AnalyticsQuery` (`remoteId`, `target?`, `metrics?`, `since?`, `until?`), `OperationContext` | `AnalyticsSnapshot` (`metrics` keyed by `CanonicalMetric`) | Map platform-native metrics onto `CANONICAL_METRICS`; extras go in `raw`. |
| `disconnect` | Revoke tokens at the platform where possible; release resources. | `OperationContext` | `DisconnectResult` (`revoked`) | Local-only revocation still returns `revoked: false`; per-credential-shape unsupported cases (§3.1) throw `NotSupportedError` instead. |

`OperationContext` carries the decrypted `token`, the developer `app: AppCredentials` this account
was connected under (Contract v1.1), the internal `accountId`, a `logger`, and an optional
`deadlineMs`. This is how the auth layer, not the connector, owns token storage.

`PublishResult.target` (Contract v1.1, `TargetContext`) carries whatever addressing context a
LATER `delete`/`edit`/`getAnalytics` call on the SAME post will need beyond the bare `remoteId` —
a channel/room/thread/guild id for platforms where a post isn't independently addressable (see §2.1).

### 2.1 `TargetContext` (Contract v1.1)

```ts
interface TargetContext {
  channelId?: string;
  threadId?: string;
  guildId?: string;
  /** Non-secret platform-specific ids that don't fit the fields above. */
  extra?: Record<string, string>;
}
```

Callers persist `PublishResult.target` alongside `remoteId` and pass it back on
`DeleteRequest.target` / `EditRequest.target` / `AnalyticsQuery.target`. `extra` MUST NEVER carry a
live credential/secret — those belong only in `OperationContext.token`. Example (Discord): a
webhook-published message returns `target: { extra: { kind: 'webhook', webhookId: '123' } }` — the
webhook's secret token is never in `remoteId`/`target` (both persisted in plaintext), only sourced
fresh from `OperationContext.token` on each `delete`/`edit` call.

### 2.2 `AuthRequest` kinds

```ts
type AuthRequest =
  | { kind: 'authorize_url'; app: AppCredentials; state: string; scopes: string[]; codeChallenge?: string }
  | { kind: 'exchange_code'; app: AppCredentials; code: string; state?: string; codeVerifier?: string }
  | { kind: 'client_credentials'; app: AppCredentials; scopes: string[] }
  | { kind: 'password'; app: AppCredentials; identifier: string; password: string; scopes?: string[] }; // Contract v1.1
```

`password` is for platforms with no OAuth2 "app" concept (e.g. Bluesky app passwords) — an
account-level `identifier`/`password` exchange, distinct from `client_credentials` (an OAuth2
app-level grant using `app.clientSecret`).

---

## 3. Capability descriptor — declaring what a platform can do

`CapabilityDescriptor` (see `capabilities.ts`) is the **single source of truth for feature
detection**. Numbers must match `docs/PLATFORM-RULES.md` and the platform's official API docs.

Key fields:

- `platform`, `displayName`, `apiBaseUrl`, `contractVersion`.
- `operations: OperationSupport` — a boolean per method. **The authoritative unsupported-ops map.**
- Convenience flags mirroring the above/limits: `supportsEdit`, `supportsDelete`,
  `supportsScheduling` (native platform scheduling), `supportsThreads`, `supportsAnalytics`,
  `supportsMediaUpload`.
- Text: `characterLimit`, `titleCharacterLimit?`, `altTextCharacterLimit?`,
  `urlsCountTowardLimit`, `countedUrlLength?`, `maxHashtags?`, `maxMentions?`.
- Media: `maxMediaCount`, `supportedMediaTypes`, `mediaConstraints[]` (per-type MIME/size/
  dimension/duration/aspect-ratio limits), `mediaUploadMode` (Contract v1.1, see below).
- Threads: `maxThreadLength?`. Scheduling/limits: `nativeScheduleHorizonDays?`, `rateLimit?`.

### `mediaUploadMode` (Contract v1.1)

`mediaUploadMode: 'staged' | 'inline'` declares how `uploadMedia` behaves:

- **`'staged'`** — `uploadMedia` actually transfers bytes to the platform and returns a durable,
  platform-issued `remoteMediaId` (often `remoteUrl`/`expiresAt` too) that a LATER, separate
  `publish`/`edit` call can reference without re-reading the source bytes (e.g. Bluesky's
  `com.atproto.repo.uploadBlob`).
- **`'inline'`** — the platform has no stage-then-reference API; media can only be attached as part
  of the SAME request that creates/edits the post. `uploadMedia` on an `'inline'` connector only
  validates against `mediaConstraints` and returns a local, non-platform-issued pending handle;
  `publish`/`edit` re-read `MediaSource.uri` themselves and attach the bytes inline (e.g. Discord's
  multipart message-create call). `UploadedMedia.remoteUrl`/`expiresAt` are meaningless here.

Callers MUST check `mediaUploadMode` before assuming `UploadedMedia.remoteMediaId`/`remoteUrl` are
usable outside of that same connector's own `publish`/`edit` call.

### 3.1 Per-credential-shape capability: `capabilitiesFor` (Contract v1.1)

Some platforms support an operation for one credential shape but not another — e.g. Discord:
`refreshToken`/`disconnect` are meaningful for an OAuth2 user token but not for a static bot token
or webhook URL, which never expire and have no revoke grant. A single static `capabilities`
descriptor can't express that, so a connector MAY additionally implement:

```ts
capabilitiesFor?(token: TokenSet): CapabilityDescriptor;
```

Rules:

- The static `capabilities` getter MUST remain the MOST PERMISSIVE descriptor — `true` for
  anything supported by ANY credential shape the connector accepts.
- `capabilitiesFor(token)` narrows that to what's true for `token`'s specific shape.
- The same "declare it AND throw" invariant applies, scoped to the credential: if
  `capabilitiesFor(token).operations.x` is `false`, calling `x` with that token MUST throw
  `NotSupportedError` — never a plain `AuthError`. `NotSupportedError` is reserved for "this
  operation cannot be performed with this credential/platform," which is exactly this case.
- Callers that need to feature-detect for a specific account should call
  `resolveCapabilities(connector, token)` (exported from `@social/core`; returns
  `connector.capabilitiesFor?.(token) ?? connector.capabilities`) rather than only reading the
  static `capabilities` getter.
- The shared conformance suite resolves the effective descriptor for its `env.token` this way, so
  a connector implementing `capabilitiesFor` gets its per-credential pairing checked automatically
  for whichever credential shape the plugin's conformance fixture uses.

### The unsupported-operation convention

An operation the platform cannot do must be handled **two ways at once**:

1. **Declare** it: `capabilities.operations.edit = false` (and `supportsEdit = false`).
2. **Throw** from the method: the implementation calls `assertSupported(this.capabilities, 'edit')`
   at the top, which throws `NotSupportedError` when the descriptor says it's unsupported.

Callers detect support cleanly without a try/catch:

```ts
import { supportsOperation } from '@social/core';

if (supportsOperation(connector.capabilities, 'edit')) {
  await connector.edit(req, ctx);
} else {
  // choose an alternative (e.g. delete + repost) or surface "edit unavailable"
}
```

The conformance suite enforces this pairing: for every method, either it works **or** it throws
`NotSupportedError` **and** the descriptor declares it unsupported. A method that throws while the
descriptor claims support (or vice versa) is a conformance failure.

---

## 4. Error model

All connector errors extend `ConnectorError` (`errors.ts`), which carries `code`
(`ConnectorErrorCode`), `platform`, `operation`, `retryable`, and optional `retryAfterMs`.

| Class | `code` | `retryable` | Queue behavior |
|-------|--------|-------------|----------------|
| `NotSupportedError` | `not_supported` | false | Do not retry; caller should feature-detect. |
| `AuthError` | `auth_failed` | false | Fail; needs credential attention. |
| `TokenExpiredError` | `token_expired` | true | Refresh token, then retry. |
| `TokenRevokedError` | `token_revoked` | false | Stop; requires full re-auth. |
| `RateLimitError` | `rate_limited` | true | Back off `retryAfterMs`, then retry. |
| `ValidationFailedError` | `validation_failed` | false | Do not publish; carries the `ValidationResult`. |
| `TransientError` | `transient` | true | Exponential backoff + jitter, then retry. |

Use `isRetryable(err)` to branch in the queue worker. Map platform HTTP responses onto these:
429 / rate-limit headers → `RateLimitError`; 5xx / network → `TransientError`; 401 with a
refreshable token → `TokenExpiredError`; 401/403 revoked → `TokenRevokedError`.

---

## 5. Plugin discovery, manifest & registration

See `packages/core/src/plugin/manifest.ts`.

### 5.1 Package marker

A plugin package declares itself in its `package.json`:

```json
{
  "name": "@social/plugin-discord",
  "version": "0.1.0",
  "type": "module",
  "socialPlugin": { "platform": "discord", "contractVersion": "1.1.0" },
  "dependencies": { "@social/core": "workspace:*" }
}
```

### 5.2 Manifest export

The package's module entry (`src/index.ts`) default-exports a `PluginManifest`:

```ts
import { defineManifest } from '@social/core';
import { capabilities } from './capabilities';
import { DiscordConnector } from './connector';

export default defineManifest({
  name: '@social/plugin-discord',
  platform: 'discord',
  version: '0.1.0',
  contractVersion: '1.1.0',
  capabilities,
  createConnector: (runtime) => new DiscordConnector(runtime),
});
```

### 5.3 Discovery & registration

The loader (`PluginLoader`, implemented by connector-engineer in t5):

1. Scans workspace packages under the configured globs (default `plugins/*`) for a `socialPlugin`
   field.
2. Imports each package's module entry and reads the default-exported `PluginManifest`.
3. Verifies `manifest.contractVersion === CONTRACT_VERSION` and `manifest.platform` matches the
   `socialPlugin.platform` declaration; rejects mismatches with a structured error.
4. Calls `registry.register(manifest)` into a `PluginRegistry` keyed by platform id.

At publish time the core does `registry.get('discord')?.createConnector(runtime)` and interacts
only through `PlatformConnector`. **The core never imports a plugin package.** Adding a platform is
adding a `plugins/<platform>` package — no core change, satisfying the "new platforms without
touching the core" goal.

`CONTRACT_VERSION` (currently `1.1.0`) is exported from `@social/core`; bump it on any breaking
change to the interface or shared types so stale plugins fail fast at load.
