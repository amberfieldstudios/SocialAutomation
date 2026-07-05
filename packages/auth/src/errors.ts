/**
 * Typed errors for the auth layer.
 *
 * SECURITY: no error message or field here ever carries token/key material.
 * Messages are generic on purpose so that a stack trace or a caught-and-logged
 * error can never leak a secret (docs/AUTH.md §7).
 */

/** Base class for every error originating in `@social/auth`. */
export class AuthLayerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
  }
}

/**
 * Sealing/opening a token failed. Thrown for a GCM auth-tag mismatch (tamper /
 * corruption / wrong AAD) or any other crypto failure. We FAIL CLOSED — a
 * `VaultError` never accompanies a partial or plaintext token.
 */
export class VaultError extends AuthLayerError {}

/**
 * The `encryption_key_ref` on a stored row cannot be resolved to key material
 * (missing key version, KMS unreachable, master key absent). Fails closed; the
 * account should be marked `error` and surfaced for reconnect.
 */
export class KeyUnavailableError extends AuthLayerError {}

/**
 * The grant is dead (platform returned revoked / auth_failed). Refresh cannot
 * help; the account must be re-paired. Carries the account id (never a token)
 * so the caller can surface a Reconnect action.
 */
export class ReauthRequiredError extends AuthLayerError {
  readonly accountId: string;
  /** 'revoked' for an explicit revoke, 'error' for an ambiguous auth failure. */
  readonly accountStatus: 'revoked' | 'error';
  constructor(
    accountId: string,
    accountStatus: 'revoked' | 'error',
    message = 'Re-authentication required for this account.',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.accountId = accountId;
    this.accountStatus = accountStatus;
  }
}

/** No account row exists for the given id. */
export class AccountNotFoundError extends AuthLayerError {
  readonly accountId: string;
  constructor(accountId: string) {
    super(`No account found for id "${accountId}".`);
    this.accountId = accountId;
  }
}

/** An account has no current (`is_current = 1`) token row to decrypt. */
export class NoCurrentTokenError extends AuthLayerError {
  readonly accountId: string;
  constructor(accountId: string) {
    super(`No current token found for account "${accountId}".`);
    this.accountId = accountId;
  }
}

/**
 * A paired account's granted scopes do not cover an operation's required scopes
 * (docs/AUTH.md §5). Thrown at pairing (granted < requested) and pre-use (stored
 * < required) so we block before wasting a platform round-trip and a 403.
 *
 * SECURITY: carries scope NAMES only (never token/secret values).
 */
export class InsufficientScopeError extends AuthLayerError {
  readonly platformId: string;
  readonly missing: string[];
  readonly required: string[];
  readonly granted: string[];
  constructor(platformId: string, missing: string[], required: string[], granted: string[]) {
    super(
      `Account for platform "${platformId}" is missing required scope(s): ${missing.join(', ')}.`,
    );
    this.platformId = platformId;
    this.missing = missing;
    this.required = required;
    this.granted = granted;
  }
}

/**
 * A pairing session could not be validated on callback: unknown `state`
 * (possible CSRF / forged callback), an expired session, or a replayed
 * single-use session. Fails closed — no token is exchanged.
 *
 * SECURITY: never echoes the raw `state` value in the message (it is a CSRF
 * token); callers correlate via structured logs by session, not by state value.
 */
export class PairingStateError extends AuthLayerError {
  readonly reason: 'unknown' | 'expired';
  constructor(reason: 'unknown' | 'expired' = 'unknown') {
    super(
      reason === 'expired'
        ? 'Pairing session has expired; restart the connection flow.'
        : 'Pairing session is unknown, already used, or forged; the callback was rejected.',
    );
    this.reason = reason;
  }
}

/**
 * The connector completed a flow but did not return the token/profile the
 * pairing coordinator needs to create an account. Fails closed.
 */
export class PairingResultError extends AuthLayerError {
  readonly platformId: string;
  constructor(platformId: string, message: string) {
    super(message);
    this.platformId = platformId;
  }
}

/**
 * A device-authorization grant expired before the user approved it
 * (RFC 8628 `expired_token`). The user must restart the device flow.
 */
export class DeviceAuthorizationExpiredError extends AuthLayerError {
  readonly platformId: string;
  constructor(platformId: string) {
    super(`Device authorization for platform "${platformId}" expired before it was approved.`);
    this.platformId = platformId;
  }
}

/** The requested grant is not offered for a platform (registry misconfiguration / wrong entry point). */
export class UnsupportedGrantError extends AuthLayerError {
  readonly platformId: string;
  readonly grant: string;
  constructor(platformId: string, grant: string, message?: string) {
    super(message ?? `Platform "${platformId}" does not support the "${grant}" grant via this entry point.`);
    this.platformId = platformId;
    this.grant = grant;
  }
}
