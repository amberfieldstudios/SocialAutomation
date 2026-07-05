/**
 * Types mirroring the `media_assets` / `media_renditions` tables
 * (`packages/db/migrations/0001_init.sql`) plus the pure planning types used
 * internally by the RenditionPlanner. Keeping these as plain data (no I/O)
 * means every transform in this package stays a pure
 * input-file -> output-file step: callers persist the returned records
 * themselves via `@social/db`.
 */

import type { MediaType } from '@social/core';

export type { MediaType };

/** Matches `media_assets.status`. */
export type MediaAssetStatus = 'uploading' | 'ready' | 'failed';

/** Matches `media_renditions.kind`. */
export type RenditionKind =
  | 'original'
  | 'square'
  | 'portrait'
  | 'landscape'
  | 'story'
  | 'thumbnail'
  | 'compressed';

/** Matches `media_renditions.status`. */
export type RenditionStatus = 'pending' | 'processing' | 'ready' | 'failed';

/**
 * A source media file handed to the pipeline. `path` must be a local
 * filesystem path the current process can read (upstream stages are
 * responsible for staging uploads to disk/object-store first).
 */
export interface SourceMedia {
  /** Internal `media_assets.id`, if this asset is already persisted. */
  assetId?: string;
  postId?: string;
  mediaType: MediaType;
  originalFilename?: string;
  mimeType: string;
  path: string;
  bytes?: number;
  width?: number;
  height?: number;
  durationMs?: number;
  checksum?: string;
  altText?: string;
}

/** Row shape for `media_assets`, as this package produces/updates it. */
export interface MediaAssetRecord {
  id: string;
  postId: string | null;
  mediaType: MediaType;
  originalFilename: string | null;
  mimeType: string;
  bytes: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  checksum: string | null;
  storageUri: string;
  altText: string | null;
  status: MediaAssetStatus;
  createdAt: string;
  updatedAt: string;
}

/** Row shape for `media_renditions`, as this package produces it. */
export interface MediaRenditionRecord {
  id: string;
  assetId: string;
  kind: RenditionKind;
  mimeType: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  bytes: number | null;
  bitrate: number | null;
  storageUri: string;
  status: RenditionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MediaProcessingIssue {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  field?: string;
  limit?: number;
  actual?: number;
}

export interface CaptionTrack {
  /** BCP-47 language tag, e.g. 'en-US'. */
  language: string;
  /** Location of the subtitle/caption file (SRT/VTT) the connector should attach. */
  uri: string;
  format: 'srt' | 'vtt';
  /** True if burned into the video frame rather than a sidecar/side-loaded track. */
  burnedIn?: boolean;
}
