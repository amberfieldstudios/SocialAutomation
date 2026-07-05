/**
 * Shared integration-test harness: a fresh in-memory `@social/db` (migrated),
 * a `buildPipeline()` instance with plugins loaded from the real `plugins/*`
 * directories, and a helper to pair a mock account (seal a token into the
 * vault, exactly like a real OAuth/app-password pairing would).
 *
 * All platform HTTP is mocked by each test file itself (undici `MockAgent` for
 * Discord, `vi.stubGlobal('fetch', ...)` for Twitch/Bluesky) — this harness
 * never talks to a real network.
 */

import { randomUUID } from 'node:crypto';
import type { LogFields, StructuredLogger, TokenSet } from '@social/core';
import { Database } from '@social/db';
import { buildPipeline, type BuildPipelineOptions, type Pipeline } from '../src/pipeline';

export interface CapturedLine {
  level: string;
  message: string;
  fields?: LogFields;
}

/** A `StructuredLogger` that records every line (for redaction assertions) instead of writing to stdout. */
export class CapturingLogger implements StructuredLogger {
  constructor(public readonly lines: CapturedLine[] = []) {}
  child(): StructuredLogger {
    return this; // share the buffer across children so one assertion covers the whole call tree
  }
  trace(message: string, fields?: LogFields): void {
    this.lines.push({ level: 'trace', message, fields });
  }
  debug(message: string, fields?: LogFields): void {
    this.lines.push({ level: 'debug', message, fields });
  }
  info(message: string, fields?: LogFields): void {
    this.lines.push({ level: 'info', message, fields });
  }
  warn(message: string, fields?: LogFields): void {
    this.lines.push({ level: 'warn', message, fields });
  }
  error(message: string, fields?: LogFields): void {
    this.lines.push({ level: 'error', message, fields });
  }
}

export interface TestHarness {
  db: Database;
  logger: CapturingLogger;
  pipeline: Pipeline;
  /** Register a `platforms` row + a paired account with a sealed current token. Returns the new accountId. */
  pairAccount(input: { platformId: string; remoteId: string; token: TokenSet; displayName?: string }): Promise<string>;
  /** All log lines emitted so far, JSON-serialized (for a single "no raw secret anywhere" substring check). */
  serializedLogs(): string;
}

export async function buildHarness(
  now: () => Date = () => new Date('2026-07-04T12:00:00.000Z'),
  /** Optional worker overrides (e.g. a fast `pollIntervalMs`) — for tests exercising `worker.start()`/`stop()`, not just `runOnce()`. */
  worker?: BuildPipelineOptions['worker'],
): Promise<TestHarness> {
  const logger = new CapturingLogger();
  const db = Database.sqlite({ filename: ':memory:' }, { logger });
  db.migrate();

  const pipeline = await buildPipeline({ db, logger, now, ...(worker ? { worker } : {}) });
  await pipeline.loadPlugins();

  async function pairAccount(input: { platformId: string; remoteId: string; token: TokenSet; displayName?: string }): Promise<string> {
    const capabilities = pipeline.connectors.resolve(input.platformId).capabilities;
    db.platforms.upsert({
      id: input.platformId,
      displayName: capabilities.displayName,
      apiBaseUrl: capabilities.apiBaseUrl,
      contractVersion: capabilities.contractVersion,
      capabilities,
    });

    const summary = await pipeline.accountManager.addAccount(
      {
        platformId: input.platformId,
        remoteId: input.remoteId,
        displayName: input.displayName ?? input.remoteId,
      },
      input.token,
    );
    return summary.id;
  }

  return {
    db,
    logger,
    pipeline,
    pairAccount,
    serializedLogs: () => JSON.stringify(logger.lines),
  };
}

/** A token that never expires (e.g. a Discord bot token) — `TokenManager` never tries to refresh it. */
export function nonExpiringToken(accessToken: string, overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken,
    tokenType: 'bot',
    scopes: [],
    obtainedAt: new Date('2026-07-04T00:00:00.000Z').toISOString(),
    ...overrides,
  };
}

/** A token with a far-future expiry (well outside the refresh skew window) so `createContext` never triggers a real refresh call. */
export function farFutureToken(accessToken: string, overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken,
    tokenType: 'Bearer',
    scopes: [],
    obtainedAt: new Date('2026-07-04T00:00:00.000Z').toISOString(),
    expiresAt: new Date('2026-07-04T23:00:00.000Z').toISOString(),
    ...overrides,
  };
}

export function uniqueId(): string {
  return randomUUID();
}
