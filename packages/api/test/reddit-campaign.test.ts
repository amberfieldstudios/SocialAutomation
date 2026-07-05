/**
 * QG-1 / t14 regression: Reddit's `validatePost` hard-requires
 * `platformOptions.subreddit` (plugins/reddit/src/connector.ts), but before
 * this fix neither `/api/compose-preview` nor `/api/campaigns` accepted or
 * forwarded it, so every Reddit campaign was rejected with
 * `subreddit_required`. These tests prove the field now reaches the
 * connector end to end and a Reddit campaign actually enqueues.
 */
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

describe('Reddit campaigns with platformOptions.subreddit (QG-1)', () => {
  it('POST /api/campaigns enqueues a Reddit target once a subreddit is supplied', async () => {
    const account = await ctx.pipeline.accountManager.addAccount({
      platformId: 'reddit',
      remoteId: 'reddit-user-1',
      handle: 'streamer',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/campaigns',
      payload: {
        description: 'Announcing our new feature launch with lots of excitement and detail for everyone following along.',
        platforms: [{ platformId: 'reddit', accountId: account.id, platformOptions: { subreddit: 'Twitch' } }],
      },
    });

    expect(res.statusCode).toBe(201);
    const { results } = res.json();
    expect(results).toHaveLength(1);
    const [result] = results;
    expect(result.platform).toBe('reddit');
    expect(result.validation?.errors ?? []).not.toContainEqual(expect.objectContaining({ code: 'subreddit_required' }));
    expect(result.status).toBe('enqueued');
    expect(result.postVariantId).toBeTruthy();
    expect(result.jobId).toBeTruthy();

    const jobs = await app.inject({ method: 'GET', url: '/api/jobs' });
    expect(jobs.json().jobs).toHaveLength(1);
  });

  it('POST /api/campaigns still rejects a Reddit target with no subreddit (subreddit_required)', async () => {
    const account = await ctx.pipeline.accountManager.addAccount({
      platformId: 'reddit',
      remoteId: 'reddit-user-2',
      handle: 'streamer2',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/campaigns',
      payload: {
        description: 'Announcing our new feature launch with lots of excitement and detail for everyone following along.',
        platforms: [{ platformId: 'reddit', accountId: account.id }],
      },
    });

    expect(res.statusCode).toBe(201);
    const { results } = res.json();
    const [result] = results;
    expect(result.status).toBe('rejected');
    expect(result.validation.errors).toContainEqual(expect.objectContaining({ code: 'subreddit_required' }));
  });

  it('POST /api/compose-preview reflects the same subreddit-validated outcome as submit (no side effects)', async () => {
    const account = await ctx.pipeline.accountManager.addAccount({
      platformId: 'reddit',
      remoteId: 'reddit-user-3',
      handle: 'streamer3',
    });

    const withSubreddit = await app.inject({
      method: 'POST',
      url: '/api/compose-preview',
      payload: {
        description: 'Announcing our new feature launch with lots of excitement and detail for everyone following along.',
        platforms: [{ platformId: 'reddit', accountId: account.id, platformOptions: { subreddit: 'Twitch' } }],
      },
    });
    expect(withSubreddit.json().results[0].status).toBe('ok');
    expect(withSubreddit.json().results[0].payload.platformOptions).toMatchObject({ subreddit: 'Twitch' });

    const withoutSubreddit = await app.inject({
      method: 'POST',
      url: '/api/compose-preview',
      payload: {
        description: 'Announcing our new feature launch with lots of excitement and detail for everyone following along.',
        platforms: [{ platformId: 'reddit', accountId: account.id }],
      },
    });
    expect(withoutSubreddit.json().results[0].status).toBe('rejected');

    // Preview never enqueues, with or without a subreddit.
    const jobs = await app.inject({ method: 'GET', url: '/api/jobs' });
    expect(jobs.json().jobs).toHaveLength(0);
  });

  it("keeps Reddit's self-post text/link mutual exclusivity intact: a link brief still validates once a subreddit is supplied", async () => {
    const account = await ctx.pipeline.accountManager.addAccount({
      platformId: 'reddit',
      remoteId: 'reddit-user-4',
      handle: 'streamer4',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/campaigns',
      payload: {
        description: 'Check out our new devlog with screenshots and a roadmap for the next release.',
        link: 'https://example.com/devlog',
        platforms: [{ platformId: 'reddit', accountId: account.id, platformOptions: { subreddit: 'Twitch' } }],
      },
    });

    expect(res.statusCode).toBe(201);
    const [result] = res.json().results;
    expect(result.status).toBe('enqueued');
  });
});
