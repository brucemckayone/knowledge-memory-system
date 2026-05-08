// Ghost markers (viz.5) — surfaces /api/ghosts/:entityId.
//
// A "ghost" is a pattern slot the entity should fill but doesn't yet (e.g.
// a canonical pattern declares "concept causes outcome" and an entity sits
// in the cause role with no matching effect on file). Ghosts are abstract
// templates — they have no concrete target entity to draw an edge to. So
// the overlay marks the *entity* with a small ghost ring + count badge,
// and the detail panel surfaces the per-ghost expectations + reasoning.

import { state } from '../state.js';
import { getGhosts } from '../api.js';

// Lazy-fetch ghosts for an entity, cache in state, and re-render the canvas
// overlay so the badge appears.
export async function loadGhostsForEntity(entityId, onLoaded) {
  if (state.ghostsByEntity[entityId] !== undefined) {
    if (onLoaded) onLoaded(state.ghostsByEntity[entityId]);
    return state.ghostsByEntity[entityId];
  }
  try {
    const body = await getGhosts(entityId);
    const ghosts = body.ghosts || [];
    state.ghostsByEntity[entityId] = ghosts;
    if (onLoaded) onLoaded(ghosts);
    renderGhostMarkers();
    return ghosts;
  } catch (err) {
    console.warn('[ghosts] load failed:', err);
    state.ghostsByEntity[entityId] = [];
    return [];
  }
}

export function renderGhostMarkers() {
  const { g } = state.refs;
  if (!g) return;
  // Clear previous markers.
  g.selectAll('g.node circle.ghost-ring').remove();
  g.selectAll('g.node text.ghost-badge').remove();

  g.selectAll('g.node').each(function(d) {
    if (!d || d._nodeType !== 'entity') return;
    const ghosts = state.ghostsByEntity[d.id];
    if (!Array.isArray(ghosts) || ghosts.length === 0) return;
    const baseR = parseFloat(d3.select(this).select('circle').attr('r')) || 6;
    const sel = d3.select(this);
    sel.append('circle')
      .attr('class', 'ghost-ring')
      .attr('r', baseR + 7)
      .attr('fill', 'none')
      .attr('stroke', '#bc8cff')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '2,3')
      .attr('stroke-opacity', 0.7)
      .attr('pointer-events', 'none');
    sel.append('text')
      .attr('class', 'ghost-badge')
      .attr('x', baseR + 6)
      .attr('y', -baseR - 4)
      .attr('font-size', '9px')
      .attr('fill', '#bc8cff')
      .attr('font-weight', '700')
      .attr('pointer-events', 'none')
      .text(`👻${ghosts.length}`);
  });
}
