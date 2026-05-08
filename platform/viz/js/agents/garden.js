import { triggerGarden } from '../api.js';
import { fetchData } from '../app.js';

async function doGarden() {
  const btn = document.getElementById('btnGarden');
  const origText = btn.textContent;
  btn.textContent = 'Gardening…';
  btn.disabled = true;
  try {
    const result = await triggerGarden();
    if (result.triggered) {
      const report = result.report || '(no report)';
      const preview = report.length > 600 ? report.substring(0, 600) + '…' : report;
      alert(`Gardening complete! (${(result.durationMs / 1000).toFixed(1)}s)\n\n${preview}`);
      await fetchData();
    } else {
      alert(`Gardening failed: ${result.error || 'unknown error'}`);
    }
  } catch (err) {
    alert(`Gardening failed: ${err.message}`);
  } finally {
    btn.textContent = origText;
    btn.disabled = false;
  }
}

export function bindGarden() {
  document.getElementById('btnGarden').addEventListener('click', doGarden);
}
