# @social/plugin-twitch

Twitch connector plugin implementing the shared `PlatformConnector` contract
(`@social/core`) against Twitch's official **Helix** API and **OAuth2** endpoints only. No
scraping, no undocumented endpoints, no browser automation.

## Why Twitch doesn't map 1:1 onto "publish a post"

Twitch has no per-post create/edit/delete/analytics API. The closest official surface for
distributing content through a channel is **Modify Channel Information** (title/category/tags),
which is a **singleton resource per channel** — there is one, and updating it overwrites the
previous value. The contract's ten methods are mapped as follows (full rationale and every
numeric limit cited in `docs/PLATFORM-RULES.md` § Twitch):

| Method | Supported? | Maps to | Why |
|---|---|---|---|
| `connect` | yes | `GET /oauth2/validate` (only if a token is supplied) | Verifies reachability + token liveness without spending a Helix rate-limit point. |
| `authenticate` | yes | `GET /oauth2/authorize`, `POST /oauth2/token` (auth code + PKCE, or client_credentials) | Standard Twitch OAuth2. |
| `refreshToken` | yes | `POST /oauth2/token` (`grant_type=refresh_token`) | Twitch access tokens are short-lived (~4h) and rotate the refresh token. |
| `validatePost` | yes | pure local check | See `docs/PLATFORM-RULES.md`. |
| `uploadMedia` | **no** | — | No Helix endpoint accepts an arbitrary client-supplied media upload for channel content. Throws `NotSupportedError`. |
| `publish` | yes | `PATCH /helix/channels` | Updates title/category/tags. `remoteId` returned is the broadcaster's Twitch user id (the channel is the "post"). |
| `delete` | **no** | — | Channel info can only be overwritten, never removed. Throws `NotSupportedError`. |
| `edit` | yes | `PATCH /helix/channels` | Re-applies the same channel-info update; the channel is a singleton, so `edit` and `publish` converge on one call. |
| `getAnalytics` | yes | `GET /helix/streams` + `GET /helix/channels/followers` | Live viewer count (`views`) and total follower count (`raw.followersTotal`). No historical/windowed metrics endpoint exists — `since`/`until` are ignored (logged), only the current snapshot is returned. |
| `disconnect` | yes | `POST /oauth2/revoke` | Official revocation endpoint. |

## Real-credential setup (do this to test against live Twitch, not for CI)

1. Register an application at the [Twitch Developer Console](https://dev.twitch.tv/console/apps)
   ("Register Your Application").
   - **OAuth Redirect URLs**: your app's callback (e.g. `https://your-app.example/oauth/twitch/callback`).
   - **Category**: "Application Integration" (or whatever fits your use case).
   - **Client Type**: confidential (issues a client secret) unless you're doing pure PKCE public-client flows.
2. Note the **Client ID** and (if confidential) **Client Secret** — these become
   `AppCredentials.clientId` / `AppCredentials.clientSecret` passed into `connect`/`authenticate`/
   `refreshToken`. They are supplied by the auth layer per `docs/AUTH.md`; this plugin never reads
   them from environment variables or config files itself.
3. **Scopes** to request during `authenticate({ kind: 'authorize_url', scopes: [...] })`:
   - `channel:manage:broadcast` — required for `publish`/`edit` (Modify Channel Information).
   - `moderator:read:followers` — required for the follower-count portion of `getAnalytics`
     (optional; the connector degrades gracefully without it).
   - `user:read:email` is **not** required by this connector; only request it if another part of
     the system needs it.
4. Grant type: **Authorization Code + PKCE** (primary, per `docs/AUTH.md` § Twitch). Device Code
   Grant and Client Credentials are supported by Twitch for alternate/app-level flows but this
   plugin only wires the flows the contract's `AuthRequest.kind` covers
   (`authorize_url` / `exchange_code` / `client_credentials`).
5. Access tokens expire in ~4 hours; store the refresh token and call `refreshToken` proactively
   (owned by `@social/auth`, not this plugin).

## Testing

All tests (`test/connector.test.ts`) run against a fully mocked `fetch` — no real credentials, no
network access. Run with:

```
pnpm --filter @social/plugin-twitch test
```

## Contract v1.1 update: the `/oauth2/validate` workaround is gone

Earlier versions of this connector called `GET /oauth2/validate` on every per-call operation just
to learn the app's `Client-Id` (every Helix call requires it as a header), since `OperationContext`
carried only the account token. Contract v1.1 added `OperationContext.app` (the same
`AppCredentials` passed to `connect`/`authenticate`/`refreshToken`), so `getAnalytics` and
`disconnect` now read `ctx.app.clientId` directly with zero extra round trips, and `authenticate`'s
post-exchange profile fetch reads `request.app.clientId` instead of re-deriving it.

`publish`/`edit` still call `GET /oauth2/validate` once per call — but only to resolve the
broadcaster's Twitch user id, which `OperationContext` has no field for (only the internal
`accountId`). That's a genuine identity-resolution need, not a Client-Id workaround.
