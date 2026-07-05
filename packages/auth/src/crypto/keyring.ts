/**
 * Key management (docs/AUTH.md §2 "Key management model").
 *
 * `encryption_key_ref` names a key VERSION, never the key. A `KeyProvider`
 * resolves a ref to key material (or, for a full-KMS deployment, would delegate
 * crypto to the KMS). Key bytes live only in process memory and are NEVER
 * logged or written to a row.
 *
 * Two implementations:
 *  - `LocalKeyProvider` (dev/self-host): keyring of base64 32-byte keys keyed by
 *    version label; the active version is used for new seals; older versions are
 *    retained so historical rows still open (lazy rotation).
 *  - `KmsKeyProvider` (prod): a stub interface + placeholder. See notes below.
 */

import { KeyUnavailableError } from '../errors';
import { KEY_BYTES } from './aead';

/**
 * Resolves an `encryption_key_ref` to raw AES key material and reports the
 * active version to seal new rows under.
 */
export interface KeyProvider {
  /** Identifies the provider family recorded in `encryption_alg` context, e.g. `local`, `kms:aws`. */
  readonly kind: string;
  /** The `key_ref` new seals should use (the current active version). */
  activeKeyRef(): string;
  /**
   * Return the 32-byte key for `keyRef`. Throws `KeyUnavailableError` if the
   * version is unknown/unreachable so callers can fail closed.
   */
  resolveKey(keyRef: string): Promise<Buffer>;
}

/**
 * Dev / self-host key provider. Holds one or more key versions in memory and
 * seals under the active one. `key_ref` is `local:<version>`.
 */
export class LocalKeyProvider implements KeyProvider {
  readonly kind = 'local';
  private readonly keys: Map<string, Buffer>;
  private readonly activeVersion: string;

  /**
   * @param keys       version-label -> 32-byte key (raw bytes).
   * @param activeVersion which version new seals use; must exist in `keys`.
   */
  constructor(keys: Record<string, Buffer>, activeVersion: string) {
    this.keys = new Map();
    for (const [version, key] of Object.entries(keys)) {
      if (key.length !== KEY_BYTES) {
        throw new KeyUnavailableError(`Key version "${version}" must be ${KEY_BYTES} bytes (got ${key.length}).`);
      }
      this.keys.set(version, key);
    }
    if (!this.keys.has(activeVersion)) {
      throw new KeyUnavailableError(`Active key version "${activeVersion}" is not present in the keyring.`);
    }
    this.activeVersion = activeVersion;
  }

  /**
   * Build a provider from environment. `SOCIAL_MASTER_KEY` is a base64-encoded
   * 32-byte key registered as version `v1`. Optional `SOCIAL_MASTER_KEY_VERSION`
   * overrides the label. Additional versions can be supplied later via the
   * constructor for rotation.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): LocalKeyProvider {
    const raw = env.SOCIAL_MASTER_KEY;
    if (!raw) {
      throw new KeyUnavailableError('SOCIAL_MASTER_KEY is not set; cannot initialize the local key provider.');
    }
    const version = env.SOCIAL_MASTER_KEY_VERSION ?? 'v1';
    let key: Buffer;
    try {
      key = Buffer.from(raw, 'base64');
    } catch (cause) {
      throw new KeyUnavailableError('SOCIAL_MASTER_KEY is not valid base64.', { cause });
    }
    if (key.length !== KEY_BYTES) {
      throw new KeyUnavailableError(`SOCIAL_MASTER_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}).`);
    }
    return new LocalKeyProvider({ [version]: key }, version);
  }

  activeKeyRef(): string {
    return `${this.kind}:${this.activeVersion}`;
  }

  resolveKey(keyRef: string): Promise<Buffer> {
    const version = this.parseVersion(keyRef);
    const key = version ? this.keys.get(version) : undefined;
    if (!key) {
      return Promise.reject(new KeyUnavailableError(`No local key registered for key_ref "${keyRef}".`));
    }
    return Promise.resolve(key);
  }

  private parseVersion(keyRef: string): string | undefined {
    const [kind, version] = keyRef.split(':', 2);
    return kind === this.kind ? version : undefined;
  }
}

/**
 * Production KMS-backed provider (STUB — not implemented in t6).
 *
 * Intended shape (docs/AUTH.md §2):
 *  - `key_ref` = the KMS key id/ARN + version.
 *  - Mode (a): fetch & cache a data key from KMS, then do AES-256-GCM locally
 *    via `resolveKey` (fits this interface directly).
 *  - Mode (b): delegate encrypt/decrypt to KMS so the master key never enters
 *    our process. Mode (b) needs a richer `Cryptor` seam than `resolveKey`; that
 *    seam is deferred until a prod deployment is scoped.
 */
export class KmsKeyProvider implements KeyProvider {
  readonly kind: string;
  constructor(kind = 'kms') {
    this.kind = kind;
  }

  activeKeyRef(): string {
    throw new KeyUnavailableError('KmsKeyProvider is a stub; wire up a KMS client before production use.');
  }

  resolveKey(_keyRef: string): Promise<Buffer> {
    return Promise.reject(
      new KeyUnavailableError('KmsKeyProvider is a stub; wire up a KMS client before production use.'),
    );
  }
}
