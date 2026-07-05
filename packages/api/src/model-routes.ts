/**
 * REST + SSE surface for the on-device model download manager (task t4), so the
 * dashboard can show download progress and let the user trigger or decline the
 * fetch of the ~2 GB local LLM model.
 *
 * The model is fetched ON FIRST USE and stored in the per-user data dir (see
 * `@social/ai`'s `ModelDownloadManager` / `resolveModelStorageDir`), NEVER
 * bundled in the distributable. Declining leaves the app on its credential-free
 * fallback provider with no nagging — `GET /api/model/status` simply reports
 * `declined: true` and the UI stops prompting.
 *
 * Routes (all under /api/model):
 *   GET  /status    → current phase, bytes, percent, present/declined flags,
 *                     model descriptor (id, size, license, quantization).
 *   POST /download   → start (or resume) the download; returns 202 + status.
 *                      Non-blocking — the ~2 GB transfer runs in the background
 *                      and progress is observed via /status polling or /events.
 *   POST /cancel     → pause an in-flight download (keeps the partial to resume).
 *   POST /decline    → opt out; write the marker so the UI stops prompting.
 *   POST /resume-optin (undecline) → reverse a prior decline.
 *   GET  /events     → Server-Sent Events stream of progress snapshots, so the
 *                      dashboard gets live updates without polling.
 *
 * This module OWNS its `ModelDownloadManager` instance (one per server), built
 * from the app logger. It never touches provider selection (that is context.ts,
 * task t5's turf); it only makes the model present on disk and reports progress.
 */

import type { FastifyInstance } from 'fastify';
import {
  ModelDownloadManager,
  type ModelDownloadManagerConfig,
  type ModelDownloadProgress,
} from '@social/ai';
import type { AppContext } from './context';

export interface RegisterModelRoutesOptions {
  /** Inject a manager (tests); defaults to one built from the app logger. */
  manager?: ModelDownloadManager;
  /** Extra manager config (e.g. a custom storageDir/http) when auto-constructing. */
  managerConfig?: Partial<ModelDownloadManagerConfig>;
}

export function registerModelRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  options: RegisterModelRoutesOptions = {},
): ModelDownloadManager {
  const manager =
    options.manager ??
    new ModelDownloadManager({ logger: ctx.logger, ...options.managerConfig });

  // The decline marker is on disk; load it once before serving status. Every
  // handler awaits this so a restart's declined choice is honored immediately.
  const ready = manager.init().catch((err: unknown) => {
    ctx.logger.warn('api.model_manager_init_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  app.get('/api/model/status', async () => {
    await ready;
    return { model: manager.getStatus() };
  });

  app.post('/api/model/download', async (_req, reply) => {
    await ready;
    if (manager.isModelPresent()) {
      return reply.status(200).send({ model: manager.getStatus() });
    }
    // Fire-and-forget: the transfer is large and must not hold the request open.
    // runDownload swallows its own errors into an `error` phase, so this never
    // rejects — the .catch is belt-and-braces against an unexpected throw.
    void manager.startDownload().catch((err: unknown) => {
      ctx.logger.error('api.model_download_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return reply.status(202).send({ model: manager.getStatus() });
  });

  app.post('/api/model/cancel', async () => {
    await ready;
    manager.cancel();
    return { model: manager.getStatus() };
  });

  app.post('/api/model/decline', async () => {
    await ready;
    await manager.decline();
    return { model: manager.getStatus() };
  });

  app.post('/api/model/resume-optin', async () => {
    await ready;
    await manager.undecline();
    return { model: manager.getStatus() };
  });

  // Server-Sent Events: push each progress snapshot to subscribed dashboards.
  app.get('/api/model/events', async (req, reply) => {
    await ready;
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (progress: ModelDownloadProgress): void => {
      reply.raw.write(`data: ${JSON.stringify(progress)}\n\n`);
    };
    // Emit the current state immediately so a late subscriber isn't blank.
    send(manager.getStatus());
    const unsubscribe = manager.subscribe(send);
    // Heartbeat keeps intermediaries from closing an idle stream.
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15000);
    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
    // Tell Fastify we own the socket now (no automatic reply).
    reply.hijack();
  });

  return manager;
}
