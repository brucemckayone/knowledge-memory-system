// Entry — wires modules together. Loaded as <script type="module">. The
// previous monolithic app.js has been split into the canvas/, layers/,
// overlays/, panels/, and agents/ subtrees plus state/api/poll/util.

import { state } from './state.js';
import { getUnified } from './api.js';
import { register, startAll, stopAll } from './poll.js';
import { initSvg } from './canvas/simulation.js';
import { renderAll } from './canvas/render.js';
import { recomputeTimeRange, bindScrubber } from './canvas/scrubber.js';
import { bindLayerToggles } from './canvas/visibility.js';
import { bindFocusEscape, toggleFocus } from './canvas/focus.js';
import { unpinTooltip, updatePinnedTooltipPosition } from './canvas/tooltip.js';
import { bindDetailClose } from './panels/detail.js';
import { refreshStats } from './panels/stats.js';
import { bindIngestPanel } from './panels/ingest.js';
import { bindQueryPanel } from './panels/query.js';
import { bindContradictionsPanel, refreshContradictions } from './panels/contradictions.js';
import { bindPatternsPanel, refreshPatterns } from './panels/patterns.js';
import { bindGarden } from './agents/garden.js';
import { bindReconcile } from './agents/reconcile.js';
import { bindReason } from './agents/reason.js';
import { bindDecay } from './agents/decay.js';
import { bindReset } from './agents/reset.js';
import { loadTopology, bindColorModeDropdown, bindCentralityToggle, bindTopologyButton } from './layers/topology.js';
import { loadClusters, bindClusterButton, bindHullsToggle } from './layers/clusters.js';
import { bindMergeCandidatesPanel, refreshMergeCandidates } from './panels/merge-candidates.js';
import { bindDriftStrip, refreshDrift } from './panels/drift.js';
import { bindReasoningReportsPanel, refreshReasoningReports } from './panels/reasoning-reports.js';
import { bindForcesPanel } from './canvas/forces.js';

export async function fetchData() {
  try {
    const unified = await getUnified();

    // Preserve simulation positions across refresh.
    const posMap = {};
    for (const n of state.data.nodes) {
      if (n.x != null) posMap[n.id] = { x: n.x, y: n.y, vx: n.vx, vy: n.vy };
    }
    for (const n of unified.nodes) {
      if (posMap[n.id]) Object.assign(n, posMap[n.id]);
    }

    state.data = unified;
    recomputeTimeRange();
    renderAll();
  } catch (err) {
    console.error('Fetch failed:', err);
  }
}

function bindAutoRefresh() {
  const checkbox = document.getElementById('autoRefresh');
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) startAll();
    else stopAll();
  });
}

function bindLayoutToggle() {
  document.querySelectorAll('.layout-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.layout-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.layoutMode = btn.dataset.layout;
      initSvg(updatePinnedTooltipPosition);
      renderAll();
    });
  });
}

function bindBackgroundClick() {
  document.getElementById('graph').addEventListener('click', (e) => {
    if (e.target.tagName === 'svg') {
      if (state.focusedEntityId) toggleFocus(state.focusedEntityId);
      unpinTooltip();
    }
  });
}

function bindResize() {
  window.addEventListener('resize', () => {
    const sim = state.refs.simulation;
    const svg = state.refs.svg;
    if (!sim || !svg) return;
    const width = svg.node().clientWidth;
    const height = svg.node().clientHeight;
    sim.force('center', d3.forceCenter(width / 2, height / 2));
    sim.alpha(0.1).restart();
  });
}

// ---- Init ----
initSvg(updatePinnedTooltipPosition);
bindLayerToggles();
bindFocusEscape();
bindDetailClose();
bindScrubber();
bindLayoutToggle();
bindBackgroundClick();
bindAutoRefresh();
bindResize();
bindIngestPanel();
bindQueryPanel();
bindContradictionsPanel();
bindPatternsPanel();
bindGarden();
bindReconcile();
bindReason();
bindDecay();
bindReset();
bindColorModeDropdown();
bindCentralityToggle();
bindTopologyButton();
bindClusterButton();
bindHullsToggle();
bindMergeCandidatesPanel();
bindDriftStrip();
bindReasoningReportsPanel();
bindForcesPanel();

// Polling registry — runs every poller once on start, then on its interval.
register('graph', async () => {
  await fetchData();
  await refreshStats();
}, 5000);
register('contradictions', refreshContradictions, 5000);
register('patterns', refreshPatterns, 5000);
// Topology refreshes on a slower cadence — its compute is opt-in via the
// Topology button or the backend's auto-trigger after gardener / clustering.
register('topology', loadTopology, 15000);
register('clusters', loadClusters, 15000);
register('mergeCandidates', refreshMergeCandidates, 15000);
register('drift', refreshDrift, 15000);
register('reasoningReports', refreshReasoningReports, 15000);

if (document.getElementById('autoRefresh').checked) startAll();
else {
  // Still fire each registered poller once on startup so the UI is populated
  // even when auto-refresh is off.
  fetchData();
  refreshStats();
  refreshContradictions();
  refreshPatterns();
  loadTopology();
  loadClusters();
  refreshMergeCandidates();
  refreshDrift();
  refreshReasoningReports();
}
