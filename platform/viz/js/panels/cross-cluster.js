// Cross-cluster candidates panel (viz.4 — Phase 4 doc 25).
//
// Surfaces merge_candidates rows where candidate_source = 'cross_cluster_generator',
// with the per-pair signal vector breakdown parsed out of the JSON-encoded
// resolution_reasoning blob written by the generator at scoring time
// (cross-cluster-generator.ts upsertCandidate). The breakdown format:
//   { contributions: { cluster, drift_a, drift_b, role, centrality, articulation }, ... }

import { state } from '../state.js';
import { esc } from '../util.js';
import { getCrossClusterCandidates, generateCrossCluster } from '../api.js';
import { renderAll } from '../canvas/render.js';
import { toggleFocus } from '../canvas/focus.js';

const SIGNAL_LABELS = [
  ['cluster', 'cluster', '#58a6ff'],
  ['drift_a', 'drift A', '#f0883e'],
  ['drift_b', 'drift B', '#f0883e'],
  ['role', 'role sim', '#27ae60'],
  ['centrality', 'centrality', '#9b59b6'],
  ['articulation', 'articulation', '#d29922'],
];

function parseContributions(reasoning) {
  if (!reasoning) return null;
  try {
    const parsed = typeof reasoning === 'string' ? JSON.parse(reasoning) : reasoning;
    return parsed?.contributions || null;
  } catch {
    return null;
  }
}

export async function refreshCrossCluster() {
  try {
    const body = await getCrossClusterCandidates(200);
    const list = body.candidates || [];
    state.crossClusterCandidates = list;
    const badge = document.getElementById('crossClusterBadge');
    if (badge) {
      badge.textContent = String(list.length);
      badge.classList.toggle('zero', list.length === 0);
    }
    const panel = document.getElementById('crossClusterPanel');
    if (panel && panel.classList.contains('open')) renderPanel(list);
    // Re-render canvas so cross-cluster edges pick up the candidate_source
    // styling without waiting for the next /api/viz/unified poll.
    renderAll();
  } catch {
    // Best-effort.
  }
}

function renderPanel(rows) {
  const list = document.getElementById('crossClusterList');
  const meta = document.getElementById('crossClusterMeta');
  if (!list || !meta) return;
  meta.textContent = `${rows.length} candidate${rows.length === 1 ? '' : 's'}`;
  if (rows.length === 0) {
    list.innerHTML = '<div class="ctrad-empty">No cross-cluster candidates yet. Click <b>Generate</b> to run the Phase 4 generator.</div>';
    return;
  }

  list.innerHTML = rows.map((r) => {
    const contrib = parseContributions(r.resolutionReasoning);
    const score = (r.combinedScore ?? 0).toFixed(3);
    const signalsHtml = contrib
      ? renderSignalBars(contrib)
      : '<div class="cc-signals-empty">no signal breakdown stored</div>';
    return `
      <div class="ctrad-row cc-row" data-a="${esc(r.entityA.id)}" data-b="${esc(r.entityB.id)}">
        <div class="ctrad-row-head">
          <span class="ctrad-type">${esc(r.entityA.name)} ↔ ${esc(r.entityB.name)}</span>
          <span class="ctrad-severity sev-medium">${score}</span>
        </div>
        <div class="ctrad-reasoning">
          <code>${esc(r.entityA.type)}</code> ↔ <code>${esc(r.entityB.type)}</code>
          · status: ${esc(r.status)} · seen ×${r.detectionCount}
        </div>
        ${signalsHtml}
      </div>
    `;
  }).join('');

  for (const row of list.querySelectorAll('.cc-row')) {
    row.addEventListener('click', () => {
      const aId = row.getAttribute('data-a');
      const bId = row.getAttribute('data-b');
      focusOnPair(aId, bId);
    });
  }
}

function renderSignalBars(contrib) {
  const cells = SIGNAL_LABELS.map(([key, label, color]) => {
    const v = Number(contrib[key] || 0);
    const pct = Math.max(0, Math.min(100, Math.round(v * 100)));
    return `
      <div class="signal-bar">
        <span class="bar-label">${esc(label)}</span>
        <div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>
        <span class="bar-value">${v.toFixed(2)}</span>
      </div>
    `;
  }).join('');
  return `<div class="cc-signals">${cells}</div>`;
}

function focusOnPair(aId, bId) {
  // Re-use focus mode: set focus on entity A. We also nudge entity B into the
  // connected set artificially by faking an edge — but since the focus
  // implementation reads state.data.edges live, we just call toggleFocus(aId)
  // and rely on the existing connectivity. If A and B aren't directly
  // connected, B will fade — acceptable for now (the rows show the pair
  // names anyway). Future iteration: a dedicated "focus pair" mode.
  if (state.focusedEntityId === aId) toggleFocus(aId); // unfocus if same
  toggleFocus(aId);
  // Ensure B is visible by un-fading it via DOM class manipulation.
  const { g } = state.refs;
  if (g) {
    g.selectAll('g.node').each(function(n) {
      if (n && (n.id === bId || n.id === aId)) {
        d3.select(this).classed('faded', false);
      }
    });
  }
}

async function doGenerate() {
  const btn = document.getElementById('btnCrossClusterGenerate');
  const orig = btn ? btn.textContent : null;
  if (btn) {
    btn.textContent = 'Generating…';
    btn.disabled = true;
  }
  try {
    const result = await generateCrossCluster();
    await refreshCrossCluster();
    if (result?.ran === false) {
      alert(`Generator skipped: ${result.skippedReason || 'unknown reason'}.\nRun Topology + Cluster first if upstreams are stale.`);
    }
  } catch (err) {
    alert(`Generation failed: ${err.message}`);
  } finally {
    if (btn) {
      btn.textContent = orig;
      btn.disabled = false;
    }
  }
}

export function bindCrossClusterPanel() {
  const open = document.getElementById('btnCrossCluster');
  if (open) {
    open.addEventListener('click', async () => {
      const panel = document.getElementById('crossClusterPanel');
      panel.classList.toggle('open');
      if (panel.classList.contains('open')) {
        const body = await getCrossClusterCandidates(200);
        renderPanel(body.candidates || []);
      }
    });
  }
  const close = document.getElementById('crossClusterClose');
  if (close) {
    close.addEventListener('click', () => {
      document.getElementById('crossClusterPanel').classList.remove('open');
    });
  }
  const gen = document.getElementById('btnCrossClusterGenerate');
  if (gen) gen.addEventListener('click', doGenerate);
}
