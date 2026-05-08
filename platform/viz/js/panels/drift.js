// Drift timeline (viz.7) — bottom-of-canvas overlay surfacing
// entity_drift_events (mig 016).
//
// Each event renders as a dot on a horizontal time axis:
//   color = triggered_action ('logged_only' / 'reconciliation_invoked' /
//                             'reconciliation_failed')
//   size  = drift_magnitude   (clamped 0..1, scaled to 4..12 px radius)
// Click a dot → focus on the entity, open its detail panel.
//
// The strip is collapsible. The toggle lives on the canvas footer.

import { state } from '../state.js';
import { esc } from '../util.js';
import { getDriftEvents, computeDrift } from '../api.js';
import { showNodeDetail } from './detail.js';
import { toggleFocus } from '../canvas/focus.js';

const ACTION_COLOR = {
  logged_only: '#8b949e',
  reconciliation_invoked: '#58a6ff',
  reconciliation_failed: '#f85149',
};

let driftEvents = [];
let collapsed = false;

export async function refreshDrift() {
  if (collapsed) return; // skip work while strip is hidden
  try {
    const body = await getDriftEvents(200);
    driftEvents = body.events || [];
    renderStrip();
  } catch {
    // best-effort
  }
}

function renderStrip() {
  const container = document.getElementById('driftStripCanvas');
  const meta = document.getElementById('driftStripMeta');
  if (!container || !meta) return;

  const events = driftEvents;
  meta.textContent = events.length === 0
    ? 'no drift events yet'
    : `${events.length} events`;
  if (events.length === 0) {
    container.innerHTML = '';
    return;
  }

  // Time axis: oldest event on the left, newest on the right.
  const times = events.map((e) => new Date(e.detected_at).getTime());
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const range = tMax - tMin || 1;
  const width = container.clientWidth || 800;

  const dots = events.map((e) => {
    const t = new Date(e.detected_at).getTime();
    const x = ((t - tMin) / range) * (width - 16) + 8;
    const r = 3 + Math.min(1, Math.max(0, e.drift_magnitude || 0)) * 9;
    const color = ACTION_COLOR[e.triggered_action] || '#8b949e';
    return `
      <circle class="drift-dot"
              cx="${x.toFixed(1)}" cy="14" r="${r.toFixed(1)}"
              fill="${color}" fill-opacity="0.8"
              stroke="${color}" stroke-width="1"
              data-entity="${esc(e.entity_id)}"
              data-event="${esc(e.event_id)}"
              data-mag="${(e.drift_magnitude || 0).toFixed(3)}"
              data-action="${esc(e.triggered_action)}"
              data-detected="${esc(e.detected_at)}"></circle>
    `;
  }).join('');

  container.innerHTML = `
    <svg width="100%" height="28" preserveAspectRatio="none" viewBox="0 0 ${width} 28">
      <line x1="0" y1="14" x2="${width}" y2="14" stroke="#21262d" stroke-width="1"/>
      ${dots}
    </svg>
  `;

  for (const el of container.querySelectorAll('circle.drift-dot')) {
    el.addEventListener('click', () => onDotClick(el));
    el.addEventListener('mouseover', (e) => onDotHover(e, el));
    el.addEventListener('mouseout', () => {
      const tip = document.getElementById('tooltip');
      if (tip && !state.tooltipPinned) tip.style.display = 'none';
    });
  }
}

function onDotHover(e, el) {
  const tip = document.getElementById('tooltip');
  if (!tip || state.tooltipPinned) return;
  tip.textContent = `${el.dataset.action}\nmag ${el.dataset.mag}\n${new Date(el.dataset.detected).toLocaleString()}`;
  tip.style.display = 'block';
  tip.style.left = e.pageX + 12 + 'px';
  tip.style.top = e.pageY - 60 + 'px';
}

function onDotClick(el) {
  const entityId = el.dataset.entity;
  if (!entityId) return;
  // Focus the entity node on the canvas + open its detail panel. We look
  // up the node by id in the live data so the tick handler keeps it in
  // sync with the simulation.
  const node = state.data.nodes.find((n) => n.id === entityId);
  if (node) {
    if (node._nodeType === 'entity') {
      // Toggle off any prior focus, then focus this one.
      if (state.focusedEntityId && state.focusedEntityId !== entityId) {
        toggleFocus(state.focusedEntityId);
      }
      state.selectedId = entityId;
      showNodeDetail(node);
    }
  }
}

function bindToggle() {
  const btn = document.getElementById('driftStripToggle');
  if (!btn) return;
  btn.addEventListener('click', () => {
    collapsed = !collapsed;
    document.getElementById('driftStrip').classList.toggle('collapsed', collapsed);
    btn.textContent = collapsed ? '▴ drift' : '▾ drift';
    if (!collapsed) refreshDrift();
  });
}

async function bindCompute() {
  const btn = document.getElementById('btnDriftCompute');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const orig = btn.textContent;
    btn.textContent = '…';
    btn.disabled = true;
    try {
      await computeDrift();
      await refreshDrift();
    } catch (err) {
      alert(`Drift compute failed: ${err.message}`);
    } finally {
      btn.textContent = orig;
      btn.disabled = false;
    }
  });
}

export function bindDriftStrip() {
  bindToggle();
  bindCompute();
}
