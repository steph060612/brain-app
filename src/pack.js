// Copy buttons: packs for the project panel and the top bar, and the close-session prompt.
// The server runs ~/.brain/brainpack.sh, which saves the pack and copies it to the macOS clipboard.
// The browser copy below is a second path to the same text; it may be refused after the await.

function copyButton(label, hint) {
  const btn = document.createElement('button');
  btn.style.cssText = `
    padding:4px 10px; background:rgba(255,255,255,0.04); border:1px solid rgba(100,120,200,0.25);
    color:#9FD8FF; border-radius:4px; font-size:12px; cursor:pointer; font-family:inherit;
    white-space:nowrap; flex-shrink:0;
  `;
  const labelEl = document.createElement('span');
  labelEl.textContent = label;
  const hintEl = document.createElement('span');
  hintEl.textContent = ` · ${hint}`;
  hintEl.style.color = '#5a6890';
  btn.appendChild(labelEl);
  if (hint) btn.appendChild(hintEl);
  return { btn, labelEl };
}

// Copies fixed text; there's no await before the copy, so the browser allows it as part of the click.
export function textCopyButton({ label, hint, text }) {
  const { btn, labelEl } = copyButton(label, hint);
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      labelEl.textContent = 'Copied';
    } catch (e) {
      labelEl.textContent = 'Copy failed';
      btn.title = e.message;
    }
    setTimeout(() => { labelEl.textContent = label; }, 2500);
  });
  return btn;
}

// body() returns { mode, project? } for /api/pack. onResult(error, data) reports the outcome.
export function packButton({ label, hint, body, onResult }) {
  const { btn, labelEl } = copyButton(label, hint);

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    labelEl.textContent = 'Building pack…';
    btn.title = '';
    try {
      const r = await fetch('/api/pack', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body()),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      try { await navigator.clipboard.writeText(data.content); } catch { /* script already copied it */ }
      labelEl.textContent = 'Copied';
      btn.title = `${data.chars.toLocaleString()} characters, saved as ${data.file}`;
      onResult?.(null, data);
    } catch (e) {
      labelEl.textContent = 'Pack failed';
      btn.title = e.message;
      onResult?.(e.message);
    }
    btn.disabled = false;
    setTimeout(() => { labelEl.textContent = label; }, 2500);
  });
  return btn;
}
