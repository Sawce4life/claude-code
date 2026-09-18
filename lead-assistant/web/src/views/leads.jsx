import { useMemo, useState } from 'react';
import { LeadRow } from '../components/lead-row.jsx';
import { Sheet, Field, Empty, Notice, StatusSelect } from '../components/ui.jsx';
import { IconPlus, IconSearch } from '../components/icons.jsx';
import { liveLeads, saveLead, rankedList } from '../store.js';
import { STATUSES, STATUS_LABELS } from '@shared/priority.js';

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  ...STATUSES.map((status) => ({ key: status, label: STATUS_LABELS[status] })),
];

export function LeadsView({ state, onOpenLead, onLog }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('active');
  const [adding, setAdding] = useState(false);

  const leads = useMemo(() => liveLeads(state), [state.leads]);
  const order = useMemo(() => {
    const ranked = rankedList(state, Date.now());
    const index = new Map(ranked.map((entry, i) => [entry.leadId, i]));
    return index;
  }, [state.leads, state.interactions, state.tasks, state.user]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return leads
      .filter((lead) => {
        if (filter === 'active') {
          if (lead.status === 'won' || lead.status === 'lost') return false;
        } else if (filter !== 'all' && lead.status !== filter) return false;

        if (!needle) return true;
        return [lead.name, lead.company, lead.phone, lead.email, lead.tags, lead.notes]
          .some((value) => String(value || '').toLowerCase().includes(needle));
      })
      .sort((a, b) => {
        const ai = order.has(a.id) ? order.get(a.id) : Number.MAX_SAFE_INTEGER;
        const bi = order.has(b.id) ? order.get(b.id) : Number.MAX_SAFE_INTEGER;
        if (ai !== bi) return ai - bi;
        return String(a.name || '').localeCompare(String(b.name || ''));
      });
  }, [leads, query, filter, order]);

  return (
    <>
      <div style={{ position: 'relative', marginBottom: 12 }}>
        <IconSearch
          style={{
            position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)',
            width: 18, height: 18, color: 'var(--text-faint)', pointerEvents: 'none',
          }}
        />
        <input
          className="input"
          style={{ paddingLeft: 38 }}
          type="search"
          placeholder="Search name, company, phone, notes"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <div className="chips" style={{ marginBottom: 14 }}>
        {FILTERS.map((item) => (
          <button
            key={item.key}
            className="chip"
            aria-pressed={filter === item.key}
            onClick={() => setFilter(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {visible.length ? (
        <div className="stack">
          {visible.map((lead) => (
            <LeadRow key={lead.id} lead={lead} onOpen={onOpenLead} onLog={onLog} />
          ))}
        </div>
      ) : (
        <Empty title={leads.length ? 'Nothing matches' : 'No leads yet'}>
          {leads.length
            ? 'Try a different search, or switch the filter to All.'
            : 'Add someone below, or log a call and the lead is created for you.'}
        </Empty>
      )}

      <button className="btn wide" style={{ marginTop: 16 }} onClick={() => setAdding(true)}>
        <IconPlus /> Add a lead
      </button>

      {adding ? (
        <AddLead
          onClose={() => setAdding(false)}
          onCreated={(id) => { setAdding(false); onOpenLead(id); }}
        />
      ) : null}
    </>
  );
}

function AddLead({ onClose, onCreated }) {
  const [form, setForm] = useState({
    name: '', company: '', phone: '', email: '', source: '', status: 'new', value: '', notes: '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (key) => (event) => setForm({ ...form, [key]: event.target.value });

  async function submit(event) {
    event.preventDefault();
    if (!form.name.trim() && !form.phone.trim()) {
      setError('Give them a name or a phone number at least.');
      return;
    }
    setBusy(true);
    try {
      const lead = await saveLead({
        ...form,
        name: form.name.trim(),
        value: Number(form.value) || 0,
      });
      onCreated(lead.id);
    } catch (err) {
      setError(err?.message || 'Could not save that.');
      setBusy(false);
    }
  }

  return (
    <Sheet title="Add a lead" onClose={onClose}>
      <form onSubmit={submit}>
        <Notice kind="error">{error}</Notice>
        <Field label="Name"><input className="input" value={form.name} onChange={set('name')} autoComplete="name" /></Field>
        <div className="grid-2">
          <Field label="Phone"><input className="input" inputMode="tel" value={form.phone} onChange={set('phone')} /></Field>
          <Field label="Company"><input className="input" value={form.company} onChange={set('company')} /></Field>
        </div>
        <div className="grid-2">
          <Field label="Email"><input className="input" type="email" value={form.email} onChange={set('email')} /></Field>
          <Field label="Where from?"><input className="input" placeholder="Referral, website..." value={form.source} onChange={set('source')} /></Field>
        </div>
        <div className="grid-2">
          <Field label="Stage"><StatusSelect value={form.status} onChange={(status) => setForm({ ...form, status })} /></Field>
          <Field label="Deal size"><input className="input" inputMode="numeric" value={form.value} onChange={set('value')} /></Field>
        </div>
        <Field label="Notes"><textarea className="textarea" rows={3} value={form.notes} onChange={set('notes')} /></Field>
        <div className="btn-row">
          <button className="btn primary" type="submit" disabled={busy}>Save lead</button>
          <button className="btn ghost" type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Sheet>
  );
}
