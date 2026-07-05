import type { RefreshInput, TokenSet } from '@social/core';
import { describe, expect, it } from 'vitest';
import { profileToAccountInput } from '../src/account-manager';
import { AccountNotFoundError } from '../src/errors';
import type { TokenRefresher } from '../src/token-manager';
import { freshToken, newHarness } from './support';

// CRUD tests never trigger a refresh; this refresher throws if ever called.
const noopRefresher: TokenRefresher = {
  refreshToken(_input: RefreshInput): Promise<TokenSet> {
    return Promise.reject(new Error('refreshToken should not be called in CRUD tests'));
  },
};

function crudHarness() {
  return newHarness({ connector: noopRefresher });
}

describe('AccountManager CRUD + multi-account', () => {
  it('adds several accounts per platform (two Twitch channels)', async () => {
    const h = crudHarness();
    const a = await h.accountManager.addAccount(
      { platformId: 'twitch', remoteId: 'chan-a', displayName: 'Channel A' },
      freshToken(),
    );
    const b = await h.accountManager.addAccount(
      { platformId: 'twitch', remoteId: 'chan-b', displayName: 'Channel B' },
      freshToken(),
    );
    expect(a.id).not.toBe(b.id);

    const twitch = await h.accountManager.listAccounts({ platformId: 'twitch' });
    expect(twitch).toHaveLength(2);
    expect(new Set(twitch.map((x) => x.displayName))).toEqual(new Set(['Channel A', 'Channel B']));
  });

  it('keeps company + personal accounts distinct across platforms', async () => {
    const h = crudHarness();
    await h.accountManager.addAccount({ platformId: 'twitter', remoteId: 'company' }, freshToken());
    await h.accountManager.addAccount({ platformId: 'twitter', remoteId: 'personal' }, freshToken());
    await h.accountManager.addAccount({ platformId: 'twitch', remoteId: 'chan-a' }, freshToken());

    expect(await h.accountManager.listAccounts({ platformId: 'twitter' })).toHaveLength(2);
    expect(await h.accountManager.listAccounts()).toHaveLength(3);
  });

  it('upserts on (platformId, remoteId) rather than duplicating', async () => {
    const h = crudHarness();
    const first = await h.accountManager.addAccount(
      { platformId: 'twitch', remoteId: 'chan-a', displayName: 'Old Name' },
      freshToken(),
    );
    const second = await h.accountManager.addAccount(
      { platformId: 'twitch', remoteId: 'chan-a', displayName: 'New Name' },
      freshToken(),
    );

    expect(second.id).toBe(first.id);
    expect((await h.accountManager.listAccounts()).length).toBe(1);
    expect((await h.accountManager.getAccount(first.id))?.displayName).toBe('New Name');
  });

  it('exposes profile metadata + scopes but no secrets in the summary', async () => {
    const h = crudHarness();
    const acct = await h.accountManager.addAccount(
      {
        platformId: 'twitch',
        remoteId: 'chan-a',
        handle: 'mychannel',
        avatarUrl: 'https://cdn/avatar.png',
        profileMetadata: { partner: true },
      },
      freshToken({ scopes: ['channel:read:subscriptions'] }),
    );
    expect(acct.handle).toBe('mychannel');
    expect(acct.profileMetadata).toEqual({ partner: true });
    expect(acct.scopes).toEqual(['channel:read:subscriptions']);
    expect(JSON.stringify(acct)).not.toContain('SECRET-ACCESS-FRESH');
  });

  it('updates profile and status', async () => {
    const h = crudHarness();
    const acct = await h.accountManager.addAccount({ platformId: 'twitch', remoteId: 'chan-a' }, freshToken());
    const renamed = await h.accountManager.updateProfile(acct.id, { displayName: 'Renamed' });
    expect(renamed.displayName).toBe('Renamed');
    const disconnected = await h.accountManager.setStatus(acct.id, 'disconnected');
    expect(disconnected.status).toBe('disconnected');
  });

  it('removes an account and purges its tokens', async () => {
    const h = crudHarness();
    const acct = await h.accountManager.addAccount({ platformId: 'twitch', remoteId: 'chan-a' }, freshToken());
    expect(await h.tokens.getCurrent(acct.id)).toBeDefined();

    await h.accountManager.removeAccount(acct.id);
    expect(await h.accountManager.getAccount(acct.id)).toBeUndefined();
    expect(await h.tokens.listByAccount(acct.id)).toHaveLength(0);
  });

  it('stores a Bluesky app password as a non-current row alongside the live session', async () => {
    const h = crudHarness();
    const acct = await h.accountManager.addAccount({ platformId: 'bluesky', remoteId: 'did:plc:xyz' }, freshToken());
    await h.tokenManager.storeTokens(
      acct.id,
      { accessToken: 'SECRET-APP-PASSWORD', scopes: [], obtainedAt: new Date().toISOString() },
      { tokenType: 'atproto_app_password', isCurrent: false },
    );

    const rows = await h.tokens.listByAccount(acct.id);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.isCurrent)).toHaveLength(1);
    const appPw = rows.find((r) => r.tokenType === 'atproto_app_password');
    expect(appPw?.isCurrent).toBe(false);
  });

  it('rejects operations on a missing account', async () => {
    const h = crudHarness();
    await expect(h.accountManager.updateProfile('nope', { displayName: 'x' })).rejects.toBeInstanceOf(
      AccountNotFoundError,
    );
  });

  it('maps a PlatformProfile onto account input', () => {
    const input = profileToAccountInput('twitch', {
      remoteId: 'r1',
      handle: 'h',
      displayName: 'D',
      avatarUrl: 'a',
      profileUrl: 'p',
    });
    expect(input).toEqual({
      platformId: 'twitch',
      remoteId: 'r1',
      handle: 'h',
      displayName: 'D',
      avatarUrl: 'a',
      profileUrl: 'p',
    });
  });
});
