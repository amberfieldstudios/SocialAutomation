import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createAppContext, type AppContext } from '../src/context';
import { createServer } from '../src/server';

let ctx: AppContext;
let app: FastifyInstance;

beforeEach(async () => {
  ctx = await createAppContext({ dbFile: ':memory:' });
  app = await createServer(ctx);
});

afterEach(async () => {
  await app.close();
  ctx.close();
});

describe('GET /api/wizard-state', () => {
  it('defaults to not-completed, step "welcome" before anything is ever saved (first-run detection)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/wizard-state' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ completed: false, currentStepId: 'welcome' });
  });
});

describe('PUT /api/wizard-state', () => {
  it('persists the current step server-side, surviving a fresh read (resume-after-refresh/restart)', async () => {
    const put = await app.inject({ method: 'PUT', url: '/api/wizard-state', payload: { currentStepId: 'twitch' } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ completed: false, currentStepId: 'twitch' });

    const get = await app.inject({ method: 'GET', url: '/api/wizard-state' });
    expect(get.json()).toMatchObject({ completed: false, currentStepId: 'twitch' });
  });

  it('marking completed persists and is reflected on a later read', async () => {
    await app.inject({ method: 'PUT', url: '/api/wizard-state', payload: { currentStepId: 'done' } });
    const put = await app.inject({ method: 'PUT', url: '/api/wizard-state', payload: { completed: true } });
    expect(put.json()).toMatchObject({ completed: true, currentStepId: 'done' });

    const get = await app.inject({ method: 'GET', url: '/api/wizard-state' });
    expect(get.json()).toMatchObject({ completed: true, currentStepId: 'done' });
  });

  it('rejects a non-string currentStepId and a non-boolean completed instead of silently coercing', async () => {
    const badStep = await app.inject({ method: 'PUT', url: '/api/wizard-state', payload: { currentStepId: 42 } });
    expect(badStep.statusCode).toBe(400);
    const badCompleted = await app.inject({ method: 'PUT', url: '/api/wizard-state', payload: { completed: 'yes' } });
    expect(badCompleted.statusCode).toBe(400);
  });

  it('surviving a full context restart (new AppContext, same db file) — not just an in-process refresh', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const dbFile = path.join(os.tmpdir(), `wizard-state-restart-${Date.now()}.sqlite`);
    // A real (non-`:memory:`) dbFile makes createAppContext persist OAuth
    // app credentials to a real on-disk key under the user-data dir (t15,
    // QG-2) — isolate that to a throwaway temp dir so this test never writes
    // a stray key file into the real developer/CI machine's profile.
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-state-restart-userdata-'));
    const originalUserDataDir = process.env.SOCIAL_AUTOMATION_USER_DATA_DIR;
    process.env.SOCIAL_AUTOMATION_USER_DATA_DIR = userDataDir;
    try {
      const ctxA = await createAppContext({ dbFile });
      const appA = await createServer(ctxA);
      await appA.inject({ method: 'PUT', url: '/api/wizard-state', payload: { currentStepId: 'reddit' } });
      await appA.close();
      ctxA.close();

      const ctxB = await createAppContext({ dbFile });
      const appB = await createServer(ctxB);
      const res = await appB.inject({ method: 'GET', url: '/api/wizard-state' });
      expect(res.json()).toMatchObject({ completed: false, currentStepId: 'reddit' });
      await appB.close();
      ctxB.close();
    } finally {
      fs.rmSync(dbFile, { force: true });
      fs.rmSync(userDataDir, { recursive: true, force: true });
      if (originalUserDataDir === undefined) delete process.env.SOCIAL_AUTOMATION_USER_DATA_DIR;
      else process.env.SOCIAL_AUTOMATION_USER_DATA_DIR = originalUserDataDir;
    }
  });
});

describe('POST /api/wizard-state/restart ("Run setup again")', () => {
  it('re-arms first-run detection (completed -> false, step -> welcome) without touching accounts', async () => {
    await app.inject({ method: 'PUT', url: '/api/wizard-state', payload: { currentStepId: 'done', completed: true } });
    await app.inject({
      method: 'POST',
      url: '/api/accounts/pair/token',
      payload: { platformId: 'discord', token: 'fake-webhook', tokenType: 'webhook', remoteId: 'chan-1' },
    });

    const restart = await app.inject({ method: 'POST', url: '/api/wizard-state/restart' });
    expect(restart.json()).toMatchObject({ completed: false, currentStepId: 'welcome' });

    const accounts = await app.inject({ method: 'GET', url: '/api/accounts' });
    expect(accounts.json().accounts).toHaveLength(1);
  });
});
