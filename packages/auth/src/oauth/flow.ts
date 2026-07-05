/**
 * Pairing orchestration (docs/AUTH.md §6): begin/complete an OAuth pairing,
 * poll a device flow, or run a direct credential (app-password / bot-token)
 * flow. On success, tokens are sealed via `TokenManager` and the account is
 * created/attached via `AccountManager` with profile metadata.
 *
 * This coordinator OWNS the CSRF `state`, the PKCE verifier/challenge, and the
 * pairing session (auth's responsibility per §0). The connector OWNS the actual
 * platform HTTP handshake (authorize URL, code exchange, device/password
 * exchange), reached only through a `PairingConnectorResolver` — never by
 * importing a plugin.
 *
 * SECURITY: PKCE verifiers, device codes, app passwords, `code`, and tokens are
 * never logged. Only `platform`, `grant`, scope NAMES, `operations`, `accountId`,
 * and `remoteId` appear in log fields.
 */

import type { PlatformProfile, StructuredLogger } from '@social/core';
import type { AccountManager } from '../account-manager';
import { PairingResultError, PairingStateError, UnsupportedGrantError } from '../errors';
import { resolveRequestedScopes, validateGranted } from '../scopes';
import type { AppCredentialsResolver } from '../token-manager';
import type { TokenManager } from '../token-manager';
import type { AccountSummary } from '../types';
import { pollForDeviceToken, type DevicePollOptions } from './device-flow';
import { challengeFor, createState, createVerifier } from './pkce';
import {
  defaultFlowRegistry,
  type FlowDescriptor,
  type FlowRegistry,
  type GrantKind,
  type PairingAuthResult,
  type PairingConnectorResolver,
} from './registry';
import type { PairingSession, PairingSessionStore } from './state-store';
import type { ConnectorOperation } from '@social/core';

/** Device authorization details safe to hand to the UI (NO secret device code). */
export interface DeviceAuthorizationPublic {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresInSec: number;
  intervalSec: number;
}

export type BeginPairingResult =
  | { kind: 'authorize_url'; state: string; authorizeUrl: string; scopes: string[] }
  | { kind: 'device_code'; state: string; deviceAuthorization: DeviceAuthorizationPublic; scopes: string[] };

export interface BeginPairingOptions {
  /** Select an alternate grant the platform offers (e.g. Twitch `device_code`). */
  grant?: GrantKind;
}

export interface PasswordPairingParams {
  /** e.g. a Bluesky handle. */
  identifier: string;
  /** SECRET — the app password. Sealed on success; never logged. */
  password: string;
  operations: ConnectorOperation[];
}

export interface TokenPairingParams {
  /** SECRET — the bot token or the incoming-webhook URL. */
  token: string;
  /** 'bot' | 'webhook' (Discord) or any static-secret type. */
  tokenType: string;
  /** Identity for the account row (bot/webhook flows resolve this out of band). */
  profile: PlatformProfile;
  /** Granted scopes to record, if any. */
  scopes?: string[];
  /** Enabled operations (for scope validation, if the platform is scoped). */
  operations?: ConnectorOperation[];
}

export interface PairingCoordinatorDeps {
  sessions: PairingSessionStore;
  connectors: PairingConnectorResolver;
  appCredentials: AppCredentialsResolver;
  accounts: AccountManager;
  tokenManager: TokenManager;
  logger: StructuredLogger;
  registry?: FlowRegistry;
  now?: () => Date;
  /** Pairing-session lifetime. Default 10 minutes (docs/AUTH.md §6). */
  sessionTtlMs?: number;
}

const DEFAULT_SESSION_TTL_MS = 10 * 60_000;

export class PairingCoordinator {
  private readonly registry: FlowRegistry;
  private readonly now: () => Date;
  private readonly sessionTtlMs: number;

  constructor(private readonly deps: PairingCoordinatorDeps) {
    this.registry = deps.registry ?? defaultFlowRegistry;
    this.now = deps.now ?? (() => new Date());
    this.sessionTtlMs = deps.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  }

  // -------------------------------------------------------------------------
  // Authorization-code + device-code entry
  // -------------------------------------------------------------------------

  /**
   * Start pairing for `operations` on `platformId`. Resolves least-privilege
   * scopes, generates CSRF `state` (+ PKCE verifier/challenge for PKCE grants),
   * saves the session, and asks the connector for the authorize URL (auth-code)
   * or a device authorization (device-code).
   */
  async beginPairing(
    platformId: string,
    operations: ConnectorOperation[],
    options: BeginPairingOptions = {},
  ): Promise<BeginPairingResult> {
    const descriptor = this.descriptor(platformId);
    const grant = this.selectGrant(descriptor, options.grant);
    const scopes = this.resolveScopes(platformId, operations);
    const state = createState();
    const app = await this.deps.appCredentials.get(platformId);
    const connector = await this.deps.connectors.get(platformId);
    const log = this.log(platformId);

    if (grant === 'auth_code' || grant === 'auth_code_pkce') {
      const usePkce = grant === 'auth_code_pkce';
      const codeVerifier = usePkce ? createVerifier() : undefined;
      const codeChallenge = codeVerifier ? challengeFor(codeVerifier) : undefined;

      const result = await connector.authenticate({
        kind: 'authorize_url',
        app,
        state,
        scopes,
        ...(codeChallenge ? { codeChallenge } : {}),
      });
      if (!result.authorizeUrl) {
        throw new PairingResultError(platformId, 'Connector did not return an authorize URL.');
      }

      await this.deps.sessions.save(
        this.newSession(state, platformId, grant, operations, scopes, { codeVerifier }),
      );
      log.info('auth.pairing_started', { platform: platformId, grant, scopes, operations });
      return { kind: 'authorize_url', state, authorizeUrl: result.authorizeUrl, scopes };
    }

    if (grant === 'device_code') {
      const result = await connector.authenticate({ kind: 'device_code', app, scopes });
      const device = result.deviceAuthorization;
      if (!device) {
        throw new PairingResultError(platformId, 'Connector did not return a device authorization.');
      }
      await this.deps.sessions.save(
        this.newSession(state, platformId, grant, operations, scopes, { deviceCode: device.deviceCode }),
      );
      log.info('auth.pairing_started', { platform: platformId, grant, scopes, operations });
      return {
        kind: 'device_code',
        state,
        scopes,
        deviceAuthorization: {
          userCode: device.userCode,
          verificationUri: device.verificationUri,
          ...(device.verificationUriComplete ? { verificationUriComplete: device.verificationUriComplete } : {}),
          expiresInSec: device.expiresInSec,
          intervalSec: device.intervalSec,
        },
      };
    }

    throw new UnsupportedGrantError(
      platformId,
      grant,
      `Grant "${grant}" is a direct flow; use pairWithPassword()/pairWithToken() instead of beginPairing().`,
    );
  }

  /**
   * Complete an authorization-code pairing from the platform callback. Loads the
   * session by `state` (single-use), verifies it exists and is not expired
   * (CSRF-safe), exchanges the `code` (with the PKCE verifier), validates scopes,
   * seals the token, and upserts the account.
   */
  async completePairing(state: string, code: string): Promise<AccountSummary> {
    const session = await this.deps.sessions.take(state);
    if (!session) {
      this.log('unknown').warn('auth.pairing_rejected', { reason: 'unknown_state' });
      throw new PairingStateError('unknown');
    }
    if (this.isExpired(session)) {
      this.log(session.platformId).warn('auth.pairing_rejected', {
        platform: session.platformId,
        reason: 'expired',
      });
      throw new PairingStateError('expired');
    }

    const app = await this.deps.appCredentials.get(session.platformId);
    const connector = await this.deps.connectors.get(session.platformId);
    const result = await connector.authenticate({
      kind: 'exchange_code',
      app,
      code,
      state,
      ...(session.codeVerifier ? { codeVerifier: session.codeVerifier } : {}),
    });
    return this.finishPairing(session.platformId, session.operations, result);
  }

  /**
   * Complete a device-code pairing: poll the connector until the user approves
   * the code, then validate scopes, seal the token, and upsert the account.
   */
  async pollDevicePairing(state: string, pollOptions?: Partial<DevicePollOptions>): Promise<AccountSummary> {
    const session = await this.deps.sessions.get(state);
    if (!session || !session.deviceCode) {
      throw new PairingStateError('unknown');
    }
    if (this.isExpired(session)) {
      await this.deps.sessions.remove(state);
      throw new PairingStateError('expired');
    }
    const app = await this.deps.appCredentials.get(session.platformId);
    const connector = await this.deps.connectors.get(session.platformId);

    const remainingSec = Math.max(1, Math.floor((Date.parse(session.expiresAt) - this.now().getTime()) / 1000));
    const result = await pollForDeviceToken(connector, app, session.deviceCode, session.platformId, {
      intervalSec: pollOptions?.intervalSec ?? 5,
      expiresInSec: pollOptions?.expiresInSec ?? remainingSec,
      ...(pollOptions?.now ? { now: pollOptions.now } : {}),
      ...(pollOptions?.sleep ? { sleep: pollOptions.sleep } : {}),
      ...(pollOptions?.slowDownIncrementSec !== undefined
        ? { slowDownIncrementSec: pollOptions.slowDownIncrementSec }
        : {}),
      ...(pollOptions?.maxAttempts !== undefined ? { maxAttempts: pollOptions.maxAttempts } : {}),
    });
    await this.deps.sessions.remove(state);
    return this.finishPairing(session.platformId, session.operations, result);
  }

  // -------------------------------------------------------------------------
  // Direct flows (no browser redirect)
  // -------------------------------------------------------------------------

  /**
   * Direct credential pairing (AT Protocol app password, docs/AUTH.md §1
   * Bluesky). Exchanges handle + app password for a session, then — per decision
   * A — seals the app password as a NON-CURRENT bootstrap row so the session can
   * be re-created without re-prompting.
   */
  async pairWithPassword(platformId: string, params: PasswordPairingParams): Promise<AccountSummary> {
    const descriptor = this.descriptor(platformId);
    if (descriptor.grant !== 'platform_password') {
      throw new UnsupportedGrantError(platformId, 'platform_password');
    }
    const scopes = this.resolveScopes(platformId, params.operations);
    const app = await this.deps.appCredentials.get(platformId);
    const connector = await this.deps.connectors.get(platformId);

    const result = await connector.authenticate({
      kind: 'password',
      app,
      identifier: params.identifier,
      password: params.password,
      scopes,
    });
    const summary = await this.finishPairing(platformId, params.operations, result);

    if (descriptor.storeCredentialAsBootstrap) {
      await this.deps.tokenManager.storeTokens(
        summary.id,
        { accessToken: params.password, scopes: [], obtainedAt: this.now().toISOString() },
        {
          ...(descriptor.bootstrapTokenType ? { tokenType: descriptor.bootstrapTokenType } : {}),
          isCurrent: false,
        },
      );
      this.log(platformId).info('auth.bootstrap_credential_stored', {
        platform: platformId,
        accountId: summary.id,
        tokenType: descriptor.bootstrapTokenType ?? null,
      });
    }
    return summary;
  }

  /**
   * Direct static-secret pairing (Discord bot token / incoming webhook, §1).
   * There is no code exchange: the supplied token IS the credential. It is sealed
   * as the current (non-expiring, non-refreshable) token and the account is
   * created from the supplied profile.
   */
  async pairWithToken(platformId: string, params: TokenPairingParams): Promise<AccountSummary> {
    const operations = params.operations ?? [];
    const granted = params.scopes ?? [];
    // Only enforce scopes if the platform is actually scoped (Discord bot path is not).
    if (operations.length > 0) {
      validateGranted(platformId, operations, granted);
    }
    const summary = await this.deps.accounts.addAccount(
      { platformId, ...profileToInput(params.profile) },
      {
        accessToken: params.token,
        scopes: granted,
        tokenType: params.tokenType,
        obtainedAt: this.now().toISOString(),
      },
      { tokenType: params.tokenType },
    );
    this.log(platformId).info('auth.pairing_completed', {
      platform: platformId,
      accountId: summary.id,
      remoteId: summary.remoteId,
      grant: 'platform_token',
      scopes: granted,
    });
    return summary;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Shared tail for every flow that yields a token+profile: validate granted
   * scopes cover the enabled operations, then upsert the account and seal the
   * token. Returns a secret-free summary.
   */
  private async finishPairing(
    platformId: string,
    operations: ConnectorOperation[],
    result: PairingAuthResult,
  ): Promise<AccountSummary> {
    if (!result.token) {
      throw new PairingResultError(platformId, 'Connector completed the flow without returning a token.');
    }
    if (!result.profile) {
      throw new PairingResultError(platformId, 'Connector completed the flow without returning a profile.');
    }
    // Least-privilege: granted must cover exactly the operations we requested.
    validateGranted(platformId, operations, result.token.scopes);

    const summary = await this.deps.accounts.addAccount(
      { platformId, ...profileToInput(result.profile) },
      result.token,
      { ...(result.token.tokenType ? { tokenType: result.token.tokenType } : {}) },
    );
    this.log(platformId).info('auth.pairing_completed', {
      platform: platformId,
      accountId: summary.id,
      remoteId: summary.remoteId,
      scopes: result.token.scopes,
    });
    return summary;
  }

  private descriptor(platformId: string): FlowDescriptor {
    const descriptor = this.registry.get(platformId);
    if (!descriptor) {
      throw new UnsupportedGrantError(platformId, 'unknown', `No flow descriptor registered for "${platformId}".`);
    }
    return descriptor;
  }

  private selectGrant(descriptor: FlowDescriptor, requested?: GrantKind): GrantKind {
    if (!requested || requested === descriptor.grant) return descriptor.grant;
    if (descriptor.alternates?.includes(requested)) return requested;
    throw new UnsupportedGrantError(descriptor.platformId, requested);
  }

  private resolveScopes(platformId: string, operations: ConnectorOperation[]): string[] {
    return resolveRequestedScopes(platformId, operations);
  }

  private newSession(
    state: string,
    platformId: string,
    grant: GrantKind,
    operations: ConnectorOperation[],
    scopes: string[],
    secrets: { codeVerifier?: string; deviceCode?: string },
  ): PairingSession {
    const nowMs = this.now().getTime();
    return {
      state,
      platformId,
      grant,
      operations,
      scopes,
      ...(secrets.codeVerifier ? { codeVerifier: secrets.codeVerifier } : {}),
      ...(secrets.deviceCode ? { deviceCode: secrets.deviceCode } : {}),
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + this.sessionTtlMs).toISOString(),
    };
  }

  private isExpired(session: PairingSession): boolean {
    return Date.parse(session.expiresAt) <= this.now().getTime();
  }

  private log(platformId: string): StructuredLogger {
    return this.deps.logger.child({ platform: platformId });
  }
}

/** Map a `PlatformProfile` onto the profile fields of an account input (no platformId). */
function profileToInput(profile: PlatformProfile): {
  remoteId: string;
  handle?: string;
  displayName?: string;
  avatarUrl?: string;
  profileUrl?: string;
} {
  return {
    remoteId: profile.remoteId,
    ...(profile.handle !== undefined ? { handle: profile.handle } : {}),
    ...(profile.displayName !== undefined ? { displayName: profile.displayName } : {}),
    ...(profile.avatarUrl !== undefined ? { avatarUrl: profile.avatarUrl } : {}),
    ...(profile.profileUrl !== undefined ? { profileUrl: profile.profileUrl } : {}),
  };
}
