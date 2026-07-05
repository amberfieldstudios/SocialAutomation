/**
 * PKCE (RFC 7636) + CSRF `state` generation (docs/AUTH.md §6).
 *
 * PKCE makes an authorization-code flow safe for a public client: the verifier
 * is a high-entropy secret kept server-side in the pairing session; only its
 * S256 challenge travels to the platform in the authorize URL. On callback we
 * present the verifier, which the platform hashes and compares — a leaked
 * `code` alone cannot be exchanged.
 *
 * SECURITY: the verifier is a SECRET (never logged, never returned to the UI).
 * The challenge and `state` are safe to place in a URL.
 */

import { createHash, randomBytes } from 'node:crypto';

/** The only code-challenge method we use (RFC 7636 §4.2). Plain is never used. */
export const PKCE_METHOD = 'S256' as const;

/** base64url with no padding — the encoding RFC 7636 mandates for PKCE. */
function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

/**
 * A fresh code verifier: 32 random bytes → 43-char base64url string, within the
 * RFC's 43–128 character range and well above the 256-bit entropy floor.
 */
export function createVerifier(): string {
  return base64url(randomBytes(32));
}

/** The S256 code challenge for a verifier: base64url(SHA-256(verifier)). */
export function challengeFor(verifier: string): string {
  return base64url(createHash('sha256').update(verifier, 'ascii').digest());
}

/**
 * A cryptographically random CSRF `state` value (256 bits). It is the key that
 * ties a platform callback back to the pairing session we started, so a forged
 * callback with an unknown `state` is rejected.
 */
export function createState(): string {
  return base64url(randomBytes(32));
}
