import { state } from '../state.js';

export function chargeStrength(d) {
  if (d._nodeType === 'entity') return -400;
  if (d._nodeType === 'sourceMemory') return -30;
  if (d._nodeType === 'causalEvent') return -60;
  return -80;
}

export function nodeRadius(d) {
  if (d._nodeType === 'entity') return 6 + Math.min((d.mentionCount || 1), 15) * 1;
  if (d._nodeType === 'causalEvent') return 5;
  if (d._nodeType === 'sourceMemory') return 20;
  if (d._nodeType === 'value') return 4;
  return 6;
}

export function initSvg(updatePinnedTooltipPosition) {
  const svg = d3.select('#graph');
  const width = svg.node().clientWidth;
  const height = svg.node().clientHeight;
  svg.selectAll('*').remove();
  svg.classed('focused', false);

  const defs = svg.append('defs');
  defs.append('marker').attr('id', 'arrow-fact')
    .attr('viewBox', '0 -4 8 8').attr('refX', 20).attr('refY', 0)
    .attr('markerWidth', 4).attr('markerHeight', 4).attr('orient', 'auto')
    .append('path').attr('d', 'M0,-3L8,0L0,3').attr('fill', '#484f58');
  defs.append('marker').attr('id', 'arrow-causal')
    .attr('viewBox', '0 -4 8 8').attr('refX', 14).attr('refY', 0)
    .attr('markerWidth', 4).attr('markerHeight', 4).attr('orient', 'auto')
    .append('path').attr('d', 'M0,-3L8,0L0,3').attr('fill', '#e5534b');

  const g = svg.append('g');

  // Render order = visual depth (back to front)
  const groups = {};
  // Cluster hulls go all the way at the back so they tint the area beneath
  // every other layer (viz.3).
  groups.clusterHulls = g.append('g').attr('class', 'layer-cluster-hulls');
  groups.sourceLinks = g.append('g').attr('class', 'layer-source');
  groups.sourceNodes = g.append('g').attr('class', 'layer-source');
  groups.mergeEdges = g.append('g').attr('class', 'layer-merge');
  groups.sameAsEdges = g.append('g').attr('class', 'layer-sameAs');
  groups.factEdges = g.append('g').attr('class', 'layer-fact');
  groups.factLabels = g.append('g').attr('class', 'layer-fact');
  groups.causalAnchors = g.append('g').attr('class', 'layer-causal');
  groups.causalEdges = g.append('g').attr('class', 'layer-causal');
  groups.causalNodes = g.append('g').attr('class', 'layer-causal');
  groups.bridges = g.append('g').attr('class', 'layer-bridges');
  groups.contradictionOverlay = g.append('g').attr('class', 'layer-contradictions');
  groups.entityNodes = g.append('g');

  svg.call(d3.zoom().scaleExtent([0.05, 5]).on('zoom', (e) => {
    g.attr('transform', e.transform);
    if (updatePinnedTooltipPosition) updatePinnedTooltipPosition();
  }));

  const simulation = d3.forceSimulation()
    .force('link', d3.forceLink().id(d => d.id).distance(d => {
      if (d._edgeType === 'causalAnchor') return 80;
      if (d._edgeType === 'causal') return 60;
      if (d._edgeType === 'sourceLink') return 140;
      if (d._edgeType === 'mergeCandidate') return 100;
      if (d._edgeType === 'sameAs') return 120;
      return 140;
    }).strength(d => {
      if (d._edgeType === 'sourceLink') return 0.03;
      if (d._edgeType === 'causalAnchor') return 0.15;
      if (d._edgeType === 'causal') return 0.2;
      if (d._edgeType === 'mergeCandidate') return 0.05;
      if (d._edgeType === 'sameAs') return 0.08;
      return 0.2;
    }))
    .force('charge', d3.forceManyBody().strength(chargeStrength))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide().radius(d => nodeRadius(d) + 6));

  state.refs.svg = svg;
  state.refs.g = g;
  state.refs.groups = groups;
  state.refs.simulation = simulation;
  return { svg, g, groups, simulation };
}
