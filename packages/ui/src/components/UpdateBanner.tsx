/**
 * Non-nagging "a new version is available" banner (t7 update story).
 *
 * - Renders nothing while loading, when no update source is configured
 *   (`configured: false` — the common case until the app owner sets
 *   SOCIAL_AUTOMATION_UPDATE_REPO), when there's no update, or when the
 *   check failed (offline etc. — never show an error banner for this,
 *   it's not something the user did wrong or needs to act on).
 * - When an update IS available and hasn't already been dismissed for that
 *   exact version, shows one plain-language line + a link to the release
 *   page + a "Dismiss" button. Dismissing persists server-side (t7's
 *   /api/update/dismiss) so it won't nag again for this version, but WILL
 *   resurface for the next one.
 */
import { useEffect, useState } from 'react';
import { api, type UpdateStatus } from '../api/client';

export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [dismissedThisSession, setDismissedThisSession] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .getUpdateStatus()
      .then((result) => {
        if (!cancelled) setStatus(result);
      })
      .catch(() => {
        // Never surface a check failure as an app error — the update check
        // is a courtesy, not a requirement to use the app.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status || !status.configured || !status.updateAvailable || status.dismissed || dismissedThisSession) {
    return null;
  }

  function handleDismiss(): void {
    setDismissedThisSession(true);
    if (status?.latestVersion) {
      void api.dismissUpdate(status.latestVersion).catch(() => {
        // Best-effort: even if the save fails, dismissedThisSession already
        // hides the banner for the rest of this session.
      });
    }
  }

  return (
    <div className="update-banner" role="status">
      <span>
        A new version of SocialAutomation is available
        {status.latestVersion ? ` (v${status.latestVersion}, you have v${status.currentVersion})` : ''}.{' '}
        {status.releaseUrl ? (
          <a href={status.releaseUrl} target="_blank" rel="noreferrer">
            See what&rsquo;s new and download it
          </a>
        ) : (
          "Check the project's release page to download it."
        )}
        {' — your accounts, settings, history, and downloaded model are kept, they live outside the app folder.'}
      </span>
      <button type="button" onClick={handleDismiss}>
        Dismiss
      </button>
    </div>
  );
}
