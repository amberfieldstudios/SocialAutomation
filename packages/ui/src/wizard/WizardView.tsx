import { useEffect, useMemo, useState } from 'react';
import { api, type AccountSummary } from '../api/client';
import { PLATFORM_COPY, type GuidedPlatformCopy, type WizardPlatformId } from './wizardCopy';
import { DiscordStep } from './DiscordStep';
import { BlueskyStep } from './BlueskyStep';
import { RedirectConnectStep } from './RedirectConnectStep';

const PLATFORM_ORDER: WizardPlatformId[] = ['discord', 'bluesky', 'twitch', 'reddit', 'mastodon'];

type StepId = 'welcome' | WizardPlatformId | 'done';
const STEPS: StepId[] = ['welcome', ...PLATFORM_ORDER, 'done'];

function stepLabel(step: StepId): string {
  if (step === 'welcome') return 'Welcome';
  if (step === 'done') return 'Done';
  return PLATFORM_COPY[step].label;
}

function stepIndexFor(stepId: string): number {
  const i = STEPS.indexOf(stepId as StepId);
  return i === -1 ? 0 : i;
}

/**
 * The guided setup wizard (t1/t2): welcome -> one step per platform -> done.
 *
 * Step position is persisted SERVER-SIDE (t2, `GET`/`PUT /api/wizard-state`,
 * backed by `@social/db`'s `app_settings` table — NOT localStorage), so an
 * abandoned run resumes at the right step after a browser refresh OR a full
 * app restart. Reaching the "done" step marks the wizard `completed`, which
 * is what `App.tsx` reads to decide whether to auto-open on this tab.
 */
export function WizardView() {
  const [stepIndex, setStepIndex] = useState(0);
  const [restored, setRestored] = useState(false);
  const [accountsByPlatform, setAccountsByPlatform] = useState<Partial<Record<WizardPlatformId, AccountSummary>>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void api.listAccounts().then(({ accounts }) => {
      const byPlatform: Partial<Record<WizardPlatformId, AccountSummary>> = {};
      for (const account of accounts) {
        if ((PLATFORM_ORDER as string[]).includes(account.platformId) && account.status === 'active') {
          byPlatform[account.platformId as WizardPlatformId] = account;
        }
      }
      setAccountsByPlatform(byPlatform);
      setLoaded(true);
    });
    void api.getWizardState().then((state) => {
      setStepIndex(stepIndexFor(state.currentStepId));
      setRestored(true);
    });
  }, []);

  const step = STEPS[stepIndex] ?? 'welcome';
  const connectedCount = useMemo(() => Object.keys(accountsByPlatform).length, [accountsByPlatform]);

  function goTo(index: number): void {
    const clamped = Math.max(0, Math.min(STEPS.length - 1, index));
    setStepIndex(clamped);
    const stepId = STEPS[clamped] ?? 'welcome';
    // Fire-and-forget: this is a UX nicety (resume-after-refresh/restart), not
    // a user-facing action that needs its own loading/error state — a failed
    // save just means a refresh resumes one step further back than expected.
    void api.saveWizardState({ currentStepId: stepId, ...(stepId === 'done' ? { completed: true } : {}) });
  }

  function handleConnected(platformId: WizardPlatformId, account: AccountSummary): void {
    setAccountsByPlatform((prev) => ({ ...prev, [platformId]: account }));
  }

  function onStepperKeyDown(e: React.KeyboardEvent, index: number): void {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const delta = e.key === 'ArrowRight' ? 1 : -1;
    const next = (index + delta + STEPS.length) % STEPS.length;
    goTo(next);
    document.getElementById(`wizard-step-${STEPS[next]}`)?.focus();
  }

  return (
    <section aria-labelledby="wizard-heading">
      <h2 id="wizard-heading">Setup wizard</h2>
      <p className="hint">
        Connect the platforms you post to. You only need one to get started — you can always add the rest later from this
        wizard or the Accounts tab.
      </p>

      {/*
        A step-progress list, not a second nested ARIA tablist (a wizard's
        steps are sequential, not independently-selectable tabs) — nesting a
        `role="tablist"` inside the dashboard's own tablist would also break
        screen-reader users' expectations of "one tablist at a time" and
        confuse any test/tool that queries `getAllByRole('tab')` for the page.
      */}
      <nav aria-label="Setup wizard steps">
        <ol className="tablist" style={{ listStyle: 'none', padding: 0 }}>
          {STEPS.map((s, i) => (
            <li key={s} style={{ display: 'inline-block' }}>
              <button
                id={`wizard-step-${s}`}
                type="button"
                aria-current={step === s ? 'step' : undefined}
                tabIndex={step === s ? 0 : -1}
                className="tab"
                onClick={() => goTo(i)}
                onKeyDown={(e) => onStepperKeyDown(e, i)}
              >
                {stepLabel(s)}
                {s !== 'welcome' && s !== 'done' && accountsByPlatform[s] && ' ✓'}
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <div id={`wizard-panel-${step}`} aria-labelledby={`wizard-step-${step}`}>
        {!restored && <p aria-live="polite">Picking up where you left off…</p>}
        {restored && step === 'welcome' && (
          <div className="card">
            <h3>Let's get you connected</h3>
            <p>
              SocialAutomation posts one announcement to every platform you connect, so you only have to write it once.
              This wizard walks you through connecting each platform in plain language — no technical knowledge needed.
            </p>
            <p className="hint">Discord and Bluesky take under a minute each. Twitch, Reddit, and Mastodon take a couple of minutes because those platforms require a one-time app registration first — we'll walk you through exactly what to click.</p>
            <button type="button" className="btn" onClick={() => goTo(1)}>
              Get started
            </button>
          </div>
        )}

        {restored && step === 'discord' && (
          <DiscordStep account={accountsByPlatform.discord ?? null} onConnected={(a) => handleConnected('discord', a)} />
        )}
        {restored && step === 'bluesky' && (
          <BlueskyStep account={accountsByPlatform.bluesky ?? null} onConnected={(a) => handleConnected('bluesky', a)} />
        )}
        {restored && step === 'twitch' && (
          <RedirectConnectStep
            copy={PLATFORM_COPY.twitch as GuidedPlatformCopy}
            account={accountsByPlatform.twitch ?? null}
            onConnected={(a) => handleConnected('twitch', a)}
          />
        )}
        {restored && step === 'reddit' && (
          <RedirectConnectStep
            copy={PLATFORM_COPY.reddit as GuidedPlatformCopy}
            account={accountsByPlatform.reddit ?? null}
            onConnected={(a) => handleConnected('reddit', a)}
          />
        )}
        {restored && step === 'mastodon' && (
          <RedirectConnectStep
            copy={PLATFORM_COPY.mastodon as GuidedPlatformCopy}
            account={accountsByPlatform.mastodon ?? null}
            onConnected={(a) => handleConnected('mastodon', a)}
          />
        )}

        {restored && step === 'done' && (
          <div className="card">
            <h3>You're all set</h3>
            {connectedCount > 0 ? (
              <p>
                You connected {connectedCount} {connectedCount === 1 ? 'platform' : 'platforms'}. Head to the Composer tab
                to write your first post — it'll go out to everything you connected.
              </p>
            ) : (
              <p>
                You haven't connected a platform yet. That's OK — you can come back to this wizard any time, or connect one
                now.
              </p>
            )}
            {loaded && connectedCount === 0 && (
              <button type="button" className="btn secondary" onClick={() => goTo(1)}>
                Connect a platform
              </button>
            )}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '1.25rem' }}>
        <button type="button" className="btn secondary" onClick={() => goTo(stepIndex - 1)} disabled={stepIndex === 0}>
          Back
        </button>
        <button type="button" className="btn secondary" onClick={() => goTo(stepIndex + 1)} disabled={stepIndex === STEPS.length - 1}>
          {stepIndex === STEPS.length - 2 ? 'Finish' : 'Skip / Next'}
        </button>
      </div>
    </section>
  );
}
