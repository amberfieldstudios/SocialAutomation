/**
 * Auth-layer domain types.
 *
 * The record types mirror the `accounts` / `account_tokens` columns in
 * `packages/db/migrations/0001_init.sql` 1:1 (camelCase of the snake_case
 * column). Any `AccountsStore` / `TokensStore` implementation (the in-memory
 * one here, a real `@social/db`-backed one later) must round-trip these fields
 * without loss.
 */

import type { StructuredLogger } from '@social/core';

// ---------------------------------------------------------------------------
// Crypto / vault
// ---------------------------------------------------------------------------

/**
 * The `field` component of a sealed row's AAD. Under the single-blob seal
 * (docs/AUTH.md §2, producer decision B) there is exactly one field: the
 * access+refresh bundle sealed together into `access_token_ciphertext`.
 */
export type TokenField = 'tokenbundle';
export const TOKEN_FIELD: TokenField = 'tokenbundle';

/**
 * The secret material that gets sealed. Exists only in memory — never written
 * as plaintext, never logged.
 */
export interface SecretBundle {
  access: string;
  refresh?: string;
}

/** The output of a seal — everything needed to persist and later re-open. */
export interface SealedToken {
  /** base64 ciphertext of the sealed `SecretBundle`. */
  ciphertext: string;
  /** base64 of the 12-byte GCM nonce, fresh per seal. */
  nonce: string;
  /** base64 of the 16-byte GCM auth tag. */
  authTag: string;
  /** Key version reference (e.g. `local:v1`) — NEVER key material. */
  keyRef: string;
  /** Encryption scheme recorded on the row (e.g. `aes-256-gcm`). */
  alg: string;
}

// ---------------------------------------------------------------------------
// Storage records
// ---------------------------------------------------------------------------

export type AccountStatus = 'active' | 'disconnected' | 'error' | 'revoked';

/** A row of the `accounts` table (contains NO secrets). */
export interface AccountRecord {
  id: string;
  platformId: string;
  remoteId: string;
  handle?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  profileUrl?: string | null;
  profileMetadata?: Record<string, unknown> | null;
  status: AccountStatus;
  connectedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A row of the `account_tokens` table. Holds CIPHERTEXT + a key reference only;
 * `nonce`/`authTag` are for AEAD open. Never holds plaintext tokens.
 */
export interface AccountTokenRecord {
  id: string;
  accountId: string;
  accessTokenCiphertext: string;
  /** NULL under the single-blob scheme (refresh rides inside the sealed bundle). */
  refreshTokenCiphertext?: string | null;
  encryptionKeyRef: string;
  encryptionAlg: string;
  nonce: string;
  authTag?: string | null;
  tokenType?: string | null;
  scopes: string[];
  expiresAt?: string | null;
  obtainedAt: string;
  rotatedAt?: string | null;
  isCurrent: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Account manager inputs / outputs
// ---------------------------------------------------------------------------

/** Profile metadata captured at pairing (from `PlatformProfile`). */
export interface AccountProfileInput {
  handle?: string;
  displayName?: string;
  avatarUrl?: string;
  profileUrl?: string;
  /** Non-secret extras only. */
  profileMetadata?: Record<string, unknown>;
}

export interface AddAccountInput extends AccountProfileInput {
  platformId: string;
  /** Platform-native account id (stable). */
  remoteId: string;
}

/** A secret-free projection of an account, safe to return to callers/UI. */
export interface AccountSummary {
  id: string;
  platformId: string;
  remoteId: string;
  handle?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  profileUrl?: string | null;
  profileMetadata?: Record<string, unknown> | null;
  status: AccountStatus;
  connectedAt?: string | null;
  /** Granted scope NAMES from the current token (never secrets). */
  scopes?: string[];
  /** ISO-8601 access-token expiry from the current token, if any. */
  tokenExpiresAt?: string | null;
}

export interface ListAccountsFilter {
  platformId?: string;
  status?: AccountStatus;
}

// ---------------------------------------------------------------------------
// Token manager options
// ---------------------------------------------------------------------------

/** Controls when a token is considered "due" for proactive refresh. */
export interface RefreshSkewConfig {
  /** Floor on the skew window. Default 60_000 (60s). */
  minSkewMs?: number;
  /** Fraction of the token lifetime used as skew. Default 0.1 (10%). */
  lifetimeFraction?: number;
}

export interface CreateContextOptions {
  /** Optional soft deadline as epoch milliseconds, forwarded to the context. */
  deadlineMs?: number;
  /** Per-call logger override; defaults to the manager's logger. */
  logger?: StructuredLogger;
}

/** Options for persisting a freshly obtained token. */
export interface StoreTokenOptions {
  /** e.g. `Bearer`, `bot`, `webhook`, `atproto_app_password`. */
  tokenType?: string;
  /**
   * Whether this becomes the account's current token. Default `true`. Set
   * `false` for bootstrap secrets like a Bluesky app password (docs/AUTH.md §1),
   * which live as a non-current row alongside the live session.
   */
  isCurrent?: boolean;
}
