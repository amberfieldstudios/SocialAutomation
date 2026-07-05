/**
 * Dev entrypoint: `pnpm --filter @social/api run dev` (via `tsx watch`).
 * Boots a SQLite dev DB (file, so it persists across restarts — seed with
 * `pnpm --filter @social/api run seed` first) and starts the Fastify server.
 */
import { AiConfigError } from '@social/ai';
import { createAppContext } from './context';
import { createServer } from './server';

const PORT = Number(process.env.PORT ?? 4000);

async function main(): Promise<void> {
  const ctx = await createAppContext({ dbFile: process.env.SOCIAL_DB_FILE ?? './dev.sqlite' });
  const app = await createServer(ctx);
  await app.listen({ port: PORT, host: '127.0.0.1' });
  ctx.logger.info('api.dev_server_started', { port: PORT });

  // Parity with prod.ts (t13 / QA finding F1): start the queue worker's
  // continuous poller so a campaign submitted through this dev server
  // actually drains, instead of sitting `pending` forever. Kept out of
  // `createAppContext`/`buildPipeline` so tests and `seed.ts` still control
  // draining explicitly via `runOnce()`.
  ctx.pipeline.worker.start();
  console.log('[api.dev] Publish/analytics queue worker started — jobs will now be drained continuously.');

  const shutdown = async (): Promise<void> => {
    await ctx.pipeline.worker.stop();
    await app.close();
    ctx.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  if (err instanceof AiConfigError) {
    console.error(`[api.dev] AI provider configuration error: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
