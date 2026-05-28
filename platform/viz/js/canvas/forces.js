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
      if (sim) sim.alpha(0.3).restart();
    });

    wrap.appendChild(input);
    wrap.appendChild(document.createTextNode(' ' + label));
    container.appendChild(wrap);
  }
}

// Hook called from renderAll() after simulation.nodes(...) and before
// simulation.alpha(0.3).restart(). Subsequent beads in the epic extend this
// with their per-force logic, each guarded by state.forces.X. No-op for
// scaffolding (bead nmemo-pd5.1).
export function applyForces(_simulation) {
}
