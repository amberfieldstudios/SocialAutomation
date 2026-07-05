import { describe, expect, it } from 'vitest';
import { KmsKeyProvider, LocalKeyProvider } from '../src/crypto/keyring';
import { KeyUnavailableError } from '../src/errors';
import { VaultError } from '../src/errors';
import { TOKEN_FIELD } from '../src/types';
import { TokenVault } from '../src/vault';
import { TEST_KEY, makeVault } from './support';

function flipByte(base64: string): string {
  const buf = Buffer.from(base64, 'base64');
  buf[0] = buf[0]! ^ 0xff;
  return buf.toString('base64');
}

describe('TokenVault seal/open', () => {
  it('round-trips access + refresh through AES-256-GCM', async () => {
    const vault = makeVault();
    const sealed = await vault.seal('acc-1', TOKEN_FIELD, { access: 'AT-123', refresh: 'RT-456' });

    expect(sealed.keyRef).toBe('local:v1');
    expect(sealed.alg).toBe('aes-256-gcm');
    // ciphertext must not leak the plaintext
    expect(sealed.ciphertext).not.toContain('AT-123');
    expect(sealed.ciphertext).not.toContain('RT-456');

    const opened = await vault.open('acc-1', TOKEN_FIELD, sealed);
    expect(opened).toEqual({ access: 'AT-123', refresh: 'RT-456' });
  });

  it('round-trips an access-only bundle (no refresh token)', async () => {
    const vault = makeVault();
    const sealed = await vault.seal('acc-1', TOKEN_FIELD, { access: 'only-access' });
    const opened = await vault.open('acc-1', TOKEN_FIELD, sealed);
    expect(opened.access).toBe('only-access');
    expect(opened.refresh).toBeUndefined();
  });

  it('uses a fresh nonce per seal', async () => {
    const vault = makeVault();
    const a = await vault.seal('acc-1', TOKEN_FIELD, { access: 'same' });
    const b = await vault.seal('acc-1', TOKEN_FIELD, { access: 'same' });
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('fails closed on tampered ciphertext (auth-tag mismatch)', async () => {
    const vault = makeVault();
    const sealed = await vault.seal('acc-1', TOKEN_FIELD, { access: 'AT', refresh: 'RT' });
    const tampered = { ...sealed, ciphertext: flipByte(sealed.ciphertext) };
    await expect(vault.open('acc-1', TOKEN_FIELD, tampered)).rejects.toBeInstanceOf(VaultError);
  });

  it('fails closed on a tampered auth tag', async () => {
    const vault = makeVault();
    const sealed = await vault.seal('acc-1', TOKEN_FIELD, { access: 'AT' });
    const tampered = { ...sealed, authTag: flipByte(sealed.authTag) };
    await expect(vault.open('acc-1', TOKEN_FIELD, tampered)).rejects.toBeInstanceOf(VaultError);
  });

  it('rejects AAD mismatch (ciphertext replayed under a different account)', async () => {
    const vault = makeVault();
    const sealed = await vault.seal('acc-1', TOKEN_FIELD, { access: 'AT', refresh: 'RT' });
    // Opening the same blob bound to a different accountId must fail the tag check.
    await expect(vault.open('acc-2', TOKEN_FIELD, sealed)).rejects.toBeInstanceOf(VaultError);
  });

  it('opens rows sealed under an older key version after rotation', async () => {
    const oldVault = makeVault(); // active v1
    const sealed = await oldVault.seal('acc-1', TOKEN_FIELD, { access: 'AT', refresh: 'RT' });
    expect(sealed.keyRef).toBe('local:v1');

    // Rotate: v2 active, v1 retained in the keyring.
    const rotated = new TokenVault(new LocalKeyProvider({ v1: TEST_KEY, v2: Buffer.alloc(32, 9) }, 'v2'));
    const opened = await rotated.open('acc-1', TOKEN_FIELD, sealed);
    expect(opened.access).toBe('AT');

    // New seals use the active version.
    const fresh = await rotated.seal('acc-1', TOKEN_FIELD, { access: 'X' });
    expect(fresh.keyRef).toBe('local:v2');
  });

  it('throws KeyUnavailableError for an unknown key_ref', async () => {
    const vault = makeVault();
    const sealed = await vault.seal('acc-1', TOKEN_FIELD, { access: 'AT' });
    const wrongRef = { ...sealed, keyRef: 'local:v99' };
    await expect(vault.open('acc-1', TOKEN_FIELD, wrongRef)).rejects.toBeInstanceOf(KeyUnavailableError);
  });
});

describe('LocalKeyProvider', () => {
  it('builds from SOCIAL_MASTER_KEY env (base64 32-byte)', () => {
    const provider = LocalKeyProvider.fromEnv({ SOCIAL_MASTER_KEY: Buffer.alloc(32, 3).toString('base64') });
    expect(provider.activeKeyRef()).toBe('local:v1');
  });

  it('rejects a wrong-length master key', () => {
    expect(() => LocalKeyProvider.fromEnv({ SOCIAL_MASTER_KEY: Buffer.alloc(16, 3).toString('base64') })).toThrow(
      KeyUnavailableError,
    );
  });

  it('rejects a missing master key', () => {
    expect(() => LocalKeyProvider.fromEnv({})).toThrow(KeyUnavailableError);
  });
});

describe('KmsKeyProvider (stub)', () => {
  it('throws until wired to a real KMS client', () => {
    const provider = new KmsKeyProvider();
    expect(() => provider.activeKeyRef()).toThrow(KeyUnavailableError);
    return expect(provider.resolveKey('kms:whatever')).rejects.toBeInstanceOf(KeyUnavailableError);
  });
});
