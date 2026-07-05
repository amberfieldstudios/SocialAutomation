/**
 * Unit tests for the first-use model download manager. No network and no real
 * model: an in-memory `ModelHttpClient` serves bytes from a Buffer (honoring
 * Range/resume and abort), and a fake model with a KNOWN sha256 proves the
 * checksum + resume + progress + decline logic. Real ~2 GB transfer + the
 * production `sha256` of the real GGUF are owed real-world verification.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ModelDownloadManager,
  ModelChecksumError,
  resolveModelStorageDir,
  resolveDefaultModelPath,
  sha256File,
  DEFAULT_MODEL,
  type ModelDescriptor,
  type ModelHttpClient,
  type ModelHttpResponse,
  type ModelDownloadProgress,
} from '../src/modelDownloadManager';
import { LOCAL_MODEL_PATH_ENV } from '../src/localProvider';
import { testLogger } from './support';

// A fake model payload with a real, computable checksum.
const PAYLOAD = Buffer.from('the-quick-brown-fox-jumps-over-the-lazy-dog'.repeat(200), 'utf8');
const PAYLOAD_SHA256 = createHash('sha256').update(PAYLOAD).digest('hex');

function fakeModel(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: 'test-model',
    displayName: 'Test Model',
    fileName: 'test-model.gguf',
    url: 'https://example.test/model.gguf',
    sizeBytes: PAYLOAD.length,
    sha256: PAYLOAD_SHA256,
    license: 'Apache-2.0',
    parameters: '3B',
    quantization: 'Q4_K_M',
    ...overrides,
  };
}

interface FakeClientOptions {
  /** Serve this many bytes per chunk. */
  chunkSize?: number;
  /** If true, ignore Range and always return the full payload with status 200. */
  ignoreRange?: boolean;
  /** If set, return this status instead of 200/206. */
  forceStatus?: number;
  /** Called just before streaming begins with the requested range start. */
  onRequest?: (rangeStart: number) => void;
  /** If set, pause between chunks so an abort can land mid-stream. */
  delayMs?: number;
}

function fakeClient(payload: Buffer, opts: FakeClientOptions = {}) {
  const chunkSize = opts.chunkSize ?? 64;
  let fetchCount = 0;
  let lastRangeStart = 0;

  const client: ModelHttpClient = {
    async fetch(_url, options): Promise<ModelHttpResponse> {
      fetchCount += 1;
      const rangeStart = options.rangeStart ?? 0;
      lastRangeStart = rangeStart;
      opts.onRequest?.(rangeStart);

      if (opts.forceStatus && opts.forceStatus !== 200 && opts.forceStatus !== 206) {
        return { status: opts.forceStatus, contentLength: 0, isPartial: false, body: emptyBody() };
      }

      const honorRange = rangeStart > 0 && !opts.ignoreRange;
      const from = honorRange ? rangeStart : 0;
      const slice = payload.subarray(from);
      const signal = options.signal;

      async function* body(): AsyncGenerator<Uint8Array> {
        for (let i = 0; i < slice.length; i += chunkSize) {
          if (signal?.aborted) {
            const err = new Error('aborted');
            err.name = 'AbortError';
            throw err;
          }
          if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
          yield slice.subarray(i, i + chunkSize);
        }
      }

      return {
        status: honorRange ? 206 : 200,
        contentLength: slice.length,
        isPartial: honorRange,
        body: body(),
      };
    },
  };

  return {
    client,
    get fetchCount() {
      return fetchCount;
    },
    get lastRangeStart() {
      return lastRangeStart;
    },
  };
}

async function* emptyBody(): AsyncGenerator<Uint8Array> {
  // no chunks
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mdm-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeManager(client: ModelHttpClient, model = fakeModel(), extra = {}) {
  return new ModelDownloadManager({
    logger: testLogger(),
    model,
    storageDir: dir,
    http: client,
    publishModelPathEnv: false,
    ...extra,
  });
}

describe('ModelDownloadManager — full download + checksum', () => {
  it('downloads to the storage dir, verifies checksum, and reports done', async () => {
    const { client } = fakeClient(PAYLOAD);
    const mgr = makeManager(client);

    expect(mgr.isModelPresent()).toBe(false);
    const status = await mgr.ensureModel();

    expect(status.phase).toBe('done');
    expect(status.present).toBe(true);
    expect(mgr.isModelPresent()).toBe(true);
    const onDisk = await readFile(mgr.getModelPath());
    expect(Buffer.compare(onDisk, PAYLOAD)).toBe(0);
    expect(await sha256File(mgr.getModelPath())).toBe(PAYLOAD_SHA256);
    // The `.part` file is renamed away on success.
    await expect(stat(`${mgr.getModelPath()}.part`)).rejects.toBeTruthy();
  });

  it('emits progress transitioning downloading -> verifying -> done, reaching 100%', async () => {
    const { client } = fakeClient(PAYLOAD, { chunkSize: 128 });
    const mgr = makeManager(client);
    const events: ModelDownloadProgress[] = [];
    mgr.subscribe((p) => events.push(p));

    await mgr.ensureModel();

    const phases = events.map((e) => e.phase);
    expect(phases).toContain('downloading');
    expect(phases).toContain('verifying');
    expect(phases[phases.length - 1]).toBe('done');
    const last = events[events.length - 1]!;
    expect(last.bytesDownloaded).toBe(PAYLOAD.length);
    expect(last.percent).toBe(100);
  });

  it('is idempotent: concurrent ensureModel calls share one download', async () => {
    const fc = fakeClient(PAYLOAD);
    const mgr = makeManager(fc.client);
    const [a, b] = await Promise.all([mgr.ensureModel(), mgr.ensureModel()]);
    expect(a.present).toBe(true);
    expect(b.present).toBe(true);
    expect(fc.fetchCount).toBe(1);
  });

  it('a second ensureModel after completion does not re-download', async () => {
    const fc = fakeClient(PAYLOAD);
    const mgr = makeManager(fc.client);
    await mgr.ensureModel();
    await mgr.ensureModel();
    expect(fc.fetchCount).toBe(1);
  });
});

describe('ModelDownloadManager — resume', () => {
  it('resumes from a partial .part file with a Range request', async () => {
    const half = Math.floor(PAYLOAD.length / 2);
    const partPath = path.join(dir, `${fakeModel().fileName}.part`);
    await writeFile(partPath, PAYLOAD.subarray(0, half));

    const fc = fakeClient(PAYLOAD);
    const mgr = makeManager(fc.client);
    const status = await mgr.ensureModel();

    expect(fc.lastRangeStart).toBe(half);
    expect(status.phase).toBe('done');
    const onDisk = await readFile(mgr.getModelPath());
    expect(Buffer.compare(onDisk, PAYLOAD)).toBe(0);
  });

  it('starts over from 0 when the server ignores Range (returns 200 full)', async () => {
    const half = Math.floor(PAYLOAD.length / 2);
    const partPath = path.join(dir, `${fakeModel().fileName}.part`);
    await writeFile(partPath, PAYLOAD.subarray(0, half));

    const fc = fakeClient(PAYLOAD, { ignoreRange: true });
    const mgr = makeManager(fc.client);
    const status = await mgr.ensureModel();

    expect(status.phase).toBe('done');
    const onDisk = await readFile(mgr.getModelPath());
    // Must be exactly the payload, not payload with a duplicated first half.
    expect(Buffer.compare(onDisk, PAYLOAD)).toBe(0);
  });
});

describe('ModelDownloadManager — checksum failure', () => {
  it('rejects a mismatching download, deletes the file, and stays not-present', async () => {
    const { client } = fakeClient(PAYLOAD);
    // Descriptor claims a different checksum than the payload actually hashes to.
    const mgr = makeManager(client, fakeModel({ sha256: 'deadbeef'.repeat(8) }));

    const status = await mgr.ensureModel();
    expect(status.phase).toBe('error');
    expect(status.error).toMatch(/checksum mismatch/i);
    expect(mgr.isModelPresent()).toBe(false);
    // Corrupt partial is removed so a retry re-downloads cleanly.
    await expect(stat(`${mgr.getModelPath()}.part`)).rejects.toBeTruthy();
  });

  it('ModelChecksumError carries expected/actual digests', () => {
    const err = new ModelChecksumError('aaa', 'bbb');
    expect(err.expected).toBe('aaa');
    expect(err.actual).toBe('bbb');
    expect(err.name).toBe('ModelChecksumError');
  });

  it('surfaces a non-2xx HTTP status as an error phase', async () => {
    const { client } = fakeClient(PAYLOAD, { forceStatus: 404 });
    const mgr = makeManager(client);
    const status = await mgr.ensureModel();
    expect(status.phase).toBe('error');
    expect(status.error).toMatch(/HTTP 404/);
  });
});

describe('ModelDownloadManager — cancel keeps the partial for resume', () => {
  it('cancel() aborts mid-download and preserves the .part file', async () => {
    const { client } = fakeClient(PAYLOAD, { chunkSize: 16, delayMs: 5 });
    const mgr = makeManager(client);

    const p = mgr.startDownload();
    // Let a few chunks land, then cancel.
    await new Promise((r) => setTimeout(r, 20));
    mgr.cancel();
    await p;

    expect(mgr.isModelPresent()).toBe(false);
    const partPath = `${mgr.getModelPath()}.part`;
    const partial = await stat(partPath);
    expect(partial.size).toBeGreaterThan(0);
    expect(partial.size).toBeLessThan(PAYLOAD.length);
    // Phase resets to a resumable state, not error.
    expect(mgr.getStatus().phase).toBe('idle');

    // Resuming completes the file from where it stopped.
    const fc2 = fakeClient(PAYLOAD);
    const mgr2 = makeManager(fc2.client);
    const status = await mgr2.ensureModel();
    expect(status.phase).toBe('done');
    expect(fc2.lastRangeStart).toBe(partial.size);
  });
});

describe('ModelDownloadManager — decline (no nagging)', () => {
  it('decline() writes a marker, reports declined, and does not download', async () => {
    const fc = fakeClient(PAYLOAD);
    const mgr = makeManager(fc.client);
    await mgr.decline();

    expect(mgr.isDeclined()).toBe(true);
    expect(mgr.getStatus().declined).toBe(true);
    expect(mgr.getStatus().phase).toBe('declined');
    expect(fc.fetchCount).toBe(0);

    // The choice persists: a fresh manager over the same dir sees it via init().
    const mgr2 = makeManager(fakeClient(PAYLOAD).client);
    await mgr2.init();
    expect(mgr2.isDeclined()).toBe(true);
  });

  it('starting a download clears a prior decline (explicit opt-in)', async () => {
    const fc = fakeClient(PAYLOAD);
    const mgr = makeManager(fc.client);
    await mgr.decline();
    const status = await mgr.ensureModel();
    expect(status.declined).toBe(false);
    expect(status.phase).toBe('done');
  });

  it('undecline() reverses the choice', async () => {
    const mgr = makeManager(fakeClient(PAYLOAD).client);
    await mgr.decline();
    await mgr.undecline();
    expect(mgr.isDeclined()).toBe(false);
    expect(mgr.getStatus().phase).toBe('idle');
  });
});

describe('ModelDownloadManager — LOCAL_MODEL_PATH publication', () => {
  it('sets LOCAL_MODEL_PATH on completion when publishModelPathEnv is true', async () => {
    const original = process.env[LOCAL_MODEL_PATH_ENV];
    delete process.env[LOCAL_MODEL_PATH_ENV];
    try {
      const mgr = makeManager(fakeClient(PAYLOAD).client, fakeModel(), { publishModelPathEnv: true });
      await mgr.ensureModel();
      expect(process.env[LOCAL_MODEL_PATH_ENV]).toBe(mgr.getModelPath());
    } finally {
      if (original !== undefined) process.env[LOCAL_MODEL_PATH_ENV] = original;
      else delete process.env[LOCAL_MODEL_PATH_ENV];
    }
  });
});

describe('storage-dir resolution (user data, outside the app dir)', () => {
  const ORIGINAL = process.env.SOCIAL_AUTOMATION_USER_DATA_DIR;
  afterEach(() => {
    if (ORIGINAL !== undefined) process.env.SOCIAL_AUTOMATION_USER_DATA_DIR = ORIGINAL;
    else delete process.env.SOCIAL_AUTOMATION_USER_DATA_DIR;
  });

  it('prefers an explicit dir', () => {
    expect(resolveModelStorageDir('/custom/dir')).toBe('/custom/dir');
  });

  it('uses <SOCIAL_AUTOMATION_USER_DATA_DIR>/models when the env is set', () => {
    process.env.SOCIAL_AUTOMATION_USER_DATA_DIR = path.join('/data', 'sa');
    expect(resolveModelStorageDir()).toBe(path.join('/data', 'sa', 'models'));
  });

  it('falls back to a per-user OS data dir when the env is unset', () => {
    delete process.env.SOCIAL_AUTOMATION_USER_DATA_DIR;
    const resolved = resolveModelStorageDir();
    expect(resolved).toContain('SocialAutomation');
    expect(resolved.endsWith('models')).toBe(true);
  });

  it('resolveDefaultModelPath joins the storage dir and the model file name', () => {
    process.env.SOCIAL_AUTOMATION_USER_DATA_DIR = path.join('/data', 'sa');
    expect(resolveDefaultModelPath(DEFAULT_MODEL)).toBe(
      path.join('/data', 'sa', 'models', DEFAULT_MODEL.fileName),
    );
  });
});
