/**
 * Minimal Mastodon REST HTTP client — official, documented endpoints only
 * (`/api/v1/*`, `/api/v2/*` on the account's OWN instance, per
 * https://docs.joinmastodon.org/api/). No scraping, no undocumented routes,
 * no browser automation. Deliberately dependency-free (Node global `fetch`).
 *
 * The instance base URL is per-account (`AppCredentials.extra.instanceUrl`),
 * unlike single-host platforms — every call targets `${instanceUrl}/api/...`.
 *
 * Every method maps transport failures onto the shared `ConnectorError`
 * hierarchy so the queue's retry/backoff logic works uniformly:
 *   - HTTP 429                       -> RateLimitError (retryable, honors Retry-After)
 *   - HTTP 5xx / network failure     -> TransientError (retryable)
 *   - HTTP 401                       -> TokenExpiredError (Mastodon has no documented
 *                                        distinct "expired vs revoked" error code, so we
 *                                        treat 401 as recoverable-by-reauth; see connector.ts)
 *   - other HTTP 4xx                 -> AuthError / generic ConnectorError
 *
 * SECURITY: never log `Authorization` header values or raw tokens. This client
 * only logs the HTTP method, path, and status/duration.
 */

import { ConnectorError, RateLimitError, TokenExpiredError, TransientError, type StructuredLogger } from '@social/core';

export interface MastodonClientOptions {
  instanceUrl: string;
  logger: StructuredLogger;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface MastodonCallOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path beginning with '/api/...'. */
  path: string;
  /** Bearer token; omitted for the unauthenticated app-registration endpoint. */
  token?: string;
  query?: Record<string, string | string[] | undefined>;
  jsonBody?: unknown;
  /** Multipart form fields for media upload. Mutually exclusive with jsonBody. */
  formBody?: FormData;
}

export class MastodonClient {
  private readonly instanceUrl: string;
  private readonly logger: StructuredLogger;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MastodonClientOptions) {
    this.instanceUrl = options.instanceUrl.replace(/\/+$/, '');
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async call<T>(options: MastodonCallOptions): Promise<{ status: number; body: T }> {
    const url = new URL(`${this.instanceUrl}${options.path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const v of value) url.searchParams.append(key, v);
      } else {
        url.searchParams.set(key, value);
      }
    }

    const headers: Record<string, string> = {};
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    let body: string | FormData | undefined;
    if (options.formBody) {
      body = options.formBody;
    } else if (options.jsonBody !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.jsonBody);
    }

    const startedAt = Date.now();
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: options.method, headers, body });
    } catch (cause) {
      this.logger.warn('mastodon.http.network_error', { path: options.path, durationMs: Date.now() - startedAt });
      throw new TransientError(`Network error calling ${options.path}`, {
        platform: 'mastodon',
        cause,
        retryable: true,
      });
    }

    const durationMs = Date.now() - startedAt;

    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('retry-after') ?? response.headers.get('x-ratelimit-reset');
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
      this.logger.warn('mastodon.http.rate_limited', { path: options.path, durationMs, retryAfterMs });
      throw new RateLimitError(`Mastodon rate limit hit calling ${options.path}`, {
        platform: 'mastodon',
        retryAfterMs: retryAfterMs && Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
      });
    }

    if (response.status >= 500) {
      this.logger.warn('mastodon.http.server_error', { path: options.path, status: response.status, durationMs });
      throw new TransientError(`Mastodon server error (${response.status}) calling ${options.path}`, {
        platform: 'mastodon',
      });
    }

    if (response.status === 401) {
      const errorBody = await this.safeJson<{ error?: string }>(response);
      this.logger.warn('mastodon.http.unauthorized', { path: options.path, durationMs });
      throw new TokenExpiredError(errorBody?.error ?? 'Mastodon access token is no longer valid.', { platform: 'mastodon' });
    }

    if (!response.ok && response.status !== 206) {
      const errorBody = await this.safeJson<{ error?: string; error_description?: string }>(response);
      this.logger.warn('mastodon.http.error', { path: options.path, status: response.status, durationMs });
      throw new ConnectorError(
        'unknown',
        `Mastodon API call ${options.path} failed (${response.status} ${errorBody?.error ?? errorBody?.error_description ?? ''}).`,
        { platform: 'mastodon', retryable: false, details: { status: response.status } },
      );
    }

    this.logger.debug('mastodon.http.ok', { path: options.path, status: response.status, durationMs });
    const parsed = (await this.safeJson<T>(response)) as T;
    return { status: response.status, body: parsed };
  }

  private async safeJson<T>(response: Response): Promise<T | undefined> {
    try {
      return (await response.json()) as T;
    } catch {
      return undefined;
    }
  }
}
