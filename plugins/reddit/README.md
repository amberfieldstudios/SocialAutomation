# @social/plugin-reddit

Reddit connector plugin implementing the shared `PlatformConnector` contract (`@social/core`,
v1.1) against Reddit's official REST API (`oauth.reddit.com`) and OAuth2 endpoints
(`www.reddit.com/api/v1/*`) only. No scraping, no undocumented endpoints, no browser automation.

## Method-by-method mapping

| Method | Supported? | Maps to | Why |
|---|---|---|---|
| `connect` | yes | `GET /api/v1/me` (only if a token is supplied) | Confirms the token is live and app config (clientId + User-Agent) is present. |
| `authenticate` | yes | `POST /api/v1/access_token` (`authorization_code` / `password` / `client_credentials`), `GET /api/v1/authorize` (authorize URL) | Standard Reddit OAuth2, plus the "script app" **password grant** for `AuthRequest.kind === 'password'`. |
| `refreshToken` | yes | `POST /api/v1/access_token` (`grant_type=refresh_token`) | — |
| `validatePost` | yes | pure local check | See `docs/PLATFORM-RULES.md` § Reddit. |
| `uploadMedia` | **no** | — | See "Media" below. Throws `NotSupportedError`. |
| `publish` | yes | `POST /api/submit` | Self-text or link post to one subreddit. `remoteId` is the returned fullname (`t3_<id36>`); `target.extra.subreddit` records the subreddit for reference. |
| `delete` | yes | `POST /api/del` | — |
| `edit` | yes (body only) | `POST /api/editusertext` | See "Edit constraints" below. |
| `getAnalytics` | yes | `GET /api/info` | `score` -> `likes`, `num_comments` -> `comments`; `upvote_ratio` is a platform-only extra in `raw`. No impressions/reach data is exposed by the official API. |
| `disconnect` | yes | `POST /api/v1/revoke_token` | Basic-auth'd with the app's client credentials, per Reddit's OAuth2 wiki. |

## Media: why `uploadMedia` is unsupported

Reddit's image/video/gallery submission flow used by its own web and mobile apps
(`POST /api/media/asset.json` to obtain a signed lease, upload the bytes directly to S3, then
`POST /api/submit` with `kind=image`/`kind=video`/`kind=gallery`) is **not part of Reddit's
stable, versioned public API reference** (`https://www.reddit.com/dev/api`) — it is reverse-engineered
from Reddit's own client behavior in most third-party integrations. Per the official-API-only rule
this connector follows, that flow is not implemented.

The supported path for attaching media to a Reddit post through this connector is a **link post**:
set `payload.link` to an already-hosted image/video/gallery URL (e.g. hosted by your own media
pipeline's public delivery URL) and omit `payload.text`. Reddit will still render an inline
preview client-side for recognized media hosts. `payload.media[]` is rejected by `validatePost`
with `media_not_supported` so the pipeline never silently drops attachments.

## Edit constraints

Reddit's API can only rewrite a **self post's body** (`POST /api/editusertext`, `text` param).
There is no endpoint to:
- change a post's **title** after creation (any platform), or
- change a **link post's** target URL after creation.

`edit()` therefore requires `request.payload.text` and always calls `editusertext`; if
`request.payload.title` is also supplied it is logged as ignored (`reddit.edit.title_ignored`)
rather than silently dropped or thrown as an error, since a title-only edit request is a caller
mistake worth surfacing but not worth failing the whole edit over (the body_text update itself is
still valid and applied).

## Real-credential setup (do this to test against live Reddit, not for CI)

1. Create an app at <https://www.reddit.com/prefs/apps> ("create another app...").
   - **script**: for a single-account bot/automation account — use the **password** grant
     (`AuthRequest.kind: 'password'`) with that account's username + password. Reddit issues a
     client id (under the app name) and a client secret.
   - **web app**: for multi-user OAuth via a redirect flow — use `authorize_url` /
     `exchange_code` (`AuthRequest.kind: 'authorize_url'` then `'exchange_code'`). Set the
     **redirect uri** to your callback.
2. `AppCredentials.clientId` / `clientSecret` come from that app registration, supplied by the
   auth layer per `docs/AUTH.md` — this plugin never reads them from env vars/config itself.
3. **`AppCredentials.extra.userAgent` is REQUIRED.** Reddit's API rules
   (<https://github.com/reddit-archive/reddit/wiki/API>) mandate a descriptive, unique
   User-Agent on every request in the form:
   ```
   <platform>:<app ID>:<version string> (by /u/<reddit username>)
   ```
   e.g. `"web:com.example.socialautomation:1.0.0 (by /u/my_bot_account)"`. Requests without one
   are aggressively rate-limited/blocked by Reddit — the connector throws `AuthError` up front
   rather than sending a request that will fail.
4. **Scopes** to request: `submit` (`publish`), `edit` (`edit`), `read` (`getAnalytics`/`connect`),
   `identity` (profile resolution on `authenticate`). `submit`/`edit` require a **user** token
   (password or authorization_code grant) — a `client_credentials` app-only token can `getAnalytics`
   (read-only) but cannot `publish`/`edit`/`delete`.
5. Access tokens expire in 1 hour; a `duration=permanent` authorize request (set by this
   connector) issues a refresh token so `refreshToken` can renew it without re-prompting the user.

## Testing

All tests run against a fully mocked `fetch` — no real credentials, no network access.

```
npx --yes pnpm@9.7.0 --filter @social/plugin-reddit run test
```

`test/connector.test.ts` covers Reddit-specific behavior (self vs link posts, edit-body-only,
analytics mapping, auth grants, User-Agent enforcement). `test/conformance.test.ts` runs the
shared `@social/conformance` harness that every connector must pass.

## Contract v1.1 shapes used

- `OperationContext.app` — every call reads `ctx.app.clientId`/`clientSecret`/`extra.userAgent`
  directly instead of re-deriving them from the token.
- `AuthRequest.kind === 'password'` — Reddit's "script" app OAuth2 password grant maps onto this
  first-class variant rather than overloading `client_credentials`.
- `CapabilityDescriptor.mediaUploadMode` — set to the inert default (`'staged'`) since
  `operations.uploadMedia` is `false`; the value never governs real behavior here.
- Typed `TargetContext` — `PublishResult.target.extra.subreddit` carries the subreddit
  non-secret addressing detail instead of encoding it into a composite `remoteId` string.
