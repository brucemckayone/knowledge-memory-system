import { triggerReconcile } from '../api.js';
import { fetchData } from '../app.js';

async function doReconcile() {
  const btn = document.getElementById('btnReconcile');
  const origText = btn.textContent;
  btn.textContent = 'Reconciling…';
  btn.disabled = true;
  try {
    const result = await triggerReconcile();
    if (result.triggered) {
      alert(`Reconciliation complete!\n\nResolved ${result.candidateCount} candidate(s).\n\nReport:\n${result.report.substring(0, 500)}${result.report.length > 500 ? '...' : ''}`);
      await fetchData();
    } else {
      alert(`No merge candidates or unconfirmed aliases to reconcile.\n\n${result.message}`);
    }
  } catch (err) {
    alert(`Reconciliation failed: ${err.message}`);
  } finally {
    btn.textContent = origText;
    btn.disabled = false;
  }
}

export function bindReconcile() {
  document.getElementById('btnReconcile').addEventListener('click', doReconcile);
}
