/**
 * REST surface test for the on-device model download manager (task t4). Uses a
 * bare Fastify app with an injected in-memory HTTP client + temp storage dir —
 * no network, no real model, no full AppContext (the routes only need a logger).
 */

import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LogFields, StructuredLogger } from '@social/core';
import type { ModelHttpClient, ModelHttpResponse } from '@social/ai';
import { registerModelRoutes } from '../src/model-routes';
import type { AppContext } from '../src/context';

function silentLogger(): StructuredLogger {
  const make = (b: LogFields): StructuredLogger => ({
    child: (m) => make({ ...b, ...m }),
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  });
  return make({});
}

const PAYLOAD = Buffer.from('model-bytes-'.repeat(64), 'utf8');
const PAYLOAD_SHA256 = createHash('sha256').update(PAYLOAD).digest('hex');

function fakeHttp(): ModelHttpClient {
  return {
    async fetch(_url, options): Promise<ModelHttpResponse> {
      const from = options.rangeStart ?? 0;
      const slice = PAYLOAD.subarray(from);
      async function* body(): AsyncGenerator<Uint8Array> {
        for (let i = 0; i < slice.length; i += 32) yield slice.subarray(i, i + 32);
      }
      return {
        status: from > 0 ? 206 : 200,
        contentLength: slice.length,
        isPartial: from > 0,
        body: body(),
      };
    },
  };
}

let app: FastifyInstance;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'model-routes-'));
  app = Fastify({ logger: false });
  const ctx = { logger: silentLogger() } as unknown as AppContext;
  registerModelRoutes(app, ctx, {
    managerConfig: {
      storageDir: dir,
      http: fakeHttp(),
      publishModelPathEnv: false,
      model: {
        id: 'test',
        displayName: 'Test',
        fileName: 'test.gguf',
        url: 'https://example.test/m.gguf',
        sizeBytes: PAYLOAD.length,
        sha256: PAYLOAD_SHA256,
        license: 'Apache-2.0',
        parameters: '3B',
        quantization: 'Q4_K_M',
      },
    },
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

async function pollUntilDone(): Promise<Record<string, unknown>> {
  for (let i = 0; i < 50; i += 1) {
    const res = await app.inject({ method: 'GET', url: '/api/model/status' });
    const model = res.json().model as Record<string, unknown>;
    if (model.phase === 'done' || model.phase === 'error') return model;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('download did not finish');
}

describe('GET /api/model/status', () => {
  it('reports a credential-free descriptor and initial phase', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/model/status' });
    expect(res.statusCode).toBe(200);
    const { model } = res.json();
    expect(model.present).toBe(false);
    expect(model.declined).toBe(false);
    expect(model.license).toBe('Apache-2.0');
    expect(model.phase).toBe('idle');
  });
});

describe('POST /api/model/download', () => {
  it('accepts the download (202) and completes to a verified present model', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/model/download' });
    expect(start.statusCode).toBe(202);
    const done = await pollUntilDone();
    expect(done.phase).toBe('done');
    expect(done.present).toBe(true);
    expect(done.percent).toBe(100);
  });

  it('returns 200 (already present) when called after completion', async () => {
    await app.inject({ method: 'POST', url: '/api/model/download' });
    await pollUntilDone();
    const again = await app.inject({ method: 'POST', url: '/api/model/download' });
    expect(again.statusCode).toBe(200);
    expect(again.json().model.present).toBe(true);
  });
});

describe('POST /api/model/decline (no nagging) + resume-optin', () => {
  it('decline marks the model declined without downloading', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/model/decline' });
    expect(res.statusCode).toBe(200);
    const { model } = res.json();
    expect(model.declined).toBe(true);
    expect(model.phase).toBe('declined');
    expect(model.present).toBe(false);
  });

  it('resume-optin reverses a decline', async () => {
    await app.inject({ method: 'POST', url: '/api/model/decline' });
    const res = await app.inject({ method: 'POST', url: '/api/model/resume-optin' });
    expect(res.json().model.declined).toBe(false);
  });
});
