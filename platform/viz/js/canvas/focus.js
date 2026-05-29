import { state } from '../state.js';
import { edgeEndpoint } from './edge-utils.js';

export function toggleFocus(entityId) {
  const { svg, g } = state.refs;
  if (state.focusedEntityId === entityId) {
    state.focusedEntityId = null;
    svg.classed('focused', false);
    g.selectAll('.faded').classed('faded', false);
    return;
  }

  state.focusedEntityId = entityId;
  svg.classed('focused', true);

  const connected = new Set([entityId]);
  for (const e of state.data.edges) {
    const srcId = edgeEndpoint(e.source);
    const tgtId = edgeEndpoint(e.target);
    if (srcId === entityId) connected.add(tgtId);
    if (tgtId === entityId) connected.add(srcId);
  }

  g.selectAll('g.node').classed('faded', d => !connected.has(d.id));
  g.selectAll('line.edge').classed('faded', d => {
    const srcId = edgeEndpoint(d.source);
    const tgtId = edgeEndpoint(d.target);
    return !connected.has(srcId) || !connected.has(tgtId);
  });
  g.selectAll('text.edge-label').classed('faded', d => {
    const srcId = edgeEndpoint(d.source);
    const tgtId = edgeEndpoint(d.target);
    return !connected.has(srcId) || !connected.has(tgtId);
  });
}

export function bindFocusEscape() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.focusedEntityId) toggleFocus(state.focusedEntityId);
  });
}
