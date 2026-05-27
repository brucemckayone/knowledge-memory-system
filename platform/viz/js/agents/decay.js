import { triggerDecay } from '../api.js';
import { fetchData } from '../app.js';

async function doDecay() {
  const btn = document.getElementById('btnDecay');
  const origText = btn.textContent;
  btn.textContent = 'Decaying…';
  btn.disabled = true;
  try {
    const result = await triggerDecay();
    if (result.triggered) {
      // Mirrors the status-line shape used by garden/reconcile/reason.
      console.log(
        `[decay] decayed ${result.decayed}, expired ${result.expired} in ${result.durationMs}ms`,
      );
      alert(
        `Decay complete! (${(result.durationMs / 1000).toFixed(1)}s)\n\n` +
          `Decayed: ${result.decayed}\nExpired: ${result.expired}`,
      );
      await fetchData();
    } else {
      alert(`Decay failed: ${result.error || 'unknown error'}`);
    }
  } catch (err) {
    alert(`Decay failed: ${err.message}`);
  } finally {
    btn.textContent = origText;
    btn.disabled = false;
  }
}

export function bindDecay() {
  document.getElementById('btnDecay').addEventListener('click', doDecay);
}
