// Orchestrator: wires brain visual + knowledge base UI.
import { camera, surfPool, surfNormVecs, onAnimate } from './brain.js';
import { initLabels, updateLabels } from './labels.js';
import { initPanel, openPanel } from './panel.js';
import { initTopbar } from './topbar.js';
import { initInbox } from './inbox.js';
import { initDistill } from './distill.js';
import { initImport } from './import.js';
import { fetchItems } from './api.js';

async function boot() {
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

  onAnimate(() => updateLabels(camera));
}

boot();
