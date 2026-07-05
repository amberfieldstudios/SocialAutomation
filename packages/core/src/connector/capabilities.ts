/**
 * Capability descriptor: how a platform DECLARES what it can and cannot do.
 *
 * The descriptor is the single source of truth for feature detection. Callers
 * check `capabilities.operations.<op>` (or the convenience `supports*` flags)
 * before invoking an operation; connectors whose descriptor says an operation
 * is unsupported MUST throw `NotSupportedError` from that method (see errors.ts).
 * Every numeric limit MUST match docs/PLATFORM-RULES.md and the platform's
 * official API docs.
 */

import type { ConnectorOperation, MediaType, MediaUploadMode } from './types';

/** Per-operation support flags — the source of truth for NotSupportedError. */
export interface OperationSupport {
  connect: boolean;
  authenticate: boolean;
  refreshToken: boolean;
  validatePost: boolean;
  uploadMedia: boolean;
  publish: boolean;
  delete: boolean;
  edit: boolean;
  getAnalytics: boolean;
  disconnect: boolean;
}

/** Constraints for one media type, sourced from the platform's official docs. */
export interface MediaConstraint {
  type: MediaType;
  /** Accepted MIME types, e.g. ['image/jpeg', 'image/png']. */
  mimeTypes: string[];
  maxBytes?: number;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  minDurationMs?: number;
  maxDurationMs?: number;
  maxFrameRate?: number;
  /** Allowed aspect ratios as 'W:H' strings, e.g. ['1:1', '4:5', '16:9']. */
  aspectRatios?: string[];
}

/** Advisory rate-limit hint; connectors still surface RateLimitError at runtime. */
export interface RateLimitHint {
  requestsPerWindow: number;
  windowMs: number;
  scope?: 'app' | 'account';
}

export interface CapabilityDescriptor {
  /** Stable platform id, e.g. 'discord', 'bluesky', 'x'. Matches plugin + DB. */
  platform: string;
  displayName: string;
  /** Documented official API base URL (no scraping/undocumented endpoints). */
  apiBaseUrl: string;
  /** Contract version this descriptor targets (semver). */
  contractVersion: string;

  /** Authoritative per-operation support map. */
  operations: OperationSupport;

  // --- Convenience high-level flags (mirror `operations`/limits above) -------
  supportsEdit: boolean;
  supportsDelete: boolean;
  /** Native platform-side scheduling (distinct from our own scheduler). */
  supportsScheduling: boolean;
  supportsThreads: boolean;
  supportsAnalytics: boolean;
  supportsMediaUpload: boolean;

  // --- Text constraints ------------------------------------------------------
  /** Max characters in the post body. */
  characterLimit: number;
  titleCharacterLimit?: number;
  altTextCharacterLimit?: number;
  /** Whether URLs count against `characterLimit`. */
  urlsCountTowardLimit: boolean;
  /** Fixed character weight a URL consumes when the platform t.co-style wraps. */
  countedUrlLength?: number;
  maxHashtags?: number;
  maxMentions?: number;

  // --- Media constraints -----------------------------------------------------
  /** Max attachments per post. 0 means media is not supported. */
  maxMediaCount: number;
  supportedMediaTypes: MediaType[];
  mediaConstraints: MediaConstraint[];
  /**
   * `'staged'` (default expectation) vs `'inline'` — see `MediaUploadMode` for
   * the full contract. Meaningless when `operations.uploadMedia` is `false`,
   * but still required for a uniform descriptor shape; platforms that don't
   * support media at all should set `'staged'` as an inert default.
   */
  mediaUploadMode: MediaUploadMode;

  // --- Threading -------------------------------------------------------------
  /** Max posts in one thread, when `supportsThreads`. */
  maxThreadLength?: number;

  // --- Scheduling / rate limits ---------------------------------------------
  /** How far ahead native scheduling allows, in days. */
  nativeScheduleHorizonDays?: number;
  rateLimit?: RateLimitHint;
}

/** Feature-detection helper: is `op` declared supported by this platform? */
export function supportsOperation(
  capabilities: CapabilityDescriptor,
  op: ConnectorOperation,
): boolean {
  return capabilities.operations[op] === true;
}
