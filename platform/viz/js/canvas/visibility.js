import { state } from '../state.js';
import { renderAll } from './render.js';

export function isBeforeScrubber(timestamp) {
  if (!state.scrubberTime || !timestamp) return true;
  return new Date(timestamp).getTime() <= state.scrubberTime;
}

export function isNodeVisible(n) {
  const layers = state.layers;
  if (n._nodeType === 'entity' || n._nodeType === 'value') return true;
  if (n._nodeType === 'causalEvent') {
    if (!layers.causal) return false;
    return isBeforeScrubber(n.occurredAt);
  }
  if (n._nodeType === 'sourceMemory') return layers.source;
  return true;
}

export function isEdgeVisible(e) {
  const layers = state.layers;
  if (e._edgeType === 'fact') return layers.fact && isBeforeScrubber(e.createdAt);
  if (e._edgeType === 'causal') return layers.causal && isBeforeScrubber(e.createdAt);
  if (e._edgeType === 'causalAnchor') {
    if (!layers.causal) return false;
    const eventNode = state.data.nodes.find(n => n.id === e.target || n.id === e.target?.id);
    return eventNode ? isNodeVisible(eventNode) : true;
  }
  if (e._edgeType === 'sourceLink') return layers.source;
  if (e._edgeType === 'mergeCandidate') return layers.merge;
  if (e._edgeType === 'sameAs') return layers.sameAs;
  return true;
}

export function toggleLayer(layerName) {
  state.layers[layerName] = !state.layers[layerName];
  const el = document.querySelector(`[data-layer="${layerName}"]`);
  if (el) el.classList.toggle('active', state.layers[layerName]);
  renderAll();
}

export function bindLayerToggles() {
  document.querySelectorAll('.layer-toggle').forEach(el => {
    el.addEventListener('click', () => toggleLayer(el.dataset.layer));
  });
}
