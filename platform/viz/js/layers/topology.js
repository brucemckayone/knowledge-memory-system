// Topology layer (viz.2) — surfaces mig 014 entity_topology + topology_bridges.
//
// Three concerns, one module:
//   1. Color mode resolution (type / component / community) — fed to entity
//      circles via render.js.
//   2. Per-entity overlays — articulation inner ring + centrality outer halo.
//   3. Bridge edges — the topology_bridges table rendered as a thicker dashed
//      line between the two entities they bridge.

import { state, COLOR_ENTITY } from '../state.js';
import { getTopology, computeTopology } from '../api.js';
import { renderAll } from '../canvas/render.js';

// Deterministic palette for component / community coloring. Component_id 0
// always lands on palette[0]; isolates (component_size === 1) override to grey.
const PALETTE = [
  '#4a90d9', '#27ae60', '#e67e22', '#9b59b6', '#1abc9c', '#e74c3c',
  '#f0883e', '#d29922', '#58a6ff', '#3fb950', '#bc8cff', '#ff7b72',
  '#79c0ff', '#56d364', '#d2a8ff', '#ffa657', '#a5d6ff', '#7ee787',
  '#ffab70', '#f97583', '#b392f0', '#85e89d', '#9ecbff', '#f1e05a',
];
const ISOLATE_GREY = '#3d4047';

function paletteFor(idx) {
  if (idx == null) return ISOLATE_GREY;
  return PALETTE[((idx % PALETTE.length) + PALETTE.length) % PALETTE.length];
}

export function resolveEntityColor(d) {
  const mode = state.colorMode;
  if (mode === 'type' || !state.topology.loaded) {
    return COLOR_ENTITY[d.entityType] || COLOR_ENTITY.other;
  }
  const t = state.topology.entities[d.id];
  if (!t) return ISOLATE_GREY;
  if (mode === 'component') {
    if (t.componentSize === 1) return ISOLATE_GREY;
    return paletteFor(t.componentId);
  }
  if (mode === 'community') {
    return paletteFor(t.communityId);
  }
  return COLOR_ENTITY[d.entityType] || COLOR_ENTITY.other;
}

export async function loadTopology() {
  try {
    const body = await getTopology();
    const map = {};
    for (const e of body.entities || []) map[e.id] = e;
    state.topology.entities = map;
    state.topology.bridges = body.bridges || [];
    state.topology.loaded = (body.entities || []).length > 0;
  } catch (err) {
    console.warn('[topology] load failed:', err);
  }
}

export async function recomputeTopology() {
  const btn = document.getElementById('btnTopology');
  const orig = btn ? btn.textContent : null;
  if (btn) {
    btn.textContent = 'Computing…';
    btn.disabled = true;
  }
  try {
    await computeTopology();
    await loadTopology();
    renderAll();
  } catch (err) {
    alert(`Topology compute failed: ${err.message}`);
  } finally {
    if (btn) {
      btn.textContent = orig;
      btn.disabled = false;
    }
  }
}

// Find max centrality for halo radius normalisation. Recomputed each render
// because new compute runs replace the rows.
function maxCentrality() {
  const metric = state.centralityMetric === 'betweenness' ? 'betweennessSampled' : 'pagerank';
  let max = 0;
  for (const t of Object.values(state.topology.entities)) {
    const v = t[metric];
    if (typeof v === 'number' && v > max) max = v;
  }
  return { metric, max };
}

export function renderTopologyOverlay() {
  const { groups, g } = state.refs;
  if (!groups) return;

  // Articulation rings + centrality halos sit inside each entity-node group.
  // We attach them on top of the existing circle so they pan/zoom together.
  // Always clear first so toggling colorMode/loaded state doesn't leak.
  g.selectAll('g.node circle.topology-articulation').remove();
  g.selectAll('g.node circle.topology-halo').remove();

  if (!state.topology.loaded) {
    // Bridges: clear if no topology data.
    if (groups.bridges) groups.bridges.selectAll('*').remove();
    return;
  }

  const { metric, max } = maxCentrality();

  g.selectAll('g.node').each(function(d) {
    if (!d || d._nodeType !== 'entity') return;
    const t = state.topology.entities[d.id];
    if (!t) return;

    const sel = d3.select(this);
    const baseR = parseFloat(sel.select('circle').attr('r')) || 6;

    // Outer halo — radius scales with centrality (0..1 of max → 0..12px extra).
    if (typeof t[metric] === 'number' && max > 0) {
      const norm = t[metric] / max;
      const haloR = baseR + 4 + norm * 12;
      sel.insert('circle', 'circle')
        .attr('class', 'topology-halo')
        .attr('r', haloR)
        .attr('fill', 'none')
        .attr('stroke', '#58a6ff')
        .attr('stroke-width', 0.8)
        .attr('stroke-opacity', 0.25 + norm * 0.35)
        .attr('pointer-events', 'none');
    }

    // Articulation inner white ring on top of the circle.
    if (t.isArticulationPoint) {
      sel.append('circle')
        .attr('class', 'topology-articulation')
        .attr('r', Math.max(baseR - 3, 1.5))
        .attr('fill', 'none')
        .attr('stroke', '#fff')
        .attr('stroke-width', 1.5)
        .attr('stroke-opacity', 0.85)
        .attr('pointer-events', 'none');
    }
  });

  // Bridge edges. We render them on the dedicated `bridges` group as their
  // own line set so they sit visually distinct from facts/causal/sameAs.
  if (!groups.bridges) return;
  // Build a node-id → simulation-node map so we can read live x/y coords.
  const nodeMap = {};
  for (const n of state.data.nodes) nodeMap[n.id] = n;
  const bridgeData = state.topology.bridges
    .map((b) => ({
      ...b,
      _src: nodeMap[b.sourceEntityId],
      _tgt: nodeMap[b.targetEntityId],
    }))
    .filter((b) => b._src && b._tgt);

  const sel = groups.bridges.selectAll('line.bridge').data(bridgeData, b => `${b.sourceEntityId}-${b.targetEntityId}`);
  sel.exit().remove();
  const enter = sel.enter().append('line')
    .attr('class', 'bridge')
    .attr('pointer-events', 'none');
  enter.merge(sel)
    .attr('stroke', '#f0883e')
    .attr('stroke-width', 3)
    .attr('stroke-opacity', 0.55)
    .attr('stroke-dasharray', '8,4')
    .attr('x1', b => b._src.x ?? 0)
    .attr('y1', b => b._src.y ?? 0)
    .attr('x2', b => b._tgt.x ?? 0)
    .attr('y2', b => b._tgt.y ?? 0);
}

export function bindColorModeDropdown() {
  const sel = document.getElementById('colorModeSelect');
  if (!sel) return;
  sel.addEventListener('change', () => {
    state.colorMode = sel.value;
    renderAll();
  });
}

export function bindCentralityToggle() {
  const sel = document.getElementById('centralitySelect');
  if (!sel) return;
  sel.addEventListener('change', () => {
    state.centralityMetric = sel.value;
    renderAll();
  });
}

export function bindTopologyButton() {
  const btn = document.getElementById('btnTopology');
  if (btn) btn.addEventListener('click', recomputeTopology);
}
