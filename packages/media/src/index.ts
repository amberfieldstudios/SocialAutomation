/**
 * @social/media — the media-processing pipeline stage.
 *
 * Derives platform-appropriate image renditions (square/portrait/landscape/
 * story/thumbnail/compressed) with `sharp`, selects video resolution/bitrate/
 * caption-track targets and (when `ffmpeg` is on PATH) transcodes video, and
 * validates source media against each platform's spec in
 * `docs/PLATFORM-RULES.md` before the pipeline ever attempts an upload. See
 * `README.md` for the ffmpeg requirement and what's real vs. selection-only.
 */

export * from './types';
export * from './platformSpecs';
export * from './validation';
export * from './imageRenditions';
export * from './videoPlan';
export * from './videoCapability';
export * from './videoTranscode';
export * from './planner';
export { newAssetId, newRenditionId, nowIso } from './ids';
