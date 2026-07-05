/**
 * Pairing-session store: holds the CSRF `state`, the PKCE code verifier, and the
 * pairing intent (platform + enabled operations + resolved scopes) between
 * `beginPairing` and the platform's callback (docs/AUTH.md §6).
 *
 * CSRF-safety rules this store enforces:
 *  - Sessions are keyed by `state`; a callback whose `state` is unknown is
 *    rejected (`PairingStateError`).
 *  - `take(state)` is SINGLE-USE: it loads AND removes the session so a replayed
 *    callback cannot be exchanged twice.
 *  - Sessions have a TTL (default 10 min); an expired session is treated as
 *    unknown.
 *
 * SECURITY: the session holds a PKCE `codeVerifier` (a secret) and, for device
 * flows, a `deviceCode` (also secret). Neither is ever logged. A real
 * `@social/db`-backed store would seal these columns; the in-memory store keeps
 * them in process memory only.
 */

import type { ConnectorOperation } from '@social/core';

/** One in-flight pairing attempt. */
export interface PairingSession {
  /** CSRF token tying the callback to this session. */
  state: string;
  platformId: string;
  /** The grant this session drives (auth_code / auth_code_pkce / device_code). */
  grant: string;
  /** Operations the user enabled — drives least-privilege scope selection + validation. */
  operations: ConnectorOperation[];
  /** The scopes actually requested (resolved from the catalog). */
  scopes: string[];
  /** PKCE verifier (SECRET). Present only for PKCE flows. */
  codeVerifier?: string;
  /** Device-flow poll code (SECRET). Present only for device_code sessions. */
  deviceCode?: string;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601 hard expiry; after this the session is unusable. */
  expiresAt: string;
}

/** Persistence port for pairing sessions. */
export interface PairingSessionStore {
  /** Persist a new session, keyed by `session.state`. */
  save(session: PairingSession): Promise<void>;
  /**
   * Load AND remove the session for `state` (single-use). Returns `undefined`
   * for an unknown/already-consumed state. Expiry is enforced by the caller.
   */
  take(state: string): Promise<PairingSession | undefined>;
  /** Peek without consuming (device-flow polling reads the session repeatedly). */
  get(state: string): Promise<PairingSession | undefined>;
  /** Remove a session by state (device flow removes on success/expiry). */
  remove(state: string): Promise<void>;
}

/**
 * In-memory pairing-session store for dev/tests. A DB-backed store swaps in
 * behind the same port. Expired sessions are pruned lazily on access and on an
 * optional sweep.
 */
export class InMemoryPairingSessionStore implements PairingSessionStore {
  private readonly rows = new Map<string, PairingSession>();
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  save(session: PairingSession): Promise<void> {
    this.rows.set(session.state, { ...session });
    return Promise.resolve();
  }

  take(state: string): Promise<PairingSession | undefined> {
    const row = this.readFresh(state);
    if (row) this.rows.delete(state);
    return Promise.resolve(row);
  }

  get(state: string): Promise<PairingSession | undefined> {
    return Promise.resolve(this.readFresh(state));
  }

  remove(state: string): Promise<void> {
    this.rows.delete(state);
    return Promise.resolve();
  }

  /** Delete every expired session (optional maintenance sweep). */
  prune(): number {
    let removed = 0;
    const nowMs = this.now().getTime();
    for (const [state, row] of this.rows) {
      if (Date.parse(row.expiresAt) <= nowMs) {
        this.rows.delete(state);
        removed += 1;
      }
    }
    return removed;
  }

  private readFresh(state: string): PairingSession | undefined {
    const row = this.rows.get(state);
    if (!row) return undefined;
    if (Date.parse(row.expiresAt) <= this.now().getTime()) {
      this.rows.delete(state);
      return undefined;
    }
    return { ...row };
  }
}
