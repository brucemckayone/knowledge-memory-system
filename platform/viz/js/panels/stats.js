// Header stats + collapsible graph_stats expansion (mig 013).
//
// The fast counts (entities, facts, events, causal-edges) come from
// /api/viz/stats and update on every poll tick. The graph_stats singleton
// (orphan rate, predicate diversity, embedding cluster spread, etc.) is
// expensive enough that we lazy-load it only when the user clicks the
// expansion chevron.

import { esc } from '../util.js';
import { getStats, getGraphStats, computeGraphStats } from '../api.js';

let expanded = false;

function fmtPct(x) {
  if (x == null) return '—';
  return `${(x * 100).toFixed(1)}%`;
}
function fmtNum(x) {
  if (x == null) return '—';
  return Number(x).toFixed(3);
}

export async function refreshStats() {
  const stats = await getStats();
  const tally = document.getElementById('stats');
  if (tally) {
    tally.innerHTML =
      `<span><b>${stats.entities}</b> entities</span>` +
      `<span><b>${stats.facts}</b> facts</span>` +
      `<span><b>${stats.causal_events}</b> events</span>` +
      `<span><b>${stats.causal_edges}</b> causal</span>` +
      `<span class="stats-expand" id="statsExpand" title="Show graph_stats singleton">${expanded ? '▾' : '▸'}</span>`;
    const exp = document.getElementById('statsExpand');
    if (exp) exp.addEventListener('click', () => toggleStatsPanel());
  }
  if (expanded) await renderGraphStatsBody();
}

function toggleStatsPanel() {
  expanded = !expanded;
  const panel = document.getElementById('graphStatsPanel');
  if (panel) panel.classList.toggle('open', expanded);
  refreshStats();
  if (expanded) renderGraphStatsBody();
}

async function renderGraphStatsBody() {
  const body = document.getElementById('graphStatsBody');
  if (!body) return;
  body.innerHTML = '<div class="gs-loading">Loading graph_stats…</div>';
  try {
    const { stats } = await getGraphStats();
    if (!stats) {
      body.innerHTML = `
        <div class="gs-empty">No graph_stats row yet.</div>
        <button class="gs-recompute" id="gsRecompute">Recompute</button>
      `;
    } else {
      body.innerHTML = `
        <div class="gs-grid">
          ${gsRow('Total entities', stats.totalEntities)}
          ${gsRow('Total facts', stats.totalFacts)}
          ${gsRow('Active facts', stats.totalActiveFacts)}
          ${gsRow('Total memories', stats.totalMemories)}
          ${gsRow('Fact density', fmtPct(stats.factDensity))}
          ${gsRow('Orphan rate', fmtPct(stats.orphanRate))}
          ${gsRow('Predicate diversity', fmtNum(stats.predicateDiversity))}
          ${gsRow('Merge candidates pending', stats.mergeCandidatesPending)}
          ${gsRow('Embedding clusters', stats.embeddingClusterCount ?? '—')}
          ${gsRow('Centroid sim mean', fmtNum(stats.centroidSimMean))}
          ${gsRow('Centroid sim p10', fmtNum(stats.centroidSimP10))}
          ${gsRow('Centroid sim p90', fmtNum(stats.centroidSimP90))}
          ${gsRow('Sample size', stats.centroidSampleSize ?? '—')}
          ${gsRow('Computed at', stats.computedAt ? new Date(stats.computedAt).toLocaleString() : '—')}
        </div>
        <button class="gs-recompute" id="gsRecompute">Recompute</button>
      `;
    }
    const btn = document.getElementById('gsRecompute');
    if (btn) {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Computing…';
        try {
          await computeGraphStats();
          await renderGraphStatsBody();
        } catch (err) {
          body.innerHTML = `<div class="gs-error">Recompute failed: ${esc(err.message)}</div>`;
        }
      });
    }
  } catch (err) {
    body.innerHTML = `<div class="gs-error">${esc(err.message)}</div>`;
  }
}

function gsRow(label, value) {
  return `<div class="gs-row"><span class="gs-label">${esc(label)}</span><span class="gs-value">${esc(String(value))}</span></div>`;
}
