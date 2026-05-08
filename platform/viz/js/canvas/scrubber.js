import { state } from '../state.js';
import { renderAll } from './render.js';

export function bindScrubber() {
  const scrubberEl = document.getElementById('timeScrubber');
  const scrubValueEl = document.getElementById('scrubValue');
  scrubberEl.addEventListener('input', () => {
    const val = parseInt(scrubberEl.value);
    if (val >= 100 || !state.timeRange.min || !state.timeRange.max) {
      state.scrubberTime = null;
      scrubValueEl.textContent = 'Now';
    } else {
      const range = state.timeRange.max - state.timeRange.min;
      state.scrubberTime = state.timeRange.min + (val / 100) * range;
      const d = new Date(state.scrubberTime);
      scrubValueEl.textContent = d.toLocaleTimeString();
    }
    renderAll();
  });
  document.getElementById('scrubReset').addEventListener('click', () => {
    scrubberEl.value = 100;
    state.scrubberTime = null;
    scrubValueEl.textContent = 'Now';
    renderAll();
  });
}

export function resetScrubber() {
  state.scrubberTime = null;
  state.timeRange = { min: null, max: null };
  const el = document.getElementById('timeScrubber');
  const val = document.getElementById('scrubValue');
  if (el) el.value = 100;
  if (val) val.textContent = 'Now';
}

export function recomputeTimeRange() {
  let tMin = Infinity, tMax = -Infinity;
  for (const n of state.data.nodes) {
    if (!n.occurredAt) continue;
    const t = new Date(n.occurredAt).getTime();
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }
  for (const e of state.data.edges) {
    if (!e.createdAt) continue;
    const t = new Date(e.createdAt).getTime();
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }
  if (tMin !== Infinity) {
    state.timeRange.min = tMin;
    state.timeRange.max = tMax;
  }
}
