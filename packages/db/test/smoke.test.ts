/**
 * Smoke test for @social/db: exercises the migration runner + every repository
 * against an in-memory SQLite database, proving the SQLite adapters are drop-in
 * for the @social/auth and @social/queue in-memory ports.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountRecord, AccountTokenRecord } from '@social/auth';
import { Database, SqliteAdvisoryLock } from '../src/index';

const EXPECTED_TABLES = [
  'platforms',
  'accounts',
  'account_tokens',
  'campaigns',
  'posts',
  'post_variants',
  'media_assets',
  'media_renditions',
  'post_variant_media',
  'schedules',
  'scheduled_campaigns',
  'publish_jobs',
  'dead_letter_jobs',
  'analytics_snapshots',
  'short_urls',
  'logs',
  'advisory_locks',
  'schema_migrations',
  'app_settings',
];

function tableNames(db: Database): string[] {
  return db
    .raw()
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .map((r) => r.name);
}

/** Seed the FK chain a publish job's post_variant depends on; returns variant id. */
function seedVariant(db: Database, platformId: string, accountId: string): string {
  const now = new Date().toISOString();
  db.raw().run('INSERT INTO posts (id, brief, created_at, updated_at) VALUES (?, ?, ?, ?)', [
    'post_1',
    'a test brief',
    now,
    now,
  ]);
  db.raw().run(
    `INSERT INTO post_variants (id, post_id, account_id, platform_id, payload, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['pv_1', 'post_1', accountId, platformId, JSON.stringify({ text: 'hello' }), now, now],
  );
  return 'pv_1';
}

describe('@social/db smoke', () => {
  let db: Database;

  beforeEach(() => {
    db = Database.sqlite({ filename: ':memory:' });
  });

  afterEach(() => {
    db.close();
  });

  it('(a) migration runner applies 0001+0002+0003 and creates all tables', () => {
    const applied = db.migrate();
    expect(applied).toEqual([
      '0001_init',
      '0002_advisory_locks',
      '0003_publish_job_payload',
      '0004_url_tracking',
      '0005_collect_analytics_operation',
      '0006_scheduled_campaigns',
      '0007_app_settings',
    ]);
    const tables = tableNames(db);
    for (const t of EXPECTED_TABLES) {
      expect(tables, `missing table ${t}`).toContain(t);
    }
    // Re-running is idempotent.
    expect(db.migrate()).toEqual([]);
    // publish_jobs.payload column exists (migration 0003).
    const cols = db
      .raw()
      .all<{ name: string }>('PRAGMA table_info(publish_jobs)')
      .map((c) => c.name);
    expect(cols).toContain('payload');
  });

  it('(b) round-trips an account + a sealed-token row (never plaintext)', async () => {
    db.migrate();
    db.platforms.upsert({
      id: 'discord',
      displayName: 'Discord',
      apiBaseUrl: 'https://discord.com/api',
      contractVersion: '1.0.0',
    });

    const now = new Date().toISOString();
    const account: AccountRecord = {
      id: 'acc_1',
      platformId: 'discord',
      remoteId: 'remote-123',
      handle: 'tester',
      displayName: 'Tester',
      avatarUrl: null,
      profileUrl: null,
      profileMetadata: { locale: 'en' },
      status: 'active',
      connectedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const inserted = await db.accounts.insert(account);
    expect(inserted).toEqual(account);
    expect(await db.accounts.getByRemote('discord', 'remote-123')).toEqual(account);
    expect((await db.accounts.list({ platformId: 'discord' })).length).toBe(1);

    // A sealed token: only ciphertext + AEAD params + key ref. No plaintext.
    const token: AccountTokenRecord = {
      id: 'tok_1',
      accountId: 'acc_1',
      accessTokenCiphertext: 'BASE64_CIPHERTEXT_v1',
      refreshTokenCiphertext: null,
      encryptionKeyRef: 'local:v1',
      encryptionAlg: 'aes-256-gcm',
      nonce: 'BASE64_NONCE',
      authTag: 'BASE64_TAG',
      tokenType: 'Bearer',
      scopes: ['messages.write', 'webhook.incoming'],
      expiresAt: now,
      obtainedAt: now,
      rotatedAt: null,
      isCurrent: true,
      createdAt: now,
      updatedAt: now,
    };
    await db.tokens.insert(token);
    const current = await db.tokens.getCurrent('acc_1');
    expect(current).toEqual(token);
    expect(current?.scopes).toEqual(['messages.write', 'webhook.incoming']);

    // Rotate: old row becomes non-current, new row is the sole current one.
    const later = new Date(Date.now() + 1000).toISOString();
    const rotated: AccountTokenRecord = {
      ...token,
      id: 'tok_2',
      accessTokenCiphertext: 'BASE64_CIPHERTEXT_v2',
      nonce: 'BASE64_NONCE_2',
      obtainedAt: later,
      createdAt: later,
      updatedAt: later,
    };
    const result = await db.tokens.rotateCurrent(rotated);
    expect(result.isCurrent).toBe(true);
    expect(result.id).toBe('tok_2');
    const all = await db.tokens.listByAccount('acc_1');
    expect(all.length).toBe(2);
    expect(all.filter((t) => t.isCurrent).length).toBe(1);
    const old = all.find((t) => t.id === 'tok_1');
    expect(old?.isCurrent).toBe(false);
    expect(old?.rotatedAt).toBe(later);

    // No plaintext ever stored — the ciphertext columns hold only the sealed
    // blob we supplied.
    const rawRow = db
      .raw()
      .get<{ access_token_ciphertext: string }>(
        'SELECT access_token_ciphertext FROM account_tokens WHERE id = ?',
        ['tok_2'],
      );
    expect(rawRow?.access_token_ciphertext).toBe('BASE64_CIPHERTEXT_v2');
  });

  it('(c) enqueues, claims, and dead-letters a job through the JobStore repo', async () => {
    db.migrate();
    db.platforms.upsert({
      id: 'discord',
      displayName: 'Discord',
      apiBaseUrl: 'https://discord.com/api',
      contractVersion: '1.0.0',
    });
    const now = new Date().toISOString();
    await db.accounts.insert({
      id: 'acc_1',
      platformId: 'discord',
      remoteId: 'remote-123',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    } as AccountRecord);
    const variantId = seedVariant(db, 'discord', 'acc_1');

    const { job, deduped } = await db.jobs.enqueue({
      postVariantId: variantId,
      payload: { text: 'hello world' },
    });
    expect(deduped).toBe(false);
    expect(job.status).toBe('pending');
    expect(job.payload).toEqual({ text: 'hello world' });

    // Idempotent enqueue dedupes to the same row.
    const second = await db.jobs.enqueue({ postVariantId: variantId, payload: { text: 'x' } });
    expect(second.deduped).toBe(true);
    expect(second.job.id).toBe(job.id);

    // Claim it.
    const claimed = await db.jobs.claimDueJobs(new Date(), 10, 'worker-1');
    expect(claimed.length).toBe(1);
    expect(claimed[0]?.status).toBe('claimed');
    expect(claimed[0]?.claimedBy).toBe('worker-1');
    // Not re-claimable while claimed.
    expect((await db.jobs.claimDueJobs(new Date(), 10, 'worker-2')).length).toBe(0);

    await db.jobs.markRunning(job.id);

    // Reclaim-sweep support (t22): a job stuck in 'running' with a stale
    // claimed_at is found once its lease has expired, and not before.
    expect(await db.jobs.findStuckJobs?.(new Date(), 60_000)).toEqual([]);
    const stuck = await db.jobs.findStuckJobs?.(new Date(Date.now() + 60_001), 60_000);
    expect(stuck?.length).toBe(1);
    expect(stuck?.[0]?.id).toBe(job.id);
    expect(stuck?.[0]?.status).toBe('running');

    // Retryable failure -> back to pending with backoff.
    const retried = await db.jobs.markFailedForRetry(
      job.id,
      { code: 'rate_limited', message: 'slow down' },
      new Date(Date.now() + 60_000),
    );
    expect(retried.status).toBe('pending');
    expect(retried.attempts).toBe(1);
    expect(retried.lastErrorCode).toBe('rate_limited');

    // Dead-letter it.
    const { job: dead, deadLetter } = await db.jobs.markDead(
      job.id,
      { code: 'publish_failed', message: 'gave up' },
      'exhausted_retries',
    );
    expect(dead.status).toBe('dead');
    expect(dead.attempts).toBe(2);
    expect(deadLetter.publishJobId).toBe(job.id);
    expect(deadLetter.postVariantId).toBe(variantId);
    expect(deadLetter.payloadSnapshot).toEqual({ text: 'hello world' });

    const dlq = await db.jobs.listDeadLetters();
    expect(dlq.length).toBe(1);
  });

  it('(d) acquires and releases an advisory lock (with mutual exclusion)', async () => {
    db.migrate();

    let sawRowDuringCritical = false;
    const value = await db.advisoryLock.withLock('refresh:acc_1', 'worker-1', 5000, async () => {
      const row = db
        .raw()
        .get<{ holder: string }>('SELECT holder FROM advisory_locks WHERE lock_key = ?', [
          'refresh:acc_1',
        ]);
      sawRowDuringCritical = row?.holder === 'worker-1';
      return 42;
    });
    expect(value).toBe(42);
    expect(sawRowDuringCritical).toBe(true);

    // Released after the critical section.
    const after = db
      .raw()
      .get('SELECT * FROM advisory_locks WHERE lock_key = ?', ['refresh:acc_1']);
    expect(after).toBeUndefined();

    // Re-acquire works after release.
    await expect(
      db.advisoryLock.withLock('refresh:acc_1', 'worker-2', 5000, async () => 'ok'),
    ).resolves.toBe('ok');

    // Mutual exclusion: a live lock held by another worker blocks acquisition
    // until the timeout, then throws.
    const nowMs = Date.now();
    db.raw().run(
      'INSERT INTO advisory_locks (lock_key, holder, acquired_at, expires_at) VALUES (?, ?, ?, ?)',
      [
        'refresh:acc_2',
        'other-worker',
        new Date(nowMs).toISOString(),
        new Date(nowMs + 60_000).toISOString(),
      ],
    );
    const contended = new SqliteAdvisoryLockFactory(db);
    await expect(
      contended.withLock('refresh:acc_2', 'worker-3', 5000, async () => 'never'),
    ).rejects.toThrow(/not acquired/);
  });
});

// Small helper to build an advisory lock with a fast acquire timeout so the
// mutual-exclusion assertion resolves quickly.
class SqliteAdvisoryLockFactory {
  private readonly lock: SqliteAdvisoryLock;
  constructor(db: Database) {
    this.lock = new SqliteAdvisoryLock(db.raw(), {
      acquireTimeoutMs: 60,
      pollIntervalMs: 10,
    });
  }
  withLock<T>(key: string, holder: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    return this.lock.withLock(key, holder, ttlMs, fn);
  }
}
