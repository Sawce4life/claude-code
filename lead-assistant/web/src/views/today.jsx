import { useMemo, useState } from 'react';
import { LeadRow } from '../components/lead-row.jsx';
import { Empty, Notice } from '../components/ui.jsx';
import { IconSpark, IconRefresh, IconClock } from '../components/icons.jsx';
import { api } from '../api.js';
import { rankedList, bucketCounts, snooze, timezoneOf } from '../store.js';
import { addDays, startOfDay, nextWeekday, DAY_MS } from '@shared/timezone.js';

const GROUPS = [
  { bucket: 'overdue', title: 'Owed a call back', tone: 'overdue' },
  { bucket: 'today', title: 'Scheduled today', tone: 'today' },
  { bucket: 'new', title: 'Never contacted', tone: 'new' },
  { bucket: 'due', title: 'Going cold', tone: 'due' },
];

export function TodayView({ state, onOpenLead, onLog }) {
  const [brief, setBrief] = useState('');
  const [briefBusy, setBriefBusy] = useState(false);
  const [briefError, setBriefError] = useState('');
  const [snoozing, setSnoozing] = useState(null);

  const now = Date.now();
  const timezone = timezoneOf(state);
  const ranked = useMemo(
    () => rankedList(state, now),
    [state.leads, state.interactions, state.tasks, state.user],
  );
  const counts = useMemo(() => bucketCounts(ranked), [ranked]);
  const grouped = useMemo(() => {
    const map = {};
    for (const group of GROUPS) map[group.bucket] = ranked.filter((e) => e.bucket === group.bucket);
    return map;
  }, [ranked]);

  const dueNow = GROUPS.reduce((total, group) => total + grouped[group.bucket].length, 0);
  const later = ranked.filter((e) => e.bucket === 'upcoming' || e.bucket === 'resting');

  async function loadBrief() {
    setBriefBusy(true);
    setBriefError('');
    try {
      const result = await api.brief();
      setBrief(result.brief);
    } catch (err) {
      setBriefError(err?.message || 'Could not write the brief.');
    } finally {
      setBriefBusy(false);
    }
  }

  const snoozeChoices = [
    { label: 'In 2 hours', at: now + 2 * 60 * 60 * 1000 },
    { label: 'Tomorrow 9am', at: startOfDay(addDays(now, 1, timezone), timezone) + 9 * 60 * 60 * 1000 },
    { label: 'Monday 9am', at: nextWeekday(now, 1, 9, 0, timezone) },
    { label: 'Next week', at: startOfDay(addDays(now, 7, timezone), timezone) + 9 * 60 * 60 * 1000 },
  ];

  return (
    <>
      {dueNow > 0 ? (
        <div className="counts">
          {counts.overdue ? <span className="pill overdue">{counts.overdue} overdue</span> : null}
          {counts.today ? <span className="pill today">{counts.today} scheduled</span> : null}
          {counts.new ? <span className="pill new">{counts.new} never called</span> : null}
          {counts.due ? <span className="pill due">{counts.due} going cold</span> : null}
        </div>
      ) : null}

      {state.aiEnabled ? (
        <div className="section">
          {brief ? (
            <div className="card" style={{ padding: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <IconSpark style={{ width: 17, height: 17, color: 'var(--brand)' }} />
                <strong style={{ fontSize: 14 }}>Your plan for today</strong>
                <span className="spacer" />
                <button className="btn small ghost" onClick={loadBrief} disabled={briefBusy}>
                  <IconRefresh className={briefBusy ? 'spin' : undefined} />
                </button>
              </div>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 14.5, lineHeight: 1.55 }}>{brief}</div>
            </div>
          ) : (
            <button className="btn wide" onClick={loadBrief} disabled={briefBusy || !dueNow}>
              <IconSpark /> {briefBusy ? 'Thinking...' : 'Plan my day'}
            </button>
          )}
          <Notice kind="error">{briefError}</Notice>
        </div>
      ) : null}

      {dueNow === 0 ? (
        <Empty title={ranked.length ? 'Nothing is due right now' : 'No leads yet'}>
          {ranked.length
            ? 'Every call back you promised is still ahead of you. Add a lead or log a call to keep the list moving.'
            : 'Add your first lead, or just log a call and the lead gets created for you.'}
        </Empty>
      ) : null}

      {GROUPS.map((group) => {
        const rows = grouped[group.bucket];
        if (!rows.length) return null;
        return (
          <section className="section" key={group.bucket}>
            <div className="section-head">
              <h2>{group.title}</h2>
              <span className="tiny">{rows.length}</span>
            </div>
            <div className="stack">
              {rows.map((entry) => (
                <div key={entry.leadId}>
                  <LeadRow entry={entry} onOpen={onOpenLead} onLog={onLog} />
                  {snoozing === entry.leadId ? (
                    <div className="chips" style={{ marginTop: 8, marginBottom: 4 }}>
                      {snoozeChoices.map((choice) => (
                        <button
                          key={choice.label}
                          className="chip"
                          onClick={async () => {
                            await snooze(entry.leadId, choice.at);
                            setSnoozing(null);
                          }}
                        >
                          {choice.label}
                        </button>
                      ))}
                      <button className="chip" onClick={() => setSnoozing(null)}>Cancel</button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <button
                        className="btn small ghost"
                        style={{ marginTop: 2, minHeight: 30, fontSize: 12.5 }}
                        onClick={() => setSnoozing(entry.leadId)}
                      >
                        <IconClock /> Later
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        );
      })}

      {later.length ? (
        <section className="section">
          <div className="section-head">
            <h2>Further out</h2>
            <span className="tiny">{later.length}</span>
          </div>
          <div className="stack">
            {later.slice(0, 8).map((entry) => (
              <LeadRow key={entry.leadId} entry={entry} onOpen={onOpenLead} onLog={onLog} />
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}

export { DAY_MS };
