/**
 * TokenVault — seals/opens a token bundle to/from the shape stored in
 * `account_tokens` (docs/AUTH.md §2).
 *
 * Single-blob seal (producer decision B): access + refresh are sealed together
 * into one ciphertext with one nonce/tag; `refresh_token_ciphertext` stays NULL.
 * AAD binds `accountId|field|keyRef|alg` so a ciphertext cannot be replayed
 * under a different account/field/key — a mismatch fails the auth-tag check.
 */

import { AEAD_ALG, openBytes, sealBytes } from './crypto/aead';
import type { KeyProvider } from './crypto/keyring';
import { VaultError } from './errors';
import type { SealedToken, SecretBundle, TokenField } from './types';

/** JSON shape of the plaintext bundle — exists only in memory, never persisted. */
interface PlaintextBundle {
  accessToken: string;
  refreshToken?: string;
}

function buildAad(accountId: string, field: TokenField, keyRef: string, alg: string): Buffer {
  return Buffer.from(`${accountId}|${field}|${keyRef}|${alg}`, 'utf8');
}

export class TokenVault {
  constructor(private readonly keys: KeyProvider) {}

  /** Seal a secret bundle for `(accountId, field)` under the active key. */
  async seal(accountId: string, field: TokenField, secret: SecretBundle): Promise<SealedToken> {
    if (!secret.access) {
      throw new VaultError('Cannot seal an empty access token.');
    }
    const keyRef = this.keys.activeKeyRef();
    const key = await this.keys.resolveKey(keyRef);
    const aad = buildAad(accountId, field, keyRef, AEAD_ALG);

    const plaintext: PlaintextBundle = {
      accessToken: secret.access,
      ...(secret.refresh ? { refreshToken: secret.refresh } : {}),
    };
    const buf = Buffer.from(JSON.stringify(plaintext), 'utf8');
    const sealed = sealBytes(key, buf, aad);
    // Best-effort scrub of the transient plaintext buffer.
    buf.fill(0);

    return {
      ciphertext: sealed.ciphertext,
      nonce: sealed.nonce,
      authTag: sealed.authTag,
      keyRef,
      alg: AEAD_ALG,
    };
  }

  /**
   * Open a sealed token back into a `SecretBundle`. The `keyRef`/`alg` recorded
   * on the row are used to resolve the (possibly historical) key and rebuild the
   * AAD, so rows sealed under an older key version still open after rotation.
   */
  async open(accountId: string, field: TokenField, sealed: SealedToken): Promise<SecretBundle> {
    const key = await this.keys.resolveKey(sealed.keyRef);
    const aad = buildAad(accountId, field, sealed.keyRef, sealed.alg);
    const plaintextBuf = openBytes(key, { ciphertext: sealed.ciphertext, nonce: sealed.nonce, authTag: sealed.authTag }, aad);

    let parsed: PlaintextBundle;
    try {
      parsed = JSON.parse(plaintextBuf.toString('utf8')) as PlaintextBundle;
    } catch (cause) {
      throw new VaultError('Opened token bundle was not valid JSON.', { cause });
    } finally {
      plaintextBuf.fill(0);
    }
    if (!parsed || typeof parsed.accessToken !== 'string') {
      throw new VaultError('Opened token bundle is missing an access token.');
    }
    return {
      access: parsed.accessToken,
      ...(typeof parsed.refreshToken === 'string' ? { refresh: parsed.refreshToken } : {}),
    };
  }
}
