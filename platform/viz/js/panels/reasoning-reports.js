// Reasoning reports panel (bead nmemo-2yv.81) — surfaces past patrol/query
// reasoning passes so the developer can audit the agent from the viz.
//
// Layout (mirrors patterns.js / contradictions.js / merge-candidates.js):
//   - Header row: total in window + time-since-last-patrol + mode breakdown
//     (cadence summary from GET /api/reasoning-reports/cadence)
//   - Mode filter chips: All / Patrol / Query
//   - Entity-filter chip: appears when an entity is focused on the canvas
//     (state.focusedEntityId). Clicking it pivots to the by-entity endpoint.
//   - List of reports DESC by created_at — each row clickable to open an
//     inline drawer with the full report markdown + actions_taken JSON.
//
// All endpoints are GET-only (causal-agent.ts MCP tool get_reasoning_history
// stays agent-internal per bead acceptance).

import { state } from '../state.js';
import { esc } from '../util.js';
import {
  getReasoningReports,
  getReasoningReportById,
  getReasoningReportsByEntity,
  getReasoningReportCadence,
} from '../api.js';

const MODE_FILTERS = [
  ['all', 'All'],
  ['patrol', 'Patrol'],
  ['query', 'Query'],
];

// Format ms-since-last in a human-readable form for the cadence header.
function fmtAge(ms) {
  if (ms == null) return '—';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

function fmtTs(s) {
  if (!s) return '—';
  return new Date(s).toLocaleString();
}

function renderCadence(cadence) {
  const host = document.getElementById('reasoningReportsCadence');
  if (!host) return;
  if (!cadence) {
    host.innerHTML = '<div class="cc-signals-empty">cadence: loading…</div>';
    return;
  }
  const patrolCount = cadence.byMode?.patrol ?? 0;
  const queryCount = cadence.byMode?.query ?? 0;
  const sinceLast = fmtAge(cadence.msSinceLastPatrol);
  const avg = cadence.avgDurationMs == null
    ? '—'
    : `${Math.round(cadence.avgDurationMs)}ms`;
  host.innerHTML = `
    <div class="rr-cadence">
      <span class="rr-cad-item"><b>${cadence.totalReports}</b> in last ${cadence.windowSize}</span>
      <span class="rr-cad-item">patrol <b>${patrolCount}</b></span>
      <span class="rr-cad-item">query <b>${queryCount}</b></span>
      <span class="rr-cad-item">last patrol <b>${esc(sinceLast)}</b></span>
      <span class="rr-cad-item">avg dur <b>${esc(avg)}</b></span>
    </div>
  `;
}

function renderModeChips() {
  const host = document.getElementById('reasoningReportsModeFilter');
  if (!host) return;
  const active = state.reasoningReportsModeFilter || 'all';
  host.innerHTML = MODE_FILTERS.map(([key, label]) => `
    <button class="pf-chip ${active === key ? 'active' : ''}" data-mode="${esc(key)}">${esc(label)}</button>
  `).join('');
  for (const chip of host.querySelectorAll('.pf-chip')) {
    chip.addEventListener('click', () => {
      state.reasoningReportsModeFilter = chip.getAttribute('data-mode');
      refreshReasoningReports({ force: true });
    });
  }
}

function renderEntityFilterChip() {
  const host = document.getElementById('reasoningReportsEntityFilter');
  if (!host) return;
  const focused = state.focusedEntityId;
  const enabled = state.reasoningReportsEntityFilterEnabled === true;
  if (!focused) {
    host.innerHTML = '<span class="rr-entity-hint">Focus an entity on the canvas to filter by it.</span>';
    return;
  }
  host.innerHTML = `
    <button class="pf-chip ${enabled ? 'active' : ''}" id="rrEntityChip">
      ${enabled ? '✓' : '○'} Filter by focused entity
    </button>
  `;
  const chip = document.getElementById('rrEntityChip');
  if (chip) {
    chip.addEventListener('click', () => {
      state.reasoningReportsEntityFilterEnabled = !enabled;
      refreshReasoningReports({ force: true });
    });
  }
}

function renderRow(row) {
  const modeTag = row.mode === 'query'
    ? '<span class="rr-mode rr-mode-query">QUERY</span>'
    : '<span class="rr-mode rr-mode-patrol">PATROL</span>';
  const question = row.question
    ? `<div class="rr-question">${esc(row.question)}</div>`
    : '';
  const dur = row.durationMs != null ? ` · ${row.durationMs}ms` : '';
  const inv = row.invocationId ? ' · idempotent' : '';
  return `
    <div class="ctrad-row rr-row" data-id="${esc(row.id)}">
      <div class="ctrad-row-head">
        <span class="ctrad-type">${modeTag}</span>
        <span class="rr-time">${esc(fmtTs(row.createdAt))}</span>
      </div>
      ${question}
      <div class="ctrad-reasoning">
        entities: ${row.entityCount} · facts: ${row.factCount} · edges: ${row.causalEdgeCount}${dur}${inv}
      </div>
      <div class="rr-detail" id="rrDetail_${esc(row.id)}" hidden></div>
    </div>
  `;
}

async function toggleDetail(reportId) {
  const drawer = document.getElementById(`rrDetail_${reportId}`);
  if (!drawer) return;
  if (!drawer.hidden) {
    drawer.hidden = true;
    drawer.innerHTML = '';
    return;
  }
  drawer.hidden = false;
  drawer.innerHTML = '<div class="cc-signals-empty">Loading report…</div>';
  try {
    const body = await getReasoningReportById(reportId);
    const actions = JSON.stringify(body.actionsTaken || {}, null, 2);
    drawer.innerHTML = `
      <div class="rr-detail-section">
        <div class="field-label">Report</div>
        <pre class="rr-report-body">${esc(body.report || '')}</pre>
      </div>
      <div class="rr-detail-section">
        <div class="field-label">actions_taken</div>
        <pre class="rr-actions-body">${esc(actions)}</pre>
      </div>
      ${(body.entityIds || []).length > 0 ? `
        <div class="rr-detail-section">
          <div class="field-label">entity_ids (${body.entityIds.length})</div>
          <div class="rr-id-list">${body.entityIds.map(id => `<code>${esc(id)}</code>`).join(' ')}</div>
        </div>
      ` : ''}
      ${(body.factIds || []).length > 0 ? `
        <div class="rr-detail-section">
          <div class="field-label">fact_ids (${body.factIds.length})</div>
          <div class="rr-id-list">${body.factIds.map(id => `<code>${esc(id)}</code>`).join(' ')}</div>
        </div>
      ` : ''}
      ${(body.causalEdgeIds || []).length > 0 ? `
        <div class="rr-detail-section">
          <div class="field-label">causal_edge_ids (${body.causalEdgeIds.length})</div>
          <div class="rr-id-list">${body.causalEdgeIds.map(id => `<code>${esc(id)}</code>`).join(' ')}</div>
        </div>
      ` : ''}
    `;
  } catch (err) {
    drawer.innerHTML = `<div class="cc-signals-empty">Failed: ${esc(err.message)}</div>`;
  }
}

function renderList(reports) {
  const list = document.getElementById('reasoningReportsList');
  const meta = document.getElementById('reasoningReportsMeta');
  if (!list || !meta) return;
  meta.textContent = `${reports.length} report${reports.length === 1 ? '' : 's'}`;
  if (reports.length === 0) {
    list.innerHTML = '<div class="ctrad-empty">No reasoning reports match the current filter.</div>';
    return;
  }
  list.innerHTML = reports.map(renderRow).join('');
  for (const row of list.querySelectorAll('.rr-row')) {
    const id = row.getAttribute('data-id');
    row.addEventListener('click', (e) => {
      // Don't toggle when clicking inside an already-open drawer.
      if (e.target.closest('.rr-detail') && !e.target.closest('.rr-row-head')) return;
      toggleDetail(id);
    });
    // Keyboard navigation: enter/space toggles the row's drawer.
    row.tabIndex = 0;
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleDetail(id);
      }
    });
  }
}

// Pull reports + cadence. The panel only re-renders when open or when forced
// (filter chip click). The badge stays current in either case so the user
// knows when new reports land.
export async function refreshReasoningReports(opts = {}) {
  const panel = document.getElementById('reasoningReportsPanel');
  const isOpen = panel && panel.classList.contains('open');
  if (!isOpen && !opts.force) {
    // Cheap cadence-only refresh so the badge stays current.
    try {
      const cadence = await getReasoningReportCadence();
      const badge = document.getElementById('reasoningReportsBadge');
      if (badge) {
        badge.textContent = String(cadence.totalReports);
        badge.classList.toggle('zero', cadence.totalReports === 0);
      }
    } catch {
      // best-effort
    }
    return;
  }
  try {
    const useEntityFilter = state.reasoningReportsEntityFilterEnabled === true && state.focusedEntityId;
    const mode = state.reasoningReportsModeFilter;
    const [cadence, listBody] = await Promise.all([
      getReasoningReportCadence(),
      useEntityFilter
        ? getReasoningReportsByEntity(state.focusedEntityId, 50)
        : getReasoningReports(50, mode === 'patrol' || mode === 'query' ? mode : null),
    ]);
    const badge = document.getElementById('reasoningReportsBadge');
    if (badge) {
      badge.textContent = String(cadence.totalReports);
      badge.classList.toggle('zero', cadence.totalReports === 0);
    }
    if (isOpen) {
      renderCadence(cadence);
      renderModeChips();
      renderEntityFilterChip();
      renderList(listBody.reports || []);
    }
  } catch {
    // best-effort — panel failure must not break the viz.
  }
}

export function bindReasoningReportsPanel() {
  const open = document.getElementById('btnReasoningReports');
  if (open) {
    open.addEventListener('click', async () => {
      const panel = document.getElementById('reasoningReportsPanel');
      panel.classList.toggle('open');
      if (panel.classList.contains('open')) {
        renderModeChips();
        renderEntityFilterChip();
        await refreshReasoningReports({ force: true });
      }
    });
  }
  const close = document.getElementById('reasoningReportsClose');
  if (close) {
    close.addEventListener('click', () => {
      document.getElementById('reasoningReportsPanel').classList.remove('open');
    });
  }
}
