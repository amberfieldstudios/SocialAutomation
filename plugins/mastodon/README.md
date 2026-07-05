# @social/plugin-mastodon

Mastodon connector. Implements the `PlatformConnector` contract
(`packages/core/src/connector/contract.ts`, v1.1) against the official
`/api/v1/*`, `/api/v2/*`, `/oauth/*` REST API only — no scraping, no
undocumented endpoints, no browser automation. See `docs/PLATFORM-RULES.md`
§ "Mastodon" for the content-limit source-of-truth.

## Mastodon has no single API host — per-instance app registration

Unlike Bluesky (one PDS host by default) or Discord/Twitch (one platform
host), every Mastodon account lives on its own **instance**
(`https://mastodon.social`, `https://fosstodon.org`, a self-hosted server,
...), and a "developer app" must be registered **separately on each
instance** before OAuth works there.

### One-time setup (per instance you want to support)

1. Register an application: `POST https://<instance>/api/v1/apps` with
   `client_name`, `redirect_uris`, and `scopes` (typically `read write`).
   This can be done once per instance via `curl` or the account-connection
   flow in `@social/auth` — this connector does **not** register apps itself,
   it only consumes the resulting credentials. Response gives `client_id` /
   `client_secret`.
2. Store those as `AppCredentials.clientId` / `clientSecret`, and the
   instance's base URL as `AppCredentials.extra.instanceUrl` (e.g.
   `https://mastodon.social`) — `AppCredentials` has no first-class
   per-platform host field, so `extra.instanceUrl` carries it, mirroring how
   `plugins/bluesky` carries its PDS `serviceUrl`.
3. Required scopes for this connector: `read` (profile, status, analytics
   reads) and `write` (publish/edit/delete/media upload). Never request more
   than `read write` — no admin/follow/push scopes are needed.

### OAuth2 flow (per end-user account, once the app above exists)

1. `authenticate({ kind: 'authorize_url', app, state, scopes })` builds
   `GET <instance>/oauth/authorize?...`; redirect the user there.
2. After consent, Mastodon redirects back with `?code=...`. Call
   `authenticate({ kind: 'exchange_code', app, code })` →
   `POST <instance>/oauth/token` (`grant_type=authorization_code`) → a
   `TokenSet`.
3. `authenticate({ kind: 'client_credentials', app, scopes })` is also
   supported (documented `grant_type=client_credentials` grant) for
   app-level, non-user-specific calls — rarely needed by this system.
4. Mastodon has **no password/direct-credential grant** for third-party apps
   (unlike Bluesky's app passwords) — `authenticate({ kind: 'password', ... })`
   throws `AuthError`.
5. `refreshToken` calls `POST <instance>/oauth/token`
   (`grant_type=refresh_token`), a Mastodon 4.3+ feature. **Tokens issued by
   older instances/versions have no `refresh_token` and never expire** —
   calling `refreshToken` on one of those throws `AuthError`; the auth layer
   should treat a Mastodon token as durable until a `401` response is seen
   (surfaced here as `TokenExpiredError`), then re-run the OAuth flow.
6. `disconnect` calls `POST <instance>/oauth/revoke` (best-effort — never
   throws; returns `revoked: false` if the call fails, since local account
   cleanup should proceed regardless).

## What's supported

| Method | Status | Notes |
|---|---|---|
| `connect` | done | Verifies reachability via `GET /api/v2/instance`. |
| `authenticate` | done (`authorize_url`/`exchange_code`/`client_credentials`) | See OAuth flow above; `password` kind throws `AuthError`. |
| `refreshToken` | done | `grant_type=refresh_token`; throws `AuthError` if the token has none (older/non-expiring tokens). |
| `validatePost` | done | 500-char default limit (23-char fixed cost per URL), media count/type/size, visibility, thread length, scheduling lead time — pure, no network. |
| `uploadMedia` | done (`mediaUploadMode: 'staged'`) | `POST /api/v2/media`; a `202`/`206` response means the platform is still transcoding (large video/gif) — `remoteUrl` may be `undefined` until it finishes processing. This connector does not poll to completion (see "Known limitations" below). |
| `publish` | done | `POST /api/v1/statuses`; text, media, spoiler/CW text, visibility, language, native `scheduled_at`, and threads via sequential `in_reply_to_id` chaining. |
| `delete` | done | `DELETE /api/v1/statuses/:id`. |
| `edit` | done | `PUT /api/v1/statuses/:id` — Mastodon supports status edit natively (unlike Bluesky). |
| `getAnalytics` | done (partial) | `GET /api/v1/statuses/:id` → likes/shares/comments; best-effort `GET /api/v1/accounts/verify_credentials` → `followersCount` (absolute, not `followersDelta` — no delta-tracking API exists). No impressions/reach/views/clicks/saves in the public API. |
| `disconnect` | done (best-effort) | `POST /oauth/revoke`. |

Every operation is declared supported in `capabilities.ts` — Mastodon's
official API genuinely covers the full contract, so there is nothing to
declare `NotSupportedError` for.

## Known limitations

- **Per-instance configurable limits**: `validatePost` is pure/no-network per
  the contract, so it enforces the **documented defaults** for a stock
  instance (`characterLimit: 500`, `maxMediaCount: 4`, image/video size
  caps — see `capabilities.ts` doc comment for sources). An instance that
  raises or lowers these will disagree with our validation; there is no way
  to know that without a network call from inside a "pure" `validatePost`.
- **Media processing polling**: `uploadMedia` does not poll
  `GET /api/v1/media/:id` until a `202`/`206` response resolves to `200`.
  Large videos/GIFs may not be immediately attachable to a status created
  right after upload; a caller publishing large video content should add its
  own poll/backoff before calling `publish`.
- **Scheduled threads**: `payload.scheduledAt` is only applied to the first
  status in a thread; Mastodon's `scheduled_at` has no concept of scheduling
  a whole reply chain, so thread continuations publish immediately once the
  root goes live (this system's own scheduler is the source of truth for
  timing regardless).

## Local dev / testing

No real credentials are used in tests — `test/conformance.test.ts` runs the
shared `@social/conformance` suite and `test/connector.test.ts` mocks
`fetch` directly for Mastodon-specific behavior (thread chaining, counted-URL
length, analytics). To test against a **real** Mastodon account manually:

```ts
const runtime = { logger: createLogger() };
const connector = new MastodonConnector(runtime);
const app = {
  clientId: 'your-app-client-id',
  clientSecret: 'your-app-client-secret',
  redirectUri: 'https://your-app.example/callback',
  extra: { instanceUrl: 'https://mastodon.social' },
};
await connector.connect({ app });
const { authorizeUrl } = await connector.authenticate({
  kind: 'authorize_url',
  app,
  state: 'random-state',
  scopes: ['read', 'write'],
});
// ...redirect the user to authorizeUrl, capture the returned `code`, then:
const { token, profile } = await connector.authenticate({ kind: 'exchange_code', app, code: '...' });
```

Never commit a real `client_secret` or access token. Revoke test tokens from
the instance's **Settings → Development** page after manual testing.
