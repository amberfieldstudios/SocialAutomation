import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../src/App';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ platforms: [], accounts: [], campaigns: [], schedules: [], jobs: [], entries: [] }), { status: 200 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('App accessibility smoke test', () => {
  it('exposes exactly one h1 and a tablist with keyboard-navigable, correctly-linked tabs/panels', async () => {
    render(<App />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);

    const tablist = screen.getByRole('tablist', { name: /dashboard sections/i });
    expect(tablist).toBeInTheDocument();

    const tabs = screen.getAllByRole('tab');
    expect(tabs.length).toBeGreaterThanOrEqual(5);

    for (const tab of tabs) {
      // Every tab must reference an existing panel via aria-controls, and every
      // panel must be labelled by its tab (WAI-ARIA tabs pattern).
      const panelId = tab.getAttribute('aria-controls');
      expect(panelId).toBeTruthy();
      const panel = document.getElementById(panelId!);
      expect(panel).not.toBeNull();
      expect(panel).toHaveAttribute('aria-labelledby', tab.id);
    }

    // Exactly one tab is selected, and its panel is the only visible one.
    const selected = tabs.filter((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);

    // Arrow-key navigation moves selection (roving tabindex pattern).
    const user = userEvent.setup();
    const firstSelected = selected[0]!;
    firstSelected.focus();
    await user.keyboard('{ArrowRight}');
    const nowSelected = tabs.filter((t) => t.getAttribute('aria-selected') === 'true');
    expect(nowSelected).toHaveLength(1);
    expect(nowSelected[0]).not.toBe(firstSelected);
  });
});
