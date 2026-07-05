/**
 * Reads the bytes for a `MediaSource` so they can be staged with
 * `POST /api/v2/media`. `MediaSource.uri` is either a local file path
 * (written by the media pipeline) or an object-store URL — never a Mastodon
 * endpoint, so this is plain I/O, not a platform API call.
 */
import { readFile } from 'node:fs/promises';

export async function readMediaBytes(uri: string, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  if (/^https?:\/\//i.test(uri)) {
    const res = await fetchImpl(uri);
    if (!res.ok) {
      throw new Error(`Failed to fetch media source "${uri}": HTTP ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }
  const fileUri = uri.startsWith('file://') ? new URL(uri) : uri;
  const buf = await readFile(fileUri);
  return new Uint8Array(buf);
}
