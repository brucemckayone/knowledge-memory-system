import { state } from '../state.js';
import { nodeRadius } from './simulation.js';

export function showTooltip(e, d) {
  if (state.tooltipPinned) return;
  if (d._edgeType === 'sourceLink' || d._edgeType === 'causalAnchor') return;
  const tip = document.getElementById('tooltip');
  let text = '';
  if (d._edgeType === 'fact') {
    text = d.predicate || '';
    if (d.sourceText) text += '\n\n' + d.sourceText.slice(0, 200);
  } else if (d._edgeType === 'causal') {
    // Bead nmemo-e2i.9 — surface corroboration alongside strength so the
    // hover signal matches the visual stroke-width (mapped from
    // corroborationCount in render.js). Falls back to count=1 when the
    // payload is missing the field (older endpoints / sample data).
    const count = d.corroborationCount ?? 1;
    let header = `Strength: ${(d.strength || 0).toFixed(2)}  •  Corroborations: ${count}`;
    if (d.lastCorroborated) {
      const last = new Date(d.lastCorroborated);
      if (!Number.isNaN(last.getTime())) {
        header += `\nLast corroborated: ${last.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
      }
    }
    text = `${header}\n\n${(d.reasoning || '').slice(0, 200)}`;
  } else if (d._edgeType === 'mergeCandidate') {
    text = `Score: ${(d.combinedScore || 0).toFixed(2)} [${d.status}]`;
  }
  if (!text) return;
  tip.textContent = text;
  tip.style.display = 'block';
  tip.style.left = e.pageX + 12 + 'px';
  tip.style.top = e.pageY - 12 + 'px';
}

export function hideTooltip() {
  if (state.tooltipPinned) return;
  document.getElementById('tooltip').style.display = 'none';
}

export function unpinTooltip() {
  state.tooltipPinned = false;
  state.tooltipPinnedNode = null;
  document.getElementById('tooltip').style.display = 'none';
}

export function pinTooltipForNode(d) {
  state.tooltipPinned = true;
  state.tooltipPinnedNode = d;
  const tip = document.getElementById('tooltip');
  tip.textContent = d.label || '';
  tip.style.display = 'block';
  updatePinnedTooltipPosition();
}

export function updatePinnedTooltipPosition() {
  if (!state.tooltipPinned || !state.tooltipPinnedNode) return;
  const d = state.tooltipPinnedNode;
  if (d.x == null || d.y == null) return;

  const svgEl = state.refs.svg.node();
  const gEl = state.refs.g.node();
  const ctm = gEl.getCTM();
  if (!ctm) return;

  const svgRect = svgEl.getBoundingClientRect();
  const screenX = svgRect.left + ctm.a * d.x + ctm.e;
  const screenY = svgRect.top + ctm.d * d.y + ctm.f;

  const tip = document.getElementById('tooltip');
  tip.style.left = (screenX + nodeRadius(d) + 8) + 'px';
  tip.style.top = (screenY - 8) + 'px';
}
