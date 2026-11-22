// Dates shown to the person, in the Mac's own time zone. toISOString() is universal time: in the evening west of
// Greenwich (or in the morning east of it) its first ten characters are a different day.
const p = n => String(n).padStart(2, '0');

// YYYY-MM-DD in local time, from a Date, an ISO string or a time in milliseconds.
export function localDate(d) {
  const t = d instanceof Date ? d : new Date(d);
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

// YYYY-MM-DD HH:MM:SS in local time.
export function localStamp(d = new Date()) {
  const t = d instanceof Date ? d : new Date(d);
  return `${localDate(t)} ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
}
