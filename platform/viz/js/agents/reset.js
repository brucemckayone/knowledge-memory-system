import { state } from '../state.js';
import { clearGraph, resetAll } from '../api.js';
import { initSvg } from '../canvas/simulation.js';
import { renderAll } from '../canvas/render.js';
import { resetScrubber } from '../canvas/scrubber.js';
import { closeDetailPanel } from '../panels/detail.js';
import { unpinTooltip, updatePinnedTooltipPosition } from '../canvas/tooltip.js';
import { fetchData } from '../app.js';

async function doReset(kind) {
  const isFull = kind === 'reset';
  const label = isFull
    ? 'Reset all: deletes all PostgreSQL graph data AND all Qdrant vectors.'
    : 'Clear graph: deletes all entities, facts, and causal data from PostgreSQL.';
  if (!confirm(`${label}\n\nThis cannot be undone. Continue?`)) return;
  const btn = document.getElementById(isFull ? 'btnResetAll' : 'btnClearGraph');
  const origText = btn.textContent;
  btn.textContent = 'Clearing…';
  btn.disabled = true;
  try {
    if (isFull) await resetAll();
    else await clearGraph();
    state.data = { nodes: [], edges: [] };
    state.selectedId = null;
    state.focusedEntityId = null;
    resetScrubber();
    closeDetailPanel();
    unpinTooltip();
    initSvg(updatePinnedTooltipPosition);
    renderAll();
    await fetchData();
  } catch (err) {
    alert(`Reset failed: ${err.message}`);
  } finally {
    btn.textContent = origText;
    btn.disabled = false;
  }
}

export function bindReset() {
  document.getElementById('btnClearGraph').addEventListener('click', () => doReset('clear'));
  document.getElementById('btnResetAll').addEventListener('click', () => doReset('reset'));
}
