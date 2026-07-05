/**
 * `buildPipeline()` — wires the whole end-to-end publish path together:
 *
 *   PluginRegistry (discovered from plugins/*)
 *     -> PluginConnectorResolver (this package)
 *     -> TokenManager / AccountManager (@social/auth, DB-backed)
 *     -> PublishService.submitPost() -> validatePost -> post_variants row -> JobStore.enqueue()
 *     -> Worker.runOnce()/start() -> createPublishHandler() -> connector.publish(ctx)
 *     -> JobStore.markSucceeded/markFailedForRetry/markDead (+ post_variants write-back)
 *
 * Every store (`accounts`, `tokens`, `jobs`, `advisoryLock`) is the real
 * `@social/db` SQLite-backed implementation, not the in-memory ports — the
 * whole point of this package is to prove persistence, not just wiring.
 */

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AppCredentials, PluginLoaderOptions, PublishResult, StructuredLogger } from '@social/core';
import { FileSystemPluginLoader, InMemoryPluginRegistry } from '@social/core';
import type { Database } from '@social/db';
import { AccountManager, LocalKeyProvider, TokenManager, TokenVault } from '@social/auth';
import type { KeyProvider } from '@social/auth';
import { deriveIdempotencyKey, Worker } from '@social/queue';
import type { BackoffOptions, JobEventListener, JobLifecycleEvent, PublishJobRecord } from '@social/queue';
import type { ContentProvider } from '@social/ai';
import { AnalyticsCollector, CampaignAggregator } from '@social/analytics';
import type { LinkRewriter } from '@social/analytics';
import { ScheduleMaterializer, ScheduleService } from '@social/scheduler';
import type { ScheduleRecord, ScheduleSubmitFn } from '@social/scheduler';

import { StaticAppCredentialsResolver } from './app-credentials';
import { SecureAppCredentialsStore, type SecureAppCredentialsStoreOptions } from './secure-app-credentials';
import { PluginConnectorResolver } from './connector-resolver';
import { createPublishHandler } from './publish-worker';
import { createAnalyticsHandler } from './analytics-worker';
import type { AnalyticsJobPayload } from './analytics-worker';
import { PostVariantsRepo } from './post-variants-repo';
import { PublishService } from './publish-service';
import type { PublishJobPayload } from './publish-service';
import { CampaignService } from './campaign-service';
import type { ComposeAndSubmitInput } from './campaign-service';

/** `packages/pipeline/src/..` -> the workspace root (`SocialAutomation/`). */
export function defaultWorkspaceRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

export interface BuildPipelineOptions {
  db: Database;
  logger: StructuredLogger;
  /** Custom key provider; defaults to a fresh in-memory `LocalKeyProvider` (fine for tests, NOT for prod persistence across restarts). */
  keyProvider?: KeyProvider;
  appCredentials?: Record<string, AppCredentials>;
  /**
   * Options for the encrypted-at-rest OAuth app-credentials store (t15,
   * QG-2) — a persisted 32-byte key by default (survives a restart, unlike
   * `keyProvider` above), sealing Twitch/Reddit/Mastodon Client ID/Secret via
   * the same AES-256-GCM primitives the token vault uses, stored in
   * `options.db.settings`. See `secure-app-credentials.ts`'s doc comment.
   */
  secureAppCredentials?: Omit<SecureAppCredentialsStoreOptions, 'settings' | 'logger'>;
  /** Platforms `buildPipeline` loads persisted app credentials for on startup. Defaults to the guided OAuth platforms (Twitch/Reddit/Mastodon) — Discord/Bluesky use platform_token/platform_password grants with no app-level Client ID/Secret. */
  appCredentialPlatformIds?: readonly string[];
  /** Where to discover plugins from. Defaults to the monorepo root + `plugins/*`. */
  pluginLoader?: Partial<PluginLoaderOptions>;
  now?: () => Date;
  worker?: {
    batchSize?: number;
    pollIntervalMs?: number;
    backoff?: Partial<BackoffOptions>;
    workerId?: string;
    random?: () => number;
  };
  onJobEvent?: JobEventListener;
  /**
   * If supplied, `buildPipeline` also constructs a `CampaignService` wired to
   * the same connectors/publishService (see `Pipeline.campaigns`). Omitted by
   * default so this package never forces an AI dependency/API key on callers
   * that only need the m3 submit/worker path; pass `MockProvider` in tests or
   * `ClaudeProvider` in production to opt in.
   */
  contentProvider?: ContentProvider;
  /** Where `CampaignService` writes derived media renditions; forwarded as-is. */
  mediaOutDir?: string;
  /** Optional (t21): forwarded to `CampaignService` so campaign links are rewritten to tracked
   * (UTM-tagged, optionally shortened) URLs before generation. Omitted -> no URL tracking, same as before t21. */
  linkRewriter?: LinkRewriter;
}

/**
 * Input to `PipelineScheduler.scheduleCampaign` — a `ComposeAndSubmitInput`
 * (the same shape `CampaignService.composeAndSubmit` takes directly) plus the
 * `ScheduleService` timing parameters for when/how often it should fire.
 * `occurrenceKey` is excluded: the materializer supplies it per-occurrence.
 */
export interface ScheduleCampaignInput extends Omit<ComposeAndSubmitInput, 'occurrenceKey'> {
  mode: 'immediate' | 'once' | 'recurring';
  /** Required for `mode: 'once'`. Local wall-clock time, e.g. `'2026-07-04T09:00:00'`. */
  localDateTime?: string;
  /** Required for `mode: 'once'` and `'recurring'`. IANA timezone, e.g. `'Africa/Johannesburg'`. */
  timezone?: string;
  /** Required for `mode: 'recurring'`. Local wall-clock anchor the recurrence pattern is evaluated against. */
  startLocalDateTime?: string;
  /** Required for `mode: 'recurring'`. RFC-5545 RRULE or 5-field cron expression. */
  recurrenceRule?: string;
}

export interface PipelineScheduler {
  service: ScheduleService;
  materializer: ScheduleMaterializer;
  /**
   * Registers a campaign brief (a `posts` row the `schedules.post_id` FK
   * anchors to) and creates the `schedules` row per `input.mode`. Each time
   * `materializer.materializeDue()` fires a due occurrence for the returned
   * schedule, the ORIGINAL `ComposeAndSubmitInput` is re-run through
   * `CampaignService.composeAndSubmit` (fresh generation -> media -> validate
   * -> enqueue, per platform/account target) with that occurrence's
   * `occurrenceKey` threaded through for idempotent enqueueing.
   */
  scheduleCampaign(input: ScheduleCampaignInput): ScheduleRecord;
}

export interface EnqueueAnalyticsCollectionInput {
  platform: string;
  accountId: string;
  postVariantId: string;
  /** Platform-native post id (`post_variants.remote_id`, set by `markPublished` after a successful publish). */
  remoteId: string;
  since?: string;
  until?: string;
  /** Stable identity for a repeated collection pass (e.g. "today's daily collection run") — folded into the idempotency key so re-running the same pass never double-enqueues. Omit for a one-off collection. */
  occurrenceKey?: string;
  maxAttempts?: number;
}

export interface PipelineAnalytics {
  collector: AnalyticsCollector;
  aggregator: CampaignAggregator;
  /** Enqueues a `collect_analytics` job, driven by the same worker/retry/DLQ machinery as publish jobs. */
  enqueueCollection(input: EnqueueAnalyticsCollectionInput): Promise<{ jobId: string; deduped: boolean }>;
}

export interface Pipeline {
  connectors: PluginConnectorResolver;
  accountManager: AccountManager;
  tokenManager: TokenManager;
  vault: TokenVault;
  /** Runtime-settable per-platform developer-app credentials (setup wizard, t1). */
  appCredentials: StaticAppCredentialsResolver;
  /** Encrypted-at-rest persistence for `appCredentials` (t15, QG-2) — callers that accept new app credentials (e.g. the wizard's save-app-credentials route) should call BOTH `appCredentials.set()` (immediate in-memory effect) and `secureAppCredentials.set()` (survives a restart). */
  secureAppCredentials: SecureAppCredentialsStore;
  variants: PostVariantsRepo;
  publishService: PublishService;
  /** Only present when `BuildPipelineOptions.contentProvider` was supplied. */
  campaigns?: CampaignService;
  /** (t23) Scheduling wiring: immediate/scheduled/recurring campaigns flowing through `CampaignService.composeAndSubmit` on each materialized occurrence. `scheduleCampaign` throws if no `contentProvider` was configured. */
  scheduler: PipelineScheduler;
  /** (t23) Analytics collection wired through the queue's `collect_analytics` operation, plus campaign roll-up. */
  analytics: PipelineAnalytics;
  worker: Worker;
  /** Populates the plugin registry by scanning the filesystem. Call once before publishing. */
  loadPlugins(): Promise<void>;
}

function randomLocalKeyProvider(): LocalKeyProvider {
  return new LocalKeyProvider({ v1: randomBytes(32) }, 'v1');
}

/** Discord/Bluesky use platform_token/platform_password grants (docs/AUTH.md §1) — no app-level Client ID/Secret to persist. */
const DEFAULT_APP_CREDENTIAL_PLATFORM_IDS = ['twitch', 'reddit', 'mastodon'] as const;

export async function buildPipeline(options: BuildPipelineOptions): Promise<Pipeline> {
  const now = options.now ?? (() => new Date());
  const logger = options.logger;
  const registry = new InMemoryPluginRegistry();
  const connectors = new PluginConnectorResolver({ registry, logger, now });

  const vault = new TokenVault(options.keyProvider ?? randomLocalKeyProvider());
  const appCredentials = new StaticAppCredentialsResolver(options.appCredentials ?? {});

  const secureAppCredentials = new SecureAppCredentialsStore({
    keyProvider: options.secureAppCredentials?.keyProvider ?? randomLocalKeyProvider(),
    settings: options.db.settings,
    logger,
  });
  // Reload any previously-saved OAuth app credentials (Twitch/Reddit/Mastodon
  // Client ID/Secret) on startup, so a restart doesn't silently break token
  // refresh for those platforms (t15, QG-2) — this is the fix; see
  // `secure-app-credentials.ts` for the persisted-key design and why it's
  // independent of `vault` above.
  const persistedAppCredentials = await secureAppCredentials.loadAll(
    options.appCredentialPlatformIds ?? DEFAULT_APP_CREDENTIAL_PLATFORM_IDS,
  );
  for (const [platformId, credentials] of Object.entries(persistedAppCredentials)) {
    appCredentials.set(platformId, credentials);
  }

  const tokenManager = new TokenManager({
    vault,
    accounts: options.db.accounts,
    tokens: options.db.tokens,
    locks: options.db.advisoryLock,
    connectors,
    appCredentials,
    logger,
    now,
  });

  const accountManager = new AccountManager({
    accounts: options.db.accounts,
    tokens: options.db.tokens,
    tokenManager,
    logger,
    now,
  });

  const variants = new PostVariantsRepo(options.db.raw(), { now });

  const publishService = new PublishService({
    connectors,
    jobs: options.db.jobs,
    variants,
    now,
  });

  // --- Analytics (t20/t23): AnalyticsCollector always constructed (it only
  // needs the connectors resolver + the real `analytics_snapshots` store,
  // both already available) so `collect_analytics` jobs work out of the box,
  // exactly like the publish path -- no extra opt-in flag needed. ---------
  const analyticsCollector = new AnalyticsCollector({
    connectors,
    store: options.db.analyticsSnapshots,
    logger,
    now,
  });
  const analyticsAggregator = new CampaignAggregator({ store: options.db.analyticsSnapshots, logger, now });

  async function enqueueAnalyticsCollection(
    input: EnqueueAnalyticsCollectionInput,
  ): Promise<{ jobId: string; deduped: boolean }> {
    const payload: AnalyticsJobPayload = {
      platform: input.platform,
      accountId: input.accountId,
      postVariantId: input.postVariantId,
      remoteId: input.remoteId,
      ...(input.since !== undefined ? { since: input.since } : {}),
      ...(input.until !== undefined ? { until: input.until } : {}),
    };
    const idempotencyKey = input.occurrenceKey
      ? deriveIdempotencyKey({ postVariantId: input.postVariantId, operation: 'collect_analytics', occurrenceKey: input.occurrenceKey })
      : undefined;
    const { job, deduped } = await options.db.jobs.enqueue({
      postVariantId: input.postVariantId,
      operation: 'collect_analytics',
      payload,
      // Same clock the Worker claims on (see PublishService.now doc) — a job
      // enqueued at the pipeline's logical now must be due to that same worker.
      availableAt: now(),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
    });
    return { jobId: job.id, deduped };
  }

  const publishHandler = createPublishHandler({ connectors, accounts: accountManager });
  const analyticsHandler = createAnalyticsHandler({
    connectors,
    accounts: accountManager,
    collector: analyticsCollector,
    logger,
  });

  /** Dispatches on `job.operation` -- `collect_analytics` jobs run through the analytics
   * handler, everything else (`publish`/`edit`/`delete`) through the existing publish handler.
   * Both share the same `Worker` instance, and therefore the same claim/retry/backoff/DLQ machinery. */
  async function handler(job: PublishJobRecord): Promise<unknown> {
    return job.operation === 'collect_analytics' ? analyticsHandler(job) : publishHandler(job);
  }

  const onEvent: JobEventListener = async (event: JobLifecycleEvent) => {
    if (event.type === 'job.published' && event.job.operation === 'publish') {
      variants.markPublished(event.job.postVariantId, event.result as PublishResult);
    } else if (event.type === 'job.dead_lettered' && event.job.operation !== 'collect_analytics') {
      // A dead-lettered analytics collection must never revert an already-published
      // variant's status -- only publish/edit/delete failures mark a variant failed.
      variants.markFailed(event.job.postVariantId);
    }
    await options.onJobEvent?.(event);
  };

  const worker = new Worker({
    store: options.db.jobs,
    handler,
    logger,
    now,
    ...(options.worker?.batchSize !== undefined ? { batchSize: options.worker.batchSize } : {}),
    ...(options.worker?.pollIntervalMs !== undefined ? { pollIntervalMs: options.worker.pollIntervalMs } : {}),
    ...(options.worker?.backoff !== undefined ? { backoff: options.worker.backoff } : {}),
    ...(options.worker?.workerId !== undefined ? { workerId: options.worker.workerId } : {}),
    ...(options.worker?.random !== undefined ? { random: options.worker.random } : {}),
    onEvent,
  });

  async function loadPlugins(): Promise<void> {
    const loader = new FileSystemPluginLoader();
    const workspaceRoot = options.pluginLoader?.workspaceRoot ?? defaultWorkspaceRoot();
    await loader.loadInto(registry, {
      workspaceRoot,
      ...(options.pluginLoader?.pluginGlobs ? { pluginGlobs: options.pluginLoader.pluginGlobs } : {}),
    });
  }

  const campaigns = options.contentProvider
    ? new CampaignService({
        connectors,
        publishService,
        provider: options.contentProvider,
        logger,
        ...(options.mediaOutDir ? { mediaOutDir: options.mediaOutDir } : {}),
        ...(options.linkRewriter ? { linkRewriter: options.linkRewriter } : {}),
      })
    : undefined;

  // --- Scheduling (t19/t23/t30): ScheduleService + ScheduleMaterializer wired
  // to CampaignService.composeAndSubmit as the materializer's `submit` port,
  // so a due schedule occurrence flows generation -> media -> validate ->
  // enqueue (LinkRewriter included, since it's already baked into `campaigns`
  // above) with that occurrence's `occurrenceKey` threaded through for
  // idempotency.
  //
  // `schedules.post_id` FKs into a real `posts` row (DB constraint), but a
  // recurring campaign's actual content (description/platforms/link/...)
  // doesn't fit the `schedules` table's columns. `scheduleCampaign` creates a
  // placeholder `posts` row to anchor the FK, and (t30) persists the real
  // `ComposeAndSubmitInput` in the `scheduled_campaigns` table, keyed by
  // `schedule.id` -- see `packages/db/migrations/0006_scheduled_campaigns.sql`.
  // The spec references accounts/platforms by id only, never a token/secret.
  //
  // `campaignSpecCache` is ONLY a same-process read-through cache in front of
  // that store -- unlike the old in-memory Map, a cache MISS falls through to
  // `options.db.scheduledCampaigns.getByScheduleId()`, so a fresh process
  // (after a restart, or a materializer running in a different process than
  // the one that created the schedule) still resolves the spec correctly. ---
  const campaignSpecCache = new Map<string, Omit<ComposeAndSubmitInput, 'occurrenceKey'>>();

  const scheduleService = new ScheduleService({ schedules: options.db.schedules, logger, now });

  function loadCampaignSpec(scheduleId: string): Omit<ComposeAndSubmitInput, 'occurrenceKey'> | undefined {
    const cached = campaignSpecCache.get(scheduleId);
    if (cached) return cached;
    const row = options.db.scheduledCampaigns.getByScheduleId<Omit<ComposeAndSubmitInput, 'occurrenceKey'>>(scheduleId);
    if (!row) return undefined;
    campaignSpecCache.set(scheduleId, row.composeSpec);
    return row.composeSpec;
  }

  const submitOccurrence: ScheduleSubmitFn = async ({ schedule, occurrenceKey }) => {
    if (!campaigns) {
      throw new Error(
        'ScheduleMaterializer: cannot submit -- buildPipeline was not given a `contentProvider` (no CampaignService configured).',
      );
    }
    const spec = loadCampaignSpec(schedule.id);
    if (!spec) {
      throw new Error(`No persisted campaign spec for schedule ${schedule.id} (postId=${schedule.postId ?? 'null'}).`);
    }
    const result = await campaigns.composeAndSubmit({ ...spec, occurrenceKey });
    const enqueued = result.results.filter((r) => r.status === 'enqueued');
    const first = enqueued[0];
    return {
      ...(first?.postVariantId !== undefined ? { postVariantId: first.postVariantId } : {}),
      ...(first?.jobId !== undefined ? { jobId: first.jobId } : {}),
      deduped: enqueued.length > 0 && enqueued.every((r) => r.deduped === true),
      campaignResult: result,
    };
  };

  const materializer = new ScheduleMaterializer({ schedules: options.db.schedules, submit: submitOccurrence, logger, now });

  function scheduleCampaign(input: ScheduleCampaignInput): ScheduleRecord {
    if (!campaigns) {
      throw new Error('buildPipeline: schedule.scheduleCampaign requires a `contentProvider` (CampaignService) to be configured.');
    }
    const { mode, localDateTime, timezone, startLocalDateTime, recurrenceRule, ...composeSpec } = input;

    const postId = variants.createPost({
      campaignId: composeSpec.campaignId ?? composeSpec.campaign ?? null,
      title: composeSpec.title ?? null,
      brief: composeSpec.description,
      linkUrl: composeSpec.link ?? null,
    });

    let record: ScheduleRecord;
    if (mode === 'immediate') {
      record = scheduleService.scheduleImmediate({ postId });
    } else if (mode === 'once') {
      if (!localDateTime || !timezone) throw new Error('schedule mode "once" requires `localDateTime` + `timezone`.');
      record = scheduleService.scheduleOnce({ postId, localDateTime, timezone });
    } else if (mode === 'recurring') {
      if (!startLocalDateTime || !timezone || !recurrenceRule) {
        throw new Error('schedule mode "recurring" requires `startLocalDateTime` + `timezone` + `recurrenceRule`.');
      }
      record = scheduleService.scheduleRecurring({ postId, startLocalDateTime, timezone, recurrenceRule });
    } else {
      throw new Error(`Unknown schedule mode "${String(mode)}".`);
    }

    // Persist the compose spec durably (t30) keyed by the schedule id just
    // created, so `submitOccurrence` can reload it after a restart -- see
    // `loadCampaignSpec` above. The in-process cache is populated eagerly here
    // too, purely as an optimization (avoids a DB round-trip for the very next
    // materialize call in THIS process).
    options.db.scheduledCampaigns.create({ scheduleId: record.id, composeSpec });
    campaignSpecCache.set(record.id, composeSpec);

    return record;
  }

  return {
    connectors,
    accountManager,
    tokenManager,
    vault,
    appCredentials,
    secureAppCredentials,
    variants,
    publishService,
    ...(campaigns ? { campaigns } : {}),
    scheduler: { service: scheduleService, materializer, scheduleCampaign },
    analytics: { collector: analyticsCollector, aggregator: analyticsAggregator, enqueueCollection: enqueueAnalyticsCollection },
    worker,
    loadPlugins,
  };
}

export type { PublishJobPayload };
