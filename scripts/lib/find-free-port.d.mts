/**
 * Type declarations for find-free-port.mjs (plain JS, shared by the dev
 * bootstrap and packages/api/src/prod.ts, which is type-checked).
 */
export interface FindFreePortOptions {
  attempts?: number;
  host?: string;
}

export function findFreePort(preferred: number, opts?: FindFreePortOptions): Promise<number>;
