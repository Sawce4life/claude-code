import { useEffect, useRef } from 'react';
import { STATUSES, STATUS_LABELS } from '@shared/priority.js';

/** A bottom sheet on phones, a centred dialog on wider screens. */
export function Sheet({ title, hint, onClose, children }) {
  const panel = useRef(null);

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = panel.current?.querySelector('input, textarea, select, button');
    focusable?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div
      className="sheet-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
      role="presentation"
    >
      <div className="sheet" ref={panel} role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-grip" />
        {title ? <h2>{title}</h2> : null}
        {hint ? <p className="hint">{hint}</p> : null}
        {children}
      </div>
    </div>
  );
}

export function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint ? <span className="tiny" style={{ marginTop: 4, display: 'block' }}>{hint}</span> : null}
    </label>
  );
}

export function Notice({ kind = 'info', children }) {
  if (!children) return null;
  return <div className={`notice ${kind}`} role={kind === 'error' ? 'alert' : undefined}>{children}</div>;
}

export function StatusSelect({ value, onChange, id }) {
  return (
    <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      {STATUSES.map((status) => (
        <option key={status} value={status}>{STATUS_LABELS[status]}</option>
      ))}
    </select>
  );
}

export function Empty({ title, children }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

/**
 * Turns a millisecond timestamp into the value a datetime-local input wants,
 * expressed in the browser's own zone.
 */
export function toLocalInput(ms) {
  if (!ms) return '';
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromLocalInput(value) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}
