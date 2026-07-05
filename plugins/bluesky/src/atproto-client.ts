/**
 * Minimal AT Protocol XRPC HTTP client — official, documented endpoints only
 * (`com.atproto.*`, `app.bsky.*` over the platform's XRPC transport, per
 * https://atproto.com/specs/xrpc). No scraping, no undocumented routes, no
 * browser automation. Deliberately dependency-free (uses the Node 22 global
 * `fetch`) so the plugin adds zero new supply-chain surface; `@atproto/api`
 * remains a drop-in alternative if the team later wants the official SDK.
 *
 * Every method maps transport failures onto the shared `ConnectorError`
 * hierarchy so the queue's retry/backoff logic works uniformly across
 * platforms:
 *   - HTTP 429                              -> RateLimitError (retryable)
 *   - HTTP 5xx / network failure             -> TransientError (retryable)
 *   - HTTP 401 with an expired-token error   -> TokenExpiredError (retryable)
 *   - HTTP 400/401 with a revoked/bad token  -> TokenRevokedError
 *   - other HTTP 4xx                         -> AuthError / generic ConnectorError
 *
 * SECURITY: never log `Authorization` header values or JWTs. Callers pass a
 * bearer token per call; this client only logs the XRPC method name, HTTP
 * status, and duration.
 */

import {
  ConnectorError,
  RateLimitError,
  TokenExpiredError,
  TokenRevokedError,
  TransientError,
  type StructuredLogger,
} from '@social/core';

export interface XrpcErrorBody {
  error?: string;
  message?: string;
}

export interface XrpcClientOptions {
  serviceUrl: string;
  logger: StructuredLogger;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface XrpcCallOptions {
  method: 'GET' | 'POST';
  /** NSID, e.g. 'com.atproto.server.createSession'. */
  nsid: string;
  /** Bearer token for the call; omitted for public/unauthenticated endpoints. */
  token?: string;
  query?: Record<string, string | string[] | undefined>;
  /** JSON body for POST calls. Mutually exclusive with `binaryBody`. */
  jsonBody?: unknown;
  /** Raw bytes + content type for `com.atproto.repo.uploadBlob`-style calls. */
  binaryBody?: { bytes: Uint8Array; mimeType: string };
}

const KNOWN_EXPIRED_ERRORS = new Set(['ExpiredToken']);
const KNOWN_REVOKED_ERRORS = new Set(['InvalidToken', 'AuthMissing', 'AccountTakedown', 'AuthenticationRequired']);

export class XrpcClient {
  private readonly serviceUrl: string;
  private readonly logger: StructuredLogger;
  private readonly fetchImpl: typeof fetch;

  constructor(options: XrpcClientOptions) {
    this.serviceUrl = options.serviceUrl.replace(/\/+$/, '');
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async call<T>(options: XrpcCallOptions): Promise<T> {
    const url = new URL(`${this.serviceUrl}/xrpc/${options.nsid}`);
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
    let body: Uint8Array | string | undefined;
    if (options.binaryBody) {
      headers['Content-Type'] = options.binaryBody.mimeType;
      body = options.binaryBody.bytes;
    } else if (options.jsonBody !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.jsonBody);
    }

    const startedAt = Date.now();
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: options.method, headers, body });
    } catch (cause) {
      this.logger.warn('bluesky.xrpc.network_error', { nsid: options.nsid, durationMs: Date.now() - startedAt });
      throw new TransientError(`Network error calling ${options.nsid}`, {
        platform: 'bluesky',
        cause,
        retryable: true,
      });
    }

    const durationMs = Date.now() - startedAt;

    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
      this.logger.warn('bluesky.xrpc.rate_limited', { nsid: options.nsid, durationMs, retryAfterMs });
      throw new RateLimitError(`Bluesky rate limit hit calling ${options.nsid}`, {
        platform: 'bluesky',
        retryAfterMs,
      });
    }

    if (response.status >= 500) {
      this.logger.warn('bluesky.xrpc.server_error', { nsid: options.nsid, status: response.status, durationMs });
      throw new TransientError(`Bluesky server error (${response.status}) calling ${options.nsid}`, {
        platform: 'bluesky',
      });
    }

    if (!response.ok) {
      const errorBody = await this.safeJson<XrpcErrorBody>(response);
      const code = errorBody?.error ?? 'unknown';
      this.logger.warn('bluesky.xrpc.error', { nsid: options.nsid, status: response.status, durationMs, code });

      if (response.status === 401 && KNOWN_EXPIRED_ERRORS.has(code)) {
        throw new TokenExpiredError(errorBody?.message ?? 'Bluesky access token expired.', { platform: 'bluesky' });
      }
      if ((response.status === 401 || response.status === 400) && KNOWN_REVOKED_ERRORS.has(code)) {
        throw new TokenRevokedError(errorBody?.message ?? 'Bluesky session is no longer valid.', { platform: 'bluesky' });
      }
      throw new ConnectorError('unknown', `Bluesky XRPC call ${options.nsid} failed (${response.status} ${code}).`, {
        platform: 'bluesky',
        retryable: false,
        details: { status: response.status, code },
      });
    }

    this.logger.debug('bluesky.xrpc.ok', { nsid: options.nsid, status: response.status, durationMs });
    return (await response.json()) as T;
  }

  private async safeJson<T>(response: Response): Promise<T | undefined> {
    try {
      return (await response.json()) as T;
    } catch {
      return undefined;
    }
  }
}
