/**
 * SQLite-backed `AccountsStore` (the port declared in
 * `@social/auth/src/store.ts`). Drop-in replacement for `InMemoryAccountsStore`.
 *
 * FK note: `accounts.platform_id` references `platforms(id)` and foreign keys
 * are enforced, so a matching `platforms` row must exist before `insert` — the
 * real pairing flow registers the platform (via the plugin loader) first; tests
 * seed it with `SqlitePlatformsRepo`.
 */

import type { StructuredLogger } from '@social/core';
import type {
  AccountRecord,
  AccountStatus,
  AccountsStore,
  ListAccountsFilter,
} from '@social/auth';
import type { SqlDriver } from '../driver';
import { nullableText, parseJsonNullable, toJson } from './rows';

interface AccountRow {
  id: string;
  platform_id: string;
  remote_id: string;
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
  profile_url: string | null;
  profile_metadata: string | null;
  status: string;
  connected_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    platformId: row.platform_id,
    remoteId: row.remote_id,
    handle: nullableText(row.handle),
    displayName: nullableText(row.display_name),
    avatarUrl: nullableText(row.avatar_url),
    profileUrl: nullableText(row.profile_url),
    profileMetadata: parseJsonNullable<Record<string, unknown>>(row.profile_metadata),
    status: row.status as AccountStatus,
    connectedAt: nullableText(row.connected_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT = 'SELECT * FROM accounts';

export class SqliteAccountsStore implements AccountsStore {
  constructor(
    private readonly driver: SqlDriver,
    private readonly logger?: StructuredLogger,
  ) {}

  insert(account: AccountRecord): Promise<AccountRecord> {
    this.driver.run(
      `INSERT INTO accounts
         (id, platform_id, remote_id, handle, display_name, avatar_url, profile_url,
          profile_metadata, status, connected_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        account.id,
        account.platformId,
        account.remoteId,
        account.handle ?? null,
        account.displayName ?? null,
        account.avatarUrl ?? null,
        account.profileUrl ?? null,
        toJson(account.profileMetadata),
        account.status,
        account.connectedAt ?? null,
        account.createdAt,
        account.updatedAt,
      ],
    );
    this.logger?.info('db.accounts.insert', {
      accountId: account.id,
      platform: account.platformId,
      status: account.status,
    });
    return Promise.resolve(mapRow(this.requireRow(account.id)));
  }

  update(
    id: string,
    patch: Partial<Omit<AccountRecord, 'id' | 'createdAt'>>,
  ): Promise<AccountRecord> {
    const existing = this.driver.get<AccountRow>(`${SELECT} WHERE id = ?`, [id]);
    if (!existing) {
      return Promise.reject(new Error(`account ${id} not found`));
    }
    const columns: Record<string, unknown> = {};
    if ('platformId' in patch) columns.platform_id = patch.platformId;
    if ('remoteId' in patch) columns.remote_id = patch.remoteId;
    if ('handle' in patch) columns.handle = patch.handle ?? null;
    if ('displayName' in patch) columns.display_name = patch.displayName ?? null;
    if ('avatarUrl' in patch) columns.avatar_url = patch.avatarUrl ?? null;
    if ('profileUrl' in patch) columns.profile_url = patch.profileUrl ?? null;
    if ('profileMetadata' in patch) columns.profile_metadata = toJson(patch.profileMetadata);
    if ('status' in patch) columns.status = patch.status;
    if ('connectedAt' in patch) columns.connected_at = patch.connectedAt ?? null;
    columns.updated_at = patch.updatedAt ?? new Date().toISOString();

    const keys = Object.keys(columns);
    const setClause = keys.map((k) => `${k} = ?`).join(', ');
    this.driver.run(`UPDATE accounts SET ${setClause} WHERE id = ?`, [
      ...keys.map((k) => columns[k] as never),
      id,
    ]);
    this.logger?.info('db.accounts.update', { accountId: id, fields: keys });
    return Promise.resolve(mapRow(this.requireRow(id)));
  }

  getById(id: string): Promise<AccountRecord | undefined> {
    const row = this.driver.get<AccountRow>(`${SELECT} WHERE id = ?`, [id]);
    return Promise.resolve(row ? mapRow(row) : undefined);
  }

  getByRemote(platformId: string, remoteId: string): Promise<AccountRecord | undefined> {
    const row = this.driver.get<AccountRow>(
      `${SELECT} WHERE platform_id = ? AND remote_id = ?`,
      [platformId, remoteId],
    );
    return Promise.resolve(row ? mapRow(row) : undefined);
  }

  list(filter?: ListAccountsFilter): Promise<AccountRecord[]> {
    const clauses: string[] = [];
    const params: (string | null)[] = [];
    if (filter?.platformId) {
      clauses.push('platform_id = ?');
      params.push(filter.platformId);
    }
    if (filter?.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.driver.all<AccountRow>(`${SELECT}${where} ORDER BY created_at`, params);
    return Promise.resolve(rows.map(mapRow));
  }

  delete(id: string): Promise<void> {
    this.driver.run('DELETE FROM accounts WHERE id = ?', [id]);
    this.logger?.info('db.accounts.delete', { accountId: id });
    return Promise.resolve();
  }

  private requireRow(id: string): AccountRow {
    const row = this.driver.get<AccountRow>(`${SELECT} WHERE id = ?`, [id]);
    if (!row) throw new Error(`account ${id} not found after write`);
    return row;
  }
}
