# @social/plugin-discord

Discord connector plugin implementing the shared `PlatformConnector` contract (`@social/core`)
against Discord's official **bot REST API** (`https://discord.com/api/v10`) and **webhook execute
API** only. No scraping, no gateway/websocket automation, no undocumented endpoints. All numeric
limits are cited (with doc URLs + date checked) in `docs/PLATFORM-RULES.md` § Discord and mirrored
in `src/capabilities.ts`.

## Credential flow

`OperationContext.token` (supplied by `@social/auth`'s `TokenManager`, never read from storage by
this connector) has three shapes, selected by `token.tokenType`:

| `tokenType` | `accessToken` holds | Auth header | Refreshable? | Revocable? |
|---|---|---|---|---|
| `'bot'` | the bot token from the Developer Portal | `Authorization: Bot <token>` | No — static secret | No API-level revoke; regenerate in the portal |
| `'webhook'` | the **full webhook URL** (`.../webhooks/{id}/{token}`) | none (the URL itself is the secret) | No — static secret | No API-level revoke; delete the webhook in channel settings |
| anything else (e.g. `'Bearer'`) | an OAuth2 user/app access token | `Authorization: Bearer <token>` | Yes, via `refreshToken` | Yes, via `disconnect` (`POST /oauth2/token/revoke`) |

`tokenType` also drives `capabilitiesFor(token)` (Contract v1.1): `refreshToken`/`disconnect` are
declared `false` for `'bot'`/`'webhook'` and throw `NotSupportedError` if called anyway.

`AppCredentials` (the *developer app*, distinct from the per-account token above) carries
`clientId`/`clientSecret` for the OAuth2 flows and an optional `extra.permissions` /
`extra.guildId` used to prefill the bot-install `authorize_url` (Discord's permissions bitfield
and guild pre-select aren't first-class `AuthRequest` fields, so they ride in `AppCredentials.extra`
— the escape hatch the contract already reserves for platform-only app config).

Per-publish routing (which channel, which webhook, embeds, pings, buttons, threads) lives in
`PostPayload.platformOptions` — see `src/types.ts` `DiscordPlatformOptions`. This is the contract's
documented "typed-per-plugin escape hatch," used here because `PostPayload` has no generic
channel/room field (see "Contract gaps" #3 below).

**Cross-server posting**: one Discord `accounts` row = one bot-token-or-webhook credential bound to
one guild/channel context (via `platformOptions.channelId`/`webhookUrl`, or a stored default per
account). To post the same content to multiple servers, the queue calls `publish()` once per
account, same as every other platform — there's nothing Discord-specific about "cross-server" at
the connector level; it falls straight out of the multi-account model in `docs/AUTH.md`.

**Go-live announcements**: Discord's API has no distinct "go-live" message type — it's an ordinary
message with an embed (+ optional role ping + a "Watch now" link button). `src/go-live.ts` exports
`buildGoLiveAnnouncement()`, a `PostPayload` constructor for this common case, so callers don't
have to hand-roll the embed/button shape.

**Buttons / interactions**: `publish()` can attach `platformOptions.components` (action rows of
buttons) to a message. Handling a **click** on a non-link button requires a separate Interactions
HTTP endpoint (or the Gateway) registered with Discord — that's an inbound webhook Discord calls
*you*, architecturally distinct from this connector's outbound `publish()` call, and out of scope
for `PlatformConnector`. Link-style buttons (`style: 5`) work end-to-end with no extra wiring since
they don't fire an interaction event.

## Contract v1.1: gaps found in m3/m4, resolved here

Three of the four gaps originally reported here are now resolved by Contract v1.1
(`packages/core/src/connector/*`); the fourth was always a usage note, not a gap.

1. **`uploadMedia` stage-vs-inline semantics — resolved.** `CapabilityDescriptor.mediaUploadMode`
   (`'staged' | 'inline'`) now makes this a declared, documented convention instead of a silent
   workaround. Discord declares `mediaUploadMode: 'inline'` (`src/capabilities.ts`): Discord's
   bot/webhook message APIs only accept attachments **inline**, as `multipart/form-data` parts of
   the same `POST` that creates the message — there is no Twitter-style "upload bytes, get a
   `remoteMediaId`, attach it later" flow. `uploadMedia()` here only validates media against
   `capabilities.mediaConstraints` and returns a **local** pending handle
   (`remoteMediaId: 'pending:<assetId>'`); no bytes reach Discord until `publish()`/`edit()`
   re-read `source.uri` and attach them. `UploadedMedia.remoteUrl`/`expiresAt` are absent here, as
   the `'inline'` convention documents they should be.

2. **`refreshToken`/`disconnect` support varying by credential shape — resolved.** Contract v1.1
   added `PlatformConnector.capabilitiesFor(token)` for exactly this case. `discordCapabilitiesFor`
   (`src/capabilities.ts`) narrows the static (most-permissive) `discordCapabilities` to
   `refreshToken: false, disconnect: false` when `token.tokenType` is `'bot'`/`'webhook'` (static,
   non-refreshable/non-revocable secrets); OAuth2 user tokens keep the full descriptor.
   `refreshToken()`/`disconnect()` call `assertSupported(discordCapabilitiesFor(token), op)` at the
   top, so a bot/webhook credential now throws `NotSupportedError` — the "declare it AND throw"
   pairing, scoped to the credential — instead of the ad hoc `AuthError` this connector threw
   before per-credential capabilities existed.

3. **No generic channel/room field on `DeleteRequest`/`EditRequest`/`AnalyticsQuery` — resolved.**
   Contract v1.1 added a typed `TargetContext` (`channelId`/`threadId`/`guildId`/`extra`) to
   `PublishResult.target`, `DeleteRequest.target`, `EditRequest.target`, and
   `AnalyticsQuery.target`. `publish()` now returns a **bare** message id in `remoteId` plus a
   `target` (`{ channelId }` for the bot API, `{ extra: { kind: 'webhook', webhookId } }` for the
   webhook API); `delete()`/`edit()` read `request.target` instead of parsing a composite
   `remoteId` string. (`resolveTarget()` in `src/connector.ts` still tolerates the pre-v1.1
   `"channel:<id>:<messageId>"` / `"webhook:<id>:<messageId>"` composite form for
   already-persisted rows, so this is a compatible upgrade.)
   - **Security note (unchanged)**: neither `remoteId` nor `target` ever carries the webhook's
     secret token — only the non-secret webhook id (`target.extra.webhookId`). `PublishResult`/
     `target` are persisted at rest in plaintext (e.g. `post_variants.remote_id`/`target`, plain
     columns — not the encrypted token vault). `delete()`/`edit()` re-derive the full webhook URL
     (including its token) from `OperationContext.token` via `credentialFromToken(ctx.token)` on
     every call — the vault supplies that token fresh each time, so the secret never round-trips
     through storage. If a webhook message is deleted or edited with a non-webhook credential in
     `ctx.token`, both methods throw `AuthError` rather than silently failing.

4. **`AuthRequest`'s `authorize_url`/`exchange_code` have no field for a platform-specific
   post-auth "install target" (Discord's bot-invite `guild_id` pre-select / `permissions`
   bitfield).** Solved without a contract change by reading `AppCredentials.extra.guildId` /
   `extra.permissions` (the contract's own documented escape hatch for app-level platform
   options), so this is a usage note rather than a gap, but worth flagging since other
   OAuth-install-a-bot-style platforms will hit the same shape.

None of the above ever blocked conformance — every method round-trips correctly and every
unsupported *operation* (`getAnalytics` always; `refreshToken`/`disconnect` for bot/webhook
credentials) both declares `false` (statically or via `capabilitiesFor`) and throws
`NotSupportedError`.

## Method map

| Method | Supported? | Notes |
|---|---|---|
| `connect` | yes | Verifies reachability: `GET /users/@me` (bot), `GET` the webhook URL (webhook), `GET /oauth2/@me` (OAuth), or `GET /gateway` (no credential yet — public, unauthenticated). |
| `authenticate` | yes | `authorize_url` builds the OAuth2 authorize link; `exchange_code` and `client_credentials` hit `POST /oauth2/token` (form-encoded, per Discord's requirement). |
| `refreshToken` | yes for OAuth2; `NotSupportedError` for bot/webhook | Credential-shape-dependent via `capabilitiesFor` — see "Contract v1.1" #2. |
| `validatePost` | yes | Pure, no network — `src/validation.ts`. |
| `uploadMedia` | yes (`mediaUploadMode: 'inline'`, local staging only) | See "Contract v1.1" #1. |
| `publish` | yes | Re-validates before any HTTP call; routes to bot or webhook API; supports embeds, buttons, role/user pings, replies, `thread[]` chains, and starting a new Discord thread. Returns a bare message `remoteId` + typed `target`. |
| `delete` | yes | Typed `target` (`TargetContext`) — see "Contract v1.1" #3. |
| `edit` | yes | Re-validates; typed `target`. |
| `getAnalytics` | **no** | Discord's bot API has no message-level analytics endpoint. Declared `false` in `capabilities.operations.getAnalytics` and throws `NotSupportedError`. |
| `disconnect` | yes for OAuth2; `NotSupportedError` for bot/webhook | Credential-shape-dependent via `capabilitiesFor`; `POST /oauth2/token/revoke` for OAuth2. |

## Real-credential setup (do this to test against live Discord, not for CI)

1. Create an application at the [Discord Developer Portal](https://discord.com/developers/applications).
2. **Bot token** (for `tokenType: 'bot'` accounts):
   - Open the **Bot** tab, click **Add Bot**, then **Reset Token** to reveal it once. Store it in
     the token vault via `@social/auth`; this plugin never reads it from env/config itself.
   - Under **Privileged Gateway Intents**, this connector needs none — it never opens a Gateway
     connection. If a future feature needs message-content inspection, intents would apply there,
     not here.
   - Invite the bot to a server: build an authorize URL via
     `authenticate({ kind: 'authorize_url', scopes: ['bot'], app: { clientId, extra: { permissions: '3072', guildId: '<optional prefill>' } } })`
     — `3072` = `Send Messages` + `Embed Links`; add `34359738368` for `Create Public Threads` if
     you'll use `platformOptions.createThread`.
3. **Webhook URL** (for `tokenType: 'webhook'` accounts): in a channel's **Integrations →
   Webhooks**, create a webhook and copy its URL. Store the full URL as the token's `accessToken`.
4. **OAuth2 user login** (only if you need `refreshToken`/`disconnect`/user identity): under
   **OAuth2 → General**, note the **Client ID** and **Client Secret**, and add a **Redirect**. Use
   scopes like `identify` for `exchange_code`.
5. No environment variables are read directly by this plugin — all credentials arrive via
   `OperationContext`/`AppCredentials` per `docs/AUTH.md`.

## Testing

All tests (`test/connector.test.ts`) run against Discord's REST/webhook APIs mocked with
[`undici`'s `MockAgent`](https://undici.nodejs.org/#/docs/api/MockAgent) (Node's built-in `fetch`
is undici under the hood, so `setGlobalDispatcher` intercepts it) — no real credentials, no
network access. Run with:

```
pnpm --filter @social/plugin-discord test
```
