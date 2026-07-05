import { createLogger } from '@social/logging';
import type { OperationContext, TokenSet } from '@social/core';

/** Builds an unsigned but structurally-valid AT Proto session JWT for tests. */
export function fakeJwt(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub, scope: 'com.atproto.access' })).toString('base64url');
  return `${header}.${payload}.sig`;
}

export function makeLogger(sink: (line: string) => void = () => {}) {
  return createLogger({ level: 'trace', sink });
}

export function makeToken(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: fakeJwt('did:plc:testaccount'),
    refreshToken: 'FAKE-REFRESH-JWT',
    tokenType: 'Bearer',
    scopes: ['atproto'],
    obtainedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    token: makeToken(),
    app: { clientId: 'unused' },
    accountId: 'acct_1',
    logger: makeLogger(),
    ...overrides,
  };
}

/** A minimal `fetch`-shaped mock driven by a queue of canned responses, keyed by call order. */
export function mockFetchSequence(handlers: Array<(url: string, init?: RequestInit) => Response | Promise<Response>>) {
  let i = 0;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    calls.push({ url, init });
    const handler = handlers[i];
    i += 1;
    if (!handler) throw new Error(`No mock handler configured for call #${i} (${url})`);
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
