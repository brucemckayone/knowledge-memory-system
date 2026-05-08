import { state } from '../state.js';

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
    const srcId = typeof e.source === 'object' ? e.source.id : e.source;
    const tgtId = typeof e.target === 'object' ? e.target.id : e.target;
    if (srcId === entityId) connected.add(tgtId);
    if (tgtId === entityId) connected.add(srcId);
  }

  g.selectAll('g.node').classed('faded', d => !connected.has(d.id));
  g.selectAll('line.edge').classed('faded', d => {
    const srcId = typeof d.source === 'object' ? d.source.id : d.source;
    const tgtId = typeof d.target === 'object' ? d.target.id : d.target;
    return !connected.has(srcId) || !connected.has(tgtId);
  });
  g.selectAll('text.edge-label').classed('faded', d => {
    const srcId = typeof d.source === 'object' ? d.source.id : d.source;
    const tgtId = typeof d.target === 'object' ? d.target.id : d.target;
    return !connected.has(srcId) || !connected.has(tgtId);
  });
}

export function bindFocusEscape() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.focusedEntityId) toggleFocus(state.focusedEntityId);
  });
}
