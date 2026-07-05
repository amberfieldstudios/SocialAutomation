/**
 * The shared PlatformConnector conformance suite.
 *
 * `runConformance` registers a `describe` block of one `it` per contract
 * requirement, so any test runner (vitest) reports a PASS/FAIL verdict per
 * requirement per connector. Every requirement maps to the connector-conformance
 * skill checklist:
 *
 *   1. Contract completeness   — all 10 methods present; operations map complete.
 *   2. Unsupported-op pairing  — every operations.<op>=false throws NotSupportedError.
 *   3. Validate-before-publish — publish/edit reject what validatePost rejects,
 *                                without hitting the network.
 *   4. Capability honesty      — convenience flags mirror the operations map;
 *                                apiBaseUrl targets an allowed official host.
 *   5. Auth discipline         — the runtime carries no token/vault (tokens arrive
 *                                only via OperationContext, and are used from it).
 *   6. Rate-limit mapping      — a 429 surfaces as a retryable RateLimitError.
 *   7. Official-API-only       — every request host is an allowed official host.
 *   8. Logging / redaction     — no raw token substring appears in any log line.
 */

import { describe, expect, it } from 'vitest';

import {
  NotSupportedError,
  RateLimitError,
  ValidationFailedError,
  isRetryable,
  resolveCapabilities,
  type CapabilityDescriptor,
  type ConnectorFactory,
  type ConnectorOperation,
  type MediaSource,
  type OperationContext,
  type PlatformConnector,
} from '@social/core';

import { CapturingLogger, hostOf, installFetch, serializeRequests } from './mock-http';
import type { ConformanceMockEnv } from './types';

export const ALL_OPERATIONS: ConnectorOperation[] = [
  'connect',
  'authenticate',
  'refreshToken',
  'validatePost',
  'uploadMedia',
  'publish',
  'delete',
  'edit',
  'getAnalytics',
  'disconnect',
];

const NOW = () => new Date('2026-07-04T12:00:00.000Z');

function makeCtx(env: ConformanceMockEnv, logger: CapturingLogger): OperationContext {
  return {
    token: env.token,
    app: env.app ?? { clientId: 'conformance-client' },
    accountId: env.accountId ?? 'acct-conformance',
    logger,
  };
}

/**
 * Invoke `op` with placeholder-but-well-typed arguments. Used only to probe that
 * a declared-unsupported operation throws before doing any work.
 */
function callOperation(
  connector: PlatformConnector,
  op: ConnectorOperation,
  ctx: OperationContext,
  env: ConformanceMockEnv,
): Promise<unknown> {
  const remoteId = env.sampleRemoteId ?? 'conformance-remote-id';
  const app = env.app ?? { clientId: 'conformance-client' };
  const media: MediaSource = { assetId: 'asset-1', mimeType: 'image/png', uri: 'file:///conformance/pixel.png', bytes: 4 };
  switch (op) {
    case 'connect':
      return connector.connect({ app });
    case 'authenticate':
      return connector.authenticate({ kind: 'authorize_url', app, state: 's', scopes: [] });
    case 'refreshToken':
      return connector.refreshToken({ app, token: env.token });
    case 'validatePost':
      return connector.validatePost(env.validPayload);
    case 'uploadMedia':
      return connector.uploadMedia(media, ctx);
    case 'publish':
      return connector.publish(env.validPayload, ctx);
    case 'delete':
      return connector.delete({ remoteId }, ctx);
    case 'edit':
      return connector.edit({ remoteId, payload: env.validPayload }, ctx);
    case 'getAnalytics':
      return connector.getAnalytics({ remoteId }, ctx);
    case 'disconnect':
      return connector.disconnect(ctx);
    default:
      return Promise.reject(new Error(`unknown operation ${op as string}`));
  }
}

export interface RunConformanceOptions {
  /** Override the describe() label; defaults to `${platform} connector conformance`. */
  label?: string;
}

/**
 * Register the conformance suite for one connector. Call at module top level in
 * a plugin's `test/conformance.test.ts`.
 */
export function runConformance(
  factory: ConnectorFactory,
  capabilities: CapabilityDescriptor,
  env: ConformanceMockEnv,
  options: RunConformanceOptions = {},
): void {
  const label = options.label ?? `${capabilities.platform} connector conformance`;

  // Fresh connector + logger per test so captured logs never bleed across cases.
  const build = (): { connector: PlatformConnector; logger: CapturingLogger } => {
    const logger = new CapturingLogger();
    const runtime = { logger, now: NOW };
    const connector = factory(runtime);
    return { connector, logger };
  };

  // Contract v1.1: the effective descriptor for the harness's OperationContext
  // token — a connector's `capabilitiesFor(token)` override when implemented
  // (e.g. Discord narrowing refreshToken/disconnect for a bot/webhook
  // credential), otherwise the static `capabilities`. Every pairing/honesty
  // check below is scoped to THIS descriptor, since that's what actually
  // governs calls made with `env.token`.
  const effectiveCapabilities: CapabilityDescriptor = resolveCapabilities(build().connector, env.token);

  describe(label, () => {
    // -- 1. Contract completeness --------------------------------------------
    describe('contract completeness', () => {
      it('implements all ten PlatformConnector methods as functions', () => {
        const { connector } = build();
        for (const op of ALL_OPERATIONS) {
          expect(typeof (connector as unknown as Record<string, unknown>)[op]).toBe('function');
        }
      });

      it('declares a boolean in operations for all ten methods', () => {
        for (const op of ALL_OPERATIONS) {
          expect(typeof capabilities.operations[op]).toBe('boolean');
        }
      });
    });

    // -- 2. Unsupported-op pairing -------------------------------------------
    describe('unsupported operations throw NotSupportedError', () => {
      const unsupported = ALL_OPERATIONS.filter((op) => effectiveCapabilities.operations[op] === false);

      if (unsupported.length === 0) {
        it('declares no unsupported operations (nothing to probe)', () => {
          expect(unsupported).toHaveLength(0);
        });
      }

      for (const op of unsupported) {
        it(`${op}: declared false AND throws NotSupportedError`, async () => {
          const { connector } = build();
          // A network stub that fails loudly proves the throw happens before any call.
          const { calls, restore } = installFetch(
            {
              ...env,
              route: () => {
                throw new Error('unsupported op must not touch the network');
              },
            },
            'ok',
          );
          try {
            const ctx = makeCtx(env, new CapturingLogger());
            await expect(callOperation(connector, op, ctx, env)).rejects.toBeInstanceOf(NotSupportedError);
            expect(calls).toHaveLength(0);
          } finally {
            restore();
          }
        });
      }
    });

    // -- 3. Validate-before-publish ------------------------------------------
    describe('validate-before-publish', () => {
      it('publish refuses what validatePost rejects, without hitting the network', async () => {
        const { connector, logger } = build();
        const validation = await connector.validatePost(env.invalidPayload);
        expect(validation.ok).toBe(false); // fixture sanity: invalidPayload really is invalid

        const { calls, restore } = installFetch(env, 'ok');
        try {
          const ctx = makeCtx(env, logger);
          await expect(connector.publish(env.invalidPayload, ctx)).rejects.toBeInstanceOf(ValidationFailedError);
          expect(calls).toHaveLength(0);
        } finally {
          restore();
        }
      });

      if (capabilities.operations.edit === true) {
        it('edit refuses what validatePost rejects, without hitting the network', async () => {
          const { connector } = build();
          const { calls, restore } = installFetch(env, 'ok');
          try {
            const ctx = makeCtx(env, new CapturingLogger());
            const remoteId = env.sampleRemoteId ?? 'conformance-remote-id';
            await expect(connector.edit({ remoteId, payload: env.invalidPayload }, ctx)).rejects.toBeInstanceOf(
              ValidationFailedError,
            );
            expect(calls).toHaveLength(0);
          } finally {
            restore();
          }
        });
      }
    });

    // -- 4. Capability honesty -----------------------------------------------
    describe('capability honesty', () => {
      it('convenience flags mirror the operations map', () => {
        expect(capabilities.supportsEdit).toBe(capabilities.operations.edit);
        expect(capabilities.supportsDelete).toBe(capabilities.operations.delete);
        expect(capabilities.supportsMediaUpload).toBe(capabilities.operations.uploadMedia);
        expect(capabilities.supportsAnalytics).toBe(capabilities.operations.getAnalytics);
      });

      it('apiBaseUrl targets a declared official host', () => {
        const host = hostOf(capabilities.apiBaseUrl);
        expect(host).not.toBe('');
        expect(env.allowedHosts).toContain(host);
      });

      it('platform id matches the descriptor used by the harness', () => {
        const { connector } = build();
        expect(connector.capabilities.platform).toBe(capabilities.platform);
      });
    });

    // -- 5. Auth discipline ---------------------------------------------------
    describe('auth discipline', () => {
      it('the runtime given to the connector carries no token/vault/credentials', () => {
        const seen: Record<string, unknown> = {};
        const runtime = {
          logger: new CapturingLogger(),
          now: NOW,
        };
        factory(runtime);
        Object.assign(seen, runtime);
        for (const forbidden of ['token', 'tokens', 'vault', 'credentials', 'accessToken', 'secret']) {
          expect(forbidden in seen).toBe(false);
        }
      });

      it('uses the OperationContext token to authenticate to the platform (token reaches an allowed host)', async () => {
        const { connector, logger } = build();
        const { calls, restore } = installFetch(env, 'ok');
        try {
          const ctx = makeCtx(env, logger);
          await connector.publish(env.validPayload, ctx);
          // The token must have been sent to the platform (header or body) — proving
          // it flowed in via ctx, not from connector-held storage.
          const outbound = serializeRequests(calls);
          expect(outbound).toContain(env.token.accessToken);
          // …and every call that carried it went to an allowed host.
          for (const call of calls) {
            expect(env.allowedHosts).toContain(hostOf(call.url));
          }
        } finally {
          restore();
        }
      });
    });

    // -- 6. Rate-limit mapping ------------------------------------------------
    describe('rate-limit mapping', () => {
      it('maps a 429 into a retryable RateLimitError', async () => {
        const { connector, logger } = build();
        const { restore } = installFetch(env, 'rateLimited');
        try {
          const ctx = makeCtx(env, logger);
          const error = await connector.publish(env.validPayload, ctx).catch((e: unknown) => e);
          expect(error).toBeInstanceOf(RateLimitError);
          expect(isRetryable(error)).toBe(true);
        } finally {
          restore();
        }
      });
    });

    // -- 7. Official-API-only -------------------------------------------------
    describe('official API only', () => {
      it('every request during a publish targets an allowed official host', async () => {
        const { connector, logger } = build();
        const { calls, restore } = installFetch(env, 'ok');
        try {
          const ctx = makeCtx(env, logger);
          await connector.publish(env.validPayload, ctx);
          expect(calls.length).toBeGreaterThan(0); // fixture sanity: a real request happened
          for (const call of calls) {
            const host = hostOf(call.url);
            expect(host, `request to disallowed host: ${call.method} ${call.url}`).not.toBe('');
            expect(env.allowedHosts, `request to disallowed host: ${host}`).toContain(host);
          }
        } finally {
          restore();
        }
      });
    });

    // -- 8. Logging / redaction ----------------------------------------------
    describe('logging redaction', () => {
      it('emits no raw secret substring in any log line during a publish', async () => {
        const { connector, logger } = build();
        const { restore } = installFetch(env, 'ok');
        try {
          const ctx = makeCtx(env, logger);
          await connector.publish(env.validPayload, ctx);
          const serialized = logger.serialized();
          for (const secret of env.secrets) {
            expect(serialized, `secret leaked into a log line: ${secret.slice(0, 6)}…`).not.toContain(secret);
          }
        } finally {
          restore();
        }
      });
    });
  });
}
