// Force-layout experimentation framework (epic nmemo-pd5). bindForcesPanel
// wires header toggles to state.forces and persists choices to localStorage.
// applyForces is the hook called from renderAll() after simulation.nodes(...)
// and before simulation.alpha(0.3).restart(); subsequent beads in the epic
// plug their force logic here, each guarded by the matching state.forces flag.

import { state } from '../state.js';

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
// state.forces and either modifies the simulation or leaves it untouched.
//
// Link distance/strength defaults below mirror simulation.js — they have to
// be respecified in full whenever this overrides one branch (sameAs), since
// d3's link force replaces the accessor wholesale, not per-key.
export function applyForces(simulation) {
  const linkForce = simulation.force('link');
  if (!linkForce) return;

  // sameAs fusion (bead nmemo-pd5.2): collapse sameAs link distance from
  // 120→10 and ramp strength from 0.08→0.9 so unresolved-but-likely-identical
  // entity pairs visually fuse into a stacked pair, making merge candidates a
  // visible decision rather than an abstract list. All other edge branches
  // keep simulation.js's defaults.
  linkForce
    .distance(d => {
      if (d._edgeType === 'sameAs' && state.forces.sameAsFusion) return 10;
      if (d._edgeType === 'causalAnchor') return 80;
      if (d._edgeType === 'causal') return 60;
      if (d._edgeType === 'sourceLink') return 140;
      if (d._edgeType === 'mergeCandidate') return 100;
      if (d._edgeType === 'sameAs') return 120;
      return 140;
    })
    .strength(d => {
      if (d._edgeType === 'sameAs' && state.forces.sameAsFusion) return 0.9;
      if (d._edgeType === 'sourceLink') return 0.03;
      if (d._edgeType === 'causalAnchor') return 0.15;
      if (d._edgeType === 'causal') return 0.2;
      if (d._edgeType === 'mergeCandidate') return 0.05;
      if (d._edgeType === 'sameAs') return 0.08;
      return 0.2;
    });
}
