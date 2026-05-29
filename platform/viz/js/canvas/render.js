import { state, COLOR_ENTITY, COLOR_TRANSITION, COLOR_MERGE } from '../state.js';
import { nodeRadius, chargeStrength } from './simulation.js';
import { isNodeVisible, isEdgeVisible } from './visibility.js';
import { applyDagLayout } from './layout-dag.js';
import { showTooltip, hideTooltip, updatePinnedTooltipPosition, pinTooltipForNode, unpinTooltip } from './tooltip.js';
import { toggleFocus } from './focus.js';
import { showNodeDetail, showEdgeDetail } from '../panels/detail.js';
import { renderContradictionsOverlay } from '../overlays/contradictions.js';
import { resolveEntityColor, resolveEntityStrokeOpacity, renderTopologyOverlay } from '../layers/topology.js';
import { renderClusterHulls } from '../layers/clusters.js';
import { renderGhostMarkers } from '../overlays/ghosts.js';
import { applyForces, isPinnedArticulationNode, isRingPinnedCausalEvent } from './forces.js';
import { edgeEndpoint } from './edge-utils.js';

export function renderAll() {
  const { nodes, edges } = state.data;
  const { svg, g, groups, simulation } = state.refs;
  if (!svg) return;

  if (nodes.length === 0) {
    svg.style('display', 'none');
    let empty = document.querySelector('.empty-state');
    if (!empty) {
      empty = document.createElement('div');
      empty.className = 'empty-state';
      document.querySelector('.main').prepend(empty);
    }
    empty.innerHTML = 'No data yet<small>POST to /ingest to add memories</small>';
    return;
  }
  svg.style('display', null);
  const el = document.querySelector('.empty-state');
  if (el) el.remove();

  const nodeIdSet = new Set(nodes.map(n => n.id));
  const visibleEdges = edges.filter(e =>
    isEdgeVisible(e) &&
    nodeIdSet.has(edgeEndpoint(e.source)) &&
    nodeIdSet.has(edgeEndpoint(e.target))
  );
  const visibleNodeIds = new Set(nodes.filter(n => isNodeVisible(n)).map(n => n.id));
  for (const e of visibleEdges) {
    visibleNodeIds.add(edgeEndpoint(e.source));
    visibleNodeIds.add(edgeEndpoint(e.target));
  }
  const visibleNodes = nodes.filter(n => visibleNodeIds.has(n.id));

  // Source links
  renderEdges(groups.sourceLinks, visibleEdges.filter(e => e._edgeType === 'sourceLink'), {
    stroke: '#21262d', width: 0.5, opacity: 0.2, dash: '2,3',
  });

  // Source memory nodes
  renderNodes(groups.sourceNodes, visibleNodes.filter(n => n._nodeType === 'sourceMemory'), {
    fill: '#2d333b', stroke: '#444c56', strokeWidth: 1, opacity: 0.6,
    labelColor: '#768390', fontSize: '9px', fontWeight: '400',
  });

  // Merge candidate edges (viz.4: cross-cluster generator rows in distinct
  // purple, three-signal in the original orange)
  renderEdges(groups.mergeEdges, visibleEdges.filter(e => e._edgeType === 'mergeCandidate'), {
    stroke: d => d.candidateSource === 'cross_cluster_generator' ? '#9b59b6' : COLOR_MERGE,
    width: d => 1.5 + (d.combinedScore || 0) * 3,
    opacity: 0.6,
    dash: d => d.candidateSource === 'cross_cluster_generator' ? '4,2,1,2' : '6,4',
    label: d => (d.combinedScore || 0).toFixed(2),
  });

  // Same-as identity links
  renderEdges(groups.sameAsEdges, visibleEdges.filter(e => e._edgeType === 'sameAs'), {
    stroke: '#2ecc71', width: 2.5, opacity: 0.7, dash: '8,4',
    label: d => `≡ ${(d.confidence || 0).toFixed(2)}`,
  });

  // Fact edges
  renderEdges(groups.factEdges, visibleEdges.filter(e => e._edgeType === 'fact'), {
    stroke: '#3d444d', width: 1, opacity: 0.4, marker: 'url(#arrow-fact)',
  });
  renderLabels(groups.factLabels, visibleEdges.filter(e => e._edgeType === 'fact'), d => d.predicate || '');

  // Causal anchor edges
  renderEdges(groups.causalAnchors, visibleEdges.filter(e => e._edgeType === 'causalAnchor'), {
    stroke: '#21262d', width: 0.5, opacity: 0.15, dash: '2,4',
  });

  // Causal edges — width scales with corroborationCount (bead nmemo-e2i.9).
  // Base width follows strength (legacy behaviour) and an extra log term
  // thickens edges that have been corroborated multiple times. log2 keeps the
  // visual readable even for the long tail (count=16 → +4px); a single-source
  // edge (count=1) renders at exactly the previous stroke-width.
  renderEdges(groups.causalEdges, visibleEdges.filter(e => e._edgeType === 'causal'), {
    stroke: d => d3.interpolateReds(0.3 + (d.strength || 0.5) * 0.4),
    width: d => 1 + (d.strength || 0.5) * 2 + Math.log2(Math.max(1, d.corroborationCount || 1)),
    opacity: 0.6, marker: 'url(#arrow-causal)',
  });

  // Causal event nodes (no canvas label)
  renderNodes(groups.causalNodes, visibleNodes.filter(n => n._nodeType === 'causalEvent'), {
    fill: d => COLOR_TRANSITION[d.transitionType] || '#95a5a6',
    stroke: '#21262d', strokeWidth: 1.5, opacity: 0.75,
    labelColor: 'transparent', fontSize: '0px',
    hideLabel: true,
  });

  // Value nodes
  renderNodes(groups.entityNodes, visibleNodes.filter(n => n._nodeType === 'value'), {
    fill: () => '#555e68',
    stroke: d => d.id === state.selectedId ? '#fff' : '#21262d',
    strokeWidth: 1.5,
    opacity: 0.7,
    hideLabel: true,
  });

  // Entity nodes (color via resolveEntityColor — driven by state.colorMode)
  renderNodes(groups.entityNodes, visibleNodes.filter(n => n._nodeType === 'entity'), {
    fill: d => resolveEntityColor(d),
    stroke: d => d.id === state.selectedId ? '#fff' : '#21262d',
    strokeWidth: d => d.id === state.selectedId ? 3 : 1.5 + Math.min((d.factCount || 0), 10) * 0.2,
    // Soft cluster_probability (viz.3): when colorMode === 'cluster' the
    // border opacity reads as crisp on hard membership / faded on soft.
    opacity: d => resolveEntityStrokeOpacity(d),
    labelColor: '#c9d1d9', fontSize: '11px', fontWeight: '500',
  });

  // Cluster hulls (viz.3 — only visible when colorMode === 'cluster' and the
  // hulls toggle is on; renders into the back-most group).
  renderClusterHulls();

  // Topology overlay (viz.2 — articulation rings + centrality halos + bridges)
  renderTopologyOverlay();

  // Ghost markers (viz.5 — entities with unfilled pattern slots)
  renderGhostMarkers();

  // Contradictions overlay (Phase 5 — viz.1)
  renderContradictionsOverlay();

  // Layout
  if (state.layoutMode === 'dag') {
    applyDagLayout(visibleNodes, visibleEdges);
  } else {
    for (const n of visibleNodes) { n.fx = undefined; n.fy = undefined; }
    const width = svg.node().clientWidth;
    const height = svg.node().clientHeight;
    simulation.force('center', d3.forceCenter(width / 2, height / 2));
    simulation.force('charge').strength(chargeStrength);
    simulation.nodes(visibleNodes);
    simulation.force('link').links(visibleEdges);
    applyForces(simulation);
    simulation.alpha(0.3).restart();
  }

  simulation.on('tick', () => {
    g.selectAll('line.edge').attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    g.selectAll('text.edge-label')
      .attr('x', d => (d.source.x + d.target.x) / 2)
      .attr('y', d => (d.source.y + d.target.y) / 2);
    g.selectAll('g.node').attr('transform', d => `translate(${d.x},${d.y})`);
    // viz.2 — bridges + contradiction-overlay underlays piggyback on the same
    // tick so their coords stay synced with the simulation.
    g.selectAll('line.bridge')
      .attr('x1', b => b._src?.x ?? 0).attr('y1', b => b._src?.y ?? 0)
      .attr('x2', b => b._tgt?.x ?? 0).attr('y2', b => b._tgt?.y ?? 0);
    g.selectAll('line.contradiction-underlay')
      .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    // viz.3 — keep cluster hulls following the simulation. Cheap no-op when
    // showClusterHulls is false (renderClusterHulls clears + returns early).
    if (state.showClusterHulls) renderClusterHulls();
    updatePinnedTooltipPosition();
  });
}

export function renderEdges(group, edges, opts) {
  const sel = group.selectAll('line.edge').data(edges, d => d.id);
  sel.exit().remove();
  const enter = sel.enter().append('line').attr('class', 'edge');
  const merged = enter.merge(sel);
  merged
    .attr('stroke', typeof opts.stroke === 'function' ? opts.stroke : () => opts.stroke)
    .attr('stroke-width', typeof opts.width === 'function' ? opts.width : () => opts.width)
    .attr('stroke-opacity', opts.opacity || 0.5)
    .attr('stroke-dasharray', opts.dash || null)
    .attr('marker-end', opts.marker || null)
    .style('cursor', d => d._edgeType === 'sourceLink' || d._edgeType === 'causalAnchor' ? 'default' : 'pointer')
    .on('click', (e, d) => {
      if (d._edgeType !== 'sourceLink' && d._edgeType !== 'causalAnchor') {
        e.stopPropagation();
        unpinTooltip();
        state.selectedId = d.id;
        showEdgeDetail(d);
      }
    })
    .on('mouseover', (e, d) => showTooltip(e, d))
    .on('mouseout', hideTooltip);

  if (opts.label) {
    const lblData = edges.filter(d => opts.label(d));
    const lbl = group.selectAll('text.edge-label').data(lblData, d => d.id);
    lbl.exit().remove();
    const lblEnter = lbl.enter().append('text').attr('class', 'edge-label')
      .attr('font-size', '9px').attr('fill', '#8b949e').attr('text-anchor', 'middle').attr('pointer-events', 'none');
    lblEnter.merge(lbl).text(d => opts.label(d));
  }
}

export function renderLabels(group, edges, textFn) {
  const lbl = group.selectAll('text.edge-label').data(edges, d => d.id);
  lbl.exit().remove();
  const lblEnter = lbl.enter().append('text').attr('class', 'edge-label')
    .attr('font-size', '9px').attr('fill', '#484f58').attr('text-anchor', 'middle').attr('pointer-events', 'none');
  lblEnter.merge(lbl).text(textFn);
}

export function renderNodes(group, nodeData, opts) {
  const { g, groups, simulation } = state.refs;
  const sel = group.selectAll('g.node').data(nodeData, d => d.id);
  sel.exit().remove();
  const enter = sel.enter().append('g').attr('class', 'node');
  enter.append('circle');
  enter.append('text').attr('dy', 4);

  const merged = enter.merge(sel);
  merged.select('circle')
    .attr('r', d => nodeRadius(d))
    .attr('fill', typeof opts.fill === 'function' ? opts.fill : () => opts.fill)
    .attr('stroke', typeof opts.stroke === 'function' ? opts.stroke : () => opts.stroke)
    .attr('stroke-width', typeof opts.strokeWidth === 'function' ? opts.strokeWidth : () => opts.strokeWidth)
    .attr('opacity', opts.opacity || 1)
    .style('cursor', 'pointer');

  if (opts.hideLabel) {
    merged.select('text').text('');
  } else {
    merged.select('text')
      .text(d => d.label || '')
      .attr('dx', d => nodeRadius(d) + 4)
      .attr('font-size', typeof opts.fontSize === 'function' ? opts.fontSize : () => opts.fontSize)
      .attr('font-weight', typeof opts.fontWeight === 'function' ? opts.fontWeight : () => (opts.fontWeight || '400'))
      .attr('fill', typeof opts.labelColor === 'function' ? opts.labelColor : () => opts.labelColor);
  }

  if (opts.hideLabel) {
    merged
      .on('mouseover', (e, d) => {
        if (state.tooltipPinned) return;
        const tip = document.getElementById('tooltip');
        tip.textContent = d.label || '';
        tip.style.display = d.label ? 'block' : 'none';
        tip.style.left = e.pageX + 12 + 'px';
        tip.style.top = e.pageY - 12 + 'px';
      })
      .on('mouseout', () => { if (!state.tooltipPinned) hideTooltip(); });
  }

  // Drag end normally clears fx/fy so the node rejoins the simulation. When
  // articulationPins is on and the dropped node is a pinned articulation
  // entity, preserve the drop position as the new pin (bead nmemo-smr) —
  // otherwise the user's manual placement would be wiped immediately and
  // applyForces() on the next renderAll would re-pin to whatever the sim
  // had drifted to. Non-pinned nodes clear as before. Causal events are
  // re-pinned to their ring every tick by causalRadialForce (bead pd5.7), so
  // dragging one needs a release handover (bead pd5.8): _radialReleased tells
  // the force to stop re-pinning this event so the drag (and the drop) stick.
  merged.call(d3.drag()
    .on('start', (e, d) => {
      if (!e.active) simulation.alphaTarget(0.3).restart();
      if (isRingPinnedCausalEvent(d)) d._radialReleased = true;
      d.fx = d.x;
      d.fy = d.y;
    })
    .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
    .on('end', (e, d) => {
      if (!e.active) simulation.alphaTarget(0);
      if (isRingPinnedCausalEvent(d)) {
        // Stays where dropped — _radialReleased keeps causalRadialForce off it
        // until the next fetchData() (fresh node objects) re-rings it. Only
        // when the force is ON; with it OFF the event is a normal force node
        // and falls through to the clear-on-drop branch below.
        d.fx = e.x;
        d.fy = e.y;
      } else if (isPinnedArticulationNode(d)) {
        d.fx = e.x;
        d.fy = e.y;
      } else {
        d.fx = null;
        d.fy = null;
      }
    })
  );

  const isHideLabel = opts.hideLabel;
  merged.on('click', function(e, d) {
    e.stopPropagation();
    state.selectedId = d.id;
    showNodeDetail(d);

    if (isHideLabel && d.label) {
      pinTooltipForNode(d);
    } else {
      unpinTooltip();
    }

    groups.entityNodes.selectAll('circle')
      .attr('stroke', dd => dd.id === state.selectedId ? '#fff' : '#21262d')
      .attr('stroke-width', dd => dd.id === state.selectedId ? 3 : 1.5 + Math.min((dd.factCount || 0), 10) * 0.2);
  });

  merged.on('mouseover', function(e, d) {
    if (state.tooltipPinned && !opts.hideLabel) return;
    const nodeId = d.id;
    g.selectAll('line.edge')
      .attr('stroke-opacity', ed => {
        const srcId = edgeEndpoint(ed.source);
        const tgtId = edgeEndpoint(ed.target);
        return (srcId === nodeId || tgtId === nodeId) ? 0.9 : 0.1;
      });
    if (opts.hideLabel && d.label && !state.tooltipPinned) {
      const tip = document.getElementById('tooltip');
      tip.textContent = d.label;
      tip.style.display = 'block';
      tip.style.left = e.pageX + 12 + 'px';
      tip.style.top = e.pageY - 12 + 'px';
    }
  }).on('mouseout', function() {
    if (!state.tooltipPinned) {
      g.selectAll('line.edge').attr('stroke-opacity', ed => {
        if (ed._edgeType === 'causalAnchor') return 0.15;
        if (ed._edgeType === 'sourceLink') return 0.2;
        if (ed._edgeType === 'fact') return 0.4;
        if (ed._edgeType === 'causal') return 0.6;
        if (ed._edgeType === 'mergeCandidate') return 0.6;
        if (ed._edgeType === 'sameAs') return 0.7;
        return 0.5;
      });
      hideTooltip();
    }
  });

  merged.on('dblclick', (e, d) => {
    e.stopPropagation();
    if (d._nodeType === 'entity') toggleFocus(d.id);
  });
}
