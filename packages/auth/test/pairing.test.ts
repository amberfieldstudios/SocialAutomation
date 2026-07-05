import type { PlatformProfile, TokenSet } from '@social/core';
import { describe, expect, it } from 'vitest';
import {
  InsufficientScopeError,
  PairingResultError,
  PairingStateError,
  UnsupportedGrantError,
} from '../src/errors';
import {
  InMemoryPairingSessionStore,
  PairingCoordinator,
  challengeFor,
  createState,
  createVerifier,
  type PairingAuthRequest,
  type PairingAuthResult,
  type PairingConnector,
} from '../src/oauth';
import { newHarness } from './support';

// ---------------------------------------------------------------------------
// A configurable mock PairingConnector (stands in for a real plugin).
// ---------------------------------------------------------------------------

interface MockConnectorConfig {
  /** Scopes the platform reports as GRANTED on code/password exchange. */
  grantedScopes?: string[];
  profile?: PlatformProfile;
  /** Number of `device_token` polls that return pending before the token. */
  devicePendingPolls?: number;
  /** Omit the token from the exchange result (to exercise fail-closed). */
  omitToken?: boolean;
}

function mockToken(scopes: string[], accessToken = 'SECRET-ACCESS-PAIRED'): TokenSet {
  const now = Date.now();
  return {
    accessToken,
    refreshToken: 'SECRET-REFRESH-PAIRED',
    tokenType: 'Bearer',
    scopes,
    obtainedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
  };
}

class MockConnector implements PairingConnector {
  readonly requests: PairingAuthRequest[] = [];
  private devicePolls = 0;
  /** Scopes the platform "saw" at authorize time; echoed as granted on exchange. */
  private authorizedScopes: string[] = [];
  constructor(private readonly cfg: MockConnectorConfig = {}) {}

  authenticate(request: PairingAuthRequest): Promise<PairingAuthResult> {
    this.requests.push(request);
    const profile: PlatformProfile = this.cfg.profile ?? {
      remoteId: 'remote-1',
      handle: 'channel_one',
      displayName: 'Channel One',
      avatarUrl: 'https://cdn.example/avatar.png',
    };

    switch (request.kind) {
      case 'authorize_url':
        this.authorizedScopes = request.scopes;
        return Promise.resolve({
          authorizeUrl: `https://platform.example/oauth/authorize?state=${request.state}&scope=${encodeURIComponent(
            request.scopes.join(' '),
          )}&code_challenge=${request.codeChallenge ?? ''}`,
        });
      case 'exchange_code': {
        // A real platform grants what was requested at authorize time.
        const granted = this.cfg.grantedScopes ?? this.authorizedScopes;
        return Promise.resolve({
          ...(this.cfg.omitToken ? {} : { token: mockToken(granted) }),
          profile,
        });
      }
      case 'password': {
        const granted = this.cfg.grantedScopes ?? request.scopes;
        return Promise.resolve({
          ...(this.cfg.omitToken ? {} : { token: mockToken(granted) }),
          profile,
        });
      }
      case 'device_code':
        return Promise.resolve({
          deviceAuthorization: {
            deviceCode: 'SECRET-DEVICE-CODE',
            userCode: 'WXYZ-1234',
            verificationUri: 'https://platform.example/activate',
            verificationUriComplete: 'https://platform.example/activate?user_code=WXYZ-1234',
            expiresInSec: 600,
            intervalSec: 1,
          },
        });
      case 'device_token': {
        this.devicePolls += 1;
        if (this.devicePolls <= (this.cfg.devicePendingPolls ?? 0)) {
          return Promise.resolve({ pending: 'authorization_pending' });
        }
        const granted = this.cfg.grantedScopes ?? ['user:read:email', 'channel:manage:broadcast'];
        return Promise.resolve({ token: mockToken(granted), profile });
      }
      case 'client_credentials':
        return Promise.resolve({ token: mockToken(request.scopes) });
      default:
        return Promise.reject(new Error('unexpected request kind'));
    }
  }
}

function buildCoordinator(connector: PairingConnector, sink?: (line: string) => void) {
  const h = newHarness({ connector: { refreshToken: () => Promise.reject(new Error('no refresh in pairing')) }, sink });
  const sessions = new InMemoryPairingSessionStore();
  const coordinator = new PairingCoordinator({
    sessions,
    connectors: { get: () => connector },
    appCredentials: { get: () => ({ clientId: 'test-client' }) },
    accounts: h.accountManager,
    tokenManager: h.tokenManager,
    logger: h.logger,
  });
  return { coordinator, sessions, h };
}

// ---------------------------------------------------------------------------
// PKCE + state
// ---------------------------------------------------------------------------

describe('PKCE + CSRF state', () => {
  it('creates a 43-char base64url verifier and a matching S256 challenge', () => {
    const verifier = createVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const challenge = challengeFor(verifier);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Deterministic for a given verifier.
    expect(challengeFor(verifier)).toBe(challenge);
    // Different verifier -> different challenge.
    expect(challengeFor(createVerifier())).not.toBe(challenge);
  });

  it('creates unique, high-entropy state values', () => {
    const states = new Set(Array.from({ length: 100 }, () => createState()));
    expect(states.size).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Authorize URL + PKCE wiring
// ---------------------------------------------------------------------------

describe('beginPairing (auth-code + PKCE)', () => {
  it('builds an authorize URL, stores the session, and wires the PKCE challenge', async () => {
    // Mastodon is the PKCE platform in the registry (Twitch does NOT support
    // PKCE per dev.twitch.tv/docs/authentication/getting-tokens-oauth — see
    // the confidential auth_code test below).
    const connector = new MockConnector();
    const { coordinator, sessions } = buildCoordinator(connector);

    const result = await coordinator.beginPairing('mastodon', ['publish']);
    expect(result.kind).toBe('authorize_url');
    if (result.kind !== 'authorize_url') return;

    expect(result.authorizeUrl).toContain('code_challenge=');

    // Session persisted with the PKCE verifier (a secret held server-side).
    const session = await sessions.get(result.state);
    expect(session?.platformId).toBe('mastodon');
    expect(session?.codeVerifier).toBeDefined();
    // The challenge in the URL is exactly S256(verifier) — PKCE is correctly wired.
    const authReq = connector.requests[0];
    expect(authReq?.kind).toBe('authorize_url');
    if (authReq?.kind === 'authorize_url') {
      expect(authReq.codeChallenge).toBe(challengeFor(session!.codeVerifier!));
    }
  });

  it('does NOT use PKCE for Twitch (confidential client, client_secret required instead)', async () => {
    const connector = new MockConnector();
    const { coordinator, sessions } = buildCoordinator(connector);

    const result = await coordinator.beginPairing('twitch', ['publish']);
    expect(result.kind).toBe('authorize_url');
    if (result.kind !== 'authorize_url') return;

    // Least-privilege scopes were requested.
    expect(result.scopes).toEqual(['user:read:email', 'channel:manage:broadcast']);
    // No PKCE challenge is generated or sent for Twitch — the URL's
    // code_challenge param is empty.
    expect(result.authorizeUrl).toMatch(/code_challenge=(&|$)/);

    const session = await sessions.get(result.state);
    expect(session?.platformId).toBe('twitch');
    expect(session?.codeVerifier).toBeUndefined();
    const authReq = connector.requests[0];
    expect(authReq?.kind).toBe('authorize_url');
    if (authReq?.kind === 'authorize_url') {
      expect(authReq.codeChallenge).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Callback token exchange (happy path) persists token + account
// ---------------------------------------------------------------------------

describe('completePairing (code exchange)', () => {
  it('exchanges the code, persists a sealed token, and creates the account', async () => {
    const connector = new MockConnector();
    const { coordinator, h } = buildCoordinator(connector);

    const begin = await coordinator.beginPairing('twitch', ['publish']);
    if (begin.kind !== 'authorize_url') throw new Error('expected authorize_url');

    const summary = await coordinator.completePairing(begin.state, 'AUTH-CODE-123');
    expect(summary.platformId).toBe('twitch');
    expect(summary.remoteId).toBe('remote-1');
    expect(summary.status).toBe('active');
    expect(summary.displayName).toBe('Channel One');
    // Secret-free summary: scope NAMES present, no token values.
    expect(summary.scopes).toEqual(['user:read:email', 'channel:manage:broadcast']);
    expect(JSON.stringify(summary)).not.toContain('SECRET');

    // Account is retrievable and a current token was sealed.
    const account = await h.accountManager.getAccount(summary.id);
    expect(account?.status).toBe('active');
    const current = await h.tokens.getCurrent(summary.id);
    expect(current?.isCurrent).toBe(true);
    expect(current?.accessTokenCiphertext).not.toContain('SECRET'); // sealed, not plaintext

    // The decrypted context yields the real token (proves round-trip sealing).
    const ctx = await h.tokenManager.createContext(summary.id);
    expect(ctx.token.accessToken).toBe('SECRET-ACCESS-PAIRED');

    // Twitch is a confidential client (no PKCE) — the exchange carries no
    // codeVerifier. (Mastodon's PKCE wiring is covered above.)
    const exchange = connector.requests.find((r) => r.kind === 'exchange_code');
    expect(exchange?.kind).toBe('exchange_code');
    if (exchange?.kind === 'exchange_code') {
      expect(exchange.code).toBe('AUTH-CODE-123');
      expect(exchange.codeVerifier).toBeUndefined();
    }
  });

  it('rejects an unknown/forged state (CSRF-safe) without exchanging', async () => {
    const connector = new MockConnector();
    const { coordinator } = buildCoordinator(connector);
    await expect(coordinator.completePairing('not-a-real-state', 'code')).rejects.toBeInstanceOf(PairingStateError);
    expect(connector.requests.filter((r) => r.kind === 'exchange_code')).toHaveLength(0);
  });

  it('rejects a replayed callback (single-use session)', async () => {
    const connector = new MockConnector();
    const { coordinator } = buildCoordinator(connector);
    const begin = await coordinator.beginPairing('twitch', ['publish']);
    if (begin.kind !== 'authorize_url') throw new Error('expected authorize_url');

    await coordinator.completePairing(begin.state, 'code-1');
    await expect(coordinator.completePairing(begin.state, 'code-1')).rejects.toBeInstanceOf(PairingStateError);
  });

  it('fails closed when the connector returns no token', async () => {
    const connector = new MockConnector({ omitToken: true });
    const { coordinator } = buildCoordinator(connector);
    const begin = await coordinator.beginPairing('twitch', ['publish']);
    if (begin.kind !== 'authorize_url') throw new Error('expected authorize_url');
    await expect(coordinator.completePairing(begin.state, 'code')).rejects.toBeInstanceOf(PairingResultError);
  });
});

// ---------------------------------------------------------------------------
// Scope validation pass / fail at pairing
// ---------------------------------------------------------------------------

describe('scope validation at pairing', () => {
  it('passes when granted scopes cover the enabled operations', async () => {
    const connector = new MockConnector({ grantedScopes: ['user:read:email', 'channel:manage:broadcast'] });
    const { coordinator } = buildCoordinator(connector);
    const begin = await coordinator.beginPairing('twitch', ['publish']);
    if (begin.kind !== 'authorize_url') throw new Error('expected authorize_url');
    await expect(coordinator.completePairing(begin.state, 'code')).resolves.toBeDefined();
  });

  it('throws InsufficientScopeError (with missing names) when a scope is not granted', async () => {
    // User only granted the base scope, not publish.
    const connector = new MockConnector({ grantedScopes: ['user:read:email'] });
    const { coordinator, h } = buildCoordinator(connector);
    const begin = await coordinator.beginPairing('twitch', ['publish']);
    if (begin.kind !== 'authorize_url') throw new Error('expected authorize_url');

    await expect(coordinator.completePairing(begin.state, 'code')).rejects.toMatchObject({
      name: 'InsufficientScopeError',
      missing: ['channel:manage:broadcast'],
    });
    expect(() => {
      throw new InsufficientScopeError('twitch', ['channel:manage:broadcast'], [], []);
    }).toThrow(/channel:manage:broadcast/);
    // No account was created for a scope-insufficient pairing.
    expect(await h.accountManager.listAccounts()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Multi-account upsert
// ---------------------------------------------------------------------------

describe('multi-account pairing', () => {
  it('pairs two distinct Twitch channels as two accounts', async () => {
    const c1 = new MockConnector({ profile: { remoteId: 'chan-a', handle: 'a', displayName: 'A' } });
    const { coordinator, h } = buildCoordinator(c1);
    const b1 = await coordinator.beginPairing('twitch', ['publish']);
    if (b1.kind !== 'authorize_url') throw new Error('x');
    await coordinator.completePairing(b1.state, 'code-a');

    const c2 = new MockConnector({ profile: { remoteId: 'chan-b', handle: 'b', displayName: 'B' } });
    // reuse the same coordinator's stores by swapping the connector via a new coordinator on same harness
    const coord2 = new PairingCoordinator({
      sessions: new InMemoryPairingSessionStore(),
      connectors: { get: () => c2 },
      appCredentials: { get: () => ({ clientId: 'c' }) },
      accounts: h.accountManager,
      tokenManager: h.tokenManager,
      logger: h.logger,
    });
    const b2 = await coord2.beginPairing('twitch', ['publish']);
    if (b2.kind !== 'authorize_url') throw new Error('x');
    await coord2.completePairing(b2.state, 'code-b');

    const accounts = await h.accountManager.listAccounts({ platformId: 'twitch' });
    expect(accounts.map((a) => a.remoteId).sort()).toEqual(['chan-a', 'chan-b']);
  });

  it('re-pairing the same remote account updates rather than duplicates', async () => {
    const connector = new MockConnector({ profile: { remoteId: 'chan-a', handle: 'a', displayName: 'Old Name' } });
    const { coordinator, h } = buildCoordinator(connector);
    const b1 = await coordinator.beginPairing('twitch', ['publish']);
    if (b1.kind !== 'authorize_url') throw new Error('x');
    await coordinator.completePairing(b1.state, 'code-a');

    const connector2 = new MockConnector({ profile: { remoteId: 'chan-a', handle: 'a', displayName: 'New Name' } });
    const coord2 = new PairingCoordinator({
      sessions: new InMemoryPairingSessionStore(),
      connectors: { get: () => connector2 },
      appCredentials: { get: () => ({ clientId: 'c' }) },
      accounts: h.accountManager,
      tokenManager: h.tokenManager,
      logger: h.logger,
    });
    const b2 = await coord2.beginPairing('twitch', ['publish']);
    if (b2.kind !== 'authorize_url') throw new Error('x');
    const summary = await coord2.completePairing(b2.state, 'code-a2');

    const accounts = await h.accountManager.listAccounts({ platformId: 'twitch' });
    expect(accounts).toHaveLength(1);
    expect(summary.displayName).toBe('New Name');
  });
});

// ---------------------------------------------------------------------------
// Device-code flow
// ---------------------------------------------------------------------------

describe('device-code pairing (Twitch alternate)', () => {
  it('starts the device flow and polls until the token is issued', async () => {
    const connector = new MockConnector({ devicePendingPolls: 2 });
    const { coordinator, h } = buildCoordinator(connector);

    const begin = await coordinator.beginPairing('twitch', ['publish'], { grant: 'device_code' });
    expect(begin.kind).toBe('device_code');
    if (begin.kind !== 'device_code') return;
    // The public device authorization does NOT leak the secret device code.
    expect(begin.deviceAuthorization.userCode).toBe('WXYZ-1234');
    expect(JSON.stringify(begin.deviceAuthorization)).not.toContain('SECRET-DEVICE-CODE');

    const summary = await coordinator.pollDevicePairing(begin.state, {
      intervalSec: 0,
      sleep: () => Promise.resolve(),
    });
    expect(summary.platformId).toBe('twitch');
    // Two pending polls then success.
    expect(connector.requests.filter((r) => r.kind === 'device_token')).toHaveLength(3);
    const current = await h.tokens.getCurrent(summary.id);
    expect(current?.isCurrent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// App-password (Bluesky) + bootstrap secret
// ---------------------------------------------------------------------------

describe('app-password pairing (Bluesky)', () => {
  it('exchanges handle+app-password and seals the app password as a non-current bootstrap row', async () => {
    const connector = new MockConnector({
      grantedScopes: [],
      profile: { remoteId: 'did:plc:abc', handle: 'me.bsky.social', displayName: 'Me' },
    });
    const { coordinator, h } = buildCoordinator(connector);

    const summary = await coordinator.pairWithPassword('bluesky', {
      identifier: 'me.bsky.social',
      password: 'SECRET-APP-PASSWORD',
      operations: ['publish'],
    });
    expect(summary.platformId).toBe('bluesky');
    expect(summary.remoteId).toBe('did:plc:abc');

    const rows = await h.tokens.listByAccount(summary.id);
    // Current session row + non-current bootstrap row.
    expect(rows.filter((r) => r.isCurrent)).toHaveLength(1);
    const bootstrap = rows.find((r) => !r.isCurrent);
    expect(bootstrap?.tokenType).toBe('atproto_app_password');
    expect(bootstrap?.accessTokenCiphertext).not.toContain('SECRET-APP-PASSWORD'); // sealed
  });
});

// ---------------------------------------------------------------------------
// Direct token (Discord bot/webhook)
// ---------------------------------------------------------------------------

describe('static-secret pairing (Discord bot/webhook)', () => {
  it('seals a bot token directly with no code exchange and never refreshes it', async () => {
    const connector = new MockConnector();
    const { coordinator, h } = buildCoordinator(connector);

    const summary = await coordinator.pairWithToken('discord', {
      token: 'SECRET-BOT-TOKEN',
      tokenType: 'bot',
      profile: { remoteId: 'guild-1', displayName: 'My Server' },
    });
    expect(summary.platformId).toBe('discord');
    // No connector round-trip for the direct path.
    expect(connector.requests).toHaveLength(0);
    const current = await h.tokens.getCurrent(summary.id);
    expect(current?.tokenType).toBe('bot');
    expect(current?.expiresAt ?? null).toBeNull(); // non-expiring
  });

  it('rejects beginPairing for a direct-flow platform with guidance', async () => {
    const connector = new MockConnector();
    const { coordinator } = buildCoordinator(connector);
    await expect(coordinator.beginPairing('discord', [])).rejects.toBeInstanceOf(UnsupportedGrantError);
  });
});

// ---------------------------------------------------------------------------
// Redaction: no secret ever reaches the log sink
// ---------------------------------------------------------------------------

describe('pairing logging redaction', () => {
  it('never logs PKCE verifiers, app passwords, codes, or token values across flows', async () => {
    const lines: string[] = [];
    // Auth-code flow.
    const c1 = new MockConnector();
    const { coordinator: coord1 } = buildCoordinator(c1, (l) => lines.push(l));
    const b1 = await coord1.beginPairing('twitch', ['publish']);
    if (b1.kind !== 'authorize_url') throw new Error('x');
    await coord1.completePairing(b1.state, 'AUTH-CODE-123');

    // App-password flow (separate coordinator/harness, same sink).
    const c2 = new MockConnector({
      grantedScopes: [],
      profile: { remoteId: 'did:plc:x', handle: 'me.bsky.social' },
    });
    const { coordinator: coord2 } = buildCoordinator(c2, (l) => lines.push(l));
    await coord2.pairWithPassword('bluesky', {
      identifier: 'me.bsky.social',
      password: 'SECRET-APP-PASSWORD',
      operations: ['publish'],
    });

    expect(lines.length).toBeGreaterThan(0);
    const blob = lines.join('\n');
    for (const secret of [
      'SECRET-ACCESS-PAIRED',
      'SECRET-REFRESH-PAIRED',
      'SECRET-APP-PASSWORD',
      'AUTH-CODE-123',
    ]) {
      expect(blob).not.toContain(secret);
    }
    // Safe correlation fields ARE present.
    expect(blob).toContain('auth.pairing_completed');
    expect(blob).toContain('twitch');
  });
});
