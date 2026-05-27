// Unified merge-candidates panel (bead nmemo-2yv.47).
//
// Subsumes the legacy cross-cluster panel: surfaces every merge_candidates row
// (any candidate_source) with status != 'resolved' by default, with per-row
// nine-signal bars and per-row reconcile.
//
// Driven by /api/viz/merge-candidates (bead nmemo-2yv.45 lands the filter +
// LIMIT contract on getMergeCandidates). The endpoint returns ALL rows including
// resolved under a 10,000-row cap; this panel filters in-render to non-resolved
// for the default view and exposes a chip filter for source.
//
// Signal vector shape (post-bead nmemo-2yv.42 / F1a): resolution_reasoning is a
// JSON blob `{ signals: { centroid_similarity, memory_overlap, ... 9 keys ... },
// combined_score, ... }`. Rows from before F1a may carry the legacy
// `{ contributions: { cluster, drift_a, ... } }` shape — fallback to the direct
// SQL columns (centroid_similarity / memory_overlap / structural_similarity)
// when signals is absent.

import { state } from '../state.js';
import { esc } from '../util.js';
import { getMergeCandidatesViz, reconcileCandidate, generateCrossCluster, getCrossClusterRuns } from '../api.js';
import { renderAll } from '../canvas/render.js';
import { toggleFocus } from '../canvas/focus.js';
import {
  SIGNAL_LABELS,
  SOURCE_FILTERS,
  parseSignals,
  filterBySource,
  filterUnresolved,
} from './merge-candidates-helpers.js';

/** Render the nine signal bars for one row's signal map. Bars for null
 *  signals render as a muted "n/a" label to preserve the vertical rhythm.
 *  Returns an HTML string. Depends on `esc()` (DOM-coupled util.js). */
function renderSignalBars(signals) {
  const cells = SIGNAL_LABELS.map(([key, label, color]) => {
    const v = signals[key];
    if (v == null) {
      return `
      <div class="signal-bar signal-bar-null">
        <span class="bar-label">${esc(label)}</span>
        <div class="bar-bg"></div>
        <span class="bar-value bar-value-null">n/a</span>
      </div>
    `;
    }
    const pct = Math.max(0, Math.min(100, Math.round(Number(v) * 100)));
    return `
      <div class="signal-bar">
        <span class="bar-label">${esc(label)}</span>
        <div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>
        <span class="bar-value">${Number(v).toFixed(2)}</span>
      </div>
    `;
  }).join('');
  return `<div class="cc-signals">${cells}</div>`;
}

/** Render one candidate row's full HTML. Returns a string. Visible state
 *  (focus, hover) is applied via DOM event handlers attached after innerHTML
 *  assignment. Depends on `esc()` (DOM-coupled util.js). */
function renderRow(row) {
  const signals = parseSignals(row);
  const score = (row.combinedScore ?? 0).toFixed(3);
  const sourceTag = row.candidateSource === 'cross_cluster_generator'
    ? '<span class="cc-source-tag cc-source-cross">cross-cluster</span>'
    : '<span class="cc-source-tag cc-source-three">three-signal</span>';
  return `
      <div class="ctrad-row cc-row" data-id="${esc(row.id)}" data-a="${esc(row.entityA.id)}" data-b="${esc(row.entityB.id)}">
        <div class="ctrad-row-head">
          <span class="ctrad-type">${esc(row.entityA.name)} ↔ ${esc(row.entityB.name)}</span>
          <span class="ctrad-severity sev-medium">${score}</span>
        </div>
        <div class="ctrad-reasoning">
          <code>${esc(row.entityA.type)}</code> ↔ <code>${esc(row.entityB.type)}</code>
          · ${sourceTag} · status: ${esc(row.status)} · seen ×${row.detectionCount}
        </div>
        ${renderSignalBars(signals)}
        <div class="cc-row-actions">
          <button class="ctrad-resolve-btn cc-reconcile-row" data-id="${esc(row.id)}">Reconcile this pair</button>
        </div>
      </div>
    `;
}

export async function refreshMergeCandidates() {
  try {
    const rows = await getMergeCandidatesViz();
    state.mergeCandidates = rows;
    const unresolved = filterUnresolved(rows);
    const badge = document.getElementById('mergeCandidatesBadge');
    if (badge) {
      badge.textContent = String(unresolved.length);
      badge.classList.toggle('zero', unresolved.length === 0);
    }
    const panel = document.getElementById('mergeCandidatesPanel');
    if (panel && panel.classList.contains('open')) renderPanel(rows);
    // Re-render canvas so merge edges pick up candidate_source styling.
    renderAll();
  } catch {
    // Best-effort — viz panels are non-blocking.
  }
}

function formatRunHeader(run) {
  if (!run) return '';
  const startedAt = run.startedAt ? new Date(run.startedAt) : null;
  const hh = startedAt ? String(startedAt.getHours()).padStart(2, '0') : '--';
  const mm = startedAt ? String(startedAt.getMinutes()).padStart(2, '0') : '--';
  let outcome;
  if (run.status === 'completed') {
    outcome = `completed (${run.candidatesInserted ?? 0} candidates, ${run.driftDrivenCandidates ?? 0} drift-driven)`;
  } else if (run.status === 'skipped') {
    outcome = `skipped (${esc(run.skippedReason || 'unknown')})`;
  } else if (run.status === 'error') {
    outcome = `error: ${esc(run.error || 'unknown')}`;
  } else {
    outcome = esc(run.status);
  }
  const duration = typeof run.durationMs === 'number' ? ` · ${run.durationMs}ms` : '';
  return `<div class="cc-last-run">Last cross-cluster run: ${hh}:${mm} — ${outcome}${duration}</div>`;
}

async function refreshLastRunHeader() {
  const headerHost = document.getElementById('mergeCandidatesLastRun');
  if (!headerHost) return;
  // Only show the cross-cluster generator's last run when the chip filter is
  // narrowed to that source. Otherwise the header is irrelevant for the
  // three-signal rows.
  if (state.mergeCandidatesSourceFilter !== 'cross_cluster_generator') {
    headerHost.innerHTML = '';
    return;
  }
  try {
    const body = await getCrossClusterRuns(1);
    const run = (body.runs || [])[0] || null;
    headerHost.innerHTML = formatRunHeader(run);
  } catch {
    headerHost.innerHTML = '';
  }
}

function renderSourceChips() {
  const host = document.getElementById('mergeCandidatesSourceFilter');
  if (!host) return;
  const active = state.mergeCandidatesSourceFilter || 'all';
  host.innerHTML = SOURCE_FILTERS.map(([key, label]) => `
    <button class="pf-chip ${active === key ? 'active' : ''}" data-source="${esc(key)}">${esc(label)}</button>
  `).join('');
  for (const chip of host.querySelectorAll('.pf-chip')) {
    chip.addEventListener('click', () => {
      state.mergeCandidatesSourceFilter = chip.getAttribute('data-source');
      renderPanel(state.mergeCandidates || []);
    });
  }
  // Toggle Generate-button visibility — only meaningful for cross-cluster.
  const genBtn = document.getElementById('btnCrossClusterGenerate');
  if (genBtn) genBtn.style.display = (active === 'cross_cluster_generator') ? '' : 'none';
}

function renderPanel(rows) {
  const list = document.getElementById('mergeCandidatesList');
  const meta = document.getElementById('mergeCandidatesMeta');
  if (!list || !meta) return;
  const sourceKey = state.mergeCandidatesSourceFilter || 'all';
  const filtered = filterBySource(filterUnresolved(rows), sourceKey);
  meta.textContent = `${filtered.length} candidate${filtered.length === 1 ? '' : 's'}`;
  renderSourceChips();
  // Fire and forget — header populates asynchronously.
  refreshLastRunHeader();
  if (filtered.length === 0) {
    const hint = sourceKey === 'cross_cluster_generator'
      ? 'No cross-cluster candidates yet. Click <b>Generate candidates</b> to run the Phase 4 generator.'
      : 'No unresolved merge candidates.';
    list.innerHTML = `<div class="ctrad-empty">${hint}</div>`;
    return;
  }
  list.innerHTML = filtered.map((r) => renderRow(r)).join('');

  for (const row of list.querySelectorAll('.cc-row')) {
    row.addEventListener('click', (e) => {
      // Don't focus when the user clicked the row's own reconcile button.
      if (e.target.closest('.cc-reconcile-row')) return;
      const aId = row.getAttribute('data-a');
      const bId = row.getAttribute('data-b');
      focusOnPair(aId, bId);
    });
  }
  for (const btn of list.querySelectorAll('.cc-reconcile-row')) {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-id');
      await doReconcileRow(btn, id);
    });
  }
}

async function doReconcileRow(btn, id) {
  const orig = btn.textContent;
  btn.textContent = 'Reconciling…';
  btn.disabled = true;
  try {
    const result = await reconcileCandidate(id);
    if (result?.triggered === false) {
      alert(result.message || 'Nothing to reconcile.');
    }
    await refreshMergeCandidates();
  } catch (err) {
    alert(`Reconcile failed: ${err.message}`);
  } finally {
    btn.textContent = orig;
    btn.disabled = false;
  }
}

function focusOnPair(aId, bId) {
  // Preserve cross-cluster panel UX: focus entity A; un-fade B if rendered.
  if (state.focusedEntityId === aId) toggleFocus(aId); // unfocus if same
  toggleFocus(aId);
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
    await refreshMergeCandidates();
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

export function bindMergeCandidatesPanel() {
  const open = document.getElementById('btnMergeCandidates');
  if (open) {
    open.addEventListener('click', async () => {
      const panel = document.getElementById('mergeCandidatesPanel');
      panel.classList.toggle('open');
      if (panel.classList.contains('open')) {
        const rows = await getMergeCandidatesViz();
        state.mergeCandidates = rows;
        renderPanel(rows);
      }
    });
  }
  const close = document.getElementById('mergeCandidatesClose');
  if (close) {
    close.addEventListener('click', () => {
      document.getElementById('mergeCandidatesPanel').classList.remove('open');
    });
  }
  const gen = document.getElementById('btnCrossClusterGenerate');
  if (gen) gen.addEventListener('click', doGenerate);
}
