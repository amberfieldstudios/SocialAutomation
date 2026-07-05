/**
 * Update-available banner (t7): must stay silent unless there's an actual,
 * undismissed update, and dismissing must call the server (not just hide
 * itself client-side forever) so a persisted dismiss actually happens.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UpdateBanner } from '../src/components/UpdateBanner';

function mockFetch(status: Record<string, unknown> | null, dismissSpy?: (body: unknown) => void): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/update/status') {
        return new Response(JSON.stringify(status), { status: 200 });
      }
      if (url === '/api/update/dismiss' && init?.method === 'POST') {
        dismissSpy?.(init.body ? JSON.parse(init.body as string) : undefined);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('UpdateBanner', () => {
  it('renders nothing when no update source is configured', async () => {
    mockFetch({ configured: false, currentVersion: '0.1.0', updateAvailable: false, dismissed: false });
    render(<UpdateBanner />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders nothing when configured but no update is available', async () => {
    mockFetch({ configured: true, currentVersion: '0.1.0', updateAvailable: false, dismissed: false });
    render(<UpdateBanner />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders nothing when a check failed (offline) — never shows an error as if it were an app problem', async () => {
    mockFetch({ configured: true, currentVersion: '0.1.0', updateAvailable: false, error: "Couldn't reach the update server.", dismissed: false });
    render(<UpdateBanner />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText(/couldn't reach/i)).not.toBeInTheDocument();
  });

  it('renders nothing when the available version was already dismissed', async () => {
    mockFetch({ configured: true, currentVersion: '0.1.0', latestVersion: '0.2.0', updateAvailable: true, dismissed: true });
    render(<UpdateBanner />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows a plain-language banner with both versions and a release link when an update is available', async () => {
    mockFetch({
      configured: true,
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      releaseUrl: 'https://example.test/releases/v0.2.0',
      updateAvailable: true,
      dismissed: false,
    });
    render(<UpdateBanner />);
    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent(/v0\.2\.0/);
    expect(banner).toHaveTextContent(/v0\.1\.0/);
    expect(banner).toHaveTextContent(/accounts, settings, history, and downloaded model are kept/i);
    expect(screen.getByRole('link', { name: /see what.s new/i })).toHaveAttribute('href', 'https://example.test/releases/v0.2.0');
  });

  it('dismissing calls the server with the latest version and hides the banner immediately', async () => {
    const dismissSpy = vi.fn();
    mockFetch(
      { configured: true, currentVersion: '0.1.0', latestVersion: '0.2.0', updateAvailable: true, dismissed: false },
      dismissSpy,
    );
    const user = userEvent.setup();
    render(<UpdateBanner />);
    await screen.findByRole('status');

    await user.click(screen.getByRole('button', { name: /dismiss/i }));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await waitFor(() => expect(dismissSpy).toHaveBeenCalledWith({ version: '0.2.0' }));
  });
});
