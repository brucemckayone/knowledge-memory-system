// Detail-panel pure renderers and formatters (bead nmemo-2yv.52).
//
// Extracted so the viz entity-detail panel's agent-authored summary section
// can be unit-tested without a DOM. Mirrors the merge-candidates-helpers.js
// pattern (.47) — DOM-coupled rendering stays in detail.js; the pure helpers
// (string formatting, "Updated N ago" math) live here.
//
// No DOM (`document`/`window`) is referenced so the module imports cleanly
// from a Node test environment. The viz util.js `esc()` uses document.createElement
// and can't be reused here; we inline a minimal string-only escape instead.
//
// See docs/architecture/truth-graph/37-entity-living-summary.md §4.2 and §8
// for the contract: summary is agent-authored prose; summaryUpdatedAt is the
// summary-specific staleness signal (NOT entity_meta.updated_at, which is
// multi-writer).

/** HTML-escape a string. Pure (no DOM). Behavioural mirror of viz/js/util.js
 *  `escHtml()` for the five characters that matter (<, >, &, ", '). Kept local
 *  so this module remains node-importable for tests. */
function escHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Format a millisecond duration as a human-friendly "N units ago" string.
 *  Returns null when ms is null/undefined/NaN/negative — the caller decides
 *  whether to show "Updated just now" or omit the indicator. Matches the
 *  granularity of other relative-time renderers in the codebase (drift.js
 *  uses toLocaleString; this is coarser because the freshness indicator
 *  doesn't need wall-clock precision). */
export function formatRelativeAgo(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

/** Render the agent-authored living-summary section for the entity detail
 *  panel. Returns an HTML string. Three branches:
 *
 *    - summary text present + summaryUpdatedAt present
 *        → bounded summary block + "Updated N ago" freshness indicator
 *    - summary text present + summaryUpdatedAt null
 *        → bounded summary block, no freshness indicator (pre-.52 legacy rows)
 *    - summary text null/empty
 *        → empty-state hint
 *
 *  The bounded layout (max-height + overflow-y) is what makes long summaries
 *  not break the panel — see the bead's third Acceptance bullet.
 *
 *  `now` is injected so unit tests can pin the clock without monkey-patching
 *  Date. Production callers pass Date.now(). */
export function renderEntitySummarySection(summary, summaryUpdatedAt, now) {
  if (!summary) {
    return '<div class="entity-summary-empty">No agent-authored summary yet</div>';
  }
  let freshnessHtml = '';
  if (summaryUpdatedAt) {
    const updatedMs = new Date(summaryUpdatedAt).getTime();
    if (Number.isFinite(updatedMs)) {
      const ago = formatRelativeAgo((now ?? Date.now()) - updatedMs);
      if (ago) {
        freshnessHtml = `<div class="entity-summary-freshness">Updated ${escHtml(ago)}</div>`;
      }
    }
  }
  return `
    <div class="entity-summary-section">
      <div class="entity-summary-block">${escHtml(summary)}</div>
      ${freshnessHtml}
    </div>
  `;
}
