import { IconPhone, IconPencil } from './icons.jsx';
import { STATUS_LABELS } from '@shared/priority.js';

const BUCKET_PILL = {
  overdue: 'overdue', today: 'today', new: 'new', due: 'due', upcoming: 'due', resting: 'due',
};

export function LeadRow({ entry, lead, onOpen, onLog }) {
  const person = lead || entry?.lead;
  if (!person) return null;
  const bucket = entry?.bucket;
  const telHref = person.phone ? `tel:${String(person.phone).replace(/[^\d+]/g, '')}` : null;

  return (
    <div className="lead-row">
      <button className="lead-open" onClick={() => onOpen(person.id)}>
        <div className="lead-name">
          <span className="who">{person.name || '(no name yet)'}</span>
          {bucket ? (
            <span className={`pill ${BUCKET_PILL[bucket] || 'due'}`}>{entry.bucketLabel}</span>
          ) : (
            <span className="pill due">{STATUS_LABELS[person.status] || person.status}</span>
          )}
        </div>
        <div className="lead-sub">
          {person.company ? `${person.company} -- ` : ''}
          {entry?.reason || person.next_action || person.phone || 'No details yet'}
        </div>
      </button>

      <div className="lead-actions">
        {telHref ? (
          <a className="icon-btn call" href={telHref} aria-label={`Call ${person.name || 'this lead'}`}>
            <IconPhone />
          </a>
        ) : (
          <button className="icon-btn" disabled aria-label="No phone number saved"><IconPhone /></button>
        )}
        <button className="icon-btn" onClick={() => onLog(person)} aria-label={`Log something for ${person.name || 'this lead'}`}>
          <IconPencil />
        </button>
      </div>
    </div>
  );
}
