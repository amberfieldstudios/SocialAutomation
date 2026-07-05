/**
 * SQLite-backed repository over `scheduled_campaigns` (migration 0006).
 *
 * A 1:1 child of `schedules` (see that migration's comment for why this is a
 * separate table): persists the pipeline package's `ComposeAndSubmitInput`
 * (opaque JSON as far as this package is concerned — `@social/db` has no
 * dependency on `@social/pipeline`) keyed by `schedule_id`, so a scheduled or
 * recurring campaign survives a process restart: `ScheduleMaterializer` reads
 * the schedule from `schedules`, and the pipeline's submit function reads the
 * matching compose spec from here instead of an in-process `Map`.
 */

import type { StructuredLogger } from '@social/core';
import type { SqlDriver } from '../driver';
import { parseJson } from './rows';

export interface ScheduledCampaignRecord<TSpec = unknown> {
  scheduleId: string;
  composeSpec: TSpec;
  createdAt: string;
}

export interface CreateScheduledCampaignInput<TSpec = unknown> {
  scheduleId: string;
  composeSpec: TSpec;
}

interface ScheduledCampaignRow {
  schedule_id: string;
  compose_spec: string;
  created_at: string;
}

function mapRow<TSpec>(row: ScheduledCampaignRow): ScheduledCampaignRecord<TSpec> {
  return {
    scheduleId: row.schedule_id,
    composeSpec: parseJson<TSpec>(row.compose_spec, undefined as TSpec),
    createdAt: row.created_at,
  };
}

/** Storage port `@social/pipeline`'s scheduler wiring depends on (structurally). */
export interface ScheduledCampaignsStore {
  /** Insert the compose spec for a just-created schedule. Throws on duplicate `scheduleId` (1:1). */
  create<TSpec = unknown>(input: CreateScheduledCampaignInput<TSpec>): ScheduledCampaignRecord<TSpec>;
  getByScheduleId<TSpec = unknown>(scheduleId: string): ScheduledCampaignRecord<TSpec> | undefined;
}

export class SqliteScheduledCampaignsRepo implements ScheduledCampaignsStore {
  constructor(
    private readonly driver: SqlDriver,
    private readonly logger?: StructuredLogger,
  ) {}

  create<TSpec = unknown>(input: CreateScheduledCampaignInput<TSpec>): ScheduledCampaignRecord<TSpec> {
    const now = new Date().toISOString();
    this.driver.run(
      `INSERT INTO scheduled_campaigns (schedule_id, compose_spec, created_at) VALUES (?, ?, ?)`,
      [input.scheduleId, JSON.stringify(input.composeSpec), now],
    );
    this.logger?.info('db.scheduled_campaign.created', { scheduleId: input.scheduleId });
    return this.requireRow<TSpec>(input.scheduleId);
  }

  getByScheduleId<TSpec = unknown>(scheduleId: string): ScheduledCampaignRecord<TSpec> | undefined {
    const row = this.driver.get<ScheduledCampaignRow>(
      'SELECT * FROM scheduled_campaigns WHERE schedule_id = ?',
      [scheduleId],
    );
    return row ? mapRow<TSpec>(row) : undefined;
  }

  private requireRow<TSpec>(scheduleId: string): ScheduledCampaignRecord<TSpec> {
    const row = this.driver.get<ScheduledCampaignRow>(
      'SELECT * FROM scheduled_campaigns WHERE schedule_id = ?',
      [scheduleId],
    );
    if (!row) throw new Error(`scheduled_campaigns row for schedule ${scheduleId} not found`);
    return mapRow<TSpec>(row);
  }
}
