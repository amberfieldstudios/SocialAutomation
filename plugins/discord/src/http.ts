/**
 * Minimal Discord REST client (bot API + webhooks). Uses Node's built-in
 * global `fetch` (undici) — no third-party HTTP SDK, no scraping, every call
 * targets `https://discord.com/api/v10` or a caller-supplied webhook URL,
 * both documented official endpoints.
 *
 * Maps Discord's documented error shapes onto the shared typed errors so the
 * queue's backoff behaves correctly:
 *  - 429 (rate limited)              -> RateLimitError, retryAfterMs from body/header
 *  - 401 (invalid/revoked token)     -> TokenRevokedError
 *  - 404                             -> ConnectorError code 'not_found'
 *  - 5xx / network failure           -> TransientError
 *  - other 4xx                       -> AuthError/ConnectorError (non-retryable)
 *
 * SECURITY: `Authorization` header values and full webhook URLs (which embed a
 * secret token) are NEVER logged. Only a redacted shape is logged.
 */

import type { StructuredLogger } from '@social/core';
import { ConnectorError, RateLimitError, TokenRevokedError, TransientError } from '@social/core';
import type { DiscordApiErrorBody } from './types';

export const DISCORD_API_BASE = 'https://discord.com/api/v10';

export interface DiscordCredential {
  /** 'bot' | 'webhook' | 'oauth' */
  kind: 'bot' | 'webhook' | 'oauth';
  /** Bot token, OAuth access token, or full webhook URL depending on `kind`. */
  value: string;
}

export interface DiscordRequestFile {
  name: string;
  filename: string;
  contentType: string;
  data: Uint8Array;
}

export interface DiscordRequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Path relative to DISCORD_API_BASE, e.g. '/channels/123/messages'. Ignored for webhook calls (use `webhookUrl`). */
  path?: string;
  /** Full webhook URL to call directly instead of `DISCORD_API_BASE + path`. */
  webhookUrl?: string;
  /** Query string appended as-is, e.g. '?wait=true'. */
  query?: string;
  body?: Record<string, unknown>;
  /** Sent as application/x-www-form-urlencoded instead of JSON (Discord's OAuth2 token endpoint requires this). */
  form?: Record<string, string>;
  files?: DiscordRequestFile[];
  credential?: DiscordCredential;
  /** Extra/override headers, e.g. a Basic-auth Authorization header for client_credentials. Never logged. */
  headers?: Record<string, string>;
  logger: StructuredLogger;
  operation: string;
}

/** Redacted view of a request, safe to log. */
function redactedTarget(opts: DiscordRequestOptions): string {
  if (opts.webhookUrl) {
    // Webhook URLs embed a secret token as the last path segment — keep only the id.
    const parts = opts.webhookUrl.split('/');
    const id = parts[parts.length - 2] ?? 'unknown';
    return `webhook:${id}/***`;
  }
  return `${opts.method} ${opts.path ?? ''}`;
}

function authHeader(credential?: DiscordCredential): string | undefined {
  if (!credential) return undefined;
  if (credential.kind === 'bot') return `Bot ${credential.value}`;
  if (credential.kind === 'oauth') return `Bearer ${credential.value}`;
  return undefined; // webhook auth is embedded in the URL itself
}

export class DiscordHttpClient {
  async request<T>(opts: DiscordRequestOptions): Promise<T> {
    const url = opts.webhookUrl
      ? `${opts.webhookUrl}${opts.query ?? ''}`
      : `${DISCORD_API_BASE}${opts.path ?? ''}${opts.query ?? ''}`;

    const headers: Record<string, string> = {};
    const auth = authHeader(opts.credential);
    if (auth) headers.Authorization = auth;
    if (opts.headers) Object.assign(headers, opts.headers);

    let bodyInit: string | FormData | undefined;
    if (opts.files && opts.files.length > 0) {
      const form = new FormData();
      if (opts.body) {
        form.set('payload_json', JSON.stringify(opts.body));
      }
      opts.files.forEach((file, index) => {
        form.set(file.name ?? `files[${index}]`, new Blob([file.data], { type: file.contentType }), file.filename);
      });
      bodyInit = form;
    } else if (opts.form !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      bodyInit = new URLSearchParams(opts.form).toString();
    } else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      bodyInit = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      res = await fetch(url, { method: opts.method, headers, body: bodyInit });
    } catch (cause) {
      opts.logger.warn('discord.http_network_error', { operation: opts.operation, target: redactedTarget(opts) });
      throw new TransientError('Network error calling the Discord API.', {
        platform: 'discord',
        cause,
      });
    }

    if (res.status === 429) {
      const retryAfterHeader = res.headers.get('retry-after');
      let retryAfterMs = retryAfterHeader ? Math.ceil(Number(retryAfterHeader) * 1000) : undefined;
      const parsed = await safeJson<{ retry_after?: number }>(res);
      if (parsed?.retry_after !== undefined) retryAfterMs = Math.ceil(parsed.retry_after * 1000);
      opts.logger.warn('discord.rate_limited', {
        operation: opts.operation,
        target: redactedTarget(opts),
        retryAfterMs,
      });
      throw new RateLimitError('Discord rate limit exceeded.', {
        platform: 'discord',
        retryAfterMs,
      });
    }

    if (res.status === 401) {
      opts.logger.warn('discord.unauthorized', { operation: opts.operation, target: redactedTarget(opts) });
      throw new TokenRevokedError('Discord rejected the credential as invalid or revoked.', { platform: 'discord' });
    }

    if (res.status === 404) {
      const body = await safeJson<DiscordApiErrorBody>(res);
      throw new ConnectorError('not_found', body?.message ?? 'Discord resource not found.', { platform: 'discord' });
    }

    if (res.status >= 500) {
      opts.logger.warn('discord.server_error', {
        operation: opts.operation,
        target: redactedTarget(opts),
        status: res.status,
      });
      throw new TransientError(`Discord API returned ${res.status}.`, { platform: 'discord' });
    }

    if (!res.ok) {
      const body = await safeJson<DiscordApiErrorBody>(res);
      opts.logger.warn('discord.request_failed', {
        operation: opts.operation,
        target: redactedTarget(opts),
        status: res.status,
        code: body?.code,
      });
      throw new ConnectorError('unknown', body?.message ?? `Discord API returned ${res.status}.`, {
        platform: 'discord',
        details: { status: res.status, code: body?.code },
      });
    }

    opts.logger.info('discord.request_succeeded', {
      operation: opts.operation,
      target: redactedTarget(opts),
      status: res.status,
    });

    if (res.status === 204) return undefined as T;
    return (await safeJson<T>(res)) as T;
  }
}

async function safeJson<T>(res: Response): Promise<T | undefined> {
  try {
    const text = await res.text();
    if (!text) return undefined;
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
