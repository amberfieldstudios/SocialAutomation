/**
 * Shared test doubles: a minimal `CapabilityDescriptor`, a stub
 * `PlatformConnector` implementing only what the collector touches
 * (`capabilities` + `getAnalytics`), and a real SQLite-backed `Database` (via
 * `@social/db`) seeded with the FK chain `analytics_snapshots` needs
 * (platform -> account -> post -> post_variant -> campaign).
 */

import { randomUUID } from 'node:crypto';
import type {
  AnalyticsQuery,
  AnalyticsSnapshot,
  CapabilityDescriptor,
  OperationContext,
  PlatformConnector,
} from '@social/core';
import { Database } from '@social/db';
import { createLogger } from '@social/logging';
import type { ConnectorResolverPort } from '../src/types';

export function baseCapabilities(overrides: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor {
  return {
    platform: 'mock',
    displayName: 'Mock',
    apiBaseUrl: 'https://mock.example/api',
    contractVersion: '1.0.0',
    operations: {
      connect: true,
      authenticate: true,
      refreshToken: true,
      validatePost: true,
      uploadMedia: false,
      publish: true,
      delete: false,
      edit: false,
      getAnalytics: true,
      disconnect: true,
    },
    supportsEdit: false,
    supportsDelete: false,
    supportsScheduling: false,
    supportsThreads: false,
    supportsAnalytics: true,
    supportsMediaUpload: false,
    characterLimit: 500,
    urlsCountTowardLimit: false,
    maxMediaCount: 0,
    supportedMediaTypes: [],
    mediaConstraints: [],
    ...overrides,
  };
}

export type GetAnalyticsFn = (
  query: AnalyticsQuery,
  ctx: OperationContext,
) => Promise<AnalyticsSnapshot>;

/** Stub connector — only `capabilities` and `getAnalytics` are wired; everything else throws if called. */
export function makeConnector(
  capabilities: CapabilityDescriptor,
  getAnalytics?: GetAnalyticsFn,
): PlatformConnector {
  const notImplemented = () => {
    throw new Error('not implemented in test stub');
  };
  return {
    capabilities,
    connect: notImplemented,
    authenticate: notImplemented,
    refreshToken: notImplemented,
    validatePost: notImplemented,
    uploadMedia: notImplemented,
    publish: notImplemented,
    delete: notImplemented,
    edit: notImplemented,
    getAnalytics: getAnalytics ?? notImplemented,
    disconnect: notImplemented,
  } as unknown as PlatformConnector;
}

/** `ConnectorResolverPort` backed by a static platform -> connector map. */
export function makeResolver(connectors: Record<string, PlatformConnector>): ConnectorResolverPort {
  return {
    resolve(platformId: string): PlatformConnector {
      const connector = connectors[platformId];
      if (!connector) throw new Error(`no test connector registered for platform "${platformId}"`);
      return connector;
    },
  };
}

export function makeCtx(): OperationContext {
  return {
    accountId: 'acc_test',
    token: {
      accessToken: 'test-access-token',
      scopes: [],
      obtainedAt: new Date().toISOString(),
    },
    logger: createLogger({ sink: () => {}, service: 'test' }),
  };
}

export interface SeededFixture {
  db: Database;
  platformId: string;
  accountId: string;
  campaignId: string;
  postId: string;
  postVariantId: string;
}

/** Seeds a real in-memory SQLite DB with the FK chain analytics_snapshots needs. */
export function seedFixture(db: Database, platformId = 'mock'): SeededFixture {
  db.migrate();
  const now = new Date().toISOString();
  db.platforms.upsert({
    id: platformId,
    displayName: platformId,
    apiBaseUrl: 'https://mock.example/api',
    contractVersion: '1.0.0',
  });

  const accountId = `acc_${randomUUID()}`;
  db.raw().run(
    `INSERT INTO accounts (id, platform_id, remote_id, status, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?)`,
    [accountId, platformId, `remote-${accountId}`, now, now],
  );

  const campaignId = `camp_${randomUUID()}`;
  db.raw().run(
    `INSERT INTO campaigns (id, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`,
    [campaignId, 'Test Campaign', now, now],
  );

  const postId = `post_${randomUUID()}`;
  db.raw().run(
    `INSERT INTO posts (id, campaign_id, brief, status, created_at, updated_at)
     VALUES (?, ?, 'a test brief', 'published', ?, ?)`,
    [postId, campaignId, now, now],
  );

  const postVariantId = `pv_${randomUUID()}`;
  db.raw().run(
    `INSERT INTO post_variants (id, post_id, account_id, platform_id, payload, status, remote_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'published', ?, ?, ?)`,
    [postVariantId, postId, accountId, platformId, JSON.stringify({ text: 'hello' }), `remote-${postVariantId}`, now, now],
  );

  return { db, platformId, accountId, campaignId, postId, postVariantId };
}
