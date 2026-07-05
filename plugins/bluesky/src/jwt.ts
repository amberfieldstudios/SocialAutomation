/**
 * Best-effort, unverified decode of an AT Proto access/refresh JWT payload.
 *
 * We only ever decode a JWT that arrived inside our own `ctx.token` (already
 * authenticated and handed to us by the auth layer) purely to read the `sub`
 * claim (the account's DID), which AT Proto embeds in every session JWT. This
 * is the same non-verifying decode every `@atproto/api`-based client performs
 * client-side; the server still authorizes the underlying request using the
 * bearer token itself, so a forged/garbage claim here cannot escalate
 * privilege — it can only cause our own request to target the wrong `repo`
 * and fail server-side.
 *
 * SECURITY: never log the raw token; only ever log the decoded `sub` (a DID,
 * not a secret).
 */
export function decodeJwtSubject(jwt: string): string | undefined {
  const parts = jwt.split('.');
  if (parts.length < 2) return undefined;
  try {
    const payloadPart = parts[1] ?? '';
    const normalized = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const payload = JSON.parse(json) as { sub?: string };
    return payload.sub;
  } catch {
    return undefined;
  }
}
