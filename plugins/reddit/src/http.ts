/**
 * Minimal OAuth2 + REST helpers shared by the connector. Every function here
 * targets a documented Reddit endpoint (`www.reddit.com/api/v1/access_token`
 * for OAuth, `oauth.reddit.com/api/*` for authenticated API calls) via the
 * platform-global `fetch`. No scraping, no undocumented endpoints. Callers
 * pass already-decrypted tokens; nothing here persists or logs a raw token —
 * only status codes and non-secret metadata are logged by the connector.
 *
 * Reddit's API rules REQUIRE a descriptive User-Agent
 * (https://github.com/reddit-archive/reddit/wiki/API) on every request, in the
 * form `<platform>:<app id>:<version> (by /u/<username>)`. The caller supplies
 * it via `AppCredentials.extra.userAgent`; requests without one are routinely
 * throttled/blocked by Reddit, so this connector treats it as required rather
 * than falling back to a generic default.
 */

import type { StructuredLogger } from '@social/core';
import { AuthError, RateLimitError, TokenExpiredError, TransientError } from '@social/core';

export const OAUTH_API_BASE_URL = 'https://oauth.reddit.com';
export const TOKEN_BASE_URL = 'https://www.reddit.com';
export const WWW_BASE_URL = 'https://www.reddit.com';

export function requireUserAgent(userAgent: string | undefined): string {
  if (!userAgent || userAgent.trim().length === 0) {
    throw new AuthError(
      'Reddit requires a descriptive User-Agent (AppCredentials.extra.userAgent), e.g. ' +
        '"web:com.example.myapp:1.0.0 (by /u/my_username)".',
      { platform: 'reddit' },
    );
  }
  return userAgent;
}

/** Parses Reddit's `X-Ratelimit-Reset` header (seconds until reset) into a ms hint. */
function retryAfterMsFromHeaders(headers: Headers): number | undefined {
  const resetSeconds = headers.get('X-Ratelimit-Reset') ?? headers.get('x-ratelimit-reset');
  if (!resetSeconds) return undefined;
  const seconds = Number(resetSeconds);
  if (!Number.isFinite(seconds)) return undefined;
  return Math.max(0, seconds * 1000);
}

export interface RedditRequestOptions {
  method?: string;
  /** Path under oauth.reddit.com, e.g. 'api/submit'. */
  path: string;
  accessToken: string;
  userAgent: string;
  /** Sent as an application/x-www-form-urlencoded body (Reddit's API convention). */
  form?: Record<string, string | number | boolean | undefined>;
  query?: Record<string, string | number | undefined>;
  logger: StructuredLogger;
  operation: string;
}

function buildUrl(base: string, path: string, query?: Record<string, string | number | undefined>): string {
  const url = new URL(path, base.endsWith('/') ? base : `${base}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/**
 * Calls an authenticated `oauth.reddit.com/api/*` endpoint. Maps
 * transport/HTTP failures onto the shared typed connector errors so the queue
 * can branch on `retryable` without inspecting raw responses.
 */
export async function redditRequest<T>(options: RedditRequestOptions): Promise<T | undefined> {
  const { method = 'GET', path, accessToken, userAgent, form, query, logger, operation } = options;
  const url = buildUrl(OAUTH_API_BASE_URL, path, query);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': userAgent,
  };
  let body: string | undefined;
  if (form) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) {
      if (value !== undefined) params.set(key, String(value));
    }
    body = params.toString();
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(url, { method, headers, body });
  } catch (cause) {
    logger.error('reddit.api.request_failed', { operation, path, durationMs: Date.now() - started });
    throw new TransientError('Network error calling Reddit API.', { platform: 'reddit', cause, details: { path } });
  }

  logger.info('reddit.api.response', {
    operation,
    path,
    status: response.status,
    durationMs: Date.now() - started,
  });

  if (response.status === 429) {
    throw new RateLimitError('Reddit API rate limit exceeded.', {
      platform: 'reddit',
      retryAfterMs: retryAfterMsFromHeaders(response.headers),
      details: { path, status: response.status },
    });
  }

  if (response.status === 401) {
    throw new TokenExpiredError('Reddit rejected the access token (401).', {
      platform: 'reddit',
      details: { path, status: response.status },
    });
  }

  if (response.status >= 500) {
    throw new TransientError(`Reddit API returned ${response.status}.`, {
      platform: 'reddit',
      details: { path, status: response.status },
    });
  }

  if (!response.ok) {
    const text = await safeText(response);
    throw new TransientError(`Reddit API request failed with status ${response.status}.`, {
      platform: 'reddit',
      retryable: false,
      details: { path, status: response.status, body: text },
    });
  }

  const text = await safeText(response);
  if (!text) return undefined;
  return JSON.parse(text) as T;
}

async function safeText(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
}
