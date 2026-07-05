import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ComposerView } from '../src/views/ComposerView';
import type { AccountSummary, PlatformInfo } from '../src/api/client';

const platforms: PlatformInfo[] = [
  {
    id: 'discord',
    capabilities: {
      platform: 'discord',
      displayName: 'Discord',
      characterLimit: 2000,
      maxMediaCount: 10,
      supportsScheduling: false,
      supportsAnalytics: false,
    },
  },
  {
    id: 'reddit',
    capabilities: {
      platform: 'reddit',
      displayName: 'Reddit',
      characterLimit: 40000,
      maxMediaCount: 1,
      supportsScheduling: false,
      supportsAnalytics: false,
    },
  },
];

const accounts: AccountSummary[] = [
  { id: 'acct-1', platformId: 'discord', remoteId: 'guild-1', handle: 'launch-hq', displayName: 'Launch HQ', status: 'active' },
  { id: 'acct-2', platformId: 'reddit', remoteId: 'reddit-1', handle: 'streamer', displayName: 'Streamer Reddit', status: 'active' },
];

/** Captured POST bodies, so tests can assert what the composer actually sent (t14: subreddit threading). */
const capturedRequests: { url: string; body: unknown }[] = [];

function mockFetchSequence(): void {
  capturedRequests.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.body) capturedRequests.push({ url, body: JSON.parse(String(init.body)) });
      if (url.startsWith('/api/platforms')) {
        return new Response(JSON.stringify({ platforms }), { status: 200 });
      }
      if (url.startsWith('/api/accounts')) {
        return new Response(JSON.stringify({ accounts }), { status: 200 });
      }
      if (url.startsWith('/api/compose-preview')) {
        const body = init?.body ? (JSON.parse(String(init.body)) as { platforms: { platformId: string }[] }) : undefined;
        const target = body?.platforms[0];
        return new Response(
          JSON.stringify({
            results: [
              {
                platform: target?.platformId ?? 'discord',
                accountId: 'acct-1',
                status: 'ok',
                payload: { platform: target?.platformId ?? 'discord', accountId: 'acct-1', text: 'Generated preview text.' },
                textLength: 24,
                characterLimit: 2000,
                validation: { ok: true, errors: [], warnings: [] },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: 'unexpected url ' + url }), { status: 500 });
    }),
  );
}

beforeEach(() => {
  mockFetchSequence();
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('ComposerView', () => {
  it('has accessible, labelled form controls', async () => {
    render(<ComposerView />);
    await screen.findByLabelText(/content description/i);
    expect(screen.getByLabelText(/content description/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/call to action/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/link/i)).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /target accounts/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /submit campaign/i })).toBeDisabled();
  });

  it('shows a live per-platform preview with validation status and character meter once a description and account are chosen', async () => {
    const user = userEvent.setup();
    render(<ComposerView />);

    const checkbox = await screen.findByLabelText('Launch HQ');
    await user.click(checkbox);

    const textarea = screen.getByLabelText(/content description/i);
    await user.type(textarea, 'Announcing our new release.');

    await waitFor(
      () => {
        expect(screen.getByText(/generated preview text\./i)).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    // Per-platform validation status is surfaced.
    expect(screen.getByRole('article', { name: /preview for discord/i })).toBeInTheDocument();
    expect(screen.getByText('ok')).toBeInTheDocument();
    expect(screen.getByText(/24 \/ 2000 characters/i)).toBeInTheDocument();

    // The character meter is an accessible progressbar with correct bounds.
    const meter = screen.getByRole('progressbar', { name: /character count for discord/i });
    expect(meter).toHaveAttribute('aria-valuenow', '24');
    expect(meter).toHaveAttribute('aria-valuemax', '2000');

    // Submit is now enabled since a description + target are set.
    expect(screen.getByRole('button', { name: /submit campaign/i })).toBeEnabled();
  });

  it('QG-1/t14: asks for a subreddit once Reddit is selected, blocks submit until one is given, and threads it into platformOptions.subreddit', async () => {
    const user = userEvent.setup();
    render(<ComposerView />);

    // No subreddit field until a Reddit target is selected.
    expect(screen.queryByLabelText(/which subreddit/i)).not.toBeInTheDocument();

    const redditCheckbox = await screen.findByLabelText('Streamer Reddit');
    await user.click(redditCheckbox);

    const subredditField = await screen.findByLabelText(/which subreddit/i);
    const textarea = screen.getByLabelText(/content description/i);
    await user.type(textarea, 'Announcing our new release.');

    // A Reddit target with no subreddit yet must not be submittable.
    expect(screen.getByRole('button', { name: /submit campaign/i })).toBeDisabled();

    await user.type(subredditField, 'r/Twitch');
    await waitFor(() => expect(screen.getByRole('button', { name: /submit campaign/i })).toBeEnabled());

    await waitFor(() => {
      const previewCalls = capturedRequests.filter((r) => r.url.startsWith('/api/compose-preview'));
      expect(previewCalls.length).toBeGreaterThan(0);
      // The debounced preview effect re-fires per keystroke; only the LAST
      // call reflects the final typed subreddit.
      const body = previewCalls[previewCalls.length - 1]!.body as {
        platforms: { platformId: string; platformOptions?: { subreddit?: string } }[];
      };
      // The leading "r/" the user typed is stripped before it reaches the API.
      expect(body.platforms[0]).toMatchObject({ platformId: 'reddit', platformOptions: { subreddit: 'Twitch' } });
    });

    await user.click(screen.getByRole('button', { name: /submit campaign/i }));
    await waitFor(() => {
      const submitCall = capturedRequests.find((r) => r.url.startsWith('/api/campaigns'));
      expect(submitCall).toBeTruthy();
    });
  });
});
