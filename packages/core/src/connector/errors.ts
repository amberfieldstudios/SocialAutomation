/**
 * Typed connector errors.
 *
 * Conventions the whole team relies on:
 *  - Unsupported operations throw `NotSupportedError` (never a silent no-op),
 *    AND are declared `false` in the capability descriptor.
 *  - Rate-limit / transient failures throw errors whose `retryable` is `true`
 *    (with optional `retryAfterMs`) so the queue's backoff can act on them.
 *  - Auth failures distinguish expired (refreshable) from revoked (re-auth).
 */

import type { CapabilityDescriptor } from './capabilities';
import type { ConnectorOperation, ValidationResult } from './types';

export type ConnectorErrorCode =
  | 'not_supported'
  | 'auth_failed'
  | 'token_expired'
  | 'token_revoked'
  | 'rate_limited'
  | 'validation_failed'
  | 'media_rejected'
  | 'publish_failed'
  | 'not_found'
  | 'transient'
  | 'unknown';

export interface ConnectorErrorOptions {
  platform?: string;
  operation?: ConnectorOperation;
  /** True if the queue may retry the same call later. */
  retryable?: boolean;
  /** Hint for how long to wait before retrying, in milliseconds. */
  retryAfterMs?: number;
  cause?: unknown;
  /** Extra structured context (already secret-free). */
  details?: Record<string, unknown>;
}

/** Base class for all connector-originated errors. */
export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly platform?: string;
  readonly operation?: ConnectorOperation;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ConnectorErrorCode,
    message: string,
    options: ConnectorErrorOptions = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.platform = options.platform;
    this.operation = options.operation;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.details = options.details;
  }
}

/**
 * Thrown by any operation the platform/connector does not support — including
 * (Contract v1.1+) an operation the platform supports in general but NOT for
 * the specific credential shape in play (see `PlatformConnector.capabilitiesFor`).
 * Never use a plain `AuthError` for that case; `NotSupportedError` is what
 * lets callers feature-detect via the descriptor instead of parsing messages.
 */
export class NotSupportedError extends ConnectorError {
  constructor(operation: ConnectorOperation, platform?: string, message?: string) {
    super('not_supported', message ?? `Operation "${operation}" is not supported by ${platform ?? 'this platform'}.`, {
      operation,
      platform,
      retryable: false,
    });
  }
}

/** Generic authentication failure (bad credentials, denied consent, etc.). */
export class AuthError extends ConnectorError {
  constructor(message: string, options: ConnectorErrorOptions = {}) {
    super('auth_failed', message, { ...options, retryable: options.retryable ?? false });
  }
}

/** Access token expired but is refreshable — the auth layer should refresh. */
export class TokenExpiredError extends ConnectorError {
  constructor(message = 'Access token has expired.', options: ConnectorErrorOptions = {}) {
    super('token_expired', message, { ...options, retryable: true });
  }
}

/** Token/authorization revoked — requires full re-authentication, not refresh. */
export class TokenRevokedError extends ConnectorError {
  constructor(message = 'Access has been revoked; re-authentication required.', options: ConnectorErrorOptions = {}) {
    super('token_revoked', message, { ...options, retryable: false });
  }
}

/** Platform rate limit hit; retry after `retryAfterMs`. Always retryable. */
export class RateLimitError extends ConnectorError {
  constructor(message = 'Rate limit exceeded.', options: ConnectorErrorOptions = {}) {
    super('rate_limited', message, { ...options, retryable: true });
  }
}

/** Publish/edit refused because validation failed; carries the full result. */
export class ValidationFailedError extends ConnectorError {
  readonly result: ValidationResult;
  constructor(result: ValidationResult, options: ConnectorErrorOptions = {}) {
    super('validation_failed', 'Post failed validation.', { ...options, retryable: false });
    this.result = result;
  }
}

/** A transient/network error worth retrying (5xx, timeouts, connection reset). */
export class TransientError extends ConnectorError {
  constructor(message: string, options: ConnectorErrorOptions = {}) {
    super('transient', message, { ...options, retryable: true });
  }
}

/** Type guard: does this error want to be retried by the queue? */
export function isRetryable(error: unknown): error is ConnectorError {
  return error instanceof ConnectorError && error.retryable;
}

/**
 * Guard used at the top of an optional operation: throws `NotSupportedError`
 * unless the descriptor declares the operation supported. Keeps the "declare it
 * false AND throw" invariant in one place.
 */
export function assertSupported(
  capabilities: CapabilityDescriptor,
  op: ConnectorOperation,
): void {
  if (capabilities.operations[op] !== true) {
    throw new NotSupportedError(op, capabilities.platform);
  }
}
