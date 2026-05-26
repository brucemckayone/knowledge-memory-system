import { state } from '../state.js';
import { getContradictions, resolveContradiction } from '../api.js';
import { renderAll } from '../canvas/render.js';

const CONTRADICTION_TYPE_LABELS = {
  opposing_object:     'Opposing object',
  expired_but_cited:   'Expired but cited',
  cyclic_causal:       'Cyclic causal',
  temporal_impossible: 'Temporal impossible',
  chain_conflict:      'Chain conflict',
};

const RESOLUTION_TYPE_PROMPT = [
  'Pick a resolution_type:',
  '  expire_a / expire_b / expire_both',
  '  invalidate_a / invalidate_b',
  '  reconcile / both_valid / dismissed',
].join('\n');

export async function refreshContradictions() {
  try {
    const body = await getContradictions(200);
    const rows = body.contradictions || [];
    state.contradictions = rows;
    const badge = document.getElementById('contradictionsBadge');
    if (badge) {
      badge.textContent = String(rows.length);
      badge.classList.toggle('zero', rows.length === 0);
    }
    const panel = document.getElementById('contradictionsPanel');
    if (panel && panel.classList.contains('open')) renderContradictionsPanel(rows);
    // Re-render canvas overlay so new contradictions appear without waiting
    // for the next /api/viz/unified poll.
    renderAll();
  } catch {
    // Best-effort; endpoint failure should not break the badge.
  }
}

function renderContradictionsPanel(rows) {
  const list = document.getElementById('ctradList');
  const meta = document.getElementById('ctradMeta');
  if (!list || !meta) return;
  meta.textContent = `${rows.length} unresolved`;
  if (rows.length === 0) {
    list.innerHTML = '<div class="ctrad-empty">No unresolved contradictions.</div>';
    return;
  }
  list.innerHTML = rows.map(r => {
    const typeLabel = CONTRADICTION_TYPE_LABELS[r.contradictionType] || r.contradictionType;
    const sevClass = `sev-${r.severity}`;
    const reasoningText = (r.detectionReasoning || '').replace(/</g, '&lt;');
    return `
      <div class="ctrad-row" data-id="${r.id}">
        <div class="ctrad-row-head">
          <span class="ctrad-type">${typeLabel}</span>
          <span class="ctrad-severity ${sevClass}">${r.severity}</span>
        </div>
        <div class="ctrad-reasoning">${reasoningText}</div>
        <div class="ctrad-actions">
          <button class="ctrad-resolve-btn" data-action="resolve" data-id="${r.id}">Resolve…</button>
        </div>
      </div>
    `;
  }).join('');

  for (const btn of list.querySelectorAll('[data-action="resolve"]')) {
    btn.addEventListener('click', () => resolveContradictionUI(btn.getAttribute('data-id')));
  }
}

async function resolveContradictionUI(contradictionId) {
  const resolutionType = window.prompt(RESOLUTION_TYPE_PROMPT);
  if (!resolutionType) return;
  const resolutionTypeTrimmed = resolutionType.trim();
  const resolutionReasoning = window.prompt('Reasoning (min 20 chars):');
  if (!resolutionReasoning || resolutionReasoning.trim().length < 20) {
    alert('Reasoning must be at least 20 characters.');
    return;
  }

  // When dismissing, the server requires a short kebab-case categorical tag
  // (dismissed_reason) so audit queries can group false positives by category.
  // The narrative resolution_reasoning is not a substitute. See bead nmemo-2yv.40.
  const body = {
    resolution_type: resolutionTypeTrimmed,
    resolution_reasoning: resolutionReasoning,
  };
  if (resolutionTypeTrimmed === 'dismissed') {
    const dismissedReason = window.prompt(
      'Dismissal category (short kebab-case tag, e.g. aliased-predicate, predicate-semantics-permits-multi):',
    );
    if (!dismissedReason || !dismissedReason.trim()) {
      alert('Dismissed resolutions require a dismissal category tag.');
      return;
    }
    body.dismissed_reason = dismissedReason.trim();
  }

  try {
    await resolveContradiction(contradictionId, body);
    await refreshContradictions();
  } catch (err) {
    alert(`Resolve failed: ${err.message}`);
  }
}

export function bindContradictionsPanel() {
  document.getElementById('btnContradictions').addEventListener('click', async () => {
    const panel = document.getElementById('contradictionsPanel');
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) {
      const body = await getContradictions(200);
      renderContradictionsPanel(body.contradictions || []);
    }
  });
  document.getElementById('ctradClose').addEventListener('click', () => {
    document.getElementById('contradictionsPanel').classList.remove('open');
  });
}
