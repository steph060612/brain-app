// Tagged comments, shared by the JavaScript side of the mapper (// and /* */ comments) and the Python side (#).
// No dependencies.

export const NOTE_TAG = /^[\s!]*(NOTE|WHY|HACK|FIXME|TODO|IMPORTANT|WARNING)\b(\s*[:\-–—]|\(|[^.:\n()]{1,40}:)?/i;
// A tag counts when written in capitals (TODO), followed by ":" or a dash, directly by "(" (todo(locale)), or by a
// colon within a few words ("Why this exists:"); plain words such as a JSX label {/* Warning */}, a section label
// "Note (in details tray)" or prose "note that…" are not notes.
export const NOTE_RE = { test: (l) => { const m = NOTE_TAG.exec(l); return !!m && (m[1] === m[1].toUpperCase() || !!m[2]); }, exec: (l) => NOTE_TAG.exec(l) };
export const CITE_RE = /\b(ADR|RFC)[\s#-]?\d+/i;
