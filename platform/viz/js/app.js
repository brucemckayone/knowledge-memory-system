// ============================================================
// Mnemo Graph Viz — Unified Canvas with Layer Toggles
// ============================================================

// --- Constants ---
const COLOR_ENTITY = {
  person: '#4a90d9', company: '#27ae60', project: '#e67e22',
  concept: '#9b59b6', place: '#1abc9c', event: '#e74c3c',
  other: '#95a5a6'
};
const COLOR_TRANSITION = {
  created: '#27ae60', strengthened: '#4a90d9', weakened: '#e67e22',
  expired: '#95a5a6', invalidated: '#e74c3c'
};
const COLOR_MERGE = '#d29922';
const COLOR_SOURCE = '#1a2332';

// --- State ---
let data = { nodes: [], edges: [] };
let simulation, svg, g;
let groups = {};
let selectedId = null;
let focusedEntityId = null;
let refreshTimer = null;
let tooltipPinned = false;
let tooltipPinnedNode = null;
let layoutMode = 'force'; // 'force' or 'dag'
let scrubberTime = null; // null = show all (now), Date = filter up to this time
let timeRange = { min: null, max: null };
const layers = { fact: true, causal: true, source: false, merge: false, sameAs: true };

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ============================================================
// GRAPH RENDERING
// ============================================================

function initSvg() {
  svg = d3.select('#graph');
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

  g = svg.append('g');

  // Render order = visual depth (back to front)
  groups.sourceLinks = g.append('g').attr('class', 'layer-source');
  groups.sourceNodes = g.append('g').attr('class', 'layer-source');
  groups.mergeEdges = g.append('g').attr('class', 'layer-merge');
  groups.sameAsEdges = g.append('g').attr('class', 'layer-sameAs');
  groups.factEdges = g.append('g').attr('class', 'layer-fact');
  groups.factLabels = g.append('g').attr('class', 'layer-fact');
  groups.causalAnchors = g.append('g').attr('class', 'layer-causal');
  groups.causalEdges = g.append('g').attr('class', 'layer-causal');
  groups.causalNodes = g.append('g').attr('class', 'layer-causal');
  groups.entityNodes = g.append('g');

  svg.call(d3.zoom().scaleExtent([0.05, 5]).on('zoom', (e) => {
    g.attr('transform', e.transform);
    updatePinnedTooltipPosition();
  }));

  simulation = d3.forceSimulation()
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
    .force('charge', d3.forceManyBody().strength(d => {
      if (d._nodeType === 'entity') return -400;
      if (d._nodeType === 'sourceMemory') return -30;
      if (d._nodeType === 'causalEvent') return -60;
      return -80;
    }))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide().radius(d => nodeRadius(d) + 6));
}

function nodeRadius(d) {
  if (d._nodeType === 'entity') return 6 + Math.min((d.mentionCount || 1), 15) * 1;
  if (d._nodeType === 'causalEvent') return 5;
  if (d._nodeType === 'sourceMemory') return 20;
  if (d._nodeType === 'value') return 4;
  return 6;
}

function render() {
  const { nodes, edges } = data;
  if (nodes.length === 0) {
    svg.style('display', 'none');
    let empty = document.querySelector('.empty-state');
    if (!empty) { empty = document.createElement('div'); empty.className = 'empty-state'; document.querySelector('.main').prepend(empty); }
    empty.innerHTML = 'No data yet<small>POST to /ingest to add memories</small>';
    return;
  }
  svg.style('display', null);
  const el = document.querySelector('.empty-state');
  if (el) el.remove();

  // Filter by layer visibility
  const visibleEdges = edges.filter(e => isEdgeVisible(e));
  const visibleNodeIds = new Set(nodes.filter(n => isNodeVisible(n)).map(n => n.id));
  // Also include nodes referenced by visible edges
  for (const e of visibleEdges) {
    visibleNodeIds.add(typeof e.source === 'object' ? e.source.id : e.source);
    visibleNodeIds.add(typeof e.target === 'object' ? e.target.id : e.target);
  }
  const visibleNodes = nodes.filter(n => visibleNodeIds.has(n.id));

  // --- Source links ---
  renderEdges(groups.sourceLinks, visibleEdges.filter(e => e._edgeType === 'sourceLink'), {
    stroke: '#21262d', width: 0.5, opacity: 0.2, dash: '2,3',
  });

  // --- Source memory nodes ---
  renderNodes(groups.sourceNodes, visibleNodes.filter(n => n._nodeType === 'sourceMemory'), {
    fill: '#2d333b', stroke: '#444c56', strokeWidth: 1, opacity: 0.6,
    labelColor: '#768390', fontSize: '9px', fontWeight: '400',
  });

  // --- Merge candidate edges ---
  renderEdges(groups.mergeEdges, visibleEdges.filter(e => e._edgeType === 'mergeCandidate'), {
    stroke: COLOR_MERGE, width: d => 1.5 + (d.combinedScore || 0) * 3, opacity: 0.6,
    dash: '6,4', label: d => (d.combinedScore || 0).toFixed(2),
  });

  // --- Same-as identity links ---
  renderEdges(groups.sameAsEdges, visibleEdges.filter(e => e._edgeType === 'sameAs'), {
    stroke: '#2ecc71', width: 2.5, opacity: 0.7, dash: '8,4',
    label: d => `≡ ${(d.confidence || 0).toFixed(2)}`,
  });

  // --- Fact edges ---
  renderEdges(groups.factEdges, visibleEdges.filter(e => e._edgeType === 'fact'), {
    stroke: '#3d444d', width: 1, opacity: 0.4, marker: 'url(#arrow-fact)',
  });
  renderLabels(groups.factLabels, visibleEdges.filter(e => e._edgeType === 'fact'), d => d.predicate || '');

  // --- Causal anchor edges (very subtle tethers) ---
  renderEdges(groups.causalAnchors, visibleEdges.filter(e => e._edgeType === 'causalAnchor'), {
    stroke: '#21262d', width: 0.5, opacity: 0.15, dash: '2,4',
  });

  // --- Causal edges (no canvas label — show on hover/click) ---
  renderEdges(groups.causalEdges, visibleEdges.filter(e => e._edgeType === 'causal'), {
    stroke: d => d3.interpolateReds(0.3 + (d.strength || 0.5) * 0.4),
    width: d => 1 + (d.strength || 0.5) * 2,
    opacity: 0.6, marker: 'url(#arrow-causal)',
  });

  // --- Causal event nodes (no label on canvas — show on hover/click only) ---
  renderNodes(groups.causalNodes, visibleNodes.filter(n => n._nodeType === 'causalEvent'), {
    fill: d => COLOR_TRANSITION[d.transitionType] || '#95a5a6',
    stroke: '#21262d', strokeWidth: 1.5, opacity: 0.75,
    labelColor: 'transparent', fontSize: '0px',
    hideLabel: true,
  });

  // --- Value nodes (hidden labels, show on hover) ---
  renderNodes(groups.entityNodes, visibleNodes.filter(n => n._nodeType === 'value'), {
    fill: () => '#555e68',
    stroke: d => d.id === selectedId ? '#fff' : '#21262d',
    strokeWidth: 1.5,
    opacity: 0.7,
    hideLabel: true,
  });

  // --- Entity nodes (always on top, always labeled) ---
  renderNodes(groups.entityNodes, visibleNodes.filter(n => n._nodeType === 'entity'), {
    fill: d => COLOR_ENTITY[d.entityType] || COLOR_ENTITY.other,
    stroke: d => d.id === selectedId ? '#fff' : '#21262d',
    strokeWidth: d => d.id === selectedId ? 3 : 1.5 + Math.min((d.factCount || 0), 10) * 0.2,
    opacity: 1,
    labelColor: '#c9d1d9', fontSize: '11px', fontWeight: '500',
  });

  // Layout
  if (layoutMode === 'dag') {
    applyDagLayout(visibleNodes, visibleEdges);
  } else {
    // Unfix any nodes fixed by DAG layout
    for (const n of visibleNodes) { n.fx = undefined; n.fy = undefined; }
    // Restore force settings
    const width = svg.node().clientWidth;
    const height = svg.node().clientHeight;
    simulation.force('center', d3.forceCenter(width / 2, height / 2));
    simulation.force('charge').strength(d => {
      if (d._nodeType === 'entity') return -400;
      if (d._nodeType === 'sourceMemory') return -30;
      if (d._nodeType === 'causalEvent') return -60;
      return -80;
    });
    simulation.nodes(visibleNodes);
    simulation.force('link').links(visibleEdges);
    simulation.alpha(0.3).restart();
  }

  simulation.on('tick', () => {
    g.selectAll('line.edge').attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    g.selectAll('text.edge-label')
      .attr('x', d => (d.source.x + d.target.x) / 2)
      .attr('y', d => (d.source.y + d.target.y) / 2);
    g.selectAll('g.node').attr('transform', d => `translate(${d.x},${d.y})`);
    updatePinnedTooltipPosition();
  });
}

// --- Render helpers ---

function renderEdges(group, data, opts) {
  const sel = group.selectAll('line.edge').data(data, d => d.id);
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
    .on('click', (e, d) => { if (d._edgeType !== 'sourceLink' && d._edgeType !== 'causalAnchor') { e.stopPropagation(); unpinTooltip(); selectedId = d.id; showEdgeDetail(d); } })
    .on('mouseover', (e, d) => showTooltip(e, d))
    .on('mouseout', hideTooltip);

  // Labels on edges
  if (opts.label) {
    const lblData = data.filter(d => opts.label(d));
    const lbl = group.selectAll('text.edge-label').data(lblData, d => d.id);
    lbl.exit().remove();
    const lblEnter = lbl.enter().append('text').attr('class', 'edge-label')
      .attr('font-size', '9px').attr('fill', '#8b949e').attr('text-anchor', 'middle').attr('pointer-events', 'none');
    lblEnter.merge(lbl).text(d => opts.label(d));
  }
}

function renderLabels(group, data, textFn) {
  const lbl = group.selectAll('text.edge-label').data(data, d => d.id);
  lbl.exit().remove();
  const lblEnter = lbl.enter().append('text').attr('class', 'edge-label')
    .attr('font-size', '9px').attr('fill', '#484f58').attr('text-anchor', 'middle').attr('pointer-events', 'none');
  lblEnter.merge(lbl).text(textFn);
}

function renderNodes(group, nodeData, opts) {
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

  // Hover tooltip for labelless nodes
  if (opts.hideLabel) {
    merged
      .on('mouseover', (e, d) => {
        if (tooltipPinned) return;
        const tip = document.getElementById('tooltip');
        tip.textContent = d.label || '';
        tip.style.display = d.label ? 'block' : 'none';
        tip.style.left = e.pageX + 12 + 'px';
        tip.style.top = e.pageY - 12 + 'px';
      })
      .on('mouseout', () => { if (!tooltipPinned) hideTooltip(); });
  }

  // Drag
  merged.call(d3.drag()
    .on('start', (e, d) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
    .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
    .on('end', (e, d) => { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; })
  );

  // Single click — show detail panel + pin tooltip for labelless nodes
  const isHideLabel = opts.hideLabel;
  merged.on('click', function(e, d) {
    e.stopPropagation();
    selectedId = d.id;
    showNodeDetail(d);

    // Pin tooltip for labelless nodes so it stays visible and follows the node
    if (isHideLabel && d.label) {
      tooltipPinned = true;
      tooltipPinnedNode = d;
      const tip = document.getElementById('tooltip');
      tip.textContent = d.label;
      tip.style.display = 'block';
      updatePinnedTooltipPosition();
    } else {
      unpinTooltip();
    }

    // Update stroke on entity nodes
    groups.entityNodes.selectAll('circle')
      .attr('stroke', dd => dd.id === selectedId ? '#fff' : '#21262d')
      .attr('stroke-width', dd => dd.id === selectedId ? 3 : 1.5 + Math.min((dd.factCount || 0), 10) * 0.2);
  });

  // Hover — highlight connected edges
  merged.on('mouseover', function(e, d) {
    if (tooltipPinned && !opts.hideLabel) return;
    // Highlight edges connected to this node
    const nodeId = d.id;
    g.selectAll('line.edge')
      .attr('stroke-opacity', ed => {
        const srcId = typeof ed.source === 'object' ? ed.source.id : ed.source;
        const tgtId = typeof ed.target === 'object' ? ed.target.id : ed.target;
        return (srcId === nodeId || tgtId === nodeId) ? 0.9 : 0.1;
      });
    // Show tooltip for hidden-label nodes
    if (opts.hideLabel && d.label && !tooltipPinned) {
      const tip = document.getElementById('tooltip');
      tip.textContent = d.label;
      tip.style.display = 'block';
      tip.style.left = e.pageX + 12 + 'px';
      tip.style.top = e.pageY - 12 + 'px';
    }
  }).on('mouseout', function() {
    if (!tooltipPinned) {
      // Restore edge opacity
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

  // Double click (focus mode)
  merged.on('dblclick', (e, d) => {
    e.stopPropagation();
    if (d._nodeType === 'entity') toggleFocus(d.id);
  });
}

// ============================================================
// LAYER VISIBILITY
// ============================================================

function isBeforeScrubber(timestamp) {
  if (!scrubberTime || !timestamp) return true;
  return new Date(timestamp).getTime() <= scrubberTime;
}

function isNodeVisible(n) {
  if (n._nodeType === 'entity' || n._nodeType === 'value') return true;
  if (n._nodeType === 'causalEvent') {
    if (!layers.causal) return false;
    return isBeforeScrubber(n.occurredAt);
  }
  if (n._nodeType === 'sourceMemory') return layers.source;
  return true;
}

function isEdgeVisible(e) {
  if (e._edgeType === 'fact') return layers.fact && isBeforeScrubber(e.createdAt);
  if (e._edgeType === 'causal') return layers.causal && isBeforeScrubber(e.createdAt);
  if (e._edgeType === 'causalAnchor') {
    if (!layers.causal) return false;
    // Anchor visible if its event is visible
    const eventNode = data.nodes.find(n => n.id === e.target || n.id === e.target?.id);
    return eventNode ? isNodeVisible(eventNode) : true;
  }
  if (e._edgeType === 'sourceLink') return layers.source;
  if (e._edgeType === 'mergeCandidate') return layers.merge;
  if (e._edgeType === 'sameAs') return layers.sameAs;
  return true;
}

// Check if an entity has any facts at the current scrubber time
function entityHasFactsAtTime(entityId) {
  if (!scrubberTime) return true;
  return data.edges.some(e =>
    e._edgeType === 'fact' &&
    ((e.source === entityId || e.source?.id === entityId) ||
     (e.target === entityId || e.target?.id === entityId)) &&
    isBeforeScrubber(e.createdAt)
  );
}

function toggleLayer(layerName) {
  layers[layerName] = !layers[layerName];
  document.querySelector(`[data-layer="${layerName}"]`).classList.toggle('active', layers[layerName]);
  render();
}

// ============================================================
// FOCUS MODE (double-click expansion)
// ============================================================

function toggleFocus(entityId) {
  if (focusedEntityId === entityId) {
    // Unfocus
    focusedEntityId = null;
    svg.classed('focused', false);
    g.selectAll('.faded').classed('faded', false);
    return;
  }

  focusedEntityId = entityId;
  svg.classed('focused', true);

  // Find connected node IDs
  const connected = new Set([entityId]);
  for (const e of data.edges) {
    const srcId = typeof e.source === 'object' ? e.source.id : e.source;
    const tgtId = typeof e.target === 'object' ? e.target.id : e.target;
    if (srcId === entityId) connected.add(tgtId);
    if (tgtId === entityId) connected.add(srcId);
  }

  // Fade everything not connected
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

// Escape to unfocus
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && focusedEntityId) toggleFocus(focusedEntityId);
});

// ============================================================
// DAG LAYOUT
// ============================================================

function applyDagLayout(nodes, edges) {
  const width = svg.node().clientWidth;
  const height = svg.node().clientHeight;
  const margin = { top: 40, right: 40, bottom: 40, left: 200 };

  // Separate entities (left column) from causal events (DAG area)
  const entityNodes = nodes.filter(n => n._nodeType === 'entity');
  const eventNodes = nodes.filter(n => n._nodeType === 'causalEvent');
  const otherNodes = nodes.filter(n => n._nodeType !== 'entity' && n._nodeType !== 'causalEvent');

  // Position entities on the left, spread vertically
  entityNodes.forEach((n, i) => {
    n.fx = margin.left / 2;
    n.fy = margin.top + (i / Math.max(entityNodes.length - 1, 1)) * (height - margin.top - margin.bottom);
  });

  // Position causal events by occurredAt (top = earliest, bottom = latest)
  if (eventNodes.length > 0 && timeRange.min && timeRange.max) {
    const tMin = timeRange.min;
    const tMax = timeRange.max;
    const tRange = tMax - tMin || 1;

    // Group events by entity for horizontal spacing
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

      // Horizontal position based on entity group
      const groupIdx = groupKeys.indexOf(n.entityId || '_none');
      const xFrac = (groupIdx + 1) / (groupKeys.length + 1);
      n.fx = margin.left + xFrac * (width - margin.left - margin.right);
    });
  }

  // Other nodes float freely but with gentle positioning
  otherNodes.forEach(n => {
    n.fx = undefined;
    n.fy = undefined;
  });

  // Use simulation with very weak forces so fixed nodes stay put
  simulation.nodes(nodes);
  simulation.force('link').links(edges);
  simulation.force('charge').strength(-20);
  simulation.force('center', null); // disable centering in DAG mode
  simulation.alpha(0.5).restart();
}

// ============================================================
// DETAIL PANEL
// ============================================================

function field(label, value) {
  if (value == null || value === '') return '';
  return `<div class="field"><div class="field-label">${esc(label)}</div><div class="field-value">${esc(String(value))}</div></div>`;
}

function signalBar(label, value, color) {
  const pct = Math.round((value || 0) * 100);
  return `<div class="signal-bar">
    <span class="bar-label">${esc(label)}</span>
    <div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>
    <span class="bar-value">${(value || 0).toFixed(2)}</span>
  </div>`;
}

function openDetailPanel() {
  document.getElementById('detail').classList.remove('collapsed');
}
function closeDetailPanel() {
  document.getElementById('detail').classList.add('collapsed');
}

function showNodeDetail(d) {
  const panel = document.getElementById('detailContent');
  openDetailPanel();
  let html = '';

  if (d._nodeType === 'entity') {
    html += `<h2>${esc(d.label)}</h2>`;
    html += `<div class="meta-row">`;
    html += `<div class="meta-item"><b>${d.mentionCount || 0}</b> <span>mentions</span></div>`;
    html += `<div class="meta-item"><b>${d.factCount || 0}</b> <span>facts</span></div>`;
    html += `<div class="meta-item"><b>${d.sourceMemoryCount || 0}</b> <span>sources</span></div>`;
    html += `</div>`;
    // Entity summary (living profile)
    if (d.summary) {
      html += `<div class="source-block" style="margin-bottom:10px;color:#c9d1d9;max-height:160px">${esc(d.summary)}</div>`;
    }

    html += field('Type', d.entityType);
    html += field('Confidence', d.confidence);

    // Connected facts
    const connected = data.edges.filter(e => e._edgeType === 'fact' && ((e.source.id || e.source) === d.id || (e.target.id || e.target) === d.id));
    if (connected.length > 0) {
      html += `<div class="section-label">Facts (${connected.length})</div>`;
      for (const f of connected.slice(0, 12)) {
        const src = data.nodes.find(n => n.id === (f.source.id || f.source));
        const tgt = data.nodes.find(n => n.id === (f.target.id || f.target));
        html += `<div class="source-block"><strong>${esc(src?.label || '?')}</strong> --[${esc(f.predicate)}]--> <strong>${esc(tgt?.label || '?')}</strong>`;
        if (f.sourceText) html += `<br><br>${esc(f.sourceText.slice(0, 150))}`;
        html += `</div>`;
      }
    }

    // Source mentions
    if (d.sources?.length > 0) {
      html += `<div class="section-label">Source mentions (${d.sources.length})</div>`;
      for (const s of d.sources.slice(0, 8)) {
        html += `<div class="source-block">`;
        if (s.mentionText) html += `<span class="mention">${esc(s.mentionText)}</span><br>`;
        if (s.context) html += `${esc(s.context.slice(0, 200))}`;
        if (!s.mentionText && !s.context) html += `Memory: ${esc(s.memoryId)}`;
        html += `</div>`;
      }
    }

    // Merge candidates
    const merges = data.edges.filter(e => e._edgeType === 'mergeCandidate' && ((e.source.id || e.source) === d.id || (e.target.id || e.target) === d.id));
    if (merges.length > 0) {
      html += `<div class="section-label">Merge candidates (${merges.length})</div>`;
      for (const m of merges) {
        const otherId = (m.source.id || m.source) === d.id ? (m.target.id || m.target) : (m.source.id || m.source);
        const other = data.nodes.find(n => n.id === otherId);
        html += `<div class="source-block"><strong>${esc(other?.label || '?')}</strong> [${esc(m.status)}]`;
        html += `<br>${signalBar('Centroid', m.centroidSimilarity, '#4a90d9')}`;
        html += `${signalBar('Overlap', m.memoryOverlap, '#27ae60')}`;
        html += `${signalBar('Structural', m.structuralSimilarity, '#e67e22')}`;
        html += `${signalBar('Combined', m.combinedScore, '#58a6ff')}`;
        html += `</div>`;
      }
    }

  } else if (d._nodeType === 'causalEvent') {
    html += `<h2>${esc(d.label)}</h2>`;
    html += field('Transition', d.transitionType);
    html += field('Entity', d.entityName);
    html += field('Predicate', d.predicate);
    html += field('Occurred', d.occurredAt);
    if (d.deltaConfidence != null) html += field('Confidence delta', d.deltaConfidence);
    // Show connected causal edges
    const asSource = data.edges.filter(e => e._edgeType === 'causal' && (e.source.id || e.source) === d.id);
    const asTarget = data.edges.filter(e => e._edgeType === 'causal' && (e.target.id || e.target) === d.id);
    if (asSource.length > 0) {
      html += `<div class="section-label">Caused (${asSource.length})</div>`;
      for (const ce of asSource) {
        const effect = data.nodes.find(n => n.id === (ce.target.id || ce.target));
        html += `<div class="source-block"><strong>${esc(effect?.label || '?')}</strong><br>strength: ${(ce.strength||0).toFixed(2)}<br>${esc((ce.reasoning||'').slice(0, 150))}</div>`;
      }
    }
    if (asTarget.length > 0) {
      html += `<div class="section-label">Caused by (${asTarget.length})</div>`;
      for (const ce of asTarget) {
        const cause = data.nodes.find(n => n.id === (ce.source.id || ce.source));
        html += `<div class="source-block"><strong>${esc(cause?.label || '?')}</strong><br>strength: ${(ce.strength||0).toFixed(2)}<br>${esc((ce.reasoning||'').slice(0, 150))}</div>`;
      }
    }
    if (d.sourceText) {
      html += `<div class="section-label">Source text</div>`;
      html += `<div class="source-block">${esc(d.sourceText)}</div>`;
    }

  } else if (d._nodeType === 'sourceMemory') {
    html += `<h2>Source: ${esc(d.label)}</h2>`;
    html += field('Entities', d.linkedEntityCount);
    // Preview
    if (d.preview) {
      html += `<div class="source-block" style="max-height:200px;color:#c9d1d9">${esc(d.preview)}</div>`;
    }
    // Find entities linked to this memory
    const linked = data.edges.filter(e => e._edgeType === 'sourceLink' && (e.source.id || e.source) === d.id);
    if (linked.length > 0) {
      html += `<div class="section-label">Entities mentioned</div>`;
      for (const l of linked) {
        const ent = data.nodes.find(n => n.id === (l.target.id || l.target));
        if (ent) html += `<div class="source-block"><strong>${esc(ent.label)}</strong> [${esc(ent.entityType)}]</div>`;
      }
    }

  } else if (d._nodeType === 'value') {
    html += `<h2>Value</h2>`;
    html += field('Value', d.label);

  } else {
    html += `<h2>Node</h2>`;
    html += field('ID', d.id);
    html += field('Type', d._nodeType);
  }

  panel.innerHTML = html;
}

function showEdgeDetail(d) {
  const panel = document.getElementById('detailContent');
  openDetailPanel();
  let html = '';

  if (d._edgeType === 'fact') {
    const src = data.nodes.find(n => n.id === (d.source.id || d.source));
    const tgt = data.nodes.find(n => n.id === (d.target.id || d.target));
    html += `<h2>Fact</h2>`;
    html += field('Subject', src?.label);
    html += field('Predicate', d.predicate);
    html += field('Object', tgt?.label || d.objectValue);
    html += field('Confidence', d.confidence);
    if (d.sourceText) {
      html += `<div class="section-label">Source text</div>`;
      html += `<div class="source-block">${esc(d.sourceText)}</div>`;
    }
    if (d.sourceMemoryId) html += field('Memory ID', d.sourceMemoryId);

  } else if (d._edgeType === 'causal') {
    html += `<h2>Causal Edge</h2>`;
    html += field('Strength', d.strength?.toFixed(3));
    if (d.reasoning) {
      html += `<div class="section-label">Reasoning</div>`;
      html += `<div class="source-block">${esc(d.reasoning)}</div>`;
    }
    if (d.sourceReferences?.length) {
      html += `<div class="section-label">Source references (${d.sourceReferences.length})</div>`;
      for (const ref of d.sourceReferences) {
        html += `<div class="source-block"><strong>${esc(ref.type)}</strong>: ${esc(ref.id?.slice(0, 8) + '...')}<br>${esc(ref.relevance?.slice(0, 150) || '')}</div>`;
      }
    }

  } else if (d._edgeType === 'mergeCandidate') {
    const a = data.nodes.find(n => n.id === (d.source.id || d.source));
    const b = data.nodes.find(n => n.id === (d.target.id || d.target));
    html += `<h2>Merge Candidate</h2>`;
    html += field('Entity A', a?.label);
    html += field('Entity B', b?.label);
    html += field('Status', d.status);
    html += `<div class="section-label">Signals</div>`;
    html += signalBar('Centroid', d.centroidSimilarity, '#4a90d9');
    html += signalBar('Overlap', d.memoryOverlap, '#27ae60');
    html += signalBar('Structural', d.structuralSimilarity, '#e67e22');
    html += signalBar('Combined', d.combinedScore, '#58a6ff');

  } else if (d._edgeType === 'sameAs') {
    const a = data.nodes.find(n => n.id === (d.source.id || d.source));
    const b = data.nodes.find(n => n.id === (d.target.id || d.target));
    html += `<h2 style="color:#2ecc71">Same-As Identity Link</h2>`;
    html += field('Entity A', a?.label);
    html += field('Entity B', b?.label);
    html += field('Confidence', d.confidence?.toFixed(3));
    if (d.reasoning) {
      html += `<div class="section-label">Reasoning</div>`;
      html += `<div class="source-block">${esc(d.reasoning)}</div>`;
    }
  }

  panel.innerHTML = html;
}

// ============================================================
// TOOLTIP
// ============================================================

function showTooltip(e, d) {
  if (tooltipPinned) return;
  if (d._edgeType === 'sourceLink' || d._edgeType === 'causalAnchor') return;
  const tip = document.getElementById('tooltip');
  let text = '';
  if (d._edgeType === 'fact') {
    text = d.predicate || '';
    if (d.sourceText) text += '\n\n' + d.sourceText.slice(0, 200);
  } else if (d._edgeType === 'causal') {
    text = `Strength: ${(d.strength || 0).toFixed(2)}\n${(d.reasoning || '').slice(0, 200)}`;
  } else if (d._edgeType === 'mergeCandidate') {
    text = `Score: ${(d.combinedScore || 0).toFixed(2)} [${d.status}]`;
  }
  if (!text) return;
  tip.textContent = text;
  tip.style.display = 'block';
  tip.style.left = e.pageX + 12 + 'px';
  tip.style.top = e.pageY - 12 + 'px';
}

function hideTooltip() {
  if (tooltipPinned) return;
  document.getElementById('tooltip').style.display = 'none';
}

function unpinTooltip() {
  tooltipPinned = false;
  tooltipPinnedNode = null;
  document.getElementById('tooltip').style.display = 'none';
}

function updatePinnedTooltipPosition() {
  if (!tooltipPinned || !tooltipPinnedNode) return;
  const d = tooltipPinnedNode;
  if (d.x == null || d.y == null) return;

  // Convert node coordinates through the current SVG transform
  const svgEl = svg.node();
  const gEl = g.node();
  const ctm = gEl.getCTM();
  if (!ctm) return;

  const svgRect = svgEl.getBoundingClientRect();
  const screenX = svgRect.left + ctm.a * d.x + ctm.e;
  const screenY = svgRect.top + ctm.d * d.y + ctm.f;

  const tip = document.getElementById('tooltip');
  tip.style.left = (screenX + nodeRadius(d) + 8) + 'px';
  tip.style.top = (screenY - 8) + 'px';
}

// ============================================================
// DATA FETCHING
// ============================================================

async function fetchData() {
  try {
    const [statsRes, unifiedRes] = await Promise.all([
      fetch('/api/viz/stats'),
      fetch('/api/viz/unified'),
    ]);
    const stats = await statsRes.json();
    const unified = await unifiedRes.json();

    // Stats bar
    document.getElementById('stats').innerHTML =
      `<span><b>${stats.entities}</b> entities</span>` +
      `<span><b>${stats.facts}</b> facts</span>` +
      `<span><b>${stats.causal_events}</b> events</span>` +
      `<span><b>${stats.causal_edges}</b> causal</span>`;

    // Preserve positions
    const posMap = {};
    for (const n of data.nodes) {
      if (n.x != null) posMap[n.id] = { x: n.x, y: n.y, vx: n.vx, vy: n.vy };
    }
    for (const n of unified.nodes) {
      if (posMap[n.id]) Object.assign(n, posMap[n.id]);
    }

    data = unified;

    // Compute time range from all timestamps
    const allTimes = [];
    for (const n of data.nodes) {
      if (n.occurredAt) allTimes.push(new Date(n.occurredAt).getTime());
    }
    for (const e of data.edges) {
      if (e.createdAt) allTimes.push(new Date(e.createdAt).getTime());
    }
    if (allTimes.length > 0) {
      timeRange.min = Math.min(...allTimes);
      timeRange.max = Math.max(...allTimes);
    }

    render();
  } catch (err) {
    console.error('Fetch failed:', err);
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  if (document.getElementById('autoRefresh').checked) {
    refreshTimer = setInterval(fetchData, 5000);
  }
}
function stopAutoRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

// ============================================================
// INIT
// ============================================================

// Layer toggles
document.querySelectorAll('.layer-toggle').forEach(el => {
  el.addEventListener('click', () => toggleLayer(el.dataset.layer));
});

document.getElementById('autoRefresh').addEventListener('change', startAutoRefresh);

// Click canvas background to unfocus + unpin tooltip
document.getElementById('graph').addEventListener('click', (e) => {
  if (e.target.tagName === 'svg') {
    if (focusedEntityId) toggleFocus(focusedEntityId);
    unpinTooltip();
  }
});

// Detail panel close
document.getElementById('detailClose').addEventListener('click', closeDetailPanel);

// Scrubber
const scrubberEl = document.getElementById('timeScrubber');
const scrubValueEl = document.getElementById('scrubValue');
scrubberEl.addEventListener('input', () => {
  const val = parseInt(scrubberEl.value);
  if (val >= 100 || !timeRange.min || !timeRange.max) {
    scrubberTime = null;
    scrubValueEl.textContent = 'Now';
  } else {
    const range = timeRange.max - timeRange.min;
    scrubberTime = timeRange.min + (val / 100) * range;
    const d = new Date(scrubberTime);
    scrubValueEl.textContent = d.toLocaleTimeString();
  }
  render();
});
document.getElementById('scrubReset').addEventListener('click', () => {
  scrubberEl.value = 100;
  scrubberTime = null;
  scrubValueEl.textContent = 'Now';
  render();
});

// Layout toggle (Force vs DAG)
document.querySelectorAll('.layout-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.layout-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    layoutMode = btn.dataset.layout;
    initSvg();
    render();
  });
});

initSvg();
fetchData();
startAutoRefresh();

window.addEventListener('resize', () => {
  const width = svg.node().clientWidth;
  const height = svg.node().clientHeight;
  simulation.force('center', d3.forceCenter(width / 2, height / 2));
  simulation.alpha(0.1).restart();
});

// ============================================================
// RESET / CLEAR
// ============================================================

async function doReset(endpoint, label) {
  if (!confirm(`${label}\n\nThis cannot be undone. Continue?`)) return;
  const btn = document.getElementById(endpoint === '/api/reset' ? 'btnResetAll' : 'btnClearGraph');
  const origText = btn.textContent;
  btn.textContent = 'Clearing…';
  btn.disabled = true;
  try {
    const res = await fetch(endpoint, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = { nodes: [], edges: [] };
    selectedId = null;
    focusedEntityId = null;
    scrubberTime = null;
    timeRange = { min: null, max: null };
    document.getElementById('timeScrubber').value = 100;
    document.getElementById('scrubValue').textContent = 'Now';
    closeDetailPanel();
    unpinTooltip();
    initSvg();
    render();
    await fetchData();
  } catch (err) {
    alert(`Reset failed: ${err.message}`);
  } finally {
    btn.textContent = origText;
    btn.disabled = false;
  }
}

document.getElementById('btnClearGraph').addEventListener('click', () =>
  doReset('/api/viz/clear', 'Clear graph: deletes all entities, facts, and causal data from PostgreSQL.')
);
document.getElementById('btnResetAll').addEventListener('click', () =>
  doReset('/api/reset', 'Reset all: deletes all PostgreSQL graph data AND all Qdrant vectors.')
);

// ============================================================
// GRAPH GARDENER
// ============================================================

async function doGarden() {
  const btn = document.getElementById('btnGarden');
  const origText = btn.textContent;
  btn.textContent = 'Gardening…';
  btn.disabled = true;
  try {
    const res = await fetch('/api/garden', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();

    if (result.triggered) {
      const report = result.report || '(no report)';
      const preview = report.length > 600 ? report.substring(0, 600) + '…' : report;
      alert(`Gardening complete! (${(result.durationMs / 1000).toFixed(1)}s)\n\n${preview}`);
      await fetchData();
    } else {
      alert(`Gardening failed: ${result.error || 'unknown error'}`);
    }
  } catch (err) {
    alert(`Gardening failed: ${err.message}`);
  } finally {
    btn.textContent = origText;
    btn.disabled = false;
  }
}

document.getElementById('btnGarden').addEventListener('click', doGarden);

// ============================================================
// RECONCILIATION
// ============================================================

async function doReconcile() {
  const btn = document.getElementById('btnReconcile');
  const origText = btn.textContent;
  btn.textContent = 'Reconciling…';
  btn.disabled = true;
  try {
    const res = await fetch('/api/reconcile', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();

    if (result.triggered) {
      alert(`Reconciliation complete!\n\nResolved ${result.candidateCount} candidate(s).\n\nReport:\n${result.report.substring(0, 500)}${result.report.length > 500 ? '...' : ''}`);
      // Refresh graph to show updated same_as links and merged entities
      await fetchData();
    } else {
      alert(`No merge candidates or unconfirmed aliases to reconcile.\n\n${result.message}`);
    }
  } catch (err) {
    alert(`Reconciliation failed: ${err.message}`);
  } finally {
    btn.textContent = origText;
    btn.disabled = false;
  }
}

document.getElementById('btnReconcile').addEventListener('click', doReconcile);

// ============================================================
// TEXT INGESTION
// ============================================================

document.getElementById('btnIngestToggle').addEventListener('click', () => {
  const panel = document.getElementById('ingestPanel');
  panel.classList.toggle('open');
  if (panel.classList.contains('open')) document.getElementById('ingestText').focus();
});

const MAX_CHUNK = 2000;

function chunkText(text) {
  if (text.length <= MAX_CHUNK) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > MAX_CHUNK) {
    // Find the last good break point within the limit
    let cut = -1;
    const slice = remaining.slice(0, MAX_CHUNK);
    cut = slice.lastIndexOf('\n\n');
    if (cut < 200) cut = slice.lastIndexOf('\n');
    if (cut < 200) cut = slice.lastIndexOf('. ');
    if (cut < 200) cut = slice.lastIndexOf(' ');
    if (cut < 200) cut = MAX_CHUNK; // hard cut
    else cut += 1; // include the break char
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function doIngest() {
  const textEl = document.getElementById('ingestText');
  const sourceEl = document.getElementById('ingestSource');
  const statusEl = document.getElementById('ingestStatus');
  const btn = document.getElementById('btnIngest');
  const text = textEl.value.trim();

  if (!text) {
    statusEl.className = 'ingest-status error';
    statusEl.textContent = 'No text to ingest';
    return;
  }

  const chunks = chunkText(text);
  const source = sourceEl.value.trim() || undefined;

  btn.textContent = `Queuing ${chunks.length} chunk${chunks.length > 1 ? 's' : ''}\u2026`;
  btn.disabled = true;
  statusEl.className = 'ingest-status';
  statusEl.textContent = '';

  try {
    for (const chunk of chunks) {
      const body = { text: chunk };
      if (source) body.source = source;

      const res = await fetch('/ingest/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
    }

    statusEl.className = 'ingest-status success';
    statusEl.textContent = chunks.length === 1
      ? 'Queued (1 chunk) \u2014 graph updates automatically'
      : `Queued (${chunks.length} chunks) \u2014 graph updates automatically`;
    textEl.value = '';
    sourceEl.value = '';
  } catch (err) {
    statusEl.className = 'ingest-status error';
    statusEl.textContent = err.message;
  } finally {
    btn.textContent = 'Ingest';
    btn.disabled = false;
  }
}

document.getElementById('btnIngest').addEventListener('click', doIngest);

// ============================================================
// REASONING AGENT
// ============================================================

async function doReason() {
  const btn = document.getElementById('btnReason');
  const origText = btn.textContent;
  btn.textContent = 'Reasoning\u2026';
  btn.disabled = true;
  try {
    const res = await fetch('/api/reason', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    showAnswer(`Patrol complete (${(data.durationMs / 1000).toFixed(1)}s)\n\n${data.result}`);
  } catch (err) {
    showAnswer(`Error: ${err.message}`);
  } finally {
    btn.textContent = origText;
    btn.disabled = false;
  }
}

document.getElementById('btnReason').addEventListener('click', doReason);

document.getElementById('btnQueryToggle').addEventListener('click', () => {
  const panel = document.getElementById('queryPanel');
  panel.classList.toggle('open');
  if (panel.classList.contains('open')) document.getElementById('queryInput').focus();
});

async function doQuery() {
  const input = document.getElementById('queryInput');
  const statusEl = document.getElementById('queryStatus');
  const btn = document.getElementById('btnQuery');
  const question = input.value.trim();

  if (!question) {
    statusEl.className = 'query-status error';
    statusEl.textContent = 'Enter a question';
    return;
  }

  btn.textContent = 'Thinking\u2026';
  btn.disabled = true;
  statusEl.className = 'query-status';
  statusEl.textContent = '';

  try {
    const res = await fetch('/api/reason/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    showAnswer(`Q: ${question}\n\n${data.result}`);
    input.value = '';
  } catch (err) {
    statusEl.className = 'query-status error';
    statusEl.textContent = err.message;
  } finally {
    btn.textContent = 'Ask';
    btn.disabled = false;
  }
}

document.getElementById('btnQuery').addEventListener('click', doQuery);
document.getElementById('queryInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doQuery();
});

function showAnswer(text) {
  const panel = document.getElementById('answerPanel');
  document.getElementById('answerContent').textContent = text;
  panel.classList.add('open');
}

document.getElementById('answerClose').addEventListener('click', () => {
  document.getElementById('answerPanel').classList.remove('open');
});
