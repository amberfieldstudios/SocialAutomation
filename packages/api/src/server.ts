/**
 * @social/api's Fastify BFF: a thin REST surface over the real
 * `@social/pipeline` stack (AccountManager, CampaignService, PublishService,
 * `@social/queue`'s JobStore, `@social/scheduler`'s ScheduleService,
 * `@social/analytics`'s CampaignAggregator) plus `@social/db` for reads.
 *
 * Every response is a typed, hand-picked projection — account summaries are
 * already secret-free (`AccountSummary` has no token/secret fields, see
 * `@social/auth`), and nothing here ever reads or forwards `account_tokens`
 * rows. Structured logs go through `@social/logging`'s redacting logger.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { KNOWN_PLATFORM_IDS, type AppContext } from './context';
import { composePreview } from './preview';
import { listCampaigns, listHistory } from './history';
import { registerPairingRoutes } from './pairing-routes';
import { registerWizardStateRoutes } from './wizard-state-routes';
import { registerModelRoutes } from './model-routes';
import { registerUpdateRoutes } from './update-routes';

export interface CreateServerOptions {
  logger?: boolean;
  /**
   * Absolute path to the built @social/ui `dist` directory. When provided,
   * the server serves it as static assets with an SPA fallback to
   * `index.html` for any non-`/api/*` GET request that doesn't match a real
   * file — this is what lets a single `PORT` (see `src/prod.ts`) serve both
   * the API and the dashboard, same-origin, with no UI code changes (the UI
   * already calls relative `/api/...` paths, see `packages/ui/vite.config.ts`).
   */
  uiDist?: string;
}

export async function createServer(ctx: AppContext, options: CreateServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  if (options.uiDist) {
    const uiDist = options.uiDist;
    await app.register(fastifyStatic, {
      root: uiDist,
      index: false, // handled by the SPA-fallback hook below so /api/* isn't shadowed
    });
    // SPA fallback: any GET that isn't /api/* and doesn't match a static
    // file falls back to index.html (client-side router support). Registered
    // as a hook (not a catch-all route) so it runs after route matching
    // fails, never intercepting the real /api/* handlers below.
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET' || req.url.startsWith('/api/')) {
        reply.status(404).send({ error: 'not found' });
        return;
      }
      reply.type('text/html').sendFile('index.html', uiDist);
    });
  }

  // The AI_PROVIDER-selected provider built once in createAppContext (mock
  // by default; claude/openai when opted in) — compose-preview uses the same
  // instance the pipeline generates with, so previews match real submits.
  const provider = ctx.contentProvider;
  // `ScheduleService`/`CampaignAggregator` come straight from the wired
  // `Pipeline` (see @social/pipeline's buildPipeline) — not re-constructed
  // here — so this API shares the exact same scheduler/analytics wiring
  // (including `scheduleCampaign`'s composeAndSubmit-on-materialize path)
  // as the rest of the system, instead of a second, divergent instance.
  const { scheduler, analytics } = ctx.pipeline;

  const log = ctx.logger.child({ module: 'api.server' });

  app.addHook('onRequest', async (req) => {
    log.info('http.request', { method: req.method, url: req.url });
  });

  app.setErrorHandler((err, req, reply) => {
    log.error('http.error', { method: req.method, url: req.url, error: err.message });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    reply.status(status).send({ error: err.message });
  });

  // ---------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------
  app.get('/api/health', async () => ({ ok: true }));

  // ---------------------------------------------------------------------
  // Platforms (capabilities the composer/UI needs: char limits, media rules)
  // ---------------------------------------------------------------------
  app.get('/api/platforms', async () => {
    // The plugin registry only exposes manifests via `get(platform)`; there is
    // no `list()` on the resolver, so we go through the well-known platform
    // ids the seeded accounts use. In a follow-up, `@social/core`'s
    // `PluginRegistry.list()` could be surfaced through the resolver directly.
    const platforms = [];
    for (const id of KNOWN_PLATFORM_IDS) {
      try {
        const connector = ctx.pipeline.connectors.resolve(id);
        platforms.push({ id, capabilities: connector.capabilities });
      } catch {
        // Not installed in this environment — skip silently.
      }
    }
    return { platforms };
  });

  // ---------------------------------------------------------------------
  // Accounts (connected-accounts manager)
  // ---------------------------------------------------------------------
  app.get('/api/accounts', async (req) => {
    const { platformId, status } = req.query as { platformId?: string; status?: string };
    const accounts = await ctx.pipeline.accountManager.listAccounts({
      ...(platformId ? { platformId } : {}),
      ...(status ? { status: status as never } : {}),
    });
    return { accounts };
  });

  app.post('/api/accounts', async (req, reply) => {
    const body = req.body as {
      platformId: string;
      remoteId: string;
      handle?: string;
      displayName?: string;
      avatarUrl?: string;
      profileUrl?: string;
    };
    if (!body?.platformId || !body?.remoteId) {
      return reply.status(400).send({ error: 'platformId and remoteId are required' });
    }
    const account = await ctx.pipeline.accountManager.addAccount({
      platformId: body.platformId,
      remoteId: body.remoteId,
      ...(body.handle ? { handle: body.handle } : {}),
      ...(body.displayName ? { displayName: body.displayName } : {}),
      ...(body.avatarUrl ? { avatarUrl: body.avatarUrl } : {}),
      ...(body.profileUrl ? { profileUrl: body.profileUrl } : {}),
    });
    return reply.status(201).send({ account });
  });

  app.post('/api/accounts/:id/reconnect', async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await ctx.pipeline.accountManager.getAccount(id);
    if (!existing) return reply.status(404).send({ error: 'account not found' });
    // No real OAuth in this dashboard (mock data only): simulate a successful
    // reconnect by flipping status back to active.
    const account = await ctx.pipeline.accountManager.setStatus(id, 'active');
    return { account };
  });

  app.delete('/api/accounts/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await ctx.pipeline.accountManager.getAccount(id);
    if (!existing) return reply.status(404).send({ error: 'account not found' });
    await ctx.pipeline.accountManager.removeAccount(id);
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------------
  // Setup wizard (t1): app-credential capture, redirect/password/token
  // pairing flows, and per-account "test this connection".
  // ---------------------------------------------------------------------
  registerPairingRoutes(app, ctx);

  // ---------------------------------------------------------------------
  // Setup wizard (t2): first-run detection + server-side resume state.
  // ---------------------------------------------------------------------
  registerWizardStateRoutes(app, ctx);

  // ---------------------------------------------------------------------
  // On-device LLM model (t4): download progress + trigger/decline surface.
  // The model is fetched on first use into the per-user data dir (never
  // bundled); declining leaves the credential-free fallback active.
  // ---------------------------------------------------------------------
  registerModelRoutes(app, ctx);

  // ---------------------------------------------------------------------
  // Update story (t7): non-nagging "a new version is available" check
  // against GitHub Releases (opt-in via SOCIAL_AUTOMATION_UPDATE_REPO) +
  // per-version dismiss. See docs/UPDATING.md.
  // ---------------------------------------------------------------------
  registerUpdateRoutes(app, ctx);

  // ---------------------------------------------------------------------
  // Campaign composer: preview (no side effects) + submit (real enqueue)
  // ---------------------------------------------------------------------
  app.post('/api/compose-preview', async (req, reply) => {
    const body = req.body as {
      description: string;
      title?: string;
      link?: string;
      tags?: string[];
      mentions?: string[];
      campaign?: string;
      cta?: string;
      platforms: { platformId: string; accountId: string; platformOptions?: Record<string, unknown> }[];
    };
    if (!body?.description || !body?.platforms?.length) {
      return reply.status(400).send({ error: 'description and at least one platform target are required' });
    }
    const results = await composePreview(
      { ...body, platforms: body.platforms },
      { connectors: ctx.pipeline.connectors, provider, logger: ctx.logger },
    );
    return { results };
  });

  app.post('/api/campaigns', async (req, reply) => {
    const body = req.body as {
      description: string;
      title?: string;
      link?: string;
      tags?: string[];
      mentions?: string[];
      campaign?: string;
      cta?: string;
      // `platformOptions` (t14): per-target platform-specific fields the UI
      // collects (e.g. Reddit's required `subreddit`) — was previously
      // dropped here, which is exactly why every Reddit campaign was
      // rejected with `subreddit_required` (QG-1). Threaded straight through
      // to `CampaignService.composeAndSubmit`, which already merges it onto
      // the generated payload (`campaign-service.ts` ~line 292) before
      // `validatePost`/`publish`.
      platforms: { platformId: string; accountId: string; platformOptions?: Record<string, unknown> }[];
    };
    if (!body?.description || !body?.platforms?.length) {
      return reply.status(400).send({ error: 'description and at least one platform target are required' });
    }
    if (!ctx.pipeline.campaigns) {
      return reply.status(500).send({ error: 'campaign service not configured' });
    }
    const result = await ctx.pipeline.campaigns.composeAndSubmit({
      description: body.description,
      ...(body.title ? { title: body.title } : {}),
      ...(body.link ? { link: body.link } : {}),
      ...(body.tags ? { tags: body.tags } : {}),
      ...(body.mentions ? { mentions: body.mentions } : {}),
      ...(body.campaign ? { campaign: body.campaign } : {}),
      ...(body.cta ? { cta: body.cta } : {}),
      platforms: body.platforms.map((p) => ({
        platformId: p.platformId,
        accountId: p.accountId,
        ...(p.platformOptions ? { platformOptions: p.platformOptions } : {}),
      })),
    });
    return reply.status(201).send(result);
  });

  // ---------------------------------------------------------------------
  // Queue / jobs (upcoming, in-flight, failed, dead-lettered)
  // ---------------------------------------------------------------------
  app.get('/api/jobs', async (req) => {
    const { status } = req.query as { status?: string };
    const all = await ctx.db.jobs.listAll();
    const jobs = status ? all.filter((j) => j.status === status) : all;
    return { jobs };
  });

  app.get('/api/jobs/dead-letters', async () => {
    const jobs = await ctx.db.jobs.listDeadLetters();
    return { jobs };
  });

  // ---------------------------------------------------------------------
  // Schedules
  // ---------------------------------------------------------------------
  app.get('/api/schedules', async () => {
    const schedules = await ctx.db.schedules.list();
    return { schedules };
  });

  /**
   * Creates a schedule for a full campaign compose spec (description +
   * platform targets), via `Pipeline.scheduler.scheduleCampaign`. On each due
   * occurrence, the ORIGINAL spec is re-run through
   * `CampaignService.composeAndSubmit` (fresh AI generation -> validate ->
   * enqueue) — not a one-shot job captured at schedule-creation time.
   */
  app.post('/api/schedules', async (req, reply) => {
    const body = req.body as {
      mode: 'immediate' | 'once' | 'recurring';
      description: string;
      title?: string;
      link?: string;
      tags?: string[];
      mentions?: string[];
      campaign?: string;
      cta?: string;
      platforms: { platformId: string; accountId: string }[];
      localDateTime?: string;
      startLocalDateTime?: string;
      timezone?: string;
      recurrenceRule?: string;
    };
    if (!body?.description || !body?.platforms?.length || !body?.mode) {
      return reply.status(400).send({ error: 'mode, description, and at least one platform target are required' });
    }
    try {
      const schedule = scheduler.scheduleCampaign({
        mode: body.mode,
        description: body.description,
        ...(body.title ? { title: body.title } : {}),
        ...(body.link ? { link: body.link } : {}),
        ...(body.tags ? { tags: body.tags } : {}),
        ...(body.mentions ? { mentions: body.mentions } : {}),
        ...(body.campaign ? { campaign: body.campaign } : {}),
        ...(body.cta ? { cta: body.cta } : {}),
        platforms: body.platforms,
        ...(body.localDateTime ? { localDateTime: body.localDateTime } : {}),
        ...(body.startLocalDateTime ? { startLocalDateTime: body.startLocalDateTime } : {}),
        ...(body.timezone ? { timezone: body.timezone } : {}),
        ...(body.recurrenceRule ? { recurrenceRule: body.recurrenceRule } : {}),
      });
      return reply.status(201).send({ schedule });
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Dev/demo helper: sweep due schedules right now instead of waiting for a poller. */
  app.post('/api/schedules/materialize-due', async () => {
    const outcomes = await scheduler.materializer.materializeDue();
    return { outcomes };
  });

  // ---------------------------------------------------------------------
  // Publish history
  // ---------------------------------------------------------------------
  app.get('/api/history', async (req) => {
    const { campaignId, platformId, status } = req.query as {
      campaignId?: string;
      platformId?: string;
      status?: string;
    };
    const entries = listHistory(ctx.db.raw(), {
      ...(campaignId ? { campaignId } : {}),
      ...(platformId ? { platformId } : {}),
      ...(status ? { status } : {}),
    });
    return { entries };
  });

  app.get('/api/campaigns-list', async () => {
    const campaigns = listCampaigns(ctx.db.raw());
    return { campaigns };
  });

  // ---------------------------------------------------------------------
  // Campaign analytics
  // ---------------------------------------------------------------------
  app.get('/api/analytics/:campaignId', async (req) => {
    const { campaignId } = req.params as { campaignId: string };
    const summary = await analytics.aggregator.aggregate(campaignId);
    return { summary };
  });

  return app;
}
