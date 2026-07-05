# Platform Content Rules

Single authoritative record of each platform's content constraints. Both the AI-generation
stage (owner: content-ai) and each connector's `validatePost`/`capabilities.ts` (owner:
connector-engineer) must enforce the numbers recorded here, sourced from the platform's official
developer docs — never from memory or another project. If a platform changes a limit, update the
section here first, then fix generation + validation together (see
`.claude/skills/platform-content-rules`).

Format per platform: text limits, media specs, hashtag/mention norms, link handling, quirks,
doc URL + date checked.

---

## Twitch

**Doc checked:** 2026-07-04. Sources:
[Modify Channel Information](https://dev.twitch.tv/docs/api/reference/#modify-channel-information),
[Get Channel Information](https://dev.twitch.tv/docs/api/reference/#get-channel-information),
[Get Streams](https://dev.twitch.tv/docs/api/reference/#get-streams),
[Get Channel Followers](https://dev.twitch.tv/docs/api/reference/#get-channel-followers),
[Authentication](https://dev.twitch.tv/docs/authentication/),
[Rate limits](https://dev.twitch.tv/docs/api/guide/#twitch-rate-limits).

### Twitch is not a "post" network

Helix has no create/edit/delete/analytics primitive for an individual "post." The closest
analogue to publishing content is updating the channel's stream metadata (title, category,
tags), which is a **singleton resource per channel** — there's one, and updating it overwrites
the previous value. `docs/CONNECTOR-CONTRACT.md`'s method mapping for `plugins/twitch`:

| Contract method | Maps to | Why |
|---|---|---|
| `publish` / `edit` | `PATCH /helix/channels` (Modify Channel Information) | Only official write surface for channel-facing content; both converge on the same call since there's one channel-info resource, not a list of posts. |
| `delete` | **unsupported** | Channel info can only be overwritten, never removed. |
| `uploadMedia` | **unsupported** | No Helix endpoint accepts an arbitrary client-supplied media upload for channel content (clips/screenshots are derived server-side from an already-live stream, not uploaded). |
| `getAnalytics` | `GET /helix/streams` + `GET /helix/channels/followers` | Only official per-channel metrics; no historical/windowed analytics endpoint exists, so `since`/`until` are ignored (current snapshot only). |
| `authenticate` / `refreshToken` | OAuth2 Authorization Code + PKCE, Device Code (alt), Client Credentials (app-level) | Per `docs/AUTH.md` § Twitch. |
| `disconnect` | `POST /oauth2/revoke` | Official token revocation endpoint. |

### Text limits

- **Title** (`payload.title`, falls back to `payload.text` if `title` is absent): **140
  characters max**, must not be blank. This is the *only* text field Twitch accepts — there is no
  separate post body.
- No alt-text field (no media upload support).
- URLs placed in the title count toward the 140-character limit like any other character (Twitch
  does not auto-shorten or card-wrap links in the title).

### Hashtags / tags

- Twitch's "tags" are **channel tags**, not inline hashtags in a body of text.
- Max **10 tags** per channel (`maxHashtags: 10`).
- Each tag: **1–25 characters**, must start with a letter or digit, and may contain only
  letters, digits, and underscores (no spaces, no leading/trailing whitespace, no other special
  characters).
- Mentions are not a concept on Twitch channel info; `payload.mentions` is rejected if non-empty.

### Media

- **No media attachments are supported** on the channel-info "post" (`maxMediaCount: 0`,
  `supportedMediaTypes: []`). Do not generate image/video attachments for Twitch in the content
  pipeline; there is nowhere for the connector to put them.

### Threads / scheduling

- No threading concept (`supportsThreads: false`); `payload.thread` is rejected if non-empty.
- No native scheduling (`supportsScheduling: false`); `payload.scheduledAt` produces a
  **warning** (not an error) since our own scheduler still controls *when* the publish job runs —
  Twitch just can't be told in advance to change the title itself.

### Rate limits

- Helix default per-token bucket: **800 points/minute**, most GET/PATCH calls costing 1 point.
  Exceeding it returns `429` with a `Ratelimit-Reset` header (epoch seconds) — the connector
  converts this into `RateLimitError.retryAfterMs`.

### Auth quirks affecting validation/publish

- Every write requires a **user access token** scoped for the broadcaster (`channel:manage:broadcast`);
  `getAnalytics`'s follower count additionally requires `moderator:read:followers` — the connector
  degrades gracefully (omits the follower total, logs a warning) if that scope is missing rather
  than failing the whole analytics call.
- Access tokens are short-lived (~4 hours) and refresh; a `401` from Helix is treated as
  `TokenExpiredError` (refreshable), while a rejected refresh grant is `TokenRevokedError`
  (re-auth required) — see `docs/AUTH.md` § Twitch.

---

## Bluesky / AT Protocol

**Doc checked:** 2026-07-04. Sources (lexicon schemas are the authoritative source — Bluesky has
no separate "developer docs" numbers that override them):
[`app.bsky.feed.post` lexicon](https://raw.githubusercontent.com/bluesky-social/atproto/main/lexicons/app/bsky/feed/post.json),
[`app.bsky.embed.images` lexicon](https://raw.githubusercontent.com/bluesky-social/atproto/main/lexicons/app/bsky/embed/images.json),
[`app.bsky.embed.video` lexicon](https://raw.githubusercontent.com/bluesky-social/atproto/main/lexicons/app/bsky/embed/video.json),
[Creating a Post](https://docs.bsky.app/docs/advanced-guides/posts),
[Rich Text (facets)](https://docs.bsky.app/docs/advanced-guides/post-richtext),
[Rate limits](https://docs.bsky.app/docs/advanced-guides/rate-limits).

### Text limits

- **300 Unicode extended grapheme clusters max** (`text.maxGraphemes`). Count with
  `Intl.Segmenter`, never UTF-16 `.length` — a family emoji or accented character is 1 grapheme
  but multiple UTF-16 code units, so `.length` over/under-counts and produces wrong accept/reject
  decisions.
- **Also 3000 UTF-8 bytes max** (`text.maxLength`) — usually not the binding constraint for
  Latin-script text, but can bind before the grapheme cap for CJK or heavy-emoji text.
- No separate title field; a `payload.title` is dropped with a warning.
- URLs count toward the grapheme budget in full — no t.co-style auto-shortening/wrapping credit.

### Hashtags / mentions / links (facets)

- Bluesky does **not** auto-linkify plain-text `#tag`/`@handle`/URLs — a post only renders them as
  live links/mentions/tags if the record includes matching `facets`, indexed by **UTF-8 byte
  offset** (`byteStart`/`byteEnd`, end exclusive). Computing offsets with JS string `.slice()`
  desyncs the instant the text contains any non-ASCII character — always encode to UTF-8 first.
- Mention facets require the target's **DID**, resolved via `com.atproto.identity.resolveHandle`
  — a bare `@handle` with no resolvable DID still renders as text but isn't a clickable mention.
- No documented numeric cap on hashtag/mention count; the 300-grapheme budget is the practical
  limit.

### Media

- **Images:** up to 4 per post (`app.bsky.embed.images.images.maxLength: 4`), `image/*` accepted
  by the lexicon; we allow-list `png/jpeg/webp/gif` (what Bluesky clients actually render).
  Per-image size: **1,000,000 bytes** enforced (the historically-documented, universally-safe PDS
  limit; some PDSes now allow up to 2,000,000 bytes per the lexicon's comment, but we stay at the
  conservative floor so uploads never bounce on a stricter PDS).
- **Video:** exactly one per post, `video/mp4` only, **100,000,000 bytes max**
  (`app.bsky.embed.video.video.maxSize`). No duration cap at the lexicon level; we mirror the
  official app's ~3-minute client-side cap as an advisory `maxDurationMs`.
- **Images and video are mutually exclusive** in one post (one `embed` of either type, never
  both).
- **Alt text:** 1000 graphemes / 10000 bytes, shared cap across image and video alt text.

### Threads

- Replies use `reply: { root: StrongRef, parent: StrongRef }` (`StrongRef = { uri, cid }`),
  resolved from the platform, not invented client-side. No lexicon-level cap on chain length; the
  connector applies an advisory ceiling of 25 sequential posts per `publish()` call.

### Editing — unsupported

- Posts are **immutable** in the supported product surface: there is no edit endpoint, and
  `com.atproto.repo.putRecord` on an existing `feed.post` produces undefined/inconsistent
  downstream AppView behavior (already-fanned-out content silently diverging). `edit` is declared
  unsupported and throws `NotSupportedError`.

### Analytics — partial support

- `app.bsky.feed.getPosts` (public AppView) returns `likeCount`/`repostCount`/`replyCount`/
  `quoteCount` for any readable post, mapped to canonical `likes`/`shares`/`comments` (+ `quotes`
  as a platform-only extra in `raw`). **No impressions/reach/view-count data is exposed by the
  official API** — never fabricate these fields.

### Rate limits

- XRPC writes are metered by a points budget: **5,000 points/hour, 35,000 points/day** per
  account; `com.atproto.repo.createRecord` costs 3 points. The connector's `rateLimit` hint uses a
  conservative 1,500 requests/hour, comfortably under the worst-case create budget.

### Auth quirks affecting validation/publish

- **App-password session flow** (producer decision A), not standard OAuth2:
  `com.atproto.server.createSession` exchanges handle + app password for `accessJwt` (short-lived)
  + `refreshJwt` (long-lived, rotates every refresh via `com.atproto.server.refreshSession`). See
  `docs/AUTH.md` § "Bluesky / AT Protocol".
- The connector derives the account's DID (needed as `repo` on every write) by decoding the
  `sub` claim of the session JWT client-side, rather than requiring a separate profile lookup —
  see `plugins/bluesky/src/jwt.ts` for the security rationale (non-verifying decode of a token we
  already trust; the server still authorizes the underlying request).

---

## Discord

**Doc checked:** 2026-07-04. Sources:
[Message resource + embed limits](https://docs.discord.com/developers/resources/message),
[Rate limits](https://docs.discord.com/developers/topics/rate-limits),
[Message components (buttons)](https://docs.discord.com/developers/interactions/message-components),
[Webhook resource](https://docs.discord.com/developers/resources/webhook).

Implemented in `plugins/discord/src/capabilities.ts` + `plugins/discord/src/validation.ts`.

### Text limits

- Message `content`: **2000 characters** max (`characterLimit: 2000`). URLs are not shortened or
  specially weighted — every character counts (`urlsCountTowardLimit: true`).
- Embed `title`: 256 chars. Embed `description`: 4096 chars. Embed `footer.text`: 2048 chars.
  Embed `author.name`: 256 chars. Embed field `name`: 256 chars, field `value`: 1024 chars, max
  25 fields per embed.
- **Combined embed budget**: the sum of every `title` + `description` + `field.name` +
  `field.value` + `footer.text` + `author.name` character across **all** embeds attached to one
  message must be <= 6000. Max **10 embeds** per message.
- `payload.title` maps to a fallback embed title (`titleCharacterLimit: 256`) when no explicit
  `platformOptions.embeds` are given; callers wanting full embed control should pass
  `platformOptions.embeds` directly.
- Attachment `description` (Discord's alt-text equivalent): 1024 characters
  (`altTextCharacterLimit: 1024`).

### Hashtags / mentions

- Discord has **no hashtag feature**; `tags[]` render as literal, non-functional `#text`.
  `validatePost` emits a `hashtags_cosmetic_only` warning (not an error) rather than rejecting.
- `@user` / `@role` pings require the numeric **snowflake ID**, not a display name — unlike
  X/Bluesky's handle-based mentions, Discord cannot resolve `@alice` from a bare username string.
  Role/user pings are supplied via `platformOptions.roleMentionIds` / `userMentionIds`
  (auto-prefixed into `content` as `<@&id>` / `<@id>` and allow-listed via `allowed_mentions` so
  arbitrary text in `content` can never trigger an unintended ping). `validatePost` warns
  (`mention_id_not_snowflake`) if a supplied id doesn't look like a snowflake.
- `@everyone`/`@here` only actually ping if `platformOptions.everyoneMention: true` is set —
  otherwise Discord (and our `allowed_mentions.parse`) suppresses them even if present in text.

### Media

- Max **10 attachments** per message (`maxMediaCount: 10`).
- Base upload size limit: **25 MiB per file** for all apps (raised from 8 MiB in a 2024 platform
  change); boosted guilds allow more (50/100 MiB) but a generic connector call has no reliable way
  to know the target guild's boost tier, so the guaranteed floor (25 MiB) is what's declared.
- Accepted types: effectively any file type as a generic attachment (`document` with `*/*`);
  image/video/gif/audio get inline preview treatment client-side. No connector-side transcoding.

### Threads

- Discord "threads" are channel-like container objects, not a linear reply chain the way
  X/Bluesky threads are. `PostPayload.thread[]` is honored as a sequential **reply chain** (each
  entry replies to the previous, in the same channel/thread); to spawn an actual Discord thread
  object from the root message, set `platformOptions.createThread` (bot-API only — see "Contract
  gaps" in `plugins/discord/README.md` for why this isn't supported via webhooks here).
- No platform-imposed max thread/reply-chain length (`maxThreadLength` left unset).

### Scheduling

- No native scheduling endpoint for ordinary channel/webhook messages
  (`supportsScheduling: false`); our own scheduler/queue is the only scheduler in play.

### Rate limits

- Global ceiling: **50 requests/second** per bot token, app-wide.
- Per-route buckets: a single channel's/webhook's message-create route commonly allows **~5
  requests / 5 seconds** before a 429 — declared as the advisory `rateLimit` hint. The connector
  always parses live `X-RateLimit-*` / `Retry-After` response headers rather than trusting the
  static hint alone, mapping 429s to `RateLimitError` with `retryAfterMs` from the response.

### Analytics — unsupported

- The bot API exposes **no message-level analytics** (no impressions/reach/engagement endpoint
  for ordinary messages). `getAnalytics` is declared unsupported and throws `NotSupportedError`.

### Auth quirks affecting validation/publish

- Two credential shapes reach the connector via `OperationContext.token.tokenType`: `'bot'`
  (`Authorization: Bot <token>`, long-lived static secret, never refreshes) and `'webhook'` (the
  full webhook URL doubles as the secret; also never refreshes). A third, `'Bearer'` (OAuth2 user
  token), DOES support `refreshToken`/`disconnect`(revoke) — see `plugins/discord/README.md`
  "Contract gaps" #2 for why `refreshToken`/`disconnect` behavior varies by credential shape even
  though the capability descriptor can only declare support once per platform.
- Link handling: Discord auto-unfurls (embeds) plain links client-side automatically; the only
  connector-level control is `platformOptions.suppressEmbeds` (sets the `SUPPRESS_EMBEDS` flag).

---

## Reddit

**Doc checked:** 2026-07-04. Sources:
[API rules / User-Agent requirement](https://github.com/reddit-archive/reddit/wiki/API),
[`POST /api/submit`](https://www.reddit.com/dev/api#POST_api_submit),
[`POST /api/editusertext`](https://www.reddit.com/dev/api#POST_api_editusertext),
[`POST /api/del`](https://www.reddit.com/dev/api#POST_api_del),
[`GET /api/info`](https://www.reddit.com/dev/api#GET_api_info),
[OAuth2 (grants + revocation)](https://github.com/reddit-archive/reddit/wiki/OAuth2),
[API rate limits](https://support.reddithelp.com/hc/en-us/articles/16160319875092).

Implemented in `plugins/reddit/src/capabilities.ts` + `plugins/reddit/src/connector.ts`.

### Text limits

- **Title** (`payload.title`): **300 characters max**, required, no separate body field for
  title. Reddit does not shorten/wrap URLs placed in the title — every character counts.
- **Self-post body** (`payload.text`): **40,000 characters max** (Reddit's documented selftext
  cap). Markdown, not counted against the title limit.
- No alt-text field (no supported media-upload path — see "Media").
- A post is **either** a self (text) post **or** a link post, never both:
  `payload.text` and `payload.link` are mutually exclusive; setting both is a validation error
  (`self_and_link_mutually_exclusive`).

### Hashtags / mentions

- Reddit has **no hashtag feature** (`maxHashtags: 0`); `tags[]` would render as literal
  `#text` markdown in the body, not a platform tag. `validatePost` emits a
  `hashtags_cosmetic_only` **warning**, not an error.
- `u/username` mentions in body text are plain markdown with no documented hard cap
  (`maxMentions: undefined`); the connector does not auto-format `mentions[]` into the body.

### Media — no supported upload path

- Reddit's image/video/gallery submission flow (`POST /api/media/asset.json` lease +
  direct-to-S3 upload + `kind=image|video|gallery` on submit) is the flow Reddit's own apps use
  but is **not part of the stable public `/dev/api` reference** — per the official-API-only rule,
  this connector does not implement it. `uploadMedia` is declared unsupported
  (`operations.uploadMedia: false`, `maxMediaCount: 0`) and `payload.media[]` is rejected by
  `validatePost` (`media_not_supported`).
- The supported path for media is a **link post**: set `payload.link` to an already-hosted
  media URL; Reddit still renders an inline preview client-side for recognized hosts.

### Threads / scheduling

- No sequential post-thread concept (`supportsThreads: false`); `payload.thread` is rejected if
  non-empty. (Reddit *does* have comment trees, but that's a different, unmodeled concept from
  the contract's `PostPayload.thread` sequential-post chain.)
- No native post-scheduling API (`supportsScheduling: false`); `payload.scheduledAt` produces a
  **warning**, not an error.

### Editing — self-post BODY only

- `POST /api/editusertext` can only rewrite a self post's body text. There is **no** endpoint to
  change a post's title (any kind) or a link post's target URL after creation. `edit()` requires
  `request.payload.text`; a supplied `payload.title` is logged as ignored
  (`reddit.edit.title_ignored`), not silently dropped or treated as a hard failure.

### Analytics

- `GET /api/info?id=<fullname>` returns `score` (net upvotes, mapped to canonical `likes` as the
  closest available proxy — **not** a raw like count), `num_comments` (mapped to canonical
  `comments`), and `upvote_ratio` (platform-only extra in `raw.upvoteRatio`). **No
  impressions/reach/view-count data is exposed by the official API** — never fabricate it.

### Rate limits

- OAuth API: **100 queries per minute (QPM)** per OAuth client. The connector also parses live
  `X-Ratelimit-Reset` response headers on a `429` rather than trusting the static hint alone.

### Auth quirks affecting validation/publish

- **User-Agent is REQUIRED** on every request (`AppCredentials.extra.userAgent`), in the form
  `<platform>:<app ID>:<version> (by /u/<username>)` — Reddit throttles/blocks generic or missing
  User-Agents. The connector throws `AuthError` up front if it's absent, before any network call.
- Two OAuth2 shapes reach `authenticate`: **`password`** grant (Contract v1.1's first-class
  `AuthRequest.kind: 'password'`) for "script" app types tied to a single bot/automation account,
  and **`authorization_code`** (`authorize_url` + `exchange_code`) for "web app" types serving
  multiple users. `client_credentials` yields an app-only, **read-only** token that can
  `getAnalytics`/`connect` but not `publish`/`edit`/`delete` — this is a token-scope constraint
  surfaced by Reddit's API itself (a `403`), not something `validatePost` can detect locally.
- Access tokens expire in ~1 hour; `authorize_url` always requests `duration=permanent` so a
  refresh token is issued (Reddit otherwise defaults to `temporary`, no refresh token).

---

## Mastodon

**Doc checked:** 2026-07-04. Sources:
[Statuses API](https://docs.joinmastodon.org/methods/statuses/),
[Media API](https://docs.joinmastodon.org/methods/media/),
[Instance entity (configuration defaults)](https://docs.joinmastodon.org/entities/Instance/),
[OAuth methods](https://docs.joinmastodon.org/methods/oauth/),
[Rate limits](https://docs.joinmastodon.org/api/rate-limits/).

Implemented in `plugins/mastodon/src/capabilities.ts` + `plugins/mastodon/src/validate.ts`.

### No single API host — per-instance limits are advisory defaults

Mastodon is federated: every account lives on its own instance, and each instance's admin can
reconfigure `configuration.statuses`/`configuration.media_attachments` (exposed live via
`GET /api/v2/instance`) away from the stock defaults below. Because `validatePost` is pure/no-
network per the contract, this connector enforces the **documented stock defaults** as a floor —
see `plugins/mastodon/README.md` § "Known limitations" for what that means in practice (a more
permissive instance will reject content local validation allowed; being conservative, we never
silently allow content a stricter instance would reject on the numbers below).

### Text limits

- Status text: **500 characters** max (`characterLimit: 500`, `configuration.statuses.max_characters`
  documented default).
- URLs count toward the limit, but every URL — regardless of its real length — is counted as a
  **fixed 23 characters** (`countedUrlLength: 23`, `configuration.statuses.characters_reserved_per_url`
  documented default), matching Mastodon's own server-side counter. `validate.ts`'s
  `countedLength()` implements this substitution rather than raw `.length`.
  Content-warning/spoiler text (`platformOptions.spoilerText`) shares the same 500-char budget.
- No separate title field; `payload.title` is ignored with a warning (statuses have no headline).
- Media `description` (alt text): practical cap of **1500 characters** (matches the official web
  UI's textarea limit; no separate documented API-level number was found).

### Hashtags / mentions

- No hard cap distinct from the character limit — `#tag` and `@user@instance` are auto-linkified
  from plain text server-side (no structured facet/offset mechanism like AT Proto). `tags[]` /
  `mentions[]` from `PostPayload` are appended as trailing `#tag`/`@mention` tokens if not already
  present verbatim in `text` (see `assembleText()` in `connector.ts`).

### Media

- Max **4 attachments** per status (`maxMediaCount: 4`, `configuration.statuses.max_media_attachments`
  documented default) — **except** video/audio, which is exactly **one** attachment, never combined
  with other media (mirrors the official web UI's upload picker behavior).
- Image size limit: **16,777,216 bytes** (16 MiB); accepted MIME types include
  `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `image/heic`, `image/heif`, `image/avif`.
- Video/audio size limit: **103,809,024 bytes** (~99 MiB); video frame-rate limit **120 fps**
  (`configuration.media_attachments.video_frame_rate_limit`).
- `mediaUploadMode: 'staged'` — `POST /api/v2/media` returns a durable attachment `id` a later
  `publish`/`edit` call references via `media_ids[]`. Large video/GIF uploads return HTTP `202`
  with `url: null` while the instance transcodes in the background (`GET /api/v1/media/:id` polls
  for completion, returning `206` while still processing) — this connector does **not** poll to
  completion (see `plugins/mastodon/README.md` § "Known limitations").

### Threads / scheduling

- No sequential-thread primitive; `payload.thread[]` is honored as a sequential **reply chain**
  (each entry's `in_reply_to_id` points at the previous status), same modeling as
  `plugins/bluesky`. Advisory cap `maxThreadLength: 25`.
- Native scheduling **is** supported (`supportsScheduling: true`) via `scheduled_at` on
  `POST /api/v1/statuses` — but Mastodon requires it to be **at least 5 minutes in the future**;
  `validatePost` rejects a closer `scheduledAt` as an error (`scheduled_at_too_soon`), and rejects
  a value that fails `Date.parse` (`invalid_scheduled_at`). Only the first status in a thread
  carries `scheduled_at` — Mastodon has no concept of scheduling a whole reply chain.

### Editing / deleting

- `PUT /api/v1/statuses/:id` (edit) and `DELETE /api/v1/statuses/:id` (delete) are both
  first-class, official endpoints — unlike Bluesky, Mastodon posts are natively mutable.

### Analytics

- `GET /api/v1/statuses/:id` returns `favourites_count`/`reblogs_count`/`replies_count`, mapped to
  canonical `likes`/`shares`/`comments`. A best-effort `GET /api/v1/accounts/verify_credentials`
  call adds `followersCount` (a platform-only extra key — **not** canonical `followersDelta`,
  since this is an absolute count and no delta-tracking endpoint exists). **No
  impressions/reach/view/click/save data is exposed by the official API** — never fabricate it.

### Rate limits

- Documented default: **300 requests / 5 minutes** per access token
  (`rateLimit: { requestsPerWindow: 300, windowMs: 300_000 }`); individual instances may configure
  their own bucket, so the connector always honors a live `429`/`Retry-After` over this hint.

### Auth quirks affecting validation/publish

- OAuth2 **authorization-code** grant, registered **per instance** (`POST /api/v1/apps`, done
  once out-of-band, not by this connector) — the instance base URL travels as
  `AppCredentials.extra.instanceUrl` since `AppCredentials` has no first-class host field (mirrors
  `plugins/bluesky`'s `serviceUrl` convention). `client_credentials` is also supported (app-level,
  rarely used by this system). Mastodon has **no password/direct-credential grant** for
  third-party apps — `AuthRequest.kind: 'password'` throws `AuthError`.
- Tokens issued by instances running Mastodon 4.3+ can carry an `expires_in`/`refresh_token` pair
  (`grant_type=refresh_token` on `/oauth/token`); older/most current tokens are **non-expiring
  with no refresh token** — `refreshToken()` throws `AuthError` in that case rather than silently
  failing, and a `401` from any call is treated as `TokenExpiredError` so the auth layer knows to
  re-run the OAuth flow instead of looping on refresh.
