import { esc } from '../util.js';
import { state } from '../state.js';
import { fetchImpact } from './impact.js';
import { loadGhostsForEntity } from '../overlays/ghosts.js';

// viz.5 — Ghosts section (lazy-loaded). Returns a placeholder element id so
// showNodeDetail can populate it asynchronously.
function ghostsSectionPlaceholder() {
  return `<div id="ghosts-section" class="ghosts-section"></div>`;
}

function renderGhostsSection(ghosts) {
  const wrap = document.getElementById('ghosts-section');
  if (!wrap) return;
  if (!Array.isArray(ghosts) || ghosts.length === 0) {
    wrap.innerHTML = '';
    return;
  }
  wrap.innerHTML = `
    <div class="section-label">Ghost patterns (${ghosts.length})</div>
    ${ghosts.map(gh => `
      <div class="source-block">
        <strong>${esc(gh.patternName || '(unnamed pattern)')}</strong>
        · pos ${gh.positionInPattern} · conf ${(gh.confidence ?? 0).toFixed(2)}
        <br>expects <code>${esc(gh.expectedCauseEntityType ?? '?')}</code>
        --[${esc(gh.expectedPredicateCategory ?? '?')}]-->
        <code>${esc(gh.expectedEffectEntityType ?? '?')}</code>
        <br><span style="color:#8b949e">${esc((gh.reasoning || '').slice(0, 200))}</span>
      </div>
    `).join('')}
  `;
}

// viz.3 — Cluster section renderer (HDBSCAN). Returns '' when the entity
// did not participate in the most recent clustering run.
function clusterSection(entityId) {
  const c = state.clusters.entities[entityId];
  if (!c) return '';
  const isNoise = c.clusterId === -1;
  let html = `<div class="section-label">Cluster</div>`;
  html += field('Cluster ID', isNoise ? 'noise (-1)' : String(c.clusterId));
  if (!isNoise) {
    html += field('Cluster size', c.clusterSize ?? '—');
    if (c.clusterProbability != null) {
      html += field('Soft probability', c.clusterProbability.toFixed(3));
    }
  }
  return html;
}

// viz.2 — Topology section renderer for entity detail. Returns '' when no
// entity_topology row exists for the given entity.
function topologySection(entityId) {
  const t = state.topology.entities[entityId];
  if (!t) return '';
  const rows = [];
  rows.push(field('Component', t.componentId != null ? `${t.componentId} (size ${t.componentSize})` : '—'));
  rows.push(field('k-core', t.kCore != null ? String(t.kCore) : '—'));
  rows.push(field('Articulation', t.isArticulationPoint ? 'yes' : 'no'));
  rows.push(field('Community', t.communityId != null ? String(t.communityId) : '—'));
  if (t.participationCoef != null) rows.push(field('Participation', t.participationCoef.toFixed(3)));
  if (t.pagerank != null) rows.push(field('PageRank', t.pagerank.toFixed(4)));
  if (t.betweennessSampled != null) rows.push(field('Betweenness', t.betweennessSampled.toFixed(4)));
  let html = `<div class="section-label">Topology</div>${rows.filter(Boolean).join('')}`;
  if (Array.isArray(t.predicateSignature) && t.predicateSignature.length > 0) {
    html += `<div class="field-label" style="margin-top:6px">Predicate signature (${t.predicateSignature.length}-dim)</div>`;
    html += predicateSignatureBars(t.predicateSignature);
  }
  return html;
}

function predicateSignatureBars(sig) {
  const max = Math.max(...sig, 0.0001);
  const cells = sig.map((v, i) => {
    const h = Math.max(1, Math.round((v / max) * 18));
    const opacity = v > 0 ? 0.85 : 0.15;
    return `<span class="psig-bar" style="height:${h}px;opacity:${opacity}" title="bin ${i}: ${v.toFixed(3)}"></span>`;
  }).join('');
  return `<div class="psig-row">${cells}</div>`;
}

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

    // Topology section (viz.2)
    html += topologySection(d.id);

    // Cluster section (viz.3)
    html += clusterSection(d.id);

    // Ghosts placeholder (viz.5 — populated asynchronously below)
    html += ghostsSectionPlaceholder();

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

  // viz.5 — lazy-load ghosts for this entity and stream into the placeholder.
  if (d._nodeType === 'entity') {
    loadGhostsForEntity(d.id, renderGhostsSection);
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
