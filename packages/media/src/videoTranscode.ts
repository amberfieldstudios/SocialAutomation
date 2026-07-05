/**
 * Real video transcoding via the `ffmpeg` CLI (spawned directly — no
 * fluent-ffmpeg dependency needed for a single fixed pipeline). Every call
 * here MUST be preceded by `assertFfmpegAvailable()`; callers normally reach
 * this only through `RenditionPlanner.execute()`, which does that check and
 * skips real transcode (leaving a `pending`/`failed` rendition with an
 * actionable message) when ffmpeg isn't present.
 *
 * This module is NOT exercised by real ffmpeg in this environment's test run
 * (no ffmpeg binary on this machine — see the package README/task report);
 * `videoPlan.test.ts` covers the pure selection logic that decides *what*
 * this module would be asked to do.
 */

import { spawn } from 'node:child_process';
import { assertFfmpegAvailable } from './videoCapability';
import type { VideoTargetPlan } from './videoPlan';
import type { CaptionTrack } from './types';

export interface TranscodeResult {
  outPath: string;
  width: number;
  height: number;
  bitrate: number;
}

/**
 * Transcodes `sourcePath` to `outPath` (mp4/h264/aac) at the resolution and
 * bitrate from `plan`. If `captions` are provided and supported, embeds them
 * as soft subtitle streams (mov_text) rather than burning them into frames,
 * so the platform/player can toggle them.
 */
export async function transcodeVideo(
  sourcePath: string,
  outPath: string,
  plan: VideoTargetPlan,
  captions: CaptionTrack[] = [],
): Promise<TranscodeResult> {
  await assertFfmpegAvailable();

  const args = ['-y', '-i', sourcePath];
  for (const track of captions) {
    args.push('-i', track.uri);
  }
  args.push(
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-vf',
    `scale=${plan.targetWidth}:${plan.targetHeight}`,
    '-c:v',
    'libx264',
    '-b:v',
    String(plan.targetBitrateBps),
    '-c:a',
    'aac',
    '-b:a',
    String(plan.targetAudioBitrateBps),
  );
  captions.forEach((_, i) => {
    args.push('-map', `${i + 1}:0`, '-c:s', 'mov_text');
  });
  args.push(outPath);

  await runFfmpeg(args);

  return {
    outPath,
    width: plan.targetWidth,
    height: plan.targetHeight,
    bitrate: plan.targetBitrateBps,
  };
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args);
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
}
