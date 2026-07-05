/**
 * Support repository for the `platforms` table.
 *
 * NOT one of the swap-in ports (auth/queue don't define a platforms port), but
 * required because `accounts.platform_id` and `post_variants.platform_id` are
 * foreign keys into it and the schema enforces `PRAGMA foreign_keys = ON`. In
 * the real system, plugin registration (the loader in `@social/core`) upserts a
 * `platforms` row per installed connector before any account is paired; this
 * repo is that write path plus a lookup, and is used by tests to satisfy the FK
 * chain.
 */

import type { SqlDriver, SqlValue } from '../driver';
import { toBool } from './rows';

export interface PlatformRecord {
  id: string;
  displayName: string;
  apiBaseUrl: string;
  contractVersion: string;
  /** CapabilityDescriptor snapshot. */
  capabilities: unknown;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface PlatformRow {
  id: string;
  display_name: string;
  api_base_url: string;
  contract_version: string;
  capabilities: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface UpsertPlatformInput {
  id: string;
  displayName: string;
  apiBaseUrl: string;
  contractVersion: string;
  capabilities?: unknown;
  enabled?: boolean;
}

function mapRow(row: PlatformRow): PlatformRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    apiBaseUrl: row.api_base_url,
    contractVersion: row.contract_version,
    capabilities: JSON.parse(row.capabilities) as unknown,
    enabled: toBool(row.enabled as unknown as SqlValue),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqlitePlatformsRepo {
  constructor(private readonly driver: SqlDriver) {}

  upsert(input: UpsertPlatformInput): PlatformRecord {
    const now = new Date().toISOString();
    this.driver.run(
      `INSERT INTO platforms (id, display_name, api_base_url, contract_version, capabilities, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         display_name = excluded.display_name,
         api_base_url = excluded.api_base_url,
         contract_version = excluded.contract_version,
         capabilities = excluded.capabilities,
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
      [
        input.id,
        input.displayName,
        input.apiBaseUrl,
        input.contractVersion,
        JSON.stringify(input.capabilities ?? {}),
        input.enabled ?? true,
        now,
        now,
      ],
    );
    return this.get(input.id)!;
  }

  get(id: string): PlatformRecord | undefined {
    const row = this.driver.get<PlatformRow>('SELECT * FROM platforms WHERE id = ?', [id]);
    return row ? mapRow(row) : undefined;
  }

  list(): PlatformRecord[] {
    return this.driver.all<PlatformRow>('SELECT * FROM platforms ORDER BY id').map(mapRow);
  }
}
