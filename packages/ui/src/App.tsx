import { useEffect, useRef, useState } from 'react';
import { api } from './api/client';
import { AccountsView } from './views/AccountsView';
import { ComposerView } from './views/ComposerView';
import { QueueView } from './views/QueueView';
import { HistoryView } from './views/HistoryView';
import { AnalyticsView } from './views/AnalyticsView';
import { WizardView } from './wizard/WizardView';
import { UpdateBanner } from './components/UpdateBanner';

const DEFAULT_TAB = 'composer';

function makeTabs(onRunSetupAgain: () => void) {
  return [
    { id: 'wizard', label: 'Setup wizard', render: () => <WizardView /> },
    { id: 'accounts', label: 'Accounts', render: () => <AccountsView onRunSetupAgain={onRunSetupAgain} /> },
    { id: DEFAULT_TAB, label: 'Composer', render: () => <ComposerView /> },
    { id: 'queue', label: 'Queue & Schedule', render: () => <QueueView /> },
    { id: 'history', label: 'History', render: () => <HistoryView /> },
    { id: 'analytics', label: 'Analytics', render: () => <AnalyticsView /> },
  ] as const;
}

type TabId = ReturnType<typeof makeTabs>[number]['id'];

export function App() {
  // First-run detection (t2): the wizard tab is the initial guess so it's
  // never a visible flash-then-switch for a brand-new user (the common
  // case), but as soon as the server-persisted wizard state resolves, a user
  // who already completed setup is moved to the normal default tab instead —
  // UNLESS they've already clicked a tab themselves in the meantime (tracked
  // via `userNavigated`, so this one-time redirect never fights a real click).
  const [active, setActive] = useState<TabId>('wizard');
  const userNavigated = useRef(false);

  useEffect(() => {
    void api.getWizardState().then((state) => {
      if (state.completed && !userNavigated.current) setActive(DEFAULT_TAB);
    });
  }, []);

  function selectTab(id: TabId): void {
    userNavigated.current = true;
    setActive(id);
  }

  function handleRunSetupAgain(): void {
    void api.restartWizard().then(() => selectTab('wizard'));
  }

  const TABS = makeTabs(handleRunSetupAgain);

  function onTabKeyDown(e: React.KeyboardEvent, index: number): void {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const delta = e.key === 'ArrowRight' ? 1 : -1;
    const next = TABS[(index + delta + TABS.length) % TABS.length]!;
    selectTab(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>SocialAutomation Dashboard</h1>
        <p>
          Every write in this dashboard runs through the real pipeline (<code>@social/api</code> →{' '}
          <code>@social/pipeline</code>) against a seeded SQLite dev database. AI previews use the deterministic{' '}
          <code>MockProvider</code> — no external AI or platform credentials are configured.
        </p>
      </header>

      <UpdateBanner />

      <div role="tablist" aria-label="Dashboard sections" className="tablist">
        {TABS.map((tab, i) => (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            role="tab"
            aria-selected={active === tab.id}
            aria-controls={`panel-${tab.id}`}
            tabIndex={active === tab.id ? 0 : -1}
            className="tab"
            onClick={() => selectTab(tab.id)}
            onKeyDown={(e) => onTabKeyDown(e, i)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {TABS.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`panel-${tab.id}`}
          aria-labelledby={`tab-${tab.id}`}
          hidden={active !== tab.id}
        >
          {active === tab.id && tab.render()}
        </div>
      ))}
    </div>
  );
}
