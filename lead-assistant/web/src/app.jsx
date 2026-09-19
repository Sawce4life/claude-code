import { useEffect, useState, useSyncExternalStore } from 'react';
import { subscribe, getState, boot, forceSync, timezoneOf } from './store.js';
import { AuthView } from './views/auth.jsx';
import { TodayView } from './views/today.jsx';
import { LeadsView } from './views/leads.jsx';
import { LeadDetailView } from './views/lead-detail.jsx';
import { AskView } from './views/ask.jsx';
import { SettingsView } from './views/settings.jsx';
import { QuickLog } from './components/quick-log.jsx';
import {
  IconToday, IconPeople, IconSpark, IconGear, IconPlus, IconBack, IconRefresh,
} from './components/icons.jsx';
import { zonedParts } from '@shared/timezone.js';

const TABS = [
  { key: 'today', label: 'Today', Icon: IconToday },
  { key: 'leads', label: 'Leads', Icon: IconPeople },
  { key: 'ask', label: 'Ask', Icon: IconSpark },
  { key: 'settings', label: 'Settings', Icon: IconGear },
];

export function App() {
  const state = useSyncExternalStore(subscribe, getState, getState);
  const [tab, setTab] = useState(() => {
    const requested = new URLSearchParams(window.location.search).get('view');
    return TABS.some((item) => item.key === requested) ? requested : 'today';
  });
  const [openLeadId, setOpenLeadId] = useState(null);
  const [logging, setLogging] = useState(null); // null | {lead}

  useEffect(() => { boot(); }, []);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('action') === 'log') {
      setLogging({ lead: null });
    }
  }, []);

  // The browser back button should close a lead rather than leave the app.
  useEffect(() => {
    const onPop = () => setOpenLeadId(null);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  function openLead(id) {
    setOpenLeadId(id);
    window.history.pushState({ lead: id }, '');
  }

  function closeLead() {
    setOpenLeadId(null);
    if (window.history.state?.lead) window.history.back();
  }

  if (state.phase === 'booting') {
    return <div className="auth-wrap"><div className="muted">Loading your leads...</div></div>;
  }

  if (state.phase === 'signed-out') {
    return <AuthView signupsOpen={state.signupsOpen} />;
  }

  const lead = openLeadId ? state.leads.find((item) => item.id === openLeadId) : null;
  const title = lead
    ? (lead.name || 'Lead')
    : tab === 'today'
      ? greeting(state)
      : TABS.find((item) => item.key === tab)?.label;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          {openLeadId ? (
            <button className="icon-btn" onClick={closeLead} aria-label="Back">
              <IconBack />
            </button>
          ) : null}
          <h1>{title}</h1>
          <button
            className="icon-btn"
            onClick={() => forceSync()}
            aria-label="Sync now"
            title={syncTitle(state)}
          >
            {state.sync.status === 'syncing'
              ? <IconRefresh className="spin" />
              : <span className={`sync-dot ${state.sync.status}`} />}
          </button>
        </div>
      </header>

      <main className="main">
        {state.sync.status === 'error' ? (
          <div className="notice warn">{state.sync.message}</div>
        ) : null}

        {openLeadId ? (
          <LeadDetailView
            state={state}
            leadId={openLeadId}
            onOpenLead={openLead}
            onLog={(target) => setLogging({ lead: target })}
            onBack={closeLead}
          />
        ) : tab === 'today' ? (
          <TodayView state={state} onOpenLead={openLead} onLog={(target) => setLogging({ lead: target })} />
        ) : tab === 'leads' ? (
          <LeadsView state={state} onOpenLead={openLead} onLog={(target) => setLogging({ lead: target })} />
        ) : tab === 'ask' ? (
          <AskView state={state} />
        ) : (
          <SettingsView state={state} />
        )}
      </main>

      {!openLeadId && (tab === 'today' || tab === 'leads') ? (
        <button className="fab" onClick={() => setLogging({ lead: null })}>
          <IconPlus /> Log a call
        </button>
      ) : null}

      <nav className="tabbar" aria-label="Sections">
        {TABS.map(({ key, label, Icon }) => (
          <button
            key={key}
            aria-current={!openLeadId && tab === key ? 'page' : undefined}
            onClick={() => { setOpenLeadId(null); setTab(key); }}
          >
            <Icon />
            {label}
          </button>
        ))}
      </nav>

      {logging ? (
        <QuickLog
          lead={logging.lead}
          onClose={() => setLogging(null)}
          onSaved={({ leadId }) => { if (!logging.lead) openLead(leadId); }}
        />
      ) : null}
    </div>
  );
}

function greeting(state) {
  const hour = zonedParts(Date.now(), timezoneOf(state)).hour;
  const part = hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening';
  const name = String(state.user?.name || '').trim().split(/\s+/)[0];
  return name ? `${part}, ${name}` : `${part}`;
}

function syncTitle(state) {
  if (state.sync.status === 'offline') return 'Offline -- changes are saved on this device';
  if (state.sync.status === 'error') return state.sync.message;
  if (state.sync.pending) return `${state.sync.pending} change(s) waiting`;
  return 'Everything is synced';
}
