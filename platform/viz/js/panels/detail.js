import { esc } from '../util.js';
import { state } from '../state.js';
import { fetchImpact } from './impact.js';

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

export function openDetailPanel() {
  document.getElementById('detail').classList.remove('collapsed');
}

export function closeDetailPanel() {
  document.getElementById('detail').classList.add('collapsed');
}

export function bindDetailClose() {
  document.getElementById('detailClose').addEventListener('click', closeDetailPanel);
}

export function showNodeDetail(d) {
  const panel = document.getElementById('detailContent');
  openDetailPanel();
  let html = '';
  const data = state.data;

  if (d._nodeType === 'entity') {
    html += `<h2>${esc(d.label)}</h2>`;
    html += `<div class="meta-row">`;
    html += `<div class="meta-item"><b>${d.mentionCount || 0}</b> <span>mentions</span></div>`;
    html += `<div class="meta-item"><b>${d.factCount || 0}</b> <span>facts</span></div>`;
    html += `<div class="meta-item"><b>${d.sourceMemoryCount || 0}</b> <span>sources</span></div>`;
    html += `</div>`;
    if (d.summary) {
      html += `<div class="source-block" style="margin-bottom:10px;color:#c9d1d9;max-height:160px">${esc(d.summary)}</div>`;
    }

    html += field('Type', d.entityType);
    html += field('Confidence', d.confidence);

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
    if (d.preview) {
      html += `<div class="source-block" style="max-height:200px;color:#c9d1d9">${esc(d.preview)}</div>`;
    }
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

  // Phase 4 — Impact analysis subpanel for entity + causalEvent roots.
  const apiNodeType = d._nodeType === 'causalEvent' ? 'causal_event'
                    : d._nodeType === 'entity' ? 'entity'
                    : null;
  if (apiNodeType) {
    html += `<div id="impact-section" class="impact-section" data-node-id="${esc(d.id)}" data-node-type="${apiNodeType}">`;
    html += `<div class="impact-loading">Computing impact analysis…</div>`;
    html += `</div>`;
  }

  panel.innerHTML = html;

  if (apiNodeType) {
    fetchImpact(apiNodeType, d.id, { hypothetical: null });
  }
}

export function showEdgeDetail(d) {
  const panel = document.getElementById('detailContent');
  openDetailPanel();
  let html = '';
  const data = state.data;

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
