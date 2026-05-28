// Force-layout experimentation framework (epic nmemo-pd5). bindForcesPanel
// wires header toggles to state.forces and persists choices to localStorage.
// applyForces is the hook called from renderAll() after simulation.nodes(...)
// and before simulation.alpha(0.3).restart(); subsequent beads in the epic
// plug their force logic here, each guarded by the matching state.forces flag.

import { state } from '../state.js';
import { defaultLinkDistance, defaultLinkStrength } from './simulation.js';

const STORAGE_KEY = 'mnemo.viz.forces';

// Human-readable label per flag. Source of truth for which forces appear in
// the header — adding a new force in a future bead means a new entry here
// and a matching default in state.js.
const FORCE_LABELS = {
  sameAsFusion: 'sameAs fuse',
  clusterCentroid: 'cluster pull',
  articulationPins: 'articulation pin',
  centralityRadial: 'centrality radial',
  predicateAffinity: 'predicate affinity',
  causalRadial: 'causal radial',
};

function loadForcesFromStorage() {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (err) {
    console.warn('forces: localStorage read failed', err);
    return;
  }
  if (!raw) return;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn('forces: localStorage parse failed', err);
    return;
  }
  // JSON.parse('null') returns null; reject anything that isn't a plain
  // object so the property-read loop below can't throw on null indexing.
  if (!parsed || typeof parsed !== 'object') return;
  // Forward-compat: missing keys fall back to state.forces defaults set in
  // state.js. Only assign if the stored value is a boolean (defends against
  // schema drift / hand-edited localStorage).
  for (const key of Object.keys(state.forces)) {
    if (typeof parsed[key] === 'boolean') state.forces[key] = parsed[key];
  }
}

function saveForcesToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.forces));
  } catch (err) {
    console.warn('forces: localStorage write failed', err);
  }
}

export function bindForcesPanel() {
  loadForcesFromStorage();

  const container = document.querySelector('.forces');
  if (!container) {
    console.warn('forces: .forces container missing in index.html');
    return;
  }

  for (const [key, label] of Object.entries(FORCE_LABELS)) {
    const wrap = document.createElement('label');
    wrap.className = 'force-toggle' + (state.forces[key] ? ' active' : '');
    wrap.dataset.force = key;

    const input = document.createElement('input');
    input.type = 'checkbox';
    // autocomplete=off + matching `checked` attribute together stop the
    // browser's form-state restoration from clobbering the script-set value
    // after a hard reload — without this, the visible checkboxes can drift
    // from state.forces (and from localStorage) on every navigation.
    input.setAttribute('autocomplete', 'off');
    input.checked = state.forces[key];
    if (state.forces[key]) input.setAttribute('checked', '');
    input.addEventListener('change', () => {
      state.forces[key] = input.checked;
      wrap.classList.toggle('active', input.checked);
      saveForcesToStorage();
      const sim = state.refs.simulation;
      if (sim) {
        // d3 evaluates link distance/strength accessors only when set via
        // .distance(fn) or .links(); re-call applyForces so the new flag
        // takes effect before alpha.restart triggers re-settle.
        applyForces(sim);
        sim.alpha(0.3).restart();
      }
    });

    wrap.appendChild(input);
    wrap.appendChild(document.createTextNode(' ' + label));
    container.appendChild(wrap);
  }
}

// Hook called from renderAll() after simulation.nodes(...) and before
// simulation.alpha(0.3).restart(). Each force module reads its flag from
// state.forces and composes its override against defaultLinkDistance /
// defaultLinkStrength from simulation.js — the canonical accessor tables
// live there and are imported here, so adding a new force only adds one
// ternary, not a full restatement.
export function applyForces(simulation) {
  const linkForce = simulation.force('link');
  if (!linkForce) return;

  // sameAs fusion (bead nmemo-pd5.2): collapse sameAs link distance from
  // 120→10 and ramp strength from 0.08→0.9 so unresolved-but-likely-identical
  // entity pairs visually fuse into a stacked pair, making merge candidates a
  // visible decision rather than an abstract list.
  linkForce
    .distance(d => (d._edgeType === 'sameAs' && state.forces.sameAsFusion) ? 10 : defaultLinkDistance(d))
    .strength(d => (d._edgeType === 'sameAs' && state.forces.sameAsFusion) ? 0.9 : defaultLinkStrength(d));

  // Cluster-centroid pull (bead nmemo-pd5.3): when on, each entity that has
  // a clusterId in state.clusters.entities gets pulled toward its cluster's
  // running centroid. Single-pass-per-tick caching: build centroid map once,
  // then apply velocity nudges — avoids the O(N²) trap of computing centroid
  // inside a per-node accessor. Noise (clusterId === -1) and unclustered
  // nodes (no entry / null) are skipped.
  simulation.force(
    'clusterCentroid',
    state.forces.clusterCentroid ? clusterCentroidForce : null,
  );
}

// Pull strength applied via velocity each tick. Bead nmemo-pd5.3 specified
// 0.05 as the initial probe value but tagged it tweakable; /verify
// measured a 1.2% intra-cluster shrinkage at that strength — directionally
// correct but overwhelmed by charge (-400) and the dense fact/causal link
// graph. 0.3 gives visible blobs while still leaving room for the other
// forces to organise within each cluster.
const CLUSTER_PULL = 0.3;

// Custom d3 force: one pass to accumulate centroids, second pass to apply
// the velocity nudge. d3 calls force(alpha) once per tick; alpha decays as
// the simulation cools so the nudge naturally softens over time.
function clusterCentroidForce(alpha) {
  const nodes = clusterCentroidForce.nodes;
  if (!nodes) return;
  const clusterOf = (id) => state.clusters.entities[id]?.clusterId;

  // Pass 1: accumulate sum(x), sum(y), count per cluster.
  const sums = {};
  for (const n of nodes) {
    const cid = clusterOf(n.id);
    if (cid == null || cid === -1) continue;
    let bucket = sums[cid];
    if (!bucket) { bucket = { sx: 0, sy: 0, count: 0 }; sums[cid] = bucket; }
    bucket.sx += n.x;
    bucket.sy += n.y;
    bucket.count += 1;
  }

  // Pass 2: nudge each clustered node toward its centroid. Single-member
  // clusters are skipped — a node would just pull toward itself.
  const k = CLUSTER_PULL * alpha;
  for (const n of nodes) {
    const cid = clusterOf(n.id);
    if (cid == null || cid === -1) continue;
    const bucket = sums[cid];
    if (!bucket || bucket.count < 2) continue;
    const cx = bucket.sx / bucket.count;
    const cy = bucket.sy / bucket.count;
    n.vx += (cx - n.x) * k;
    n.vy += (cy - n.y) * k;
  }
}

// d3 calls initialize(nodes) when the force is added to / linked with the
// simulation — capture the live node list so force(alpha) can iterate.
clusterCentroidForce.initialize = function (nodes) {
  clusterCentroidForce.nodes = nodes;
};
