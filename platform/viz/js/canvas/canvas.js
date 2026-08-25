// Canvas 2D renderer for the high-count graph bulk (viz-perf goal).
//
// Why this exists: the SVG renderer repaints thousands of <line>/<g>/<text>
// elements every simulation tick. Profiling showed the per-tick JS was ~6ms
// but the browser's SVG style-recalc + layout + paint was ~890ms — ~1-12 FPS
// at the arxiv-nlp workload (3,052 nodes / 3,370 edges). Immediate-mode canvas
// draws the same primitives in a few ms with no per-element layout.
//
// Scope: this module draws the always-on, high-count layers — entity / value /
// causalEvent nodes and fact / causal / causalAnchor edges, plus their labels
// and arrowheads — and owns pan / zoom / hover / click / drag / focus for them
// via a quadtree hit-test. The low-count, off-by-default layers (source, merge,
// sameAs) and the decorative overlays (topology, cluster hulls, ghosts,
// contradictions, bridges) stay on the SVG that sits above the canvas, driven
// by render.js exactly as before. Both surfaces share one pan/zoom transform.
//
// INVARIANT: canvas draws every node and edge it is handed — there is no cap,
// cull, or level-of-detail on the node/edge primitives. render.js hands it the
// full visible set; the drawn count therefore equals the payload (minus only
// the explicit layer toggles, which are a separate mode, not a speed cull).

import { state, COLOR_TRANSITION } from '../state.js';
import { nodeRadius } from './simulation.js';
import { edgeEndpoint } from './edge-utils.js';
import { resolveEntityColor, resolveEntityStrokeOpacity } from '../layers/topology.js';
import { showNodeDetail, showEdgeDetail } from '../panels/detail.js';
import { pinTooltipForNode, unpinTooltip, updatePinnedTooltipPosition } from './tooltip.js';
import { toggleFocus } from './focus.js';

// Node / edge types this canvas owns. Everything else renders on the SVG.
const CANVAS_NODE_TYPES = new Set(['entity', 'value', 'causalEvent']);
const CANVAS_EDGE_TYPES = new Set(['fact', 'causal', 'causalAnchor']);

// Shared pan/zoom transform (screen = translate(tx,ty) . scale(tk)). Kept in
// lock-step with the SVG <g> transform so tooltip.updatePinnedTooltipPosition
// (which reads the <g> CTM) and the SVG overlays stay aligned with the canvas.
let tk = 1, tx = 0, ty = 0;
const MIN_K = 0.05, MAX_K = 5;

let canvas = null;      // HTMLCanvasElement
let ctx = null;         // 2D context
let dpr = 1;
let sceneNodes = [];    // canvas-owned nodes to draw (entity/value/causalEvent)
let sceneEdges = [];    // canvas-owned edges to draw (fact/causal/causalAnchor)
let quadtree = null;    // rebuilt lazily from node positions on interaction
let quadDirty = true;
let hoverNodeId = null; // node under the pointer (edge-dim highlight + tooltip)
let wired = false;      // interaction handlers attached once

// --- setup ---------------------------------------------------------------

// Create the canvas element (once) as a sibling behind the SVG, size it to the
// SVG's box at devicePixelRatio, and wire interactions. Called from initSvg.
export function ensureCanvas() {
  const svg = state.refs.svg;
  if (!svg) return;
  const svgNode = svg.node();
  if (!canvas) {
    canvas = document.getElementById('graphCanvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'graphCanvas';
      svgNode.parentNode.insertBefore(canvas, svgNode); // behind the SVG
    }
    ctx = canvas.getContext('2d');
  }
  resizeCanvas();
  // Wire interactions on the .graph-wrap container (not the SVG): a div reliably
  // receives pointer events over its whole box, including where the transparent
  // SVG on top is unpainted. Painted SVG-layer children still bubble up with
  // their own event.target, so onSvgLayerElement() can defer to them.
  if (!wired) { wireInteractions(svgNode.parentNode); wired = true; }
}

export function resizeCanvas() {
  if (!canvas) return;
  const svgNode = state.refs.svg.node();
  const w = svgNode.clientWidth, h = svgNode.clientHeight;
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  drawScene();
}

// Hand the canvas the current visible bulk. render.js filters to exactly the
// nodes/edges that pass isNodeVisible/isEdgeVisible, so drawing all of them
// keeps drawn == payload for the enabled layers.
export function setSceneData(nodes, edges) {
  sceneNodes = nodes.filter(n => CANVAS_NODE_TYPES.has(n._nodeType));
  sceneEdges = edges.filter(e => CANVAS_EDGE_TYPES.has(e._edgeType));
  quadDirty = true;
}

export function getTransform() { return { k: tk, x: tx, y: ty }; }

// Apply the shared transform to the SVG <g> too, so overlays + the pinned
// tooltip's CTM math track the canvas.
function syncGroupTransform() {
  const g = state.refs.g;
  if (g) g.attr('transform', `translate(${tx},${ty}) scale(${tk})`);
}

// --- draw ----------------------------------------------------------------

// Draw-count instrument for the invariant check: how many primitives the last
// draw actually rendered. edges/nodes here must equal the visible canvas-owned
// payload counts — proof the canvas caps/culls nothing.
let lastDraw = { edges: 0, nodes: 0, factLabels: 0, entityLabels: 0 };
export function getDrawCounts() {
  return { ...lastDraw, sceneEdges: sceneEdges.length, sceneNodes: sceneNodes.length };
}

export function drawScene() {
  if (!ctx) return;
  let dEdges = 0, dNodes = 0, dFactLabels = 0, dEntityLabels = 0;
  const cssW = canvas.width / dpr, cssH = canvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.translate(tx, ty);
  ctx.scale(tk, tk);

  const focusOn = !!state.focusedEntityId;
  const connected = focusOn ? state.focusConnected : null;
  const dimEdge = (e) => focusOn && connected
    ? (connected.has(edgeEndpoint(e.source)) && connected.has(edgeEndpoint(e.target)))
    : true;
  const dimNode = (n) => focusOn && connected ? connected.has(n.id) : true;

  // Hover: dim edges not incident to the hovered node (mirrors the SVG
  // mouseover behaviour of 0.9 incident / 0.1 rest).
  const hover = hoverNodeId;

  // 1) edges (back). Line-width is in graph units; divide by nothing — d3
  //    positions are graph coords and the ctx scale handles zoom.
  for (const e of sceneEdges) {
    const s = e.source, t = e.target;
    if (!s || !t || s.x == null || t.x == null) continue;
    let stroke, width, alpha, dash = null;
    if (e._edgeType === 'fact') {
      stroke = e._staged ? '#d29922' : '#3d444d';
      width = e._staged ? 1.2 : 1;
      alpha = e._staged ? 0.5 : 0.4;
      if (e._staged) dash = [5, 4];
    } else if (e._edgeType === 'causalAnchor') {
      stroke = '#21262d'; width = 0.5; alpha = 0.15; dash = [2, 4];
    } else { // causal
      stroke = redsInterp(0.3 + (e.strength || 0.5) * 0.4);
      width = 1 + (e.strength || 0.5) * 2 + Math.log2(Math.max(1, e.corroborationCount || 1));
      alpha = 0.6;
    }
    if (!dimEdge(e)) alpha *= 0.12;
    else if (hover) alpha = (edgeEndpoint(s) === hover || edgeEndpoint(t) === hover) ? Math.min(0.95, alpha + 0.5) : alpha * 0.25;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    if (dash) ctx.setLineDash(dash); else ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(t.x, t.y);
    ctx.stroke();
    dEdges++;
    // arrowhead for fact + causal (parity with the SVG markers)
    if (e._edgeType !== 'causalAnchor') {
      drawArrow(s.x, s.y, t.x, t.y, nodeRadius(t), e._edgeType === 'causal' ? '#e5534b' : '#484f58', width);
    }
  }
  ctx.setLineDash([]);

  // 2) nodes
  for (const n of sceneNodes) {
    if (n.x == null) continue;
    const r = nodeRadius(n);
    const selected = n.id === state.selectedId;
    let fill, stroke, sw, alpha;
    if (n._nodeType === 'entity') {
      fill = n._staged ? '#d29922' : resolveEntityColor(n);
      stroke = selected ? '#fff' : (n._staged ? '#8a6d1a' : '#21262d');
      sw = selected ? 3 : 1.5 + Math.min(n.factCount || 0, 10) * 0.2;
      alpha = n._staged ? 0.55 : resolveEntityStrokeOpacity(n);
    } else if (n._nodeType === 'value') {
      fill = '#555e68';
      stroke = selected ? '#fff' : '#21262d';
      sw = 1.5; alpha = 0.7;
    } else { // causalEvent
      fill = COLOR_TRANSITION[n.transitionType] || '#95a5a6';
      stroke = '#21262d'; sw = 1.5; alpha = 0.75;
    }
    if (!dimNode(n)) alpha *= 0.15;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, TWO_PI);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = sw;
    ctx.strokeStyle = stroke;
    ctx.stroke();
    dNodes++;
  }

  // 3) labels (front). Fact-edge predicate labels + entity name labels — both
  //    are on by default (parity with the SVG renderer). Canvas text is far
  //    cheaper than SVG text; no thinning.
  ctx.globalAlpha = 1;
  ctx.textBaseline = 'middle';
  ctx.font = '9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillStyle = '#484f58';
  ctx.textAlign = 'center';
  for (const e of sceneEdges) {
    if (e._edgeType !== 'fact' || !e.predicate) continue;
    const s = e.source, t = e.target;
    if (!s || !t || s.x == null) continue;
    if (!dimEdge(e)) continue; // faded edges drop their label (matches .faded)
    ctx.fillText(e.predicate, (s.x + t.x) / 2, (s.y + t.y) / 2);
    dFactLabels++;
  }
  ctx.textAlign = 'left';
  ctx.font = '500 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  for (const n of sceneNodes) {
    if (n._nodeType !== 'entity' || !n.label || n.x == null) continue;
    if (!dimNode(n)) continue;
    ctx.fillStyle = n._staged ? '#e0b050' : '#c9d1d9';
    ctx.fillText(n.label, n.x + nodeRadius(n) + 4, n.y);
    dEntityLabels++;
  }
  lastDraw = { edges: dEdges, nodes: dNodes, factLabels: dFactLabels, entityLabels: dEntityLabels };
}

const TWO_PI = Math.PI * 2;

// d3.interpolateReds without pulling the whole d3 scale-chromatic in — the two
// endpoints used by the causal-edge colour ramp are enough. Falls back to d3 if
// present (it is, via the CDN global) for exact parity.
function redsInterp(t) {
  return (typeof d3 !== 'undefined' && d3.interpolateReds) ? d3.interpolateReds(t) : '#e5534b';
}

// Small filled arrowhead just short of the target node's rim.
function drawArrow(sx, sy, txx, tyy, targetR, color, width) {
  const dx = txx - sx, dy = tyy - sy;
  const len = Math.hypot(dx, dy);
  if (len < 1e-3) return;
  const ux = dx / len, uy = dy / len;
  const tipX = txx - ux * (targetR + 1), tipY = tyy - uy * (targetR + 1);
  const size = Math.max(3, 2 + width);
  const ax = -uy, ay = ux; // perpendicular
  ctx.globalAlpha = Math.min(1, (ctx.globalAlpha || 0.6) + 0.2);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - ux * size + ax * size * 0.6, tipY - uy * size + ay * size * 0.6);
  ctx.lineTo(tipX - ux * size - ax * size * 0.6, tipY - uy * size - ay * size * 0.6);
  ctx.closePath();
  ctx.fill();
}

// --- interaction ---------------------------------------------------------

function rebuildQuadtree() {
  quadtree = d3.quadtree()
    .x(n => n.x)
    .y(n => n.y)
    .addAll(sceneNodes.filter(n => n.x != null));
  quadDirty = false;
}

// screen (CSS px, relative to the svg box) -> graph coords
function toGraph(px, py) { return [(px - tx) / tk, (py - ty) / tk]; }

function pointerPx(event) {
  const rect = state.refs.svg.node().getBoundingClientRect();
  return [event.clientX - rect.left, event.clientY - rect.top];
}

// Nearest node within its own radius (+2px slop) of the pointer, or null.
function pickNode(event) {
  if (quadDirty || !quadtree) rebuildQuadtree();
  if (!quadtree) return null;
  const [px, py] = pointerPx(event);
  const [gx, gy] = toGraph(px, py);
  // search radius in graph units — generous enough for the biggest node
  const found = quadtree.find(gx, gy, 40 / tk + 20);
  if (!found || found.x == null) return null;
  const r = nodeRadius(found);
  return (Math.hypot(found.x - gx, found.y - gy) <= r + 2 / tk) ? found : null;
}

// Nearest pickable edge (fact/causal) within a few px of the pointer, or null.
function pickEdge(event) {
  const [px, py] = pointerPx(event);
  const [gx, gy] = toGraph(px, py);
  const thresh = 4 / tk;
  let best = null, bestD = thresh;
  for (const e of sceneEdges) {
    if (e._edgeType === 'causalAnchor') continue; // not interactive
    const s = e.source, t = e.target;
    if (!s || !t || s.x == null) continue;
    const d = distToSegment(gx, gy, s.x, s.y, t.x, t.y);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// True when the pointer is over an SVG-layer element that owns its own handlers
// (source nodes, and the source/merge/sameAs edges + labels). Those keep their
// per-element SVG interactions; the canvas defers rather than double-handling.
function onSvgLayerElement(event) {
  const t = event.target;
  return !!(t && t.closest && t.closest('g.node, line.edge, text.edge-label'));
}

function wireInteractions(svgNode) {
  let mode = null;            // 'drag' | 'pan' | null
  let dragNode = null;
  let panStart = null;        // {px, py, tx, ty}
  let downAt = null;          // {px, py} for click-vs-drag discrimination
  let moved = false;
  const sim = () => state.refs.simulation;

  svgNode.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (onSvgLayerElement(event)) return; // SVG-layer element owns this gesture
    const [px, py] = pointerPx(event);
    downAt = { px, py }; moved = false;
    const node = pickNode(event);
    if (node) {
      mode = 'drag'; dragNode = node;
      const s = sim();
      if (s) { if (!event.shiftKey) s.alphaTarget(0.3).restart(); }
      // release a ring-pinned causal event so the drag sticks (parity w/ pd5.8)
      if (state.forces.causalRadial && node._nodeType === 'causalEvent') node._radialReleased = true;
      const [gx, gy] = toGraph(px, py);
      node.fx = gx; node.fy = gy;
    } else {
      mode = 'pan'; panStart = { px, py, tx, ty };
    }
    svgNode.setPointerCapture(event.pointerId);
  });

  svgNode.addEventListener('pointermove', (event) => {
    const [px, py] = pointerPx(event);
    if (mode === 'drag' && dragNode) {
      moved = true;
      const [gx, gy] = toGraph(px, py);
      dragNode.fx = gx; dragNode.fy = gy;
      quadDirty = true;
      return;
    }
    if (mode === 'pan' && panStart) {
      moved = true;
      tx = panStart.tx + (px - panStart.px);
      ty = panStart.ty + (py - panStart.py);
      syncGroupTransform();
      if (updatePinnedTooltipPosition) updatePinnedTooltipPosition();
      drawScene();
      return;
    }
    // hover (no button down)
    if (onSvgLayerElement(event)) { if (hoverNodeId !== null) { hoverNodeId = null; drawScene(); } return; }
    const node = pickNode(event);
    const newHover = node ? node.id : null;
    if (node) {
      hoverNodeId = newHover;
      showHoverTooltip(node, event);
      drawScene();
    } else {
      const edge = pickEdge(event);
      if (hoverNodeId !== null) { hoverNodeId = null; drawScene(); }
      if (edge) showEdgeTooltip(edge, event); else hideHoverTooltip();
    }
  });

  const endGesture = (event) => {
    if (mode === 'drag' && dragNode) {
      const s = sim();
      if (s && !event.shiftKey) s.alphaTarget(0);
      applyDropPin(dragNode, dragNode.fx, dragNode.fy);
      quadDirty = true;
    }
    mode = null; dragNode = null; panStart = null;
    try { svgNode.releasePointerCapture(event.pointerId); } catch (e) {}
  };
  svgNode.addEventListener('pointerup', endGesture);
  svgNode.addEventListener('pointercancel', endGesture);

  // Click = pointerdown+up without a meaningful move. Select node / edge, or
  // clear on background.
  svgNode.addEventListener('click', (event) => {
    if (moved) return; // it was a drag/pan
    if (onSvgLayerElement(event)) return; // SVG-layer element handles its own click
    const node = pickNode(event);
    if (node) {
      state.selectedId = node.id;
      showNodeDetail(node);
      if ((node._nodeType === 'value' || node._nodeType === 'causalEvent') && node.label) pinTooltipForNode(node);
      else unpinTooltip();
      drawScene();
      return;
    }
    const edge = pickEdge(event);
    if (edge) {
      state.selectedId = edge.id;
      unpinTooltip();
      showEdgeDetail(edge);
      drawScene();
      return;
    }
    // background
    if (state.focusedEntityId) toggleFocus(state.focusedEntityId);
    unpinTooltip();
    state.selectedId = null;
    drawScene();
  });

  svgNode.addEventListener('dblclick', (event) => {
    if (onSvgLayerElement(event)) return;
    const node = pickNode(event);
    if (node && node._nodeType === 'entity') toggleFocus(node.id);
  });

  // Wheel zoom about the cursor.
  svgNode.addEventListener('wheel', (event) => {
    event.preventDefault();
    const [px, py] = pointerPx(event);
    const [gx, gy] = toGraph(px, py);
    const factor = Math.pow(1.0015, -event.deltaY);
    const nk = Math.max(MIN_K, Math.min(MAX_K, tk * factor));
    // keep the graph point under the cursor fixed: px = tx + gx*nk
    tx = px - gx * nk;
    ty = py - gy * nk;
    tk = nk;
    syncGroupTransform();
    if (updatePinnedTooltipPosition) updatePinnedTooltipPosition();
    drawScene();
  }, { passive: false });
}

// Drop logic parity with render.js's drag end: ring-pinned causal events and
// pinned articulation entities keep their dropped position; everything else
// rejoins the force layout.
function applyDropPin(node, x, y) {
  const ring = state.forces.causalRadial && node._nodeType === 'causalEvent';
  const artic = state.forces.articulationPins && state.topology.loaded
    && node._nodeType === 'entity' && !!state.topology.entities[node.id]?.isArticulationPoint;
  if (ring || artic) { node.fx = x; node.fy = y; }
  else { node.fx = null; node.fy = null; }
}

function showHoverTooltip(node, event) {
  const tip = document.getElementById('tooltip');
  if (!tip || state.tooltipPinned) return;
  tip.textContent = node.label || '';
  tip.style.display = node.label ? 'block' : 'none';
  tip.style.left = event.pageX + 12 + 'px';
  tip.style.top = event.pageY - 12 + 'px';
}

function showEdgeTooltip(edge, event) {
  if (state.tooltipPinned) return;
  const tip = document.getElementById('tooltip');
  if (!tip) return;
  let text = '';
  if (edge._edgeType === 'fact') {
    text = edge.predicate || '';
    if (edge.sourceText) text += '\n\n' + edge.sourceText.slice(0, 200);
  } else if (edge._edgeType === 'causal') {
    const count = edge.corroborationCount ?? 1;
    text = `Strength: ${(edge.strength || 0).toFixed(2)}  •  Corroborations: ${count}\n\n${(edge.reasoning || '').slice(0, 200)}`;
  }
  if (!text) { hideHoverTooltip(); return; }
  tip.textContent = text;
  tip.style.display = 'block';
  tip.style.left = event.pageX + 12 + 'px';
  tip.style.top = event.pageY - 12 + 'px';
}

function hideHoverTooltip() {
  if (state.tooltipPinned) return;
  const tip = document.getElementById('tooltip');
  if (tip) tip.style.display = 'none';
}

// Mark the quadtree stale (called from the tick loop when positions move).
export function invalidateQuadtree() { quadDirty = true; }
