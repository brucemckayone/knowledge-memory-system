// Patterns panel (viz.5) — surfaces causal_patterns lifecycle (mig 012).
//
// Layout:
//   - Status filter chips: Staging / Candidate / Provisional / Canonical / Rejected.
//     'Rejected' off by default (terminal, less useful day-to-day).
//   - Detect + Promote buttons (manual triggers).
//   - List of patterns matching the active chip filter, each row clickable
//     to open an inline instances drawer (GET /api/patterns/:id/instances).

import { state } from '../state.js';
import { esc } from '../util.js';
import {
  getPatterns,
  getPatternInstances,
  detectPatterns,
  promotePatterns,
} from '../api.js';

const ALL_STATUSES = ['staging', 'candidate', 'provisional', 'canonical', 'rejected'];

const STATUS_LABEL = {
  staging: 'Staging',
  candidate: 'Candidate',
  provisional: 'Provisional',
  canonical: 'Canonical',
  rejected: 'Rejected',
};

const STATUS_CLASS = {
  staging: 'sev-low',
  candidate: 'sev-medium',
  provisional: 'sev-medium',
  canonical: 'sev-low',
  rejected: 'sev-high',
};

export async function refreshPatterns() {
  try {
    const body = await getPatterns(100, state.patternStatusFilter);
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
  meta.textContent = `${rows.length} match${rows.length === 1 ? '' : 'es'}`;
  if (rows.length === 0) {
    list.innerHTML = '<div class="ctrad-empty">No patterns matching the current filter. Click <b>Detect</b> to run the chain scan.</div>';
    return;
  }
  list.innerHTML = rows.map(r => {
    const name = (r.name || '(unnamed candidate)').replace(/</g, '&lt;');
    const desc = (r.description || '').replace(/</g, '&lt;');
    const status = r.status;
    const sevClass = STATUS_CLASS[status] || 'sev-medium';
    const tplShape = (r.templateStructure || []).map(n =>
      `${n.entity_type || '?'}/${n.predicate_category || '?'}`
    ).join(' → ');
    const ageHours = r.firstDetectedAt
      ? Math.round((Date.now() - new Date(r.firstDetectedAt).getTime()) / 3_600_000)
      : null;
    return `
      <div class="ctrad-row pattern-row" data-id="${esc(r.id)}">
        <div class="ctrad-row-head">
          <span class="ctrad-type">${name}</span>
          <span class="ctrad-severity ${sevClass}">${STATUS_LABEL[status] || status}</span>
        </div>
        <div class="ctrad-reasoning">${desc || '<em>no description</em>'}</div>
        <div class="ctrad-reasoning"><code>${tplShape.replace(/</g, '&lt;') || '—'}</code></div>
        <div class="ctrad-actions">
          instances: ${r.instanceCount} · activations(30d): ${r.activations30d ?? 0} · avg_strength: ${r.avgStrength?.toFixed?.(2) ?? '—'}${ageHours != null ? ` · ${ageHours}h old` : ''}
        </div>
        <div class="pattern-instances" id="patternInstances_${esc(r.id)}" hidden></div>
      </div>
    `;
  }).join('');

  for (const row of list.querySelectorAll('.pattern-row')) {
    const id = row.getAttribute('data-id');
    row.addEventListener('click', (e) => {
      // Don't toggle when clicking inside the drawer.
      if (e.target.closest('.pattern-instances')) return;
      togglePatternInstances(id);
    });
  }
}

async function togglePatternInstances(patternId) {
  const drawer = document.getElementById(`patternInstances_${patternId}`);
  if (!drawer) return;
  if (!drawer.hidden) {
    drawer.hidden = true;
    drawer.innerHTML = '';
    return;
  }
  drawer.hidden = false;
  drawer.innerHTML = '<div class="cc-signals-empty">Loading instances…</div>';
  try {
    const body = await getPatternInstances(patternId, 20);
    const inst = body.instances || [];
    if (inst.length === 0) {
      drawer.innerHTML = '<div class="cc-signals-empty">No instances on file.</div>';
      return;
    }
    drawer.innerHTML = inst.map(i => `
      <div class="pattern-instance-row">
        <div class="pi-meta">pos ${i.pattern_position ?? '?'} · strength ${(Number(i.strength) || 0).toFixed(2)} · ${i.created_at ? new Date(i.created_at).toLocaleDateString() : ''}</div>
        <div class="pi-reasoning">${esc((i.reasoning || '').slice(0, 200))}</div>
      </div>
    `).join('');
  } catch (err) {
    drawer.innerHTML = `<div class="cc-signals-empty">Failed: ${esc(err.message)}</div>`;
  }
}

// Filter chips — toggle inclusion of each status in state.patternStatusFilter.
function bindFilterChips() {
  const wrap = document.getElementById('patternsFilter');
  if (!wrap) return;
  wrap.innerHTML = ALL_STATUSES.map(s => `
    <button class="pf-chip ${state.patternStatusFilter.includes(s) ? 'active' : ''}" data-status="${s}">${STATUS_LABEL[s]}</button>
  `).join('');
  for (const chip of wrap.querySelectorAll('.pf-chip')) {
    chip.addEventListener('click', () => {
      const s = chip.dataset.status;
      const idx = state.patternStatusFilter.indexOf(s);
      if (idx >= 0) state.patternStatusFilter.splice(idx, 1);
      else state.patternStatusFilter.push(s);
      chip.classList.toggle('active');
      refreshPatterns();
    });
  }
}

async function doDetect() {
  const btn = document.getElementById('btnPatternsDetect');
  btn.textContent = 'Detecting…';
  btn.disabled = true;
  try {
    const result = await detectPatterns();
    await refreshPatterns();
    alert(`Detection complete.\n\n${JSON.stringify(result).slice(0, 400)}`);
  } catch (err) {
    alert(`Detection failed: ${err.message}`);
  } finally {
    btn.textContent = 'Detect';
    btn.disabled = false;
  }
}

async function doPromote() {
  const btn = document.getElementById('btnPatternsPromote');
  btn.textContent = 'Promoting…';
  btn.disabled = true;
  try {
    const result = await promotePatterns();
    await refreshPatterns();
    alert(`Promote complete.\n\n${JSON.stringify(result).slice(0, 400)}`);
  } catch (err) {
    alert(`Promote failed: ${err.message}`);
  } finally {
    btn.textContent = 'Promote';
    btn.disabled = false;
  }
}

export function bindPatternsPanel() {
  document.getElementById('btnPatterns').addEventListener('click', async () => {
    const panel = document.getElementById('patternsPanel');
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) {
      bindFilterChips();
      const body = await getPatterns(100, state.patternStatusFilter);
      renderPatternsPanel(body.patterns || []);
    }
  });
  document.getElementById('patternsClose').addEventListener('click', () => {
    document.getElementById('patternsPanel').classList.remove('open');
  });
  const detectBtn = document.getElementById('btnPatternsDetect');
  if (detectBtn) detectBtn.addEventListener('click', doDetect);
  const promoteBtn = document.getElementById('btnPatternsPromote');
  if (promoteBtn) promoteBtn.addEventListener('click', doPromote);
}
