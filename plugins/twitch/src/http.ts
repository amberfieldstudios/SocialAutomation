/**
 * Minimal Helix/OAuth HTTP helpers shared by the connector.
 *
 * Every function here targets a documented Twitch endpoint (id.twitch.tv or
 * api.twitch.tv/helix) via the platform-global `fetch`. No scraping, no
 * undocumented endpoints. Callers pass already-decrypted tokens; nothing here
 * persists or logs a raw token — only status codes and non-secret metadata are
 * logged by the connector.
 */

import type { StructuredLogger } from '@social/core';
import { RateLimitError, TokenExpiredError, TransientError } from '@social/core';

export const HELIX_BASE_URL = 'https://api.twitch.tv/helix';
export const OAUTH_BASE_URL = 'https://id.twitch.tv/oauth2';

export interface HelixRequestOptions {
  method?: string;
  path: string;
  clientId: string;
  accessToken: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  logger: StructuredLogger;
  operation: string;
}

function buildUrl(base: string, path: string, query?: Record<string, string | number | undefined>): string {
  const url = new URL(path, base.endsWith('/') ? base : `${base}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

/** Parses a `Ratelimit-Reset` header (epoch seconds) into a retry-after ms hint. */
function retryAfterMsFromHeaders(headers: Headers): number | undefined {
  const reset = headers.get('Ratelimit-Reset') ?? headers.get('ratelimit-reset');
  if (!reset) return undefined;
  const resetEpochSeconds = Number(reset);
  if (!Number.isFinite(resetEpochSeconds)) return undefined;
  const ms = resetEpochSeconds * 1000 - Date.now();
  return ms > 0 ? ms : 0;
}

/**
 * Calls a Helix endpoint with the caller's user/app access token. Maps
 * transport/HTTP failures onto the shared typed connector errors so the queue
 * can branch on `retryable` without inspecting raw responses.
 */
export async function helixRequest<T>(options: HelixRequestOptions): Promise<T | undefined> {
  const { method = 'GET', path, clientId, accessToken, query, body, logger, operation } = options;
  const url = buildUrl(HELIX_BASE_URL, path, query);

  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        'Client-Id': clientId,
        Authorization: `Bearer ${accessToken}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (cause) {
    logger.error('twitch.helix.request_failed', { operation, path, durationMs: Date.now() - started });
    throw new TransientError('Network error calling Twitch Helix API.', {
      platform: 'twitch',
      cause,
      details: { path },
    });
  }

  logger.info('twitch.helix.response', {
    operation,
    path,
    status: response.status,
    durationMs: Date.now() - started,
  });

  if (response.status === 429) {
    throw new RateLimitError('Twitch Helix rate limit exceeded.', {
      platform: 'twitch',
      retryAfterMs: retryAfterMsFromHeaders(response.headers),
      details: { path, status: response.status },
    });
  }

  if (response.status === 401) {
    // Per docs/AUTH.md: a Helix 401 is treated as an expired (refreshable)
    // token unless the refresh grant itself is rejected (handled separately
    // in refreshToken).
    throw new TokenExpiredError('Twitch rejected the access token (401).', {
      platform: 'twitch',
      details: { path, status: response.status },
    });
  }

  if (response.status >= 500) {
    throw new TransientError(`Twitch Helix returned ${response.status}.`, {
      platform: 'twitch',
      details: { path, status: response.status },
    });
  }

  if (!response.ok) {
    const text = await safeText(response);
    throw new TransientError(`Twitch Helix request failed with status ${response.status}.`, {
      platform: 'twitch',
      retryable: false,
      details: { path, status: response.status, body: text },
    });
  }

  if (response.status === 204) {
    return undefined;
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
  scope?: string[];
  token_type?: string;
}

export interface OAuthValidateResponse {
  client_id: string;
  login?: string;
  user_id?: string;
  scopes?: string[];
  expires_in?: number;
}
