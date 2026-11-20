// "Connect Claude Code" in the top bar (server side: src/claude-connect.js). Shown only when Claude Code is found:
// "Connect Claude Code" when nothing is connected, "Update Claude Code connection" when the block or the tool
// server registration is missing or outdated, and a small "Claude Code connected" link when everything is current
// (it opens the same panel, with Remove). Every change is previewed with the exact text and paths first.
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const BTN = `padding:4px 10px; background:rgba(60,108,255,0.18); border:1px solid rgba(60,108,255,0.4); color:#9FD8FF;
  border-radius:4px; font-size:12px; cursor:pointer; font-family:inherit; white-space:nowrap;`;
const BTN2 = `padding:4px 10px; background:rgba(255,255,255,0.04); border:1px solid rgba(100,120,200,0.25); color:#9FD8FF;
  border-radius:4px; font-size:12px; cursor:pointer; font-family:inherit; white-space:nowrap;`;
const MUTED = 'font-size:11px; color:#5a6890;';
const pre = text => `<pre style="margin:4px 0 0; padding:7px 8px; background:#0b0e1c; border:1px solid rgba(100,120,200,0.15); border-radius:4px;
  font-size:11px; line-height:1.45; color:#a8b4d4; white-space:pre-wrap; word-break:break-word; max-height:220px; overflow:auto">${esc(text)}</pre>`;

let slot = null, status = null, overlay = null;

async function call(method, body) {
  const r = await fetch(`/api/claude-connect${method === 'GET' ? '?fresh=1' : ''}`, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

export function initClaudeConnect(beforeEl) {
  slot = document.createElement('span');
  slot.id = 'claude-connect';
  slot.style.display = 'none';
  beforeEl?.parentNode.insertBefore(slot, beforeEl);
  refresh();
}

async function refresh() {
  try { status = await call('GET'); } catch { status = null; }
  renderButton();
}

function renderButton() {
  if (!slot) return;
  if (!status?.claude) { slot.style.display = 'none'; slot.innerHTML = ''; return; }
  slot.style.display = '';
  slot.innerHTML = status.upToDate
    ? `<button style="background:none; border:none; padding:0; ${MUTED} cursor:pointer; font-family:inherit; white-space:nowrap" title="Every Claude Code session knows your brain. Click to see or remove the connection.">Claude Code connected</button>`
    : `<button style="${BTN}${status.connected ? ' color:#e0a040; border-color:rgba(224,160,64,0.45);' : ''}" title="Tells every Claude Code session where your brain is, and registers the code map tools. Shows the exact changes first.">${status.connected ? 'Update Claude Code connection' : 'Connect Claude Code'}</button>`;
  slot.querySelector('button').addEventListener('click', () => openPanel(status.upToDate ? 'view' : 'connect'));
}

const FILE_TEXT = {
  create: 'does not exist. It is created with the text below (marked as created by the app, so Remove deletes it again if nothing else was added).',
  add: 'exists. The text below is added at the end; nothing else in the file changes.',
  update: 'already has a brain block in older wording. It is replaced in place by the text below; nothing else changes.',
  current: 'already has the current block. Nothing changes.',
};

function openPanel(mode, result) {
  overlay?.remove();
  overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed; inset:0; z-index:200; background:rgba(5,7,15,0.6); display:flex; align-items:flex-start; justify-content:center; padding:70px 16px 16px; overflow:auto;';
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  const box = document.createElement('div');
  box.style.cssText = 'width:min(640px,100%); background:#12162a; border:1px solid rgba(100,120,200,0.3); border-radius:8px; padding:16px 18px; font-size:12.5px; color:#c8d0e8; line-height:1.5;';
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  render(box, mode, result);
}
function close() { overlay?.remove(); overlay = null; refresh(); }

function render(box, mode, result) {
  const s = status, f = s.file, m = s.mcp;
  const head = t => `<div style="font-size:15px; font-weight:700; color:#fff; margin-bottom:8px">${esc(t)}</div>`;
  const buttons = list => `<div style="display:flex; gap:8px; margin-top:14px; flex-wrap:wrap">${list.join('')}</div>`;
  const mcpLine = m.error
    ? `<div style="margin-top:12px; color:#e0a040"><b>Code map tools:</b> ${esc(m.error)}</div>`
    : `<div style="margin-top:12px"><b>Code map tools.</b> ${m.state === 'current'
        ? 'The brainmap tool server is already registered with Claude Code at user scope. Nothing changes.'
        : m.state === 'other'
          ? `brainmap is registered as <code>${esc(m.current)}</code> (${esc(m.scope)}). It is replaced by running:${pre(m.add)}`
          : `The brainmap tool server is registered with Claude Code at user scope (all your projects) by running:${pre(m.add)}`}</div>`;

  if (mode === 'connect') {
    const writes = f.action !== 'current';
    box.innerHTML = head(s.connected ? 'Update the Claude Code connection' : 'Connect Claude Code')
      + `<div>Claude Code reads <b>${esc(f.path)}</b> at the start of every session. This tells it where your brain is and how to treat it. Nothing is written until you click below.</div>`
      + `<div style="margin-top:12px"><b>${esc(f.path)}</b> ${esc(FILE_TEXT[f.action])}${writes ? pre(f.text) : ''}</div>`
      + (f.backup ? `<div style="margin-top:6px; ${MUTED}">Before the first change, a copy of the file is saved as <b>${esc(f.backup)}</b>.</div>` : '')
      + mcpLine
      + (s.notOnPath ? `<div style="margin-top:6px; ${MUTED}">Claude Code is at ${esc(s.claudePath)}, but a new Terminal window does not find the claude command by name, so the app uses that full path.</div>` : '')
      + buttons([`<button class="cc-ok" style="${BTN}">${writes || (m.state && m.state !== 'current') ? 'Connect' : 'Done'}</button>`, `<button class="cc-cancel" style="${BTN2}">Cancel</button>`]);
    box.querySelector('.cc-ok').addEventListener('click', async e => {
      e.target.disabled = true; e.target.textContent = 'Connecting…';
      try { const r = await call('POST', { expect: s.expect }); status = await call('GET'); render(box, 'done', r); }
      catch (err) { box.insertAdjacentHTML('beforeend', `<div style="margin-top:10px; color:#e08040">${esc(err.message)}</div>`); e.target.disabled = false; e.target.textContent = 'Connect'; }
    });
  } else if (mode === 'remove') {
    box.innerHTML = head('Remove the Claude Code connection')
      + `<div><b>${esc(f.path)}</b>: ${f.hasBlock ? (f.removeDeletes
          ? 'the app created this file and nothing else is in it, so the file is deleted.'
          : 'only the marked brain block is taken out. Everything else in the file stays exactly as it is.') : 'has no brain block; nothing changes.'}</div>`
      + `<div style="margin-top:10px"><b>Code map tools:</b> ${m.error ? esc(m.error) : m.registered
          ? `the brainmap tool server registration is removed by running:${pre(m.remove)}Claude Code sessions then no longer have the mcp__brainmap__* tools; the brainmap command still works.`
          : 'brainmap is not registered with Claude Code; nothing changes.'}</div>`
      + buttons([`<button class="cc-ok" style="${BTN}">Remove</button>`, `<button class="cc-cancel" style="${BTN2}">Cancel</button>`]);
    box.querySelector('.cc-ok').addEventListener('click', async e => {
      e.target.disabled = true;
      try { const r = await call('DELETE', { expect: s.expect }); status = await call('GET'); render(box, 'removed', r); }
      catch (err) { box.insertAdjacentHTML('beforeend', `<div style="margin-top:10px; color:#e08040">${esc(err.message)}</div>`); e.target.disabled = false; }
    });
  } else if (mode === 'done' || mode === 'view') {
    const r = result;
    const fileDone = r ? ({ create: `Created ${r.file.path} with the brain block.`, add: `Added the brain block at the end of ${r.file.path}.`, update: `Updated the brain block in ${r.file.path}.`, current: `${r.file.path} already had the current block.` })[r.file.action] : `${f.path} has the brain block.`;
    const mcpDone = r ? (r.mcp?.ok ? ({ add: 'Registered the brainmap tool server with Claude Code (user scope).', update: 'Re-registered the brainmap tool server with Claude Code (user scope).', current: 'The brainmap tool server was already registered.' })[r.mcp.action] : esc(r.mcp?.error || ''))
      : m.state === 'current' ? 'The brainmap tool server is registered with Claude Code (user scope).' : esc(m.error || 'The brainmap tool server is not registered.');
    box.innerHTML = head(mode === 'done' ? 'Claude Code connected' : 'Claude Code connection')
      + `<div>${esc(fileDone)}</div>`
      + (r?.file.backup ? `<div style="margin-top:6px">The earlier file was saved as <b>${esc(r.file.backup)}</b>.</div>` : '')
      + `<div style="margin-top:6px${r && !r.mcp?.ok ? '; color:#e0a040' : ''}">${mcpDone}</div>`
      + `<div style="margin-top:10px">The block now in ${esc(f.path)}:${pre(f.text)}</div>`
      + `<div style="margin-top:8px; ${MUTED}">New Claude Code sessions pick this up; sessions already open do not.</div>`
      + buttons([`<button class="cc-cancel" style="${BTN}">Close</button>`, `<button class="cc-remove" style="${BTN2}">Remove…</button>`]);
    box.querySelector('.cc-remove').addEventListener('click', () => render(box, 'remove'));
  } else if (mode === 'removed') {
    const r = result;
    box.innerHTML = head('Claude Code connection removed')
      + `<div>${esc(({ removed: `Took the brain block out of ${r.file.path}; the rest of the file is as it was.`, deleted: `Deleted ${r.file.path} (the app had created it and nothing else was in it).`, none: `${r.file.path} had no brain block.` })[r.file.action])}</div>`
      + `<div style="margin-top:6px">${esc(({ removed: 'Removed the brainmap tool server registration from Claude Code.', none: 'brainmap was not registered with Claude Code.', skipped: r.mcp.error || '', failed: `Could not remove the registration: ${r.mcp.error}` })[r.mcp.action] || '')}</div>`
      + buttons([`<button class="cc-cancel" style="${BTN}">Close</button>`]);
  }
  box.querySelector('.cc-cancel')?.addEventListener('click', close);
}
