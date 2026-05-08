import { getPatterns } from '../api.js';

export async function refreshPatterns() {
  try {
    const body = await getPatterns(100);
    const rows = body.patterns || [];
    const badge = document.getElementById('patternsBadge');
    if (badge) {
      badge.textContent = String(rows.length);
      badge.classList.toggle('zero', rows.length === 0);
    }
    const panel = document.getElementById('patternsPanel');
    if (panel && panel.classList.contains('open')) renderPatternsPanel(rows);
  } catch {
    // Best-effort
  }
}

function renderPatternsPanel(rows) {
  const list = document.getElementById('patternsList');
  const meta = document.getElementById('patternsMeta');
  if (!list || !meta) return;
  meta.textContent = `${rows.length} active`;
  if (rows.length === 0) {
    list.innerHTML = '<div class="ctrad-empty">No active patterns yet. Detection auto-runs every 3 reasoning patrols.</div>';
    return;
  }
  list.innerHTML = rows.map(r => {
    const name = (r.name || '(unnamed candidate)').replace(/</g, '&lt;');
    const desc = (r.description || '').replace(/</g, '&lt;');
    const status = r.status;
    const sevClass = status === 'canonical' ? 'sev-low' : 'sev-medium';
    const tplShape = (r.templateStructure || []).map(n =>
      `${n.entity_type || '?'}/${n.predicate_category || '?'}`
    ).join(' → ');
    return `
      <div class="ctrad-row" data-id="${r.id}">
        <div class="ctrad-row-head">
          <span class="ctrad-type">${name}</span>
          <span class="ctrad-severity ${sevClass}">${status}</span>
        </div>
        <div class="ctrad-reasoning">${desc || '<em>no description</em>'}</div>
        <div class="ctrad-reasoning"><code>${tplShape.replace(/</g, '&lt;')}</code></div>
        <div class="ctrad-actions">
          instances: ${r.instanceCount} · activations(30d): ${r.activations30d ?? 0} · avg_strength: ${r.avgStrength?.toFixed?.(2) ?? '—'}
        </div>
      </div>
    `;
  }).join('');
}

export function bindPatternsPanel() {
  document.getElementById('btnPatterns').addEventListener('click', async () => {
    const panel = document.getElementById('patternsPanel');
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) {
      const body = await getPatterns(100);
      renderPatternsPanel(body.patterns || []);
    }
  });
  document.getElementById('patternsClose').addEventListener('click', () => {
    document.getElementById('patternsPanel').classList.remove('open');
  });
}
