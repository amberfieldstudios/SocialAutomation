/**
 * Reddit capability descriptor.
 *
 * Every number and mapping below is sourced from Reddit's official API docs
 * (checked 2026-07-04):
 *
 *  - Submit a link/self post:  https://www.reddit.com/dev/api#POST_api_submit
 *  - Edit self-post body:      https://www.reddit.com/dev/api#POST_api_editusertext
 *  - Delete:                   https://www.reddit.com/dev/api#POST_api_del
 *  - Info (score/comments):    https://www.reddit.com/dev/api#GET_api_info
 *  - OAuth2:                   https://github.com/reddit-archive/reddit/wiki/OAuth2
 *  - Rate limits:              https://support.reddithelp.com/hc/en-us/articles/16160319875092
 *
 * See plugins/reddit/README.md for the full method-by-method mapping rationale
 * and docs/PLATFORM-RULES.md § Reddit for the content-rule detail.
 */

import type { CapabilityDescriptor } from '@social/core';

export const REDDIT_TITLE_CHARACTER_LIMIT = 300;
/** Reddit's documented selftext body cap (40,000 characters). */
export const REDDIT_BODY_CHARACTER_LIMIT = 40_000;

export const capabilities: CapabilityDescriptor = {
  platform: 'reddit',
  displayName: 'Reddit',
  apiBaseUrl: 'https://oauth.reddit.com',
  contractVersion: '1.1.0',

  operations: {
    connect: true,
    authenticate: true,
    refreshToken: true,
    validatePost: true,
    // Reddit's image/video/gallery upload flow (`/api/media/asset.json` +
    // direct-to-S3 lease, then `kind=image|video` on submit) is an internal
    // flow used by Reddit's own web/apps and is not part of the stable,
    // versioned public API reference (`/dev/api`). Per the official-API-only
    // rule, this connector does not implement it. Link posts pointing at
    // already-hosted media (an image/video URL) are the supported path for
    // attaching media to a Reddit post — see README "Media" section.
    uploadMedia: false,
    // POST /api/submit (self or link post).
    publish: true,
    // POST /api/del.
    delete: true,
    // POST /api/editusertext — self-post BODY only; Reddit has no endpoint to
    // change a post's title or convert a link post's target URL after
    // creation. See README "Edit constraints".
    edit: true,
    // GET /api/info — score / upvote_ratio / num_comments for the thing.
    getAnalytics: true,
    // OAuth2 access/refresh tokens are not revocable via a documented
    // per-token endpoint scoped to installed "script" apps in the way
    // Twitch/Discord support; Reddit's revoke_token endpoint exists for
    // confidential web apps. We support disconnect for that shape; see
    // connector.ts.
    disconnect: true,
  },

  supportsEdit: true,
  supportsDelete: true,
  // No native "publish this post later" scheduling on Reddit's API.
  supportsScheduling: false,
  // Reddit has comment trees, but PostPayload.thread (a *sequential* chain of
  // top-level posts) has no Reddit analogue — a "post" is a single submission.
  supportsThreads: false,
  supportsAnalytics: true,
  supportsMediaUpload: false,

  // Post title: 1-300 characters (POST /api/submit `title` param).
  characterLimit: REDDIT_BODY_CHARACTER_LIMIT,
  titleCharacterLimit: REDDIT_TITLE_CHARACTER_LIMIT,
  altTextCharacterLimit: undefined,
  // Reddit does not shorten/wrap URLs placed in selftext or the link field;
  // every character counts toward the relevant limit.
  urlsCountTowardLimit: true,
  countedUrlLength: undefined,
  // Reddit has no dedicated hashtag feature; '#text' in a body is literal
  // markdown, not a platform hashtag. See docs/PLATFORM-RULES.md.
  maxHashtags: 0,
  // u/username mentions in body text have no documented hard cap.
  maxMentions: undefined,

  // No supported upload path (see operations.uploadMedia); media is instead
  // attached by posting a direct link to already-hosted media.
  maxMediaCount: 0,
  supportedMediaTypes: [],
  mediaConstraints: [],
  // Inert default — uploadMedia is unsupported, so this value never governs
  // real behavior, but the descriptor shape requires it.
  mediaUploadMode: 'staged',

  maxThreadLength: undefined,

  nativeScheduleHorizonDays: undefined,
  // OAuth API: 100 queries per minute (QPM) per OAuth client per the current
  // API rules; the connector also parses live `X-Ratelimit-*` response
  // headers rather than trusting this hint alone.
  rateLimit: {
    requestsPerWindow: 100,
    windowMs: 60_000,
    scope: 'account',
  },
};
