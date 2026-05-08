// Clusters layer (viz.3) — surfaces mig 015 entity_clusters (HDBSCAN).
//
// Color mode 'cluster' is resolved in topology.js's resolveEntityColor so
// the chooser stays single-source-of-truth. This module owns:
//   1. Loading entity_clusters into state on a 15s poll cadence.
//   2. The Re-cluster button (POST /api/clustering/compute).
//   3. Optional convex-hull overlay per cluster (off by default — only fires
//      when state.showClusterHulls is true and colorMode === 'cluster').
//   4. The "Hulls" checkbox binding.

import { state } from '../state.js';
import { getClusters, computeClustering } from '../api.js';
import { renderAll } from '../canvas/render.js';
import { paletteFor } from './palette.js';

export async function loadClusters() {
  try {
    const body = await getClusters();
    const map = {};
    for (const e of body.entities || []) map[e.id] = e;
    state.clusters.entities = map;
    state.clusters.summary = body.summary || {};
    state.clusters.noiseCount = body.noiseCount || 0;
    state.clusters.clusterCount = body.clusterCount || 0;
    state.clusters.loaded = (body.entities || []).length > 0;
  } catch (err) {
    console.warn('[clusters] load failed:', err);
  }
}

export async function recomputeClustering() {
  const btn = document.getElementById('btnCluster');
  const orig = btn ? btn.textContent : null;
  if (btn) {
    btn.textContent = 'Clustering…';
    btn.disabled = true;
  }
  try {
    await computeClustering();
    await loadClusters();
    renderAll();
  } catch (err) {
    alert(`Clustering failed: ${err.message}`);
  } finally {
    if (btn) {
      btn.textContent = orig;
      btn.disabled = false;
    }
  }
}

// Convex-hull overlay. d3 v7 ships d3.polygonHull which expects [[x,y], ...]
// and returns a vertex list (or null if <3 points). We render one path per
// cluster_id (excluding noise) onto the canvas group `clusterHulls`.
export function renderClusterHulls() {
  const { groups, g } = state.refs;
  if (!groups || !groups.clusterHulls) return;
  const layer = groups.clusterHulls;

  if (!state.showClusterHulls || state.colorMode !== 'cluster' || !state.clusters.loaded) {
    layer.selectAll('*').remove();
    return;
  }

  // Group entity nodes by cluster_id, skipping noise and unassigned entities.
  const byCluster = {};
  for (const n of state.data.nodes) {
    if (n._nodeType !== 'entity') continue;
    if (n.x == null || n.y == null) continue;
    const c = state.clusters.entities[n.id];
    if (!c || c.clusterId === -1) continue;
    if (!byCluster[c.clusterId]) byCluster[c.clusterId] = [];
    byCluster[c.clusterId].push([n.x, n.y]);
  }

  const data = Object.entries(byCluster)
    .map(([cid, points]) => {
      const id = Number(cid);
      const hull = points.length >= 3 ? d3.polygonHull(points) : null;
      return { id, points, hull };
    })
    .filter((c) => c.hull && c.hull.length > 0);

  const sel = layer.selectAll('path.cluster-hull').data(data, (d) => d.id);
  sel.exit().remove();
  const enter = sel.enter().append('path')
    .attr('class', 'cluster-hull')
    .attr('pointer-events', 'none');
  enter.merge(sel)
    .attr('fill', (d) => paletteFor(d.id))
    .attr('fill-opacity', 0.06)
    .attr('stroke', (d) => paletteFor(d.id))
    .attr('stroke-width', 1)
    .attr('stroke-opacity', 0.4)
    .attr('d', (d) => `M${d.hull.map((p) => p.join(',')).join('L')}Z`);
}

export function bindClusterButton() {
  const btn = document.getElementById('btnCluster');
  if (btn) btn.addEventListener('click', recomputeClustering);
}

export function bindHullsToggle() {
  const cb = document.getElementById('clusterHullsToggle');
  if (!cb) return;
  cb.addEventListener('change', () => {
    state.showClusterHulls = cb.checked;
    renderAll();
  });
}
