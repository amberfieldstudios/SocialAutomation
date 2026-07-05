/**
 * First-run detection + "Run setup again" (t2): the dashboard should open on
 * the Setup wizard tab for a user who hasn't completed it, and on the normal
 * default tab once they have — driven by the server-persisted
 * `GET /api/wizard-state`, never localStorage.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../src/App';

function mockFetch(wizardState: { completed: boolean; currentStepId: string }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/wizard-state' && (!init || init.method === undefined)) {
        return new Response(JSON.stringify({ ...wizardState, updatedAt: new Date(0).toISOString() }), { status: 200 });
      }
      if (url === '/api/wizard-state/restart' && init?.method === 'POST') {
        return new Response(JSON.stringify({ completed: false, currentStepId: 'welcome', updatedAt: new Date().toISOString() }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ platforms: [], accounts: [], campaigns: [], schedules: [], jobs: [], entries: [] }),
        { status: 200 },
      );
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('App first-run detection', () => {
  it('opens on the Setup wizard tab when the wizard has not been completed', async () => {
    mockFetch({ completed: false, currentStepId: 'welcome' });
    render(<App />);
    await waitFor(() => expect(screen.getByRole('tab', { name: /setup wizard/i })).toHaveAttribute('aria-selected', 'true'));
  });

  it('opens on the normal default tab once the wizard is marked completed, and never shows it again automatically', async () => {
    mockFetch({ completed: true, currentStepId: 'done' });
    render(<App />);
    await waitFor(() => expect(screen.getByRole('tab', { name: /^composer$/i })).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByRole('tab', { name: /setup wizard/i })).toHaveAttribute('aria-selected', 'false');
  });

  it('"Run setup again" on the Accounts tab re-opens the wizard on demand', async () => {
    mockFetch({ completed: true, currentStepId: 'done' });
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(screen.getByRole('tab', { name: /^composer$/i })).toHaveAttribute('aria-selected', 'true'));

    await user.click(screen.getByRole('tab', { name: /accounts/i }));
    await user.click(await screen.findByRole('button', { name: /run setup again/i }));

    await waitFor(() => expect(screen.getByRole('tab', { name: /setup wizard/i })).toHaveAttribute('aria-selected', 'true'));
  });
});
