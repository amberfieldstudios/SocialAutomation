/**
 * SQLite-backed `TokensStore` (the port declared in `@social/auth/src/store.ts`).
 * Drop-in replacement for `InMemoryTokensStore`.
 *
 * SECURITY: this repo persists ONLY sealed material — `access_token_ciphertext`,
 * `refresh_token_ciphertext`, `nonce`, `auth_tag`, `encryption_key_ref`,
 * `encryption_alg`. It NEVER receives, stores, or logs plaintext tokens
 * (sealing/opening happens in the `@social/auth` vault). Log lines here carry
 * only non-secret metadata: accountId, keyRef, alg, isCurrent, expiresAt, and a
 * scope COUNT — never ciphertext, nonce, auth tag, or scope contents that could
 * leak. `nonce`/`auth_tag` are opaque AEAD parameters, not secrets, but are
 * still kept out of logs.
 */

import type { StructuredLogger } from '@social/core';
import type { AccountTokenRecord, TokensStore } from '@social/auth';
import type { SqlDriver } from '../driver';
import { nullableText, parseJson, toBool } from './rows';

interface TokenRow {
  id: string;
  account_id: string;
  access_token_ciphertext: string;
  refresh_token_ciphertext: string | null;
  encryption_key_ref: string;
  encryption_alg: string;
  nonce: string;
  auth_tag: string | null;
  token_type: string | null;
  scopes: string;
  expires_at: string | null;
  obtained_at: string;
  rotated_at: string | null;
  is_current: number;
  created_at: string;
  updated_at: string;
}

function mapRow(row: TokenRow): AccountTokenRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    accessTokenCiphertext: row.access_token_ciphertext,
    refreshTokenCiphertext: nullableText(row.refresh_token_ciphertext),
    encryptionKeyRef: row.encryption_key_ref,
    encryptionAlg: row.encryption_alg,
    nonce: row.nonce,
    authTag: nullableText(row.auth_tag),
    tokenType: nullableText(row.token_type),
    scopes: parseJson<string[]>(row.scopes, []),
    expiresAt: nullableText(row.expires_at),
    obtainedAt: row.obtained_at,
    rotatedAt: nullableText(row.rotated_at),
    isCurrent: toBool(row.is_current),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const INSERT_SQL = `INSERT INTO account_tokens
    (id, account_id, access_token_ciphertext, refresh_token_ciphertext, encryption_key_ref,
     encryption_alg, nonce, auth_tag, token_type, scopes, expires_at, obtained_at,
     rotated_at, is_current, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function insertParams(token: AccountTokenRecord) {
  return [
    token.id,
    token.accountId,
    token.accessTokenCiphertext,
    token.refreshTokenCiphertext ?? null,
    token.encryptionKeyRef,
    token.encryptionAlg,
    token.nonce,
    token.authTag ?? null,
    token.tokenType ?? null,
    JSON.stringify(token.scopes ?? []),
    token.expiresAt ?? null,
    token.obtainedAt,
    token.rotatedAt ?? null,
    token.isCurrent,
    token.createdAt,
    token.updatedAt,
  ];
}

export class SqliteTokensStore implements TokensStore {
  constructor(
    private readonly driver: SqlDriver,
    private readonly logger?: StructuredLogger,
  ) {}

  private safeFields(token: AccountTokenRecord): Record<string, unknown> {
    return {
      accountId: token.accountId,
      keyRef: token.encryptionKeyRef,
      alg: token.encryptionAlg,
      isCurrent: token.isCurrent,
      expiresAt: token.expiresAt ?? null,
      scopeCount: token.scopes?.length ?? 0,
    };
  }

  insert(token: AccountTokenRecord): Promise<AccountTokenRecord> {
    this.driver.run(INSERT_SQL, insertParams(token));
    this.logger?.info('db.tokens.insert', this.safeFields(token));
    return Promise.resolve(mapRow(this.requireRow(token.id)));
  }

  getCurrent(accountId: string): Promise<AccountTokenRecord | undefined> {
    const row = this.driver.get<TokenRow>(
      'SELECT * FROM account_tokens WHERE account_id = ? AND is_current = 1',
      [accountId],
    );
    return Promise.resolve(row ? mapRow(row) : undefined);
  }

  listByAccount(accountId: string): Promise<AccountTokenRecord[]> {
    const rows = this.driver.all<TokenRow>(
      'SELECT * FROM account_tokens WHERE account_id = ? ORDER BY obtained_at',
      [accountId],
    );
    return Promise.resolve(rows.map(mapRow));
  }

  /**
   * Atomic write-back (docs/AUTH.md §3): flip the existing current row to
   * `is_current = 0` (stamping `rotated_at`) then insert `newRow` as the sole
   * `is_current = 1` row, all under one `BEGIN IMMEDIATE` transaction so the
   * partial unique index `uq_account_tokens_current` never sees two current
   * rows. `rotated_at`/`updated_at` on the demoted row are stamped with the new
   * row's `obtainedAt`, matching `InMemoryTokensStore`.
   */
  rotateCurrent(newRow: AccountTokenRecord): Promise<AccountTokenRecord> {
    this.driver.transaction(() => {
      this.driver.run(
        `UPDATE account_tokens
           SET is_current = 0, rotated_at = ?, updated_at = ?
         WHERE account_id = ? AND is_current = 1`,
        [newRow.obtainedAt, newRow.obtainedAt, newRow.accountId],
      );
      this.driver.run(INSERT_SQL, insertParams({ ...newRow, isCurrent: true }));
    });
    this.logger?.info('db.tokens.rotate_current', this.safeFields(newRow));
    return Promise.resolve(mapRow(this.requireRow(newRow.id)));
  }

  deleteByAccount(accountId: string): Promise<void> {
    this.driver.run('DELETE FROM account_tokens WHERE account_id = ?', [accountId]);
    this.logger?.info('db.tokens.delete_by_account', { accountId });
    return Promise.resolve();
  }

  private requireRow(id: string): TokenRow {
    const row = this.driver.get<TokenRow>('SELECT * FROM account_tokens WHERE id = ?', [id]);
    if (!row) throw new Error(`token ${id} not found after write`);
    return row;
  }
}
