// Entry — wires modules together. Loaded as <script type="module">. The
// previous monolithic app.js has been split into the canvas/, layers/,
// overlays/, panels/, and agents/ subtrees plus state/api/poll/util.

import { state } from './state.js';
import { getUnified, getStaging, getCorpora } from './api.js';
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
import { bindForcesPanel, computePredicateAffinityLinks } from './canvas/forces.js';
import { resizeCanvas, getDrawCounts } from './canvas/canvas.js';

export async function fetchData() {
  try {
    const unified = await getUnified(state.corpus, state.limit);

    // Staging overlay: merge the current epoch's proposed (pre-promote) nodes
    // and edges in, flagged `_staged`. Best-effort — a staging fetch failure
    // must not break the canonical view.
    if (state.showStaging) {
      try {
        const staging = await getStaging();
        unified.nodes = unified.nodes.concat(staging.nodes);
        unified.edges = unified.edges.concat(staging.edges);
        state.stagingMeta = staging.meta;
      } catch (err) {
        console.warn('[staging] fetch failed:', err);
        state.stagingMeta = null;
      }
    } else {
      state.stagingMeta = null;
    }
    updateStagingLabel();

    // Preserve simulation positions across refresh.
    const posMap = {};
    for (const n of state.data.nodes) {
      if (n.x != null) posMap[n.id] = { x: n.x, y: n.y, vx: n.vx, vy: n.vy };
    }
    for (const n of unified.nodes) {
      if (posMap[n.id]) Object.assign(n, posMap[n.id]);
    }

    state.data = unified;
    // Precompute predicate-affinity pseudo-links once per fetch (bead
    // nmemo-pd5.6) — the O(N²) Jaccard pass is too expensive per tick, so the
    // result is cached on state and merged into the link force by applyForces.
    computePredicateAffinityLinks();
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

function updateStagingLabel() {
  const label = document.getElementById('stagingToggleLabel');
  if (!label) return;
  const span = label.querySelector('.staging-text');
  if (!span) return;
  const m = state.stagingMeta;
  span.textContent = state.showStaging && m
    ? `Staging ${m.renderedNodes}◍ (${m.proposedEntities}e/${m.proposedFacts}f, ${m.chunksSeen} chunks${m.capped ? ', capped' : ''})`
    : 'Staging';
}

function bindStagingToggle() {
  const checkbox = document.getElementById('stagingToggle');
  if (!checkbox) return;
  checkbox.addEventListener('change', () => {
    state.showStaging = checkbox.checked;
    fetchData(); // immediate refresh so the overlay appears/clears at once
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
    resizeCanvas();
    sim.alpha(0.1).restart();
  });
}

// ---- Init ----
// Deep-link / benchmark support: honor ?corpus= and ?limit= from the URL so a
// fixed workload is reproducible (viz-perf goal). Read before the corpus picker
// so its default doesn't override an explicit choice.
{
  const params = new URLSearchParams(window.location.search);
  const urlCorpus = params.get('corpus');
  const urlLimit = params.get('limit');
  if (urlCorpus) state.corpus = urlCorpus;
  if (urlLimit && /^\d+$/.test(urlLimit)) state.limit = parseInt(urlLimit, 10);
}

// Introspection handle for the perf benchmark (read-only use). Exposes the
// live state + a couple of controls so the Playwright harness can hold the
// simulation hot, halt pollers, and count drawn elements per group against the
// API payload (invariant check). No effect on normal rendering.
window.__mnemo = { state, fetchData, renderAll, startAll, stopAll, getDrawCounts };

initSvg(updatePinnedTooltipPosition);
bindLayerToggles();
bindFocusEscape();
bindDetailClose();
bindScrubber();
bindLayoutToggle();
bindBackgroundClick();
bindAutoRefresh();
bindStagingToggle();
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

// Scope to a corpus BEFORE the first fetch, so the initial render is one coherent
// corpus rather than an arbitrary blend of every experiment in the database.
await initCorpusPicker(async () => {
  await fetchData();
  await refreshStats();
});

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


// ---- Corpus picker -------------------------------------------------------
// The graph DB holds several corpora at once (papers, the C++ experiment, old test
// fixtures). Viewing them blended is meaningless, so the viz scopes to one corpus and
// defaults to the largest.
export async function initCorpusPicker(onChange) {
  const sel = document.getElementById('corpusSelect');
  if (!sel) return;
  try {
    const { corpora } = await getCorpora();
    sel.innerHTML = '';
    for (const row of corpora) {
      const opt = document.createElement('option');
      opt.value = row.corpus_id;
      opt.textContent = `${row.corpus_id} (${row.entities} nodes, ${row.edges} edges)`;
      sel.appendChild(opt);
    }
    if (corpora.length > 0 && !state.corpus) state.corpus = corpora[0].corpus_id;
    sel.value = state.corpus ?? '';
    sel.addEventListener('change', async () => {
      state.corpus = sel.value || null;
      if (typeof onChange === 'function') await onChange();
    });
  } catch (err) {
    console.warn('[corpus] picker init failed:', err);
  }
}
