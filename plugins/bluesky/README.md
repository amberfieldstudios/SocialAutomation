# @social/plugin-bluesky

Bluesky / AT Protocol connector. Implements the `PlatformConnector` contract
(`packages/core/src/connector/contract.ts`) against the official
`com.atproto.*` / `app.bsky.*` XRPC API only — no scraping, no undocumented
endpoints, no browser automation. See `docs/PLATFORM-RULES.md` § "Bluesky /
AT Protocol" for the content-limit source-of-truth and `docs/AUTH.md` §
"Bluesky / AT Protocol" for the auth design this implements.

## Auth model: app passwords, not OAuth2

Bluesky/AT Proto has an OAuth flow, but the locked producer decision for this
project (decision A) is the simpler **app-password session flow**:

1. The end user goes to **Bluesky Settings → Privacy and Security → App
   Passwords** (in-app: `https://bsky.app/settings/app-passwords`) and creates
   a new app password. It looks like `xxxx-xxxx-xxxx-xxxx`. **Never use the
   account's main login password** — app passwords are scoped, revocable, and
   don't grant access to account settings/other app passwords.
2. Our auth layer calls `connector.authenticate()` with `kind: 'password'`,
   passing the user's **handle** (e.g. `alice.bsky.social`) as `identifier`
   and the app password as `password` — the first-class password-grant
   `AuthRequest` variant added in Contract v1.1. `app.extra.serviceUrl` is
   still read (optional; defaults to `https://bsky.social` — set this for a
   self-hosted PDS), since that's genuinely app/deployment-level config, not
   a credential.
3. `com.atproto.server.createSession` exchanges those for a session:
   `accessJwt` (minutes-lived) + `refreshJwt` (long-lived, rotates on every
   refresh). These map onto `TokenSet.accessToken` / `TokenSet.refreshToken`.
   `refreshToken()` calls `com.atproto.server.refreshSession`.
4. The app password itself should be sealed and retained by `@social/auth` as
   a non-current bootstrap credential (`token_type = 'atproto_app_password'`)
   so a fully-expired refresh chain can be silently recovered without asking
   the user to re-enter it — see `docs/AUTH.md` for the storage shape. This
   plugin does not do that storage itself (connectors never persist tokens);
   it only produces the `TokenSet` the auth layer stores.

No client ID/secret registration is required with Bluesky for this flow —
`app.clientId`/`clientSecret` are repurposed as identifier/password carriers
per the mapping above, since the platform doesn't have a "developer app"
concept for app-password auth.

## Contract v1.1: password-grant kind (former gap, now resolved)

`AuthRequest` (`packages/core/src/connector/types.ts`) used to have only three
kinds: `'authorize_url' | 'exchange_code' | 'client_credentials'`, none of
them named for a password grant — this connector previously mapped the
password exchange onto `'client_credentials'` using `app.extra.handle` /
`app.extra.appPassword` as a workaround. Contract v1.1 added an explicit
`kind: 'password'` variant (`identifier` + `password` fields), which this
connector now uses directly.

## What's supported

| Method | Status | Notes |
|---|---|---|
| `connect` | ✅ | Verifies reachability via `com.atproto.server.describeServer`. |
| `authenticate` | ✅ (`password` kind only) | App-password → session. |
| `refreshToken` | ✅ | `com.atproto.server.refreshSession`; rotates `refreshJwt`. |
| `validatePost` | ✅ | 300-grapheme + 3000-byte text limits, media rules — pure, no network. |
| `uploadMedia` | ✅ | `com.atproto.repo.uploadBlob`. |
| `publish` | ✅ | `com.atproto.repo.createRecord`; handles images, single video, reply threads, mentions/links/hashtags as byte-indexed facets. |
| `delete` | ✅ | `com.atproto.repo.deleteRecord`. |
| `edit` | ❌ declared unsupported | AT Proto posts are immutable in the supported product surface — throws `NotSupportedError`. |
| `getAnalytics` | ✅ partial | `app.bsky.feed.getPosts` gives likes/reposts/replies/quotes; no impressions/reach/views exist in the public API. |
| `disconnect` | ✅ best-effort | `com.atproto.server.deleteSession`; returns `revoked: false` (never throws) if there's no refresh token or the call fails, since local cleanup should proceed regardless. |

## Facets: byte offsets, not character offsets

AT Proto indexes mentions/links/hashtags by **UTF-8 byte offset**
(`packages/bluesky/src/richtext.ts`). Any string containing non-ASCII text
(accents, CJK, emoji) has UTF-8 byte offsets that diverge from JS string
(UTF-16) indices — `richtext.ts` always converts through `TextEncoder` rather
than using `.slice()`/`.indexOf()` directly on offsets.

## Local dev / testing

No real credentials are used in tests — `test/connector.test.ts` mocks
`fetch` (`vi.stubGlobal('fetch', ...)`) and drives the connector against
canned XRPC responses. To test against a **real** Bluesky account manually:

```ts
const runtime = { logger: createLogger() };
const connector = new BlueskyConnector(runtime);
await connector.connect({ app: { clientId: 'unused' } });
const { token, profile } = await connector.authenticate({
  kind: 'password',
  app: { clientId: 'unused' },
  identifier: 'you.bsky.social',
  password: 'xxxx-xxxx-xxxx-xxxx',
});
```

Never commit a real handle/app password. Rotate/delete the app password from
Bluesky settings after manual testing.
