/**
 * Reads the bytes for a `MediaSource` so `publish`/`edit` can attach them to a
 * Discord message as multipart `files[n]` parts (Discord's bot API has no
 * separate "stage a file, get a persistent handle" endpoint for ordinary
 * channel/webhook messages — see README.md "Contract gaps" #1).
 *
 * Supports:
 *  - `data:` URIs (used by tests / small inline assets)
 *  - local file paths (object-store downloads land on local disk upstream of us)
 *  - http(s) URLs (proxy-fetched, e.g. a signed object-store URL)
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { MediaSource } from '@social/core';
import type { DiscordRequestFile } from './http';

function filenameFor(source: MediaSource, index: number): string {
  try {
    const base = path.basename(new URL(source.uri).pathname || '');
    if (base) return base;
  } catch {
    const base = path.basename(source.uri);
    if (base && base !== source.uri) return base;
  }
  const ext = source.mimeType.split('/')[1] ?? 'bin';
  return `attachment-${index}.${ext}`;
}

export async function readMediaBytes(source: MediaSource, index: number): Promise<DiscordRequestFile> {
  const filename = filenameFor(source, index);

  if (source.uri.startsWith('data:')) {
    const comma = source.uri.indexOf(',');
    const meta = source.uri.slice(5, comma);
    const data = source.uri.slice(comma + 1);
    const bytes = meta.includes('base64') ? Buffer.from(data, 'base64') : Buffer.from(decodeURIComponent(data), 'utf8');
    return { name: `files[${index}]`, filename, contentType: source.mimeType, data: bytes };
  }

  if (source.uri.startsWith('http://') || source.uri.startsWith('https://')) {
    const res = await fetch(source.uri);
    if (!res.ok) {
      throw new Error(`Failed to fetch media source "${source.uri}": HTTP ${res.status}`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    return { name: `files[${index}]`, filename, contentType: source.mimeType, data: buf };
  }

  const buf = await readFile(source.uri);
  return { name: `files[${index}]`, filename, contentType: source.mimeType, data: new Uint8Array(buf) };
}
