import { esc } from '../util.js';
import { getImpact } from '../api.js';

export async function fetchImpact(nodeType, nodeId, opts = {}) {
  const section = document.getElementById('impact-section');
  if (!section) return;

  try {
    const report = await getImpact(nodeType, nodeId, opts);
    renderImpactSection(report, nodeType, nodeId);
  } catch (err) {
    section.innerHTML = `<div class="impact-loading">Impact fetch failed: ${esc(err.message || 'unknown error')}</div>`;
  }
}

function renderImpactSection(report, nodeType, nodeId) {
  const section = document.getElementById('impact-section');
  if (!section) return;

  const summary = report.severitySummary || { critical: 0, high: 0, medium: 0, low: 0 };
  const isHypothetical = report.hypothetical === 'expire';
  const totalAffected = report.totalAffected || 0;

  const tally = ['critical', 'high', 'medium', 'low']
    .filter((s) => summary[s] > 0)
    .map((s) => `<span class="impact-tag impact-tag-${s}">${summary[s]} ${s}</span>`)
    .join(' ');

  let html = `
    <div class="impact-header">
      <h3>Impact analysis ${isHypothetical ? '(expire preview)' : ''}</h3>
      <div class="impact-tally">${tally || '<span style="color:#8b949e">no dependents</span>'}</div>
    </div>
  `;

  if (totalAffected > 0) {
    html += renderImpactBucket('Direct dependents', report.directDependents);
    html += renderImpactBucket('Transitive chains', report.transitiveChains);
    html += renderImpactBucket('Citation dependents', report.citationDependents);
    html += renderImpactBucket('Pattern impact', report.patternImpact);
  } else {
    html += `<div class="impact-loading">Nothing depends on this node.</div>`;
  }

  html += `
    <div class="impact-actions">
      <button id="impact-toggle-hypo" class="${isHypothetical ? 'preview-active' : ''}">
        ${isHypothetical ? 'Showing expire preview · click to revert' : 'Preview expire'}
      </button>
    </div>
  `;

  section.innerHTML = html;

  const btn = document.getElementById('impact-toggle-hypo');
  if (btn) {
    btn.addEventListener('click', () => {
      fetchImpact(nodeType, nodeId, { hypothetical: isHypothetical ? null : 'expire' });
    });
  }
}

function renderImpactBucket(label, nodes) {
  if (!nodes || nodes.length === 0) return '';
  const rows = nodes.slice(0, 8).map((n) => {
    const sevClass = `sev-${n.severity}`;
    const meta = [
      n.depth != null ? `d${n.depth}` : null,
      n.relationship,
      n.strength != null ? `s=${(n.strength).toFixed(2)}` : null,
    ].filter(Boolean).join(' · ');
    return `
      <div class="impact-row ${sevClass}">
        <span class="impact-summary" title="${esc(n.reasoning || '')}">${esc(n.summary || n.nodeId)}</span>
        <span class="impact-meta">${meta}</span>
      </div>
    `;
  }).join('');
  const overflow = nodes.length > 8 ? `<div class="impact-meta">+${nodes.length - 8} more…</div>` : '';
  return `
    <div class="impact-bucket">
      <div class="impact-bucket-label">${esc(label)} (${nodes.length})</div>
      ${rows}
      ${overflow}
    </div>
  `;
}
