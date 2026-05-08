import { triggerReason } from '../api.js';
import { showAnswer } from '../panels/query.js';

async function doReason() {
  const btn = document.getElementById('btnReason');
  const origText = btn.textContent;
  btn.textContent = 'Reasoning…';
  btn.disabled = true;
  try {
    const data = await triggerReason();
    showAnswer(`Patrol complete (${(data.durationMs / 1000).toFixed(1)}s)\n\n${data.result}`);
  } catch (err) {
    showAnswer(`Error: ${err.message}`);
  } finally {
    btn.textContent = origText;
    btn.disabled = false;
  }
}

export function bindReason() {
  document.getElementById('btnReason').addEventListener('click', doReason);
}
