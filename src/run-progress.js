// Shared by the Import and Distill windows: run progress, Cancel, and the estimate shown before large runs.
export const CONFIRM_ABOVE_CALLS = 5;
const CHARS_PER_CALL = 40_000; // same as src/claude-parser.js, which is server-only

export function fmtDuration(ms) {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600), m = Math.floor(totalSec / 60) % 60, s = totalSec % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

export function progressText(state) {
  const elapsed = fmtDuration(Date.now() - new Date(state.startedAt).getTime());
  return state.callNumber && state.message !== 'Cancelling…'
    ? `Call ${state.callNumber} of ${state.totalCalls}, ${elapsed} elapsed`
    : `${state.message || 'Working…'} (${elapsed} elapsed)`;
}

export function cancelRun(runId) {
  return fetch(`/api/distill/cancel/${runId}`, { method: 'POST' }).catch(() => {});
}

export async function fetchRuns() {
  const r = await fetch('/api/distill/runs');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// The chunks the server will cut from uploaded files.
export function callsForFiles(files) {
  const chars = files.reduce((n, f) => n + `=== ${f.name} ===\n`.length + f.content.length + 2, -2);
  return Math.max(1, Math.ceil(chars / CHARS_PER_CALL));
}

export async function callEstimate(calls) {
  const { avgCallMs, callSamples } = await fetchRuns().catch(() => ({ avgCallMs: 90_000, callSamples: 0 }));
  return {
    estimate: fmtDuration(calls * avgCallMs),
    basis: callSamples
      ? `from the average of your last ${callSamples} call${callSamples !== 1 ? 's' : ''}`
      : 'a rough guess of 90 seconds per call, until there are real timings',
  };
}
