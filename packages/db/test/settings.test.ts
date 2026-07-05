/**
 * `app_settings` migration (0007) + `SqliteSettingsStore` round-trip: a
 * generic key/value JSON store, first used by the setup wizard's server-side
 * first-run/resume state (t2).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../src/index';

describe('@social/db app_settings (migration 0007)', () => {
  let db: Database;

  beforeEach(() => {
    db = Database.sqlite({ filename: ':memory:' });
    db.migrate();
  });

  afterEach(() => {
    db.close();
  });

  it('returns undefined for a key that was never set', () => {
    expect(db.settings.get('wizard_state')).toBeUndefined();
  });

  it('round-trips a JSON value through set/get', () => {
    db.settings.set('wizard_state', { completed: false, currentStepId: 'discord' });
    expect(db.settings.get('wizard_state')).toEqual({ completed: false, currentStepId: 'discord' });
  });

  it('upserts: setting the same key again overwrites the previous value', () => {
    db.settings.set('wizard_state', { completed: false, currentStepId: 'discord' });
    db.settings.set('wizard_state', { completed: true, currentStepId: 'done' });
    expect(db.settings.get('wizard_state')).toEqual({ completed: true, currentStepId: 'done' });
  });

  it('keeps unrelated keys independent', () => {
    db.settings.set('wizard_state', { completed: true });
    db.settings.set('some_other_setting', { flag: 1 });
    expect(db.settings.get('wizard_state')).toEqual({ completed: true });
    expect(db.settings.get('some_other_setting')).toEqual({ flag: 1 });
  });
});
