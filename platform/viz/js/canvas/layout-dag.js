import { state } from '../state.js';

export function applyDagLayout(nodes, edges) {
  const svg = state.refs.svg;
  const simulation = state.refs.simulation;
  const width = svg.node().clientWidth;
  const height = svg.node().clientHeight;
  const margin = { top: 40, right: 40, bottom: 40, left: 200 };

  const entityNodes = nodes.filter(n => n._nodeType === 'entity');
  const eventNodes = nodes.filter(n => n._nodeType === 'causalEvent');
  const otherNodes = nodes.filter(n => n._nodeType !== 'entity' && n._nodeType !== 'causalEvent');

  entityNodes.forEach((n, i) => {
    n.fx = margin.left / 2;
    n.fy = margin.top + (i / Math.max(entityNodes.length - 1, 1)) * (height - margin.top - margin.bottom);
  });

  if (eventNodes.length > 0 && state.timeRange.min && state.timeRange.max) {
    const tMin = state.timeRange.min;
    const tMax = state.timeRange.max;
    const tRange = tMax - tMin || 1;

    const entityGroups = {};
    for (const n of eventNodes) {
      const eid = n.entityId || '_none';
      if (!entityGroups[eid]) entityGroups[eid] = [];
      entityGroups[eid].push(n);
    }
    const groupKeys = Object.keys(entityGroups);

    eventNodes.forEach(n => {
      const t = n.occurredAt ? new Date(n.occurredAt).getTime() : tMin;
      const yFrac = (t - tMin) / tRange;
      n.fy = margin.top + yFrac * (height - margin.top - margin.bottom);

      const groupIdx = groupKeys.indexOf(n.entityId || '_none');
      const xFrac = (groupIdx + 1) / (groupKeys.length + 1);
      n.fx = margin.left + xFrac * (width - margin.left - margin.right);
    });
  }

  otherNodes.forEach(n => { n.fx = undefined; n.fy = undefined; });

  simulation.nodes(nodes);
  simulation.force('link').links(edges);
  simulation.force('charge').strength(-20);
  simulation.force('center', null);
  simulation.alpha(0.5).restart();
}
