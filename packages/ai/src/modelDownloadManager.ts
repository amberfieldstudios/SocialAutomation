/**
 * First-use model download manager for the on-device `LocalProvider`.
 *
 * WHY THIS EXISTS: the credential-free generation path (`LocalProvider`, see
 * localProvider.ts) needs a ~2 GB quantized GGUF model on disk, and that model
 * MUST NOT ship inside the distributable (the app download stays small; the
 * model is fetched on first use). This manager fetches it once, to a per-user
 * data directory that survives app updates, with:
 *   1. RESUME of a partial download (HTTP Range / append to a `.part` file).
 *   2. SHA256 CHECKSUM verification of the completed file — a mismatch deletes
 *      the file so the next attempt re-downloads it (never a corrupt model).
 *   3. PROGRESS EVENTS the dashboard subscribes to (phase + bytes + percent),
 *      exposed over REST/SSE by `@social/api` (see model-routes.ts).
 *   4. Storage in the USER-DATA dir (outside the replaceable app/install dir),
 *      keyed off `SOCIAL_AUTOMATION_USER_DATA_DIR` — the same convention the
 *      launcher/bootstrap and `packages/api/src/prod.ts` use for the SQLite DB,
 *      so an update never re-downloads the model.
 *   5. A DECLINE path: declining writes a marker and leaves the app on the
 *      credential-free fallback provider with NO nagging (status reports
 *      `declined`; the UI simply stops prompting).
 *
 * INJECTABLE HTTP SEAM: the network layer is the `ModelHttpClient` interface.
 * The default client (`createFetchModelClient`) uses global `fetch` with a
 * `Range` header and an `AbortSignal`. Tests inject a fake in-memory client to
 * prove resume + checksum + progress + cancel WITHOUT any network. Actually
 * fetching the real ~2 GB model over the wire is explicitly OWED real-world
 * verification (no bandwidth in CI), as is confirming `DEFAULT_MODEL.sha256`
 * against the published file — see the note on that constant.
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import path from 'node:path';
import type { StructuredLogger } from '@social/core';
import { isLocalModelAvailable, LOCAL_MODEL_PATH_ENV } from './localProvider';

// ---------------------------------------------------------------------------
// Model catalogue
// ---------------------------------------------------------------------------

/** Everything needed to fetch and verify one downloadable model. */
export interface ModelDescriptor {
  /** Stable id, used in status payloads and logs. */
  id: string;
  /** Human-readable name for the dashboard. */
  displayName: string;
  /** File name written to the storage dir (also what `resolveDefaultModelPath` returns). */
  fileName: string;
  /** HTTPS URL to download from. */
  url: string;
  /**
   * Expected total size in bytes. Used only to compute a progress percentage
   * when the server does not report `Content-Length`; it is NOT trusted for
   * integrity (that is `sha256`'s job). Approximate is fine.
   */
  sizeBytes: number;
  /**
   * Lowercase-hex SHA256 of the COMPLETE model file. The manager computes the
   * digest of the downloaded file and rejects (deletes) it on mismatch.
   */
  sha256: string;
  /** SPDX license id — must be permissive (we only ship permissively licensed models). */
  license: string;
  /** Parameter count, for display (e.g. "3B"). */
  parameters: string;
  /** Quantization, for display (e.g. "Q4_K_M"). */
  quantization: string;
}

/**
 * A small, permissively licensed (Apache-2.0) quantized instruct model:
 * Qwen2.5-3B-Instruct, Q4_K_M GGUF (~1.9 GB). Runs on-device via
 * `node-llama-cpp` with no API key.
 *
 * OWED REAL-WORLD VERIFICATION — the `sha256` below is a PLACEHOLDER. It MUST
 * be replaced with the checksum published for the exact `url` file before this
 * ships. Until it is, a real download will FAIL verification BY DESIGN (the
 * fail-safe: an unverified 2 GB blob is never promoted to the live model, so
 * the app simply stays on the credential-free fallback). `sizeBytes` is
 * likewise approximate and only feeds the progress bar. The download+verify
 * MECHANISM is fully unit-tested with a fake model whose checksum is known.
 */
export const PLACEHOLDER_SHA256 =
  '0000000000000000000000000000000000000000000000000000000000000000';

export const DEFAULT_MODEL: ModelDescriptor = {
  id: 'qwen2.5-3b-instruct-q4_k_m',
  displayName: 'Qwen2.5 3B Instruct (Q4_K_M GGUF)',
  fileName: 'qwen2.5-3b-instruct-q4_k_m.gguf',
  url: 'https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf?download=true',
  sizeBytes: 1_929_903_264,
  sha256: PLACEHOLDER_SHA256,
  license: 'Apache-2.0',
  parameters: '3B',
  quantization: 'Q4_K_M',
};

// ---------------------------------------------------------------------------
// Storage-dir resolution (user data, outside the app install dir)
// ---------------------------------------------------------------------------

/**
 * Directory the model file(s) live in. Prefers `SOCIAL_AUTOMATION_USER_DATA_DIR`
 * (set by the packaged launcher to a per-user folder OUTSIDE the replaceable
 * app dir, exactly like the SQLite DB — see `packages/api/src/prod.ts`), so an
 * app update never re-downloads the model. When that env is unset (plain
 * dev/`pnpm start`), it falls back to a per-user OS data dir, mirroring the
 * launcher/bootstrap convention.
 */
export function resolveModelStorageDir(explicit?: string): string {
  if (explicit && explicit.length > 0) return explicit;
  const userDataDir = process.env.SOCIAL_AUTOMATION_USER_DATA_DIR;
  if (userDataDir && userDataDir.length > 0) return path.join(userDataDir, 'models');
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local')
      : process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share');
  return path.join(base, 'SocialAutomation', 'models');
}

/**
 * The canonical on-disk path a downloaded `model` ends up at. Exposed so the
 * app can point `LOCAL_MODEL_PATH` at this location (see localProvider.ts) —
 * once the file exists there, `isLocalModelAvailable` is true and the on-device
 * provider is selectable.
 */
export function resolveDefaultModelPath(
  model: ModelDescriptor = DEFAULT_MODEL,
  storageDir?: string,
): string {
  return path.join(resolveModelStorageDir(storageDir), model.fileName);
}

// ---------------------------------------------------------------------------
// Injectable HTTP layer
// ---------------------------------------------------------------------------

/** A single HTTP response, reduced to what the downloader needs. */
export interface ModelHttpResponse {
  /** HTTP status code (200 full, 206 partial, else an error). */
  status: number;
  /** `Content-Length` of THIS response body in bytes, if the server sent it. */
  contentLength: number | undefined;
  /** True for a `206 Partial Content` response honoring the requested range. */
  isPartial: boolean;
  /** The response body as a stream of byte chunks. */
  body: AsyncIterable<Uint8Array>;
}

/** The network seam. A real client wraps `fetch`; tests inject a fake. */
export interface ModelHttpClient {
  fetch(
    url: string,
    options: { rangeStart?: number; signal?: AbortSignal },
  ): Promise<ModelHttpResponse>;
}

/** Adapt a web `ReadableStream` into an async iterable of chunks (fully typed,
 * portable across Node versions rather than relying on stream async-iteration). */
async function* readWebStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * The default `ModelHttpClient`, backed by global `fetch`. Sends a `Range`
 * header to resume and forwards an `AbortSignal` so a download can be
 * cancelled. NOTE: this path is OWED real-world verification — a real ~2 GB
 * transfer cannot run in CI, so only the fake-client tests exercise the
 * downloader's logic.
 */
export function createFetchModelClient(): ModelHttpClient {
  return {
    async fetch(url, options): Promise<ModelHttpResponse> {
      const headers: Record<string, string> = {};
      if (options.rangeStart && options.rangeStart > 0) {
        headers['Range'] = `bytes=${options.rangeStart}-`;
      }
      const res = await fetch(url, {
        headers,
        ...(options.signal ? { signal: options.signal } : {}),
        redirect: 'follow',
      });
      const lenHeader = res.headers.get('content-length');
      const contentLength = lenHeader !== null ? Number(lenHeader) : undefined;
      const body: AsyncIterable<Uint8Array> = res.body
        ? readWebStream(res.body as ReadableStream<Uint8Array>)
        : (async function* () {})();
      return {
        status: res.status,
        contentLength: contentLength !== undefined && Number.isFinite(contentLength) ? contentLength : undefined,
        isPartial: res.status === 206,
        body,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Progress / status model
// ---------------------------------------------------------------------------

export type ModelDownloadPhase =
  | 'idle' // no model, no download in progress, not declined
  | 'downloading'
  | 'verifying'
  | 'done' // model present and (if downloaded here) checksum-verified
  | 'error'
  | 'declined'; // user opted out; stay on the fallback provider, no nagging

/** One progress snapshot emitted to subscribers and returned by `getStatus`. */
export interface ModelDownloadProgress {
  phase: ModelDownloadPhase;
  modelId: string;
  fileName: string;
  /** Bytes on disk so far (includes bytes carried over from a resumed `.part`). */
  bytesDownloaded: number;
  /** Total expected bytes, if known (server `Content-Length` or descriptor size). */
  totalBytes: number | undefined;
  /** 0–100 when `totalBytes` is known, else undefined. */
  percent: number | undefined;
  /** Human-readable error message when `phase === 'error'`. */
  error: string | undefined;
}

/** Full status the API returns, including static descriptor + declined marker. */
export interface ModelDownloadStatus extends ModelDownloadProgress {
  /** True once the final model file exists on disk. */
  present: boolean;
  /** True while a download is actively running. */
  downloading: boolean;
  /** True when the user declined; the UI must not nag. */
  declined: boolean;
  /** Absolute path the model lives (or will live) at. */
  modelPath: string;
  displayName: string;
  license: string;
  parameters: string;
  quantization: string;
  sizeBytes: number;
}

export type ModelDownloadListener = (progress: ModelDownloadProgress) => void;

/** Thrown when the completed download's SHA256 does not match the descriptor. */
export class ModelChecksumError extends Error {
  readonly expected: string;
  readonly actual: string;
  constructor(expected: string, actual: string) {
    super(
      `Downloaded model checksum mismatch: expected ${expected}, got ${actual}. ` +
        'The partial file was deleted; the download can be retried.',
    );
    this.name = 'ModelChecksumError';
    this.expected = expected;
    this.actual = actual;
  }
}

const PROGRESS_EMIT_INTERVAL_MS = 250;

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export interface ModelDownloadManagerConfig {
  logger: StructuredLogger;
  /** Which model to fetch. Defaults to `DEFAULT_MODEL`. */
  model?: ModelDescriptor;
  /** Where to store it. Defaults to `resolveModelStorageDir()`. */
  storageDir?: string;
  /** Network layer. Defaults to `createFetchModelClient()`. */
  http?: ModelHttpClient;
  /**
   * When true (default), completing a download sets `process.env.LOCAL_MODEL_PATH`
   * to the model path so a freshly built provider/app restart can select the
   * on-device provider. (Selecting it WITHOUT a restart is the fallback-chain's
   * job — task t5 — and outside this manager.)
   */
  publishModelPathEnv?: boolean;
}

/**
 * Downloads and verifies the on-device model on demand, emitting progress.
 * Safe to construct at startup (does no I/O until `ensureModel`/`startDownload`).
 */
export class ModelDownloadManager {
  readonly model: ModelDescriptor;
  private readonly logger: StructuredLogger;
  private readonly http: ModelHttpClient;
  private readonly storageDir: string;
  private readonly finalPath: string;
  private readonly partPath: string;
  private readonly declinedMarkerPath: string;
  private readonly publishModelPathEnv: boolean;
  private readonly emitter = new EventEmitter();

  private phase: ModelDownloadPhase = 'idle';
  private bytesDownloaded = 0;
  private totalBytes: number | undefined;
  private errorMessage: string | undefined;
  private declined = false;
  private inFlight: Promise<void> | undefined;
  private abort: AbortController | undefined;
  private lastEmitAt = 0;

  constructor(config: ModelDownloadManagerConfig) {
    this.logger = config.logger.child({ component: 'ai.model_download_manager' });
    this.model = config.model ?? DEFAULT_MODEL;
    this.http = config.http ?? createFetchModelClient();
    this.storageDir = resolveModelStorageDir(config.storageDir);
    this.finalPath = path.join(this.storageDir, this.model.fileName);
    this.partPath = `${this.finalPath}.part`;
    this.declinedMarkerPath = path.join(this.storageDir, '.download-declined');
    this.publishModelPathEnv = config.publishModelPathEnv ?? true;
    // Emitter fan-out to many dashboard subscribers; lift the default cap.
    this.emitter.setMaxListeners(0);
    if (this.isModelPresent()) this.phase = 'done';
  }

  /** Absolute path the model file lives (or will live) at. */
  getModelPath(): string {
    return this.finalPath;
  }

  /** Cheap sync check: is the final model file on disk? */
  isModelPresent(): boolean {
    return isLocalModelAvailable(this.finalPath);
  }

  /** Subscribe to progress events. Returns an unsubscribe function. */
  subscribe(listener: ModelDownloadListener): () => void {
    this.emitter.on('progress', listener);
    return () => this.emitter.off('progress', listener);
  }

  /** Current, complete status — what the REST `GET /api/model/status` returns. */
  getStatus(): ModelDownloadStatus {
    const present = this.isModelPresent();
    return {
      ...this.currentProgress(),
      present,
      downloading: this.inFlight !== undefined,
      declined: this.declined,
      modelPath: this.finalPath,
      displayName: this.model.displayName,
      license: this.model.license,
      parameters: this.model.parameters,
      quantization: this.model.quantization,
      sizeBytes: this.model.sizeBytes,
    };
  }

  /** Load any persisted decline marker. Call once after construction if the
   * decline choice must survive a restart. */
  async init(): Promise<void> {
    this.declined = await this.readDeclinedMarker();
    if (this.declined && !this.isModelPresent()) this.setPhase('declined');
  }

  /**
   * Ensure the model is present, downloading it if needed. Idempotent: parallel
   * callers share one in-flight download. Returns immediately if the model is
   * already present. Starting a download clears any prior decline (an explicit
   * opt-in).
   */
  async ensureModel(): Promise<ModelDownloadStatus> {
    if (this.isModelPresent()) {
      this.setPhase('done');
      return this.getStatus();
    }
    await this.startDownload();
    return this.getStatus();
  }

  /**
   * Begin (or resume) a download. Idempotent while running — a second call
   * awaits the same in-flight promise. Clears a prior decline marker.
   */
  async startDownload(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.isModelPresent()) {
      this.setPhase('done');
      return;
    }
    if (this.declined) await this.undecline();
    this.abort = new AbortController();
    this.errorMessage = undefined;
    this.inFlight = this.runDownload(this.abort.signal).finally(() => {
      this.inFlight = undefined;
      this.abort = undefined;
    });
    return this.inFlight;
  }

  /**
   * Cancel an in-flight download. The partial `.part` file is KEPT so a later
   * `startDownload` resumes from where it stopped.
   */
  cancel(): void {
    if (this.abort) {
      this.logger.info('ai.model_download_cancelled', { modelId: this.model.id });
      this.abort.abort();
    }
  }

  /** True if the user has declined the download. */
  isDeclined(): boolean {
    return this.declined;
  }

  /**
   * Decline the download: cancel anything in flight and write a marker so the
   * UI stops prompting. The app stays on the credential-free fallback provider.
   */
  async decline(): Promise<void> {
    this.cancel();
    this.declined = true;
    await mkdir(this.storageDir, { recursive: true });
    await writeFile(this.declinedMarkerPath, `${new Date().toISOString()}\n`, 'utf8');
    this.setPhase('declined');
    this.logger.info('ai.model_download_declined', { modelId: this.model.id });
  }

  /** Reverse a decline (user changed their mind). */
  async undecline(): Promise<void> {
    this.declined = false;
    await rm(this.declinedMarkerPath, { force: true });
    if (this.phase === 'declined') this.setPhase(this.isModelPresent() ? 'done' : 'idle');
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async runDownload(signal: AbortSignal): Promise<void> {
    const startedAt = Date.now();
    try {
      await mkdir(this.storageDir, { recursive: true });

      let resumeFrom = await this.partialBytes();
      this.setPhase('downloading');
      this.bytesDownloaded = resumeFrom;
      this.totalBytes = this.model.sizeBytes > 0 ? this.model.sizeBytes : undefined;
      this.emitProgress(true);

      this.logger.info('ai.model_download_started', {
        modelId: this.model.id,
        resumeFrom,
        url: this.model.url,
      });

      const res = await this.http.fetch(this.model.url, { rangeStart: resumeFrom, signal });

      if (res.status !== 200 && res.status !== 206) {
        throw new Error(`Download failed with HTTP ${res.status}.`);
      }
      // Requested a range but the server sent the whole file (200): it does not
      // support resume — start over from byte 0.
      if (resumeFrom > 0 && !res.isPartial) {
        this.logger.warn('ai.model_download_no_resume', { modelId: this.model.id });
        await rm(this.partPath, { force: true });
        resumeFrom = 0;
        this.bytesDownloaded = 0;
      }

      // Total = bytes already on disk + this response's length (206), or just
      // the response length (200), falling back to the descriptor size.
      if (res.contentLength !== undefined) {
        this.totalBytes = resumeFrom + res.contentLength;
      }

      const append = resumeFrom > 0;
      const out = createWriteStream(this.partPath, { flags: append ? 'a' : 'w' });
      try {
        for await (const chunk of res.body) {
          if (signal.aborted) throw makeAbortError();
          await writeChunk(out, chunk);
          this.bytesDownloaded += chunk.byteLength;
          this.emitProgress(false);
        }
      } finally {
        await endStream(out);
      }
      if (signal.aborted) throw makeAbortError();

      // Verify the COMPLETE file (a resumed download's hash must cover the
      // carried-over bytes too, so we hash the file on disk, not the stream).
      this.setPhase('verifying');
      this.emitProgress(true);
      const actual = await sha256File(this.partPath);
      if (actual !== this.model.sha256) {
        await rm(this.partPath, { force: true });
        throw new ModelChecksumError(this.model.sha256, actual);
      }

      await rename(this.partPath, this.finalPath);
      if (this.publishModelPathEnv) process.env[LOCAL_MODEL_PATH_ENV] = this.finalPath;
      this.setPhase('done');
      this.emitProgress(true);
      this.logger.info('ai.model_download_complete', {
        modelId: this.model.id,
        modelPath: this.finalPath,
        bytes: this.bytesDownloaded,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const aborted = isAbortError(error) || signal.aborted;
      if (aborted) {
        // A cancel is not an error state — keep `.part` for resume and reset to
        // a resumable phase.
        this.setPhase(this.isModelPresent() ? 'done' : 'idle');
        this.logger.info('ai.model_download_paused', {
          modelId: this.model.id,
          bytes: this.bytesDownloaded,
        });
        return;
      }
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.setPhase('error');
      this.emitProgress(true);
      this.logger.error('ai.model_download_error', {
        modelId: this.model.id,
        error: this.errorMessage,
      });
    }
  }

  private async partialBytes(): Promise<number> {
    try {
      const s = await stat(this.partPath);
      return s.isFile() ? s.size : 0;
    } catch {
      return 0;
    }
  }

  private async readDeclinedMarker(): Promise<boolean> {
    try {
      await readFile(this.declinedMarkerPath, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  private currentProgress(): ModelDownloadProgress {
    const percent =
      this.totalBytes && this.totalBytes > 0
        ? Math.min(100, Math.round((this.bytesDownloaded / this.totalBytes) * 100))
        : undefined;
    return {
      phase: this.phase,
      modelId: this.model.id,
      fileName: this.model.fileName,
      bytesDownloaded: this.bytesDownloaded,
      totalBytes: this.totalBytes,
      percent,
      error: this.errorMessage,
    };
  }

  private setPhase(phase: ModelDownloadPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    // Phase transitions always emit, bypassing the byte-progress throttle.
    this.lastEmitAt = 0;
    this.emitProgress(true);
  }

  private emitProgress(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastEmitAt < PROGRESS_EMIT_INTERVAL_MS) return;
    this.lastEmitAt = now;
    this.emitter.emit('progress', this.currentProgress());
  }
}

// ---------------------------------------------------------------------------
// Small fs/stream helpers
// ---------------------------------------------------------------------------

function writeChunk(stream: WriteStream, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (err) => (err ? reject(err) : resolve()));
  });
}

function endStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.end((err?: NodeJS.ErrnoException | null) => (err ? reject(err) : resolve()));
  });
}

/** Streaming SHA256 of a file (never loads the whole ~2 GB into memory). */
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const rs = createReadStream(filePath);
    rs.on('error', reject);
    rs.on('data', (chunk) => hash.update(chunk));
    rs.on('end', () => resolve(hash.digest('hex')));
  });
}

function makeAbortError(): Error {
  const err = new Error('The download was aborted.');
  err.name = 'AbortError';
  return err;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
