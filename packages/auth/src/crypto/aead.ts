/**
 * AES-256-GCM authenticated encryption (docs/AUTH.md §2).
 *
 * Pure byte-level primitive: no knowledge of accounts, rows, or key management
 * — callers pass the resolved key and the AAD. A fresh random 12-byte nonce is
 * generated for every seal; a nonce is NEVER reused under a key (the one rule
 * that, if broken, breaks GCM).
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { VaultError } from '../errors';

export const AEAD_ALG = 'aes-256-gcm';
/** 96-bit nonce/IV, per NIST recommendation for GCM. */
export const NONCE_BYTES = 12;
/** 128-bit GCM auth tag. */
export const AUTH_TAG_BYTES = 16;
/** 256-bit key. */
export const KEY_BYTES = 32;

/** Raw sealed output (binary-as-base64), independent of storage columns. */
export interface AeadSealed {
  ciphertext: string;
  nonce: string;
  authTag: string;
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new VaultError(`AES-256-GCM requires a ${KEY_BYTES}-byte key (got ${key.length}).`);
  }
}

/** Encrypt `plaintext` under `key`, binding `aad`. Returns base64 fields. */
export function sealBytes(key: Buffer, plaintext: Buffer, aad: Buffer): AeadSealed {
  assertKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(AEAD_ALG, key, nonce, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString('base64'),
    nonce: nonce.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

/**
 * Decrypt and verify. A tag mismatch (tamper, corruption, or wrong AAD) throws
 * `VaultError` — we fail closed and never return partial/plaintext output.
 */
export function openBytes(key: Buffer, sealed: AeadSealed, aad: Buffer): Buffer {
  assertKey(key);
  try {
    const nonce = Buffer.from(sealed.nonce, 'base64');
    const authTag = Buffer.from(sealed.authTag, 'base64');
    const decipher = createDecipheriv(AEAD_ALG, key, nonce, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final()]);
  } catch (cause) {
    // Generic message on purpose: never echo ciphertext/key/AAD into the error.
    throw new VaultError('Failed to open sealed token (auth-tag verification failed).', { cause });
  }
}
