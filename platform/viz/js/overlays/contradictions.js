// Canvas overlay (viz.1) — annotates fact edges and causal edges that appear
// in any unresolved contradiction with a red dashed underlay. The
// contradictions panel itself remains the primary surface; this overlay is a
// glance indicator that something on screen is flagged.
//
// Polymorphic refs (mig 011): contradictions reference fact_a/b, edge_a/b, or
// entity_id. We currently visualize the first three; entity-only contradictions
// (rare per the migration comment) light up the entity's stroke instead.

import { state } from '../state.js';

const SEVERITY_COLOR = {
  critical: '#f85149',
  high: '#f85149',
  medium: '#f0883e',
  low: '#8b949e',
};

export function renderContradictionsOverlay() {
  const { groups, g } = state.refs;
  if (!groups || !groups.contradictionOverlay) return;
  const overlay = groups.contradictionOverlay;

  if (!state.layers.contradictions || state.contradictions.length === 0) {
    overlay.selectAll('*').remove();
    // Reset entity contradiction stroke
    g.selectAll('g.node circle.contradiction-ring').remove();
    return;
  }

  // Build sets of flagged fact/edge/entity IDs.
  const flaggedFacts = new Map();
  const flaggedEdges = new Map();
  const flaggedEntities = new Map();
  for (const c of state.contradictions) {
    if (c.resolvedAt) continue;
    const sev = c.severity || 'medium';
    for (const id of [c.factAId, c.factBId]) {
      if (id) flaggedFacts.set(id, sev);
    }
    for (const id of [c.edgeAId, c.edgeBId]) {
      if (id) flaggedEdges.set(id, sev);
    }
    if (c.entityId) flaggedEntities.set(c.entityId, sev);
  }

  // Underlay: a thicker red dashed stripe under any flagged fact/causal edge.
  const flaggedEdgeData = state.data.edges.filter(e => {
    if (e._edgeType === 'fact') return flaggedFacts.has(e.id);
    if (e._edgeType === 'causal') return flaggedEdges.has(e.id);
    return false;
  });

  const sel = overlay.selectAll('line.contradiction-underlay').data(flaggedEdgeData, d => d.id);
  sel.exit().remove();
  const enter = sel.enter().append('line')
    .attr('class', 'contradiction-underlay')
    .attr('pointer-events', 'none');
  enter.merge(sel)
    .attr('stroke', d => {
      const sev = d._edgeType === 'fact' ? flaggedFacts.get(d.id) : flaggedEdges.get(d.id);
      return SEVERITY_COLOR[sev] || SEVERITY_COLOR.medium;
    })
    .attr('stroke-width', 6)
    .attr('stroke-opacity', 0.35)
    .attr('stroke-dasharray', '4,3')
    .attr('x1', d => d.source.x ?? 0)
    .attr('y1', d => d.source.y ?? 0)
    .attr('x2', d => d.target.x ?? 0)
    .attr('y2', d => d.target.y ?? 0);

  // Apply outer ring to flagged entity nodes.
  g.selectAll('g.node circle.contradiction-ring').remove();
  if (flaggedEntities.size > 0) {
    g.selectAll('g.node').each(function(d) {
      if (!d || !flaggedEntities.has(d.id)) return;
      const sev = flaggedEntities.get(d.id);
      const baseR = parseFloat(d3.select(this).select('circle').attr('r')) || 6;
      d3.select(this).append('circle')
        .attr('class', 'contradiction-ring')
        .attr('r', baseR + 4)
        .attr('fill', 'none')
        .attr('stroke', SEVERITY_COLOR[sev] || SEVERITY_COLOR.medium)
        .attr('stroke-width', 1.5)
        .attr('stroke-dasharray', '3,2')
        .attr('pointer-events', 'none');
    });
  }
}
