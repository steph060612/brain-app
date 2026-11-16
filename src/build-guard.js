// Keeps an open page in step with the server. The bundle knows the build it came from (__BRAIN_BUILD__, set by
// vite.config.js); the server reports the build it serves at /api/version. When they differ, the page is older than
// the app (it was loaded before a rebuild and restart), so it reloads itself. A reload that does not fix it (the
// server serves a stale build) is not repeated; the caller gets a readable message instead.
/* global __BRAIN_BUILD__ */
export const BUNDLE_BUILD = typeof __BRAIN_BUILD__ !== 'undefined' ? __BRAIN_BUILD__ : { id: 'dev', schemaVersion: null };
const RELOAD_KEY = 'brain-build-reload';

export async function checkBuild() {
  let server;
  try { server = await (await fetch('/api/version', { cache: 'no-store' })).json(); }
  catch { return { ok: true }; } // server unreachable: nothing to compare
  if (server.stale) return { ok: false, message: server.stale };
  if (BUNDLE_BUILD.id === 'dev' || server.buildId === BUNDLE_BUILD.id) {
    try { sessionStorage.removeItem(RELOAD_KEY); } catch {}
    return { ok: true };
  }
  let last = 0;
  try { last = Number(sessionStorage.getItem(RELOAD_KEY)) || 0; } catch {}
  if (Date.now() - last > 60_000) {
    try { sessionStorage.setItem(RELOAD_KEY, String(Date.now())); } catch {}
    location.reload();
    return new Promise(() => {}); // the page is going away
  }
  return { ok: false, message: `This page (build ${BUNDLE_BUILD.id}) is older than the app (build ${server.buildId}) and reloading did not help. Quit and reopen the Brain app.` };
}

// At start and whenever the window comes back into view.
export function watchBuild() {
  checkBuild();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkBuild(); });
}
