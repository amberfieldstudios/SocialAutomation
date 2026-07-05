/**
 * Shared "pick a free TCP port" helper used by both the dev bootstrap
 * (`scripts/start.mjs`) and the packaged-distributable bootstrap
 * (`launcher/bootstrap.mjs`), so both paths handle "port already in use"
 * the same friendly way instead of letting the server crash with a raw
 * EADDRINUSE stack trace.
 *
 * Tries `preferred` first, then `preferred+1 .. preferred+attempts-1`.
 * Returns the first port that can be bound, or throws a plain-language
 * Error if none of them are free.
 */
import net from 'node:net';

function canBind(port, host) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });
    try {
      tester.listen({ port, host, exclusive: true });
    } catch {
      resolve(false);
    }
  });
}

/**
 * @param {number} preferred
 * @param {{ attempts?: number, host?: string }} [opts]
 * @returns {Promise<number>}
 */
export async function findFreePort(preferred, opts = {}) {
  const attempts = opts.attempts ?? 20;
  const host = opts.host ?? '0.0.0.0';
  for (let i = 0; i < attempts; i++) {
    const candidate = preferred + i;
    if (await canBind(candidate, host)) {
      return candidate;
    }
  }
  throw new Error(
    `Every port from ${preferred} to ${preferred + attempts - 1} is already in use on this machine. ` +
      'Close whatever else is using them (or another copy of SocialAutomation) and try again, ' +
      `or set the PORT environment variable to a free port yourself.`,
  );
}
