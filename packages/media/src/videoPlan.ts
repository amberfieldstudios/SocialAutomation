/**
 * Pure video target-SELECTION logic: given a source video's known metadata
 * and a platform's `VideoSpec`, decide which resolution/bitrate to transcode
 * to and whether a caption track can be attached. No I/O, no ffmpeg call —
 * this is the part of "video handling" that must work (and be unit-tested)
 * identically whether or not ffmpeg is installed on the machine.
 */

import type { VideoSpec } from './platformSpecs';
import type { CaptionTrack } from './types';

export interface VideoSourceInfo {
  width: number;
  height: number;
  durationMs: number;
  bytes: number;
  mimeType: string;
}

export interface VideoTargetPlan {
  /** False when the source already fits the platform's spec byte-for-byte. */
  needsTranscode: boolean;
  targetWidth: number;
  targetHeight: number;
  targetBitrateBps: number;
  targetAudioBitrateBps: number;
  /** Human-readable reasons transcoding was (or wasn't) selected. */
  reasons: string[];
}

/**
 * Selects the resolution/bitrate a source video should be transcoded to for
 * `spec`. Preserves the source aspect ratio, only ever scales the long edge
 * down to `spec.targetResolutionPx` (never up), and estimates whether the
 * spec's target bitrate would still exceed `spec.maxBytes` over the source's
 * duration, tightening the bitrate further if so.
 */
export function selectVideoTarget(source: VideoSourceInfo, spec: VideoSpec): VideoTargetPlan {
  const reasons: string[] = [];
  const longEdge = Math.max(source.width, source.height);
  const scale = longEdge > spec.targetResolutionPx ? spec.targetResolutionPx / longEdge : 1;

  let targetWidth = evenify(Math.round(source.width * scale));
  let targetHeight = evenify(Math.round(source.height * scale));

  if (scale < 1) {
    reasons.push(
      `long edge ${longEdge}px exceeds target ${spec.targetResolutionPx}px; downscaling to ${targetWidth}x${targetHeight}`,
    );
  } else {
    targetWidth = source.width;
    targetHeight = source.height;
    reasons.push(`source resolution ${source.width}x${source.height} already at/under target; no upscale`);
  }

  let targetBitrateBps = spec.targetBitrateBps;
  const durationSec = source.durationMs / 1000;
  if (durationSec > 0) {
    const estimatedBytes = ((targetBitrateBps + spec.targetAudioBitrateBps) / 8) * durationSec;
    if (estimatedBytes > spec.maxBytes) {
      // Tighten the video bitrate so total estimated size fits maxBytes,
      // leaving audio bitrate untouched (audio is a small share of the budget).
      const availableBitsPerSec = (spec.maxBytes * 8) / durationSec - spec.targetAudioBitrateBps;
      targetBitrateBps = Math.max(200_000, Math.floor(availableBitsPerSec));
      reasons.push(
        `spec target bitrate would produce ~${Math.round(estimatedBytes)} bytes, over the ${spec.maxBytes}-byte cap; tightened to ${targetBitrateBps} bps`,
      );
    }
  }

  const needsTranscode =
    scale < 1 ||
    targetBitrateBps !== spec.targetBitrateBps ||
    source.bytes > spec.maxBytes ||
    source.mimeType !== 'video/mp4';

  if (!needsTranscode) {
    reasons.push('source already fits the platform spec as-is; transcode not required');
  }

  return {
    needsTranscode,
    targetWidth,
    targetHeight,
    targetBitrateBps,
    targetAudioBitrateBps: spec.targetAudioBitrateBps,
    reasons,
  };
}

function evenify(n: number): number {
  // Most video codecs (h264/vp9) require even width/height.
  return n % 2 === 0 ? n : n - 1;
}

export interface CaptionPlanResult {
  attach: CaptionTrack[];
  dropped: Array<{ track: CaptionTrack; reason: string }>;
}

/**
 * Decides which supplied caption/subtitle tracks can actually be attached
 * for a platform. Platforms that don't support a caption-track upload
 * surface (per `VideoSpec.supportsCaptionTrack`) get every track dropped
 * with an explicit reason rather than silently discarded.
 */
export function planCaptionTracks(tracks: CaptionTrack[], spec: VideoSpec): CaptionPlanResult {
  if (!spec.supportsCaptionTrack) {
    return {
      attach: [],
      dropped: tracks.map((track) => ({
        track,
        reason: 'platform does not accept a separate caption/subtitle track upload',
      })),
    };
  }
  const attach: CaptionTrack[] = [];
  const dropped: CaptionPlanResult['dropped'] = [];
  const seenLanguages = new Set<string>();
  for (const track of tracks) {
    if (seenLanguages.has(track.language)) {
      dropped.push({ track, reason: `duplicate caption track for language "${track.language}"` });
      continue;
    }
    seenLanguages.add(track.language);
    attach.push(track);
  }
  return { attach, dropped };
}
