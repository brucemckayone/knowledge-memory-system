// Force-layout experimentation framework (epic nmemo-pd5). bindForcesPanel
// wires header toggles to state.forces and persists choices to localStorage.
// applyForces is the hook called from renderAll() after simulation.nodes(...)
// and before simulation.alpha(0.3).restart(); subsequent beads in the epic
// plug their force logic here, each guarded by the matching state.forces flag.

import { state } from '../state.js';
import { defaultLinkDistance, defaultLinkStrength, nodeRadius } from './simulation.js';

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
        // takes effect before alpha.restart triggers re-settle. alpha=1.0
        // (was 0.3) gives the layout enough energy to reorganise around
        // any new pin geometry in a single cooldown pass (bead nmemo-ywe).
        applyForces(sim);
        sim.alpha(1.0).restart();
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

  // Predicate-affinity pseudo-links (bead nmemo-pd5.6): merge the precomputed
  // cache into / strip it from the link force BEFORE the distance/strength
  // accessors are set, so the accessors below apply to the full link list.
  mergePredicateAffinityLinks(simulation, linkForce);

  // sameAs fusion (bead nmemo-pd5.2): collapse sameAs link distance from
  // 120→10 and ramp strength from 0.08→0.9 so unresolved-but-likely-identical
  // entity pairs visually fuse into a stacked pair, making merge candidates a
  // visible decision rather than an abstract list.
  // Predicate affinity (pd5.6): pseudo-links get a long, weak spring —
  // distance 200, strength 0.01*similarity — so shared-predicate entities feel
  // a gentle attraction without overpowering the real fact/causal topology.
  linkForce
    .distance(d => {
      if (d._edgeType === 'predicateAffinity') return PREDICATE_AFFINITY_DISTANCE;
      if (d._edgeType === 'sameAs' && state.forces.sameAsFusion) return 10;
      return defaultLinkDistance(d);
    })
    .strength(d => {
      if (d._edgeType === 'predicateAffinity') return PREDICATE_AFFINITY_STRENGTH_SCALE * (d.similarity ?? 0);
      if (d._edgeType === 'sameAs' && state.forces.sameAsFusion) return 0.9;
      return defaultLinkStrength(d);
    });

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

  // Centrality-radial pull (bead nmemo-pd5.5): high-centrality entities are
  // pulled toward the canvas centre, low-centrality entities to the periphery
  // — surfaces the visual spine of the graph. Strength returns 0 for
  // non-entity nodes and entities missing topology data, keeping the force
  // scoped without filtering the simulation's node list. The radius accessor
  // re-evaluates at force.initialize, so rebuilding the force on each
  // applyForces() picks up any metric switch automatically.
  simulation.force(
    'centralityRadial',
    (state.forces.centralityRadial && state.topology.loaded)
      ? buildCentralityRadialForce(simulation)
      : null,
  );

  // Causal-event radial decoration (bead nmemo-pd5.7): replace the force-driven
  // "porcupine" of causal events with geometric placement — each entity's
  // anchored events sit on an evenly-spaced ring around it. The force runs every
  // tick (so events follow their anchor as it drifts) and rebuilds membership on
  // every nodes() reset (i.e. every fetchData/renderAll) via its initialize.
  // When OFF, events are released (fx/fy cleared) so they rejoin the force layout.
  if (state.forces.causalRadial) {
    simulation.force('causalRadial', causalRadialForce);
  } else {
    simulation.force('causalRadial', null);
    for (const node of simulation.nodes()) {
      // Reset all radial state for causal events: release the pin and the
      // drag-handover flag (bead pd5.8) so a fresh ON toggle re-rings cleanly
      // rather than treating a previously-dragged event as still released.
      if (node._nodeType === 'causalEvent') {
        node.fx = null;
        node.fy = null;
        node._radialReleased = false;
      }
    }
  }

  // Articulation-point hard pin on a central ring (bead nmemo-ywe, evolving
  // smr's pin-at-current-position into a deliberate geometry): cut-vertex
  // entities get evenly-spaced positions on a circle around the simulation
  // center. Clusters then drape around the ring of bridges instead of the
  // bridges floating wherever the layout happened to settle. Non-entity
  // nodes are never touched. Non-articulation entities (and previously-
  // pinned-now-non-articulation) get fx/fy cleared.
  const articulationToRing = [];
  for (const node of simulation.nodes()) {
    if (node._nodeType !== 'entity') continue;
    if (isPinnedArticulationNode(node)) {
      articulationToRing.push(node);
    } else {
      // Clear covers (a) toggle just flipped OFF, (b) topology refresh
      // re-classified this entity as non-articulation, (c) prior re-pin
      // from a hand-drag should not survive the toggle going OFF.
      node.fx = null;
      node.fy = null;
    }
  }
  if (articulationToRing.length > 0) {
    // Stable id sort so re-toggling OFF/ON deterministically lands every
    // entity on the same angle — predictability matters for orientation.
    articulationToRing.sort((a, b) => a.id.localeCompare(b.id));
    const center = simulation.force('center');
    const cx = center ? center.x() : 0;
    const cy = center ? center.y() : 0;
    const svgNode = state.refs.svg && state.refs.svg.node();
    const viewportMin = svgNode ? Math.min(svgNode.clientWidth, svgNode.clientHeight) : 600;
    // Radius scales with N so each articulation slot gets a target arc
    // length (~60px) regardless of how many bridges the graph has (bead
    // nmemo-739). Clamp to viewport bounds so small N doesn't shrink the
    // ring absurdly and large N doesn't blow it past the visible area.
    const ARC_PER_NODE = 60;
    const idealRadius = articulationToRing.length * ARC_PER_NODE / (2 * Math.PI);
    const minRadius = viewportMin * 0.2;
    const maxRadius = viewportMin * 0.5;
    const radius = Math.max(minRadius, Math.min(maxRadius, idealRadius));
    const step = (2 * Math.PI) / articulationToRing.length;
    for (let i = 0; i < articulationToRing.length; i++) {
      articulationToRing[i].fx = cx + radius * Math.cos(i * step);
      articulationToRing[i].fy = cy + radius * Math.sin(i * step);
    }
  }
}

// Predicate shared with the drag handler in render.js so the four-condition
// hard-pin gate stays defined in one place. Returns true when the node is
// an entity that the articulationPins force currently considers pinned.
export function isPinnedArticulationNode(node) {
  return state.forces.articulationPins
    && state.topology.loaded
    && node._nodeType === 'entity'
    && !!state.topology.entities[node.id]?.isArticulationPoint;
}

// Sibling of isPinnedArticulationNode for the causal-radial force: true when a
// node is a causal event that causalRadialForce currently ring-pins. Shared
// with render.js's drag handler (bead pd5.8) so the "is this drag a ring-pin
// handover" gate stays defined in one place, exactly as the articulation gate.
export function isRingPinnedCausalEvent(node) {
  return state.forces.causalRadial && node._nodeType === 'causalEvent';
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

// --- Predicate affinity (bead nmemo-pd5.6) ---

// Jaccard threshold above which a pair of entities earns a pseudo-link.
const PREDICATE_AFFINITY_THRESHOLD = 0.3;
// Pseudo-links are long + weak so they nudge shared-predicate entities together
// without competing with the real fact/causal springs.
const PREDICATE_AFFINITY_DISTANCE = 200;
const PREDICATE_AFFINITY_STRENGTH_SCALE = 0.01; // strength = scale * similarity

// Precompute predicate-affinity pseudo-links from state.data and cache them on
// state.predicateAffinityLinks. Called once per fetchData() (NOT per tick) —
// the pairwise Jaccard is O(N²) over entities-that-are-fact-subjects. The
// signature of an entity is the SET of distinct predicates on fact edges where
// it is the subject (source); multiplicity is dropped because shared predicate
// *types* (works-at, located-in) are the semantic-grouping signal, not how
// many times each fires. Pairs scoring ≥ threshold become pseudo-links with
// string-id endpoints; applyForces() clones + node-filters them before handing
// them to d3.
export function computePredicateAffinityLinks() {
  const { nodes, edges } = state.data;
  const entityIds = new Set(
    nodes.filter(n => n._nodeType === 'entity').map(n => n.id),
  );
  // Endpoint id whether the edge is fresh (string) or d3-resolved (object).
  const epId = (v) => (v && typeof v === 'object') ? v.id : v;

  // entityId → Set<predicate>
  const signatures = new Map();
  for (const e of edges) {
    if (e._edgeType !== 'fact') continue;
    const subject = epId(e.source);
    if (!entityIds.has(subject)) continue;
    const predicate = e.predicate;
    if (!predicate) continue;
    let set = signatures.get(subject);
    if (!set) { set = new Set(); signatures.set(subject, set); }
    set.add(predicate);
  }

  const ids = [...signatures.keys()];
  const links = [];
  for (let i = 0; i < ids.length; i++) {
    const a = signatures.get(ids[i]);
    for (let j = i + 1; j < ids.length; j++) {
      const b = signatures.get(ids[j]);
      // |A ∩ B| via the smaller set, then Jaccard = inter / (|A|+|B|-inter).
      const [small, large] = a.size <= b.size ? [a, b] : [b, a];
      let inter = 0;
      for (const p of small) if (large.has(p)) inter++;
      const union = a.size + b.size - inter;
      const similarity = union > 0 ? inter / union : 0;
      if (similarity >= PREDICATE_AFFINITY_THRESHOLD) {
        links.push({
          id: `pa:${ids[i]}:${ids[j]}`,
          source: ids[i],
          target: ids[j],
          similarity,
          _edgeType: 'predicateAffinity',
        });
      }
    }
  }
  state.predicateAffinityLinks = links;
  return links;
}

// Idempotent merge of the cached pseudo-links into the live link force. Always
// strips any prior predicateAffinity links first (so repeated applyForces calls
// — e.g. a toggle flip that doesn't go through renderAll — don't double-add),
// then re-adds fresh CLONES when the flag is on. Cloning is mandatory: d3
// rewrites link.source/target from string ids to node objects on .links(), so
// handing the cache directly would corrupt it for the next merge. Pseudo-links
// referencing nodes absent from the current simulation are dropped — d3.forceLink
// throws "missing: <id>" otherwise.
function mergePredicateAffinityLinks(simulation, linkForce) {
  const current = linkForce.links();
  const hadPseudo = current.some(l => l._edgeType === 'predicateAffinity');
  // Feature off: only re-set (a full force re-init) if there are stale
  // pseudo-links to strip. The common default-OFF render stays free — render.js
  // already re-set .links(visibleEdges), which never contains pseudo-links.
  if (!state.forces.predicateAffinity) {
    if (hadPseudo) {
      linkForce.links(current.filter(l => l._edgeType !== 'predicateAffinity'));
    }
    return;
  }
  const kept = current.filter(l => l._edgeType !== 'predicateAffinity');
  const nodeIds = new Set(simulation.nodes().map(n => n.id));
  const pseudo = (state.predicateAffinityLinks || [])
    .filter(l => nodeIds.has(l.source) && nodeIds.has(l.target))
    .map(l => ({ ...l }));
  linkForce.links(kept.concat(pseudo));
}

// --- Causal-event radial decoration (bead nmemo-pd5.7) ---

// Per-tick force: hard-place each entity's anchored causal events on an
// evenly-spaced ring around the entity's CURRENT position, so the ring follows
// the anchor as it drifts. Geometric (fx/fy) rather than velocity-based — the
// porcupine this replaces came from letting the link force drag events around,
// so we pin instead of nudge. alpha is unused (placement is absolute, not
// energy-scaled). Membership + ring sizing come from initialize() below.
function causalRadialForce() {
  const groups = causalRadialForce.groups;
  if (!groups) return;
  for (const { entity, events } of groups) {
    const count = events.length;
    // radius grows with event count but caps so a busy entity's ring doesn't
    // balloon: base entity radius + 20px gap + up to 30px of fan-out.
    const radius = nodeRadius(entity) + 20 + Math.min(count * 2, 30);
    const step = (2 * Math.PI) / count;
    for (let i = 0; i < count; i++) {
      // Skip an event the user has dragged out of its ring slot (bead pd5.8):
      // leave its fx/fy at the dropped position. The slot is still counted, so
      // its siblings keep their angles instead of re-spacing mid-drag.
      if (events[i]._radialReleased) continue;
      const angle = step * i;
      events[i].fx = entity.x + radius * Math.cos(angle);
      events[i].fy = entity.y + radius * Math.sin(angle);
    }
  }
}

// d3 calls initialize(nodes) whenever the node set is (re)assigned — i.e. on
// every renderAll/fetchData — so membership recomputes when events appear or
// move between anchors. Anchor is the event node's own entityId (== the causal
// event's subjectEntityId, per src/index.ts), resolved against the live node
// set; events whose anchor entity isn't currently in the simulation are left
// force-driven. Events are id-sorted so angle assignment is stable across
// re-inits (a given event keeps its slot when membership is unchanged).
causalRadialForce.initialize = function (nodes) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const groups = new Map(); // anchorEntityId → { entity, events: [] }
  for (const n of nodes) {
    if (n._nodeType !== 'causalEvent' || n.entityId == null) continue;
    const entity = byId.get(n.entityId);
    if (!entity || entity._nodeType !== 'entity') {
      // Anchor entity is no longer in the simulation (filtered out, merged,
      // or deleted) but the event still is. Release any stale ring pin so the
      // event rejoins the force layout instead of freezing at its last
      // geometric position — mirrors the articulation force's release sweep.
      n.fx = null;
      n.fy = null;
      continue;
    }
    let g = groups.get(n.entityId);
    if (!g) { g = { entity, events: [] }; groups.set(n.entityId, g); }
    g.events.push(n);
  }
  for (const g of groups.values()) g.events.sort((a, b) => a.id.localeCompare(b.id));
  causalRadialForce.groups = [...groups.values()];
};

// Bead nmemo-pd5.5 specced strength 0.05 as the starting probe value;
// /verify measured ratio 0.987 (bottom-decile mean dist vs top-decile mean
// dist) at 0.05 across the live 311-entity graph — too weak to overcome
// charge (-400). Bumped to 0.3 to mirror the pd5.3 precedent
// (cluster-centroid pull walked through the same probe → bump cycle).
const CENTRALITY_RADIAL_STRENGTH = 0.3;

// maxRadius ~ min(canvasW, canvasH) / 2.5 (bead spec). 2.5 leaves margin so
// the periphery ring doesn't clip the viewport edge under typical zoom.
const CENTRALITY_RADIAL_DIVISOR = 2.5;

// Build a configured d3.forceRadial for centrality-radial pull. Returns a
// fresh force each time applyForces() is called so a centralityMetric switch
// (which triggers renderAll → applyForces) picks up the new metric's
// normalisation range without needing a separate re-init step.
function buildCentralityRadialForce(simulation) {
  const metric = state.centralityMetric === 'betweenness' ? 'betweennessSampled' : 'pagerank';
  // Min/max across the topology population for [0,1] normalisation. Only
  // numeric values count — entities created since the last topology compute
  // have no entry / no metric value and are excluded from the range AND from
  // the force (strength 0 below).
  let min = Infinity;
  let max = -Infinity;
  for (const t of Object.values(state.topology.entities)) {
    const v = t[metric];
    if (typeof v === 'number') {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  const range = max - min;
  const svgNode = state.refs.svg && state.refs.svg.node();
  const viewportMin = svgNode ? Math.min(svgNode.clientWidth, svgNode.clientHeight) : 600;
  const maxRadius = viewportMin / CENTRALITY_RADIAL_DIVISOR;
  const center = simulation.force('center');
  const cx = center ? center.x() : 0;
  const cy = center ? center.y() : 0;
  // Shared gate so radius + strength can never disagree about which nodes
  // participate — non-entity nodes and entities missing topology data are
  // excluded from both, neutralising the force for those nodes.
  const eligible = (d) => d._nodeType === 'entity'
    && typeof state.topology.entities[d.id]?.[metric] === 'number';
  const radiusFn = (d) => {
    if (!eligible(d)) return 0;
    // range === 0 means every entity has the same centrality (degenerate
    // topology, e.g. an empty graph) — park them at the midpoint rather
    // than div-by-zero.
    const norm = range > 0 ? (state.topology.entities[d.id][metric] - min) / range : 0.5;
    return (1 - norm) * maxRadius;
  };
  const strengthFn = (d) => eligible(d) ? CENTRALITY_RADIAL_STRENGTH : 0;
  return d3.forceRadial(radiusFn, cx, cy).strength(strengthFn);
}
