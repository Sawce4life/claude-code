/** Inline icons, so the app ships no icon font and works offline. */
const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.9,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': 'true',
};

export const IconToday = (p) => (
  <svg {...base} {...p}><path d="M8 2v3M16 2v3" /><rect x="3" y="5" width="18" height="17" rx="3" /><path d="M3 10h18M8 15h4" /></svg>
);
export const IconPeople = (p) => (
  <svg {...base} {...p}><path d="M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20" /><circle cx="9" cy="7" r="3.4" /><path d="M17 4.2a3.4 3.4 0 0 1 0 6.6M22 20v-1.5a4 4 0 0 0-3-3.8" /></svg>
);
export const IconSpark = (p) => (
  <svg {...base} {...p}><path d="M12 3l1.8 4.9L19 9.7l-4.6 2.1L12 17l-2.4-5.2L5 9.7l5.2-1.8z" /><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" /></svg>
);
export const IconGear = (p) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="3.2" /><path d="M19.4 14.5a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-3-1.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.3-3l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 2.9-1.2V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 3 1.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.2a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.6 1.1z" /></svg>
);
export const IconPhone = (p) => (
  <svg {...base} {...p}><path d="M21.5 16.9v2.6a1.8 1.8 0 0 1-2 1.8 17.6 17.6 0 0 1-7.7-2.7 17.3 17.3 0 0 1-5.3-5.3A17.6 17.6 0 0 1 3.8 5.5a1.8 1.8 0 0 1 1.8-2h2.6a1.8 1.8 0 0 1 1.8 1.5c.1.9.3 1.7.7 2.5a1.8 1.8 0 0 1-.4 1.9l-1.1 1.1a14 14 0 0 0 5.3 5.3l1.1-1.1a1.8 1.8 0 0 1 1.9-.4c.8.3 1.6.6 2.5.7a1.8 1.8 0 0 1 1.5 1.9z" /></svg>
);
export const IconPlus = (p) => (
  <svg {...base} {...p}><path d="M12 5v14M5 12h14" /></svg>
);
export const IconPencil = (p) => (
  <svg {...base} {...p}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
);
export const IconBack = (p) => (
  <svg {...base} {...p}><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
);
export const IconSend = (p) => (
  <svg {...base} {...p}><path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" /></svg>
);
export const IconMic = (p) => (
  <svg {...base} {...p}><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v4" /></svg>
);
export const IconClock = (p) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
);
export const IconRefresh = (p) => (
  <svg {...base} {...p}><path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" /></svg>
);
export const IconSearch = (p) => (
  <svg {...base} {...p}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.2-4.2" /></svg>
);
export const IconTrash = (p) => (
  <svg {...base} {...p}><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>
);
export const IconCheck = (p) => (
  <svg {...base} {...p}><path d="M20 6L9 17l-5-5" /></svg>
);
export const IconMail = (p) => (
  <svg {...base} {...p}><rect x="2" y="4" width="20" height="16" rx="2.5" /><path d="M2.5 6.5L12 13l9.5-6.5" /></svg>
);
