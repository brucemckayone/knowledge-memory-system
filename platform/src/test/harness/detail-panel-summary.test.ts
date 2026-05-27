/**
 * Unit tests: viz entity-detail panel summary section (bead nmemo-2yv.52).
 *
 * The viz panel (viz/js/panels/detail.js) renders the agent-authored living
 * summary (entity_meta.summary) with a freshness indicator and an empty
 * state. The truly-correctness-bearing logic — "Updated N ago" math + the
 * three-branch render (text+ts / text-only / null) — lives in the pure
 * helper module viz/js/panels/detail-helpers.js so it can be exercised
 * without a DOM. Mirrors merge-candidates-helpers.js (.47).
 *
 * Acceptance bullets covered here:
 *
 *   - Click an entity with summary + summaryUpdatedAt → summary text + "Updated N ago"
 *   - Click an unsummarised entity → empty-state hint
 *   - Long summary does not break the panel layout (bounded section via CSS;
 *     here we verify the rendered HTML carries the bounded-block container
 *     class the CSS targets)
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — viz module is plain JS, no type declarations.
import { formatRelativeAgo, renderEntitySummarySection } from '../../../viz/js/panels/detail-helpers.js';

describe('viz detail-panel summary helpers (nmemo-2yv.52)', () => {
  describe('formatRelativeAgo', () => {
    it('returns "just now" for sub-minute durations', () => {
      expect(formatRelativeAgo(0)).toBe('just now');
      expect(formatRelativeAgo(59_000)).toBe('just now');
    });

    it('renders minutes with singular/plural agreement', () => {
      expect(formatRelativeAgo(60_000)).toBe('1 minute ago');
      expect(formatRelativeAgo(5 * 60_000)).toBe('5 minutes ago');
      expect(formatRelativeAgo(59 * 60_000)).toBe('59 minutes ago');
    });

    it('renders hours, days, months, years at the right boundaries', () => {
      const ONE_HOUR = 60 * 60_000;
      const ONE_DAY = 24 * ONE_HOUR;
      expect(formatRelativeAgo(ONE_HOUR)).toBe('1 hour ago');
      expect(formatRelativeAgo(3 * ONE_HOUR)).toBe('3 hours ago');
      expect(formatRelativeAgo(ONE_DAY)).toBe('1 day ago');
      expect(formatRelativeAgo(10 * ONE_DAY)).toBe('10 days ago');
      expect(formatRelativeAgo(30 * ONE_DAY)).toBe('1 month ago');
      expect(formatRelativeAgo(370 * ONE_DAY)).toBe('1 year ago');
    });

    it('returns null for null / undefined / negative / NaN inputs', () => {
      expect(formatRelativeAgo(null)).toBeNull();
      expect(formatRelativeAgo(undefined)).toBeNull();
      expect(formatRelativeAgo(-5_000)).toBeNull();
      expect(formatRelativeAgo(Number.NaN)).toBeNull();
    });
  });

  describe('renderEntitySummarySection', () => {
    const NOW = Date.parse('2026-05-27T12:00:00Z');

    it('renders the bounded summary block + freshness when both present', () => {
      const tenMinAgo = NOW - 10 * 60_000;
      const html = renderEntitySummarySection(
        'Bruce is the platform engineer for the Mnemo project.',
        new Date(tenMinAgo).toISOString(),
        NOW,
      );
      expect(html).toContain('entity-summary-section');
      expect(html).toContain('entity-summary-block');
      expect(html).toContain('Bruce is the platform engineer for the Mnemo project.');
      expect(html).toContain('entity-summary-freshness');
      expect(html).toContain('Updated 10 minutes ago');
    });

    it('renders the summary block without freshness when summaryUpdatedAt is null', () => {
      const html = renderEntitySummarySection(
        'Pre-.52 legacy row.',
        null,
        NOW,
      );
      expect(html).toContain('entity-summary-block');
      expect(html).toContain('Pre-.52 legacy row.');
      expect(html).not.toContain('entity-summary-freshness');
      expect(html).not.toContain('Updated');
    });

    it('renders the empty-state hint when summary is null', () => {
      const html = renderEntitySummarySection(null, null, NOW);
      expect(html).toContain('entity-summary-empty');
      expect(html).toContain('No agent-authored summary yet');
      expect(html).not.toContain('entity-summary-block');
    });

    it('renders the empty-state hint when summary is empty string', () => {
      const html = renderEntitySummarySection('', null, NOW);
      expect(html).toContain('entity-summary-empty');
      expect(html).not.toContain('entity-summary-block');
    });

    it('escapes HTML in the summary to prevent injection (e.g. agent-written angle brackets)', () => {
      const html = renderEntitySummarySection(
        'Contains <script>alert(1)</script> markup.',
        null,
        NOW,
      );
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    });

    it('preserves layout bounding (entity-summary-block class) for arbitrarily long summaries', () => {
      // Bead Acceptance: "summary text is bounded (panel layout does not
      // break for an unusually long summary)". The CSS rule .entity-summary-block
      // sets max-height + overflow-y; here we verify the renderer always emits
      // that container for any non-empty summary length, including the worst
      // case (the 3000-char hard cap from .53).
      const longSummary = 'x'.repeat(3000);
      const html = renderEntitySummarySection(longSummary, null, NOW);
      expect(html).toContain('entity-summary-block');
      // Sanity: the summary made it into the block content.
      expect(html.length).toBeGreaterThan(3000);
    });
  });
});
