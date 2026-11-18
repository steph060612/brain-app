// Orchestrator: wires brain visual + knowledge base UI.
import { camera, surfPool, surfNormVecs, onAnimate } from './brain.js';
import { initLabels, updateLabels, setLabelItems } from './labels.js';
import { initPanel, openPanel } from './panel.js';
import { initTopbar, showSetupIfEmpty } from './topbar.js';
import { initInbox } from './inbox.js';
import { initDistill } from './distill.js';
import { initImport } from './import.js';
import { initList, setListItems } from './list.js';
import { fetchItems } from './api.js';
import { watchBuild } from './build-guard.js';

async function boot() {
  watchBuild();
  initPanel();
  initTopbar();
  initInbox();
  initDistill();
  initImport();

  let items = [];
  try {
    items = await fetchItems();
  } catch (e) {
    console.error('Failed to load Brain items:', e);
  }

  initLabels(items, surfPool, surfNormVecs, camera, openPanel);
  initList(items, openPanel);
  showSetupIfEmpty(items);

  onAnimate(() => updateLabels(camera));

  // A project archived or unarchived (or any other change to the set of items): fresh labels and list.
  window.addEventListener('brain-items-changed', async () => {
    try { const fresh = await fetchItems(); setLabelItems(fresh); setListItems(fresh); } catch { /* keep what's shown */ }
  });
}

boot();
