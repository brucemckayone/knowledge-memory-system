// History panel module (viz.6) — renders fact_history / causal_edge_history
// rows as a vertical timeline inside the existing detail panel. Mounted
// inline by detail.js below the main fact/edge fields.

import { esc } from '../util.js';
import { getFactHistory, getCausalEdgeHistory } from '../api.js';

const ACTOR_COLOR = {
  graph_agent: '#58a6ff',
  reasoning_agent: '#9b59b6',
  gardener_agent: '#27ae60',
  reconciliation_agent: '#f0883e',
  user: '#c9d1d9',
  system_trigger: '#8b949e',
  cascade: '#d29922',
};

function fmtConf(x) { return x == null ? '—' : Number(x).toFixed(2); }
function fmtStrength(x) { return x == null ? '—' : Number(x).toFixed(3); }
function fmtTs(s) { return s ? new Date(s).toLocaleString() : '—'; }

function diffRow(label, before, after) {
  if (before == null && after == null) return '';
  return `<div class="hist-diff"><span class="hist-diff-label">${esc(label)}</span> <span class="hist-diff-before">${esc(before ?? '—')}</span> <span class="hist-diff-arrow">→</span> <span class="hist-diff-after">${esc(after ?? '—')}</span></div>`;
}

function renderFactRow(r) {
  const actorColor = ACTOR_COLOR[r.actor] || '#8b949e';
  const diffs = [
    diffRow('confidence', fmtConf(r.previousConfidence), fmtConf(r.newConfidence)),
    diffRow('valid_at', r.previousValidAt ? fmtTs(r.previousValidAt) : null, r.newValidAt ? fmtTs(r.newValidAt) : null),
    diffRow('invalid_at', r.previousInvalidAt ? fmtTs(r.previousInvalidAt) : null, r.newInvalidAt ? fmtTs(r.newInvalidAt) : null),
  ].join('');
  const reportLink = r.reasoningReportId
    ? `<span class="hist-report" data-report="${esc(r.reasoningReportId)}">↗ report</span>`
    : '';
  return `
    <div class="hist-row">
      <div class="hist-row-head">
        <span class="hist-event">${esc(r.eventType)}</span>
        <span class="hist-actor" style="color:${actorColor}">${esc(r.actor)}</span>
        <span class="hist-time">${fmtTs(r.occurredAt)}</span>
        ${reportLink}
      </div>
      ${diffs}
      ${r.reasoning ? `<div class="hist-reasoning">${esc(r.reasoning)}</div>` : ''}
    </div>
  `;
}

function renderEdgeRow(r) {
  const actorColor = ACTOR_COLOR[r.actor] || '#8b949e';
  const diffs = [
    diffRow('strength', fmtStrength(r.previousStrength), fmtStrength(r.newStrength)),
  ].join('');
  let reasoningDiff = '';
  if (r.previousReasoning != null && r.newReasoning != null && r.previousReasoning !== r.newReasoning) {
    reasoningDiff = `<div class="hist-reasoning"><em>reasoning revised:</em> ${esc(r.newReasoning.slice(0, 200))}</div>`;
  }
  const reportLink = r.reasoningReportId
    ? `<span class="hist-report" data-report="${esc(r.reasoningReportId)}">↗ report</span>`
    : '';
  return `
    <div class="hist-row">
      <div class="hist-row-head">
        <span class="hist-event">${esc(r.eventType)}</span>
        <span class="hist-actor" style="color:${actorColor}">${esc(r.actor)}</span>
        <span class="hist-time">${fmtTs(r.occurredAt)}</span>
        ${reportLink}
      </div>
      ${diffs}
      ${r.reasoning ? `<div class="hist-reasoning">${esc(r.reasoning)}</div>` : ''}
      ${reasoningDiff}
    </div>
  `;
}

// Stream history into the placeholder div mounted by detail.js. The kind
// param picks the right endpoint + row renderer.
export async function loadHistoryInto(target, kind, id) {
  if (!target) return;
  target.innerHTML = '<div class="cc-signals-empty">Loading history…</div>';
  try {
    const body = kind === 'fact' ? await getFactHistory(id) : await getCausalEdgeHistory(id);
    const rows = body.history || [];
    if (rows.length === 0) {
      target.innerHTML = '<div class="cc-signals-empty">No history rows.</div>';
      return;
    }
    const renderer = kind === 'fact' ? renderFactRow : renderEdgeRow;
    target.innerHTML = `<div class="hist-timeline">${rows.map(renderer).join('')}</div>`;
  } catch (err) {
    target.innerHTML = `<div class="cc-signals-empty">Failed to load history: ${esc(err.message)}</div>`;
  }
}
