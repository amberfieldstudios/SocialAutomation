/**
 * Test doubles the harness installs: a capturing StructuredLogger and a global
 * `fetch` stub that records every outbound request and routes it through the
 * plugin's `ConformanceMockEnv.route`.
 *
 * All three m3 connectors ultimately call the Node global `fetch` (Discord's
 * REST client, Twitch's direct fetch, and Bluesky's XrpcClient default), so a
 * single global-fetch stub intercepts every platform uniformly — no per-plugin
 * transport knowledge leaks into the harness.
 */

import { vi } from 'vitest';

import type { LogFields, StructuredLogger } from '@social/core';

import type { ConformanceMockEnv, RoutedRequest, RouteScenario } from './types';

export interface CapturedLine {
  level: string;
  message: string;
  fields?: LogFields;
}

/** A StructuredLogger that captures every line (children share the same buffer). */
export class CapturingLogger implements StructuredLogger {
  readonly lines: CapturedLine[];
  private readonly bindings: LogFields;

  constructor(lines: CapturedLine[] = [], bindings: LogFields = {}) {
    this.lines = lines;
    this.bindings = bindings;
  }

  child(bindings: LogFields): StructuredLogger {
    return new CapturingLogger(this.lines, { ...this.bindings, ...bindings });
  }

  private push(level: string, message: string, fields?: LogFields): void {
    this.lines.push({ level, message, fields: { ...this.bindings, ...fields } });
  }

  trace(message: string, fields?: LogFields): void {
    this.push('trace', message, fields);
  }
  debug(message: string, fields?: LogFields): void {
    this.push('debug', message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.push('info', message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.push('warn', message, fields);
  }
  error(message: string, fields?: LogFields): void {
    this.push('error', message, fields);
  }

  /** Everything logged, serialized — used for secret-substring assertions. */
  serialized(): string {
    return JSON.stringify(this.lines);
  }
}

/** Coerce fetch's many header shapes into a plain record. */
function normalizeHeaders(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const h = init?.headers;
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((value, key) => {
      out[key] = value;
    });
  } else if (Array.isArray(h)) {
    for (const pair of h) {
      const key = pair[0];
      if (key !== undefined) out[key] = String(pair[1]);
    }
  } else {
    for (const [key, value] of Object.entries(h)) out[key] = String(value);
  }
  return out;
}

function bodyToString(init?: RequestInit): string | undefined {
  const b = init?.body;
  if (b === undefined || b === null) return undefined;
  if (typeof b === 'string') return b;
  if (b instanceof URLSearchParams) return b.toString();
  // FormData / Blob / stream bodies — capture the type name, not the bytes.
  return `[${b.constructor?.name ?? typeof b}]`;
}

export interface InstalledFetch {
  calls: RoutedRequest[];
  stub: ReturnType<typeof vi.fn>;
  restore: () => void;
}

/**
 * Installs a global `fetch` stub for `scenario`, recording every request into
 * `calls`. Restores the real fetch via `restore()` (or `vi.unstubAllGlobals`).
 */
export function installFetch(env: ConformanceMockEnv, scenario: RouteScenario): InstalledFetch {
  const calls: RoutedRequest[] = [];
  const stub = vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const req: RoutedRequest = {
      url,
      method,
      headers: normalizeHeaders(init),
      body: bodyToString(init),
    };
    calls.push(req);
    return env.route(req, scenario);
  });
  vi.stubGlobal('fetch', stub);
  return { calls, stub, restore: () => vi.unstubAllGlobals() };
}

/** The union of headers+body across all recorded requests, serialized. */
export function serializeRequests(calls: RoutedRequest[]): string {
  return JSON.stringify(calls.map((c) => ({ url: c.url, method: c.method, headers: c.headers, body: c.body })));
}

/** Hostname of a URL, or '' if unparseable. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
