/**
 * Runtime capability check for real video transcoding. `ffmpeg` is a native
 * binary this package does not (and should not) vendor — it must already be
 * on the host's PATH. Every real-transcode entry point in `videoTranscode.ts`
 * calls `assertFfmpegAvailable()` first so a missing binary fails fast with
 * an actionable error instead of a cryptic ENOENT from `spawn`.
 *
 * The RenditionPlanner itself never calls ffmpeg directly: target SELECTION
 * (`videoPlan.ts`) is pure and always runs; only the actual bytes-in/
 * bytes-out transcode step is gated behind this check, so planning/tests work
 * identically with or without ffmpeg installed.
 */

import { spawn } from 'node:child_process';

let cached: boolean | undefined;

/** Runs `ffmpeg -version` once and caches the result for the process lifetime. */
export async function isFfmpegAvailable(): Promise<boolean> {
  if (cached !== undefined) return cached;
  cached = await new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const child = spawn('ffmpeg', ['-version']);
      child.on('error', () => done(false));
      child.on('exit', (code) => done(code === 0));
    } catch {
      done(false);
    }
  });
  return cached;
}

/** Test-only: forces the next `isFfmpegAvailable()` call to recompute. */
export function resetFfmpegAvailabilityCache(): void {
  cached = undefined;
}

export class FfmpegUnavailableError extends Error {
  constructor() {
    super(
      'ffmpeg is not installed / not on PATH. Real video transcoding requires an ffmpeg binary ' +
        '(https://ffmpeg.org/download.html) on the machine running @social/media; target-selection ' +
        'and planning still work without it, but actual bytes-in/bytes-out transcode does not.',
    );
    this.name = 'FfmpegUnavailableError';
  }
}

export async function assertFfmpegAvailable(): Promise<void> {
  if (!(await isFfmpegAvailable())) {
    throw new FfmpegUnavailableError();
  }
}
