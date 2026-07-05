import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WizardView } from '../src/wizard/WizardView';
import type { AccountSummary } from '../src/api/client';

const pairedAccount: AccountSummary = {
  id: 'acct-discord-1',
  platformId: 'discord',
  remoteId: 'channel-1',
  displayName: '#announcements',
  status: 'active',
};

function mockFetchSequence(wizardState: { completed: boolean; currentStepId: string } = { completed: false, currentStepId: 'welcome' }): ReturnType<typeof vi.fn> {
  const putCalls: unknown[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/accounts') && (!init || init.method === undefined)) {
      return new Response(JSON.stringify({ accounts: [] }), { status: 200 });
    }
    if (url === '/api/accounts/pair/token' && init?.method === 'POST') {
      return new Response(JSON.stringify({ account: pairedAccount }), { status: 201 });
    }
    if (url === '/api/wizard-state' && (!init || init.method === undefined)) {
      return new Response(JSON.stringify({ ...wizardState, updatedAt: new Date(0).toISOString() }), { status: 200 });
    }
    if (url === '/api/wizard-state' && init?.method === 'PUT') {
      putCalls.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ...wizardState, updatedAt: new Date().toISOString() }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
  (fn as unknown as { putCalls: unknown[] }).putCalls = putCalls;
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  mockFetchSequence();
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('WizardView', () => {
  it('restores at the "welcome" step by default (server-persisted state, not localStorage) and walks welcome -> Discord connect -> shows the connected account with a test-connection button', async () => {
    const user = userEvent.setup();
    render(<WizardView />);

    expect(screen.getByRole('heading', { name: /setup wizard/i })).toBeInTheDocument();
    const getStarted = await screen.findByRole('button', { name: /get started/i });
    await user.click(getStarted);

    expect(await screen.findByRole('heading', { name: /connect discord/i })).toBeInTheDocument();

    await user.type(screen.getByLabelText(/^webhook url$/i), 'https://discord.com/api/webhooks/123/abc');
    await user.click(screen.getByRole('button', { name: /^connect discord$/i }));

    await waitFor(() => expect(screen.getByText(/connected:/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /test this connection/i })).toBeInTheDocument();

    // The wizard's own step list must not read as a second nested tablist —
    // it renders as a plain step nav so page-level ARIA-tabs assumptions
    // (see App.a11y.test.tsx) hold even with the wizard mounted.
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('never shows raw jargon (OAuth/client secret/redirect URI) without a plain-language explanation on the welcome step', async () => {
    render(<WizardView />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\bOAuth\b/);
    expect(text).not.toMatch(/client secret/i);
  });

  it('resumes at the step the server says was last saved, not always "welcome" (mid-wizard abandon + refresh/restart)', async () => {
    mockFetchSequence({ completed: false, currentStepId: 'bluesky' });
    render(<WizardView />);
    expect(await screen.findByRole('heading', { name: /connect bluesky/i })).toBeInTheDocument();
  });

  it('persists the step server-side (not localStorage) every time the user navigates', async () => {
    const fetchMock = mockFetchSequence();
    const user = userEvent.setup();
    render(<WizardView />);
    const getStarted = await screen.findByRole('button', { name: /get started/i });
    await user.click(getStarted);

    await waitFor(() => {
      const putCalls = (fetchMock as unknown as { putCalls: unknown[] }).putCalls;
      expect(putCalls).toContainEqual({ currentStepId: 'discord' });
    });

    // Never touches localStorage/sessionStorage for this.
    expect(window.localStorage.length).toBe(0);
  });
});
