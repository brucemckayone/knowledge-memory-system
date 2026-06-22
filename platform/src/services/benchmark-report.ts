/**
 * Human-readable per-run report + cross-run trend (doc 39 §3.3/§3.4, nmemo-hm4.6).
 *
 * PURE shaping — imports TYPES only, no `node:fs`, no DB. {@link buildRunReport}
 * folds the manifest + the full {@link RunMetrics} (exact + semantic scorecards,
 * gold correctness, graph-integrity invariants, per-step instrumentation) into
 * the `report.md` a human reads: scorecards, correctness per arm, every invariant
 * verdict WITH its offending rows (e.g. "Elena: 5 active title facts, expected
 * 1"), the contradiction detected-vs-reflected gap, and links to the snapshots.
 * {@link buildTrend} diffs run N vs N-1 from the history lines so a fix shows up
 * as current-state-correctness climbing over commits.
 *
 * Supersedes the concise `buildReportMd` that lived in benchmark-snapshot.ts.
 */

import type { Scorecard } from './graph-canonical.js';
import type {
  Manifest,
  RunMetrics,
  SemanticSummary,
  F1Pair,
  HistoryLine,
  ArmHistory,
} from './benchmark-snapshot.js';
import type { InvariantReport } from './graph-invariants.js';
import type { CorrectnessReport } from './graph-correctness.js';
import type { SnapshotInstrumentation, ContradictionGap } from './graph-instrumentation.js';
import type { GraphReview, ReviewSeverity } from './graph-review.js';
import type { ReportsReview } from './reports-review.js';
import type { Aggregate } from './benchmark-aggregate.js';

/** Per-invariant cap on the offending rows we render (keeps report.md readable). */
const MAX_VIOLATIONS_PER_INVARIANT = 20;

/** Format an entity/fact F1 pair as `entity/fact`, or `-` when the axis didn't run. */
const f1Pair = (p: F1Pair | null): string =>
  p ? `${p.entity.toFixed(2)}/${p.fact.toFixed(2)}` : '-';

/** Format a 0..1 fraction to 2 dp, or `-` when null. */
const frac = (n: number | null | undefined): string =>
  n == null ? '-' : n.toFixed(2);

/** The per-step shape the driver stores per `<mode>.<order>` (see RunMetrics.perStep). */
interface PerStepEntry {
  snapshot?: SnapshotInstrumentation;
  contradictions?: ContradictionGap;
}

/** The structural (exact) scorecard table. */
function structuralTable(scorecard: Scorecard, lines: string[]): void {
  lines.push('## Structural scorecard (exact)');
  lines.push('');
  lines.push('| mode | wallMs | ents | facts | dupEnt | dupFact | litmus | vsBaseline(match/extraF/missF) |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const a of scorecard.arms) {
    const vb = a.vsBaseline
      ? `${a.vsBaseline.structuralMatch}/${a.vsBaseline.factsExtra}/${a.vsBaseline.factsMissing}`
      : 'baseline';
    lines.push(
      `| ${a.mode} | ${a.wallClockMs} | ${a.counts.entities} | ${a.counts.activeFacts} | ${a.duplicateEntities} | ${a.duplicateFacts} | ${a.litmusPass} | ${vb} |`,
    );
  }
  lines.push('');
}

/** The semantic (fuzzy F1) scorecard table. */
function semanticTable(
  scorecard: Scorecard,
  semanticByMode: Record<string, SemanticSummary>,
  lines: string[],
): void {
  lines.push('## Semantic scorecard (entityF1/factF1)');
  lines.push('');
  lines.push('| mode | determinism | litmus(fwd/rev) | vsBaseline |');
  lines.push('|---|---|---|---|');
  for (const a of scorecard.arms) {
    const sm = semanticByMode[a.mode];
    const vsb = a.mode === scorecard.baselineMode ? 'baseline' : f1Pair(sm?.vsBaselineF1 ?? null);
    lines.push(
      `| ${a.mode} | ${f1Pair(sm?.determinismF1 ?? null)} | ${f1Pair(sm?.litmusF1 ?? null)} | ${vsb} |`,
    );
  }
  lines.push('');
}

/** Correctness vs gold for one arm: F1s, current-state fraction + failures, sprawl. */
function correctnessForArm(key: string, c: CorrectnessReport, lines: string[]): void {
  lines.push(`### ${key} vs gold (\`${c.corpus}\`)`);
  lines.push('');
  lines.push(`- entity F1: ${c.entities.f1.toFixed(2)} (P ${c.entities.precision.toFixed(2)} / R ${c.entities.recall.toFixed(2)})`);
  lines.push(`- current-fact F1: ${c.currentFacts.f1.toFixed(2)} (P ${c.currentFacts.precision.toFixed(2)} / R ${c.currentFacts.recall.toFixed(2)})`);
  const passed = c.expectations.filter((e) => e.pass).length;
  lines.push(`- current-state correctness: ${frac(c.currentStateCorrectness)} (${passed}/${c.expectations.length} exclusive expectations)`);
  const failing = c.expectations.filter((e) => !e.pass);
  if (failing.length > 0) {
    lines.push('- failing exclusive expectations:');
    for (const e of failing) {
      const got = e.actualObjects.length === 0 ? 'none' : e.actualObjects.join(', ');
      lines.push(`  - ${e.subject} [${e.group}]: expected \`${e.expectedObject}\`, got ${e.actualObjects.length} active (${got})`);
    }
  }
  if (c.predicateSprawl.length > 0) {
    lines.push('- predicate sprawl:');
    for (const s of c.predicateSprawl) {
      lines.push(`  - ${s.group}: ${s.predicateCount} predicates (${s.predicates.join(', ')})`);
    }
  } else {
    lines.push('- predicate sprawl: none');
  }
  lines.push('');
}

/** Every invariant verdict for one arm, with offending rows for failures. */
function invariantsForArm(key: string, report: InvariantReport, lines: string[]): void {
  const { summary } = report;
  lines.push(`### ${key} (${summary.passed}/${summary.total} pass, ${summary.errorViolations} error rows)`);
  lines.push('');
  for (const r of report.results) {
    const verdict = r.pass ? 'PASS' : 'FAIL';
    lines.push(`- ${verdict} [${r.severity}] ${r.name} — ${r.description}`);
    if (!r.pass) {
      const shown = r.violations.slice(0, MAX_VIOLATIONS_PER_INVARIANT);
      for (const v of shown) lines.push(`  - ${v.detail}`);
      const hidden = r.violations.length - shown.length;
      if (hidden > 0) lines.push(`  - … and ${hidden} more`);
    }
  }
  lines.push('');
}

/** Per-step instrumentation for one arm: the contradiction gap + key counters. */
function perStepForArm(key: string, entry: PerStepEntry, lines: string[]): void {
  lines.push(`### ${key}`);
  lines.push('');
  const gap = entry.contradictions;
  if (gap) {
    lines.push(
      `- contradictions: detected ${gap.detectedDuringIngest} during ingest, reflected ${gap.reflectedInFinalTable} in final table, gap ${gap.gap}`,
    );
  }
  const snap = entry.snapshot;
  if (snap) {
    lines.push(`- contradictions by status: ${snap.contradictions.resolved} resolved / ${snap.contradictions.dismissed} dismissed / ${snap.contradictions.active} active`);
    lines.push(`- supersession: ${snap.supersession.expiredFacts} expired / ${snap.supersession.activeFacts} active facts`);
    lines.push(`- causal edges: ${snap.causalEdges.active} active / ${snap.causalEdges.expired} expired`);
    lines.push(`- same_as merges: ${snap.sameAs}; entities ${snap.entities}; facts ${snap.facts}`);
  }
  lines.push('');
}

/** Severity render order — high-impact issues first. */
const REVIEW_SEVERITY_ORDER: ReviewSeverity[] = ['high', 'medium', 'low'];
/** Per-arm cap on rendered review issues (keeps report.md readable). */
const MAX_REVIEW_ISSUES_PER_ARM = 20;

/** One arm's agent-review verdict + its issues grouped by severity (doc 39 §2.D). */
function agentReviewForArm(key: string, review: GraphReview, lines: string[]): void {
  lines.push(`### ${key} — verdict: ${review.verdict} (${review.issues.length} issue${review.issues.length === 1 ? '' : 's'})`);
  lines.push('');
  if (review.parseError) {
    lines.push(`- judge reply could not be parsed: ${review.parseError}`);
    lines.push('');
    return;
  }
  if (review.issues.length === 0) {
    lines.push('- no issues raised.');
    lines.push('');
    return;
  }
  let shown = 0;
  for (const severity of REVIEW_SEVERITY_ORDER) {
    const group = review.issues.filter((i) => i.severity === severity);
    if (group.length === 0) continue;
    lines.push(`- ${severity}:`);
    for (const issue of group) {
      if (shown >= MAX_REVIEW_ISSUES_PER_ARM) break;
      const subject = issue.subject ? `${issue.subject}: ` : '';
      lines.push(`  - [${issue.category}] ${subject}${issue.detail}`);
      shown += 1;
    }
    if (shown >= MAX_REVIEW_ISSUES_PER_ARM) break;
  }
  const hidden = review.issues.length - shown;
  if (hidden > 0) lines.push(`  - … and ${hidden} more`);
  lines.push('');
}

/** Per-arm cap on rendered report-review discrepancies (keeps report.md readable). */
const MAX_DISCREPANCIES_PER_ARM = 20;

/**
 * One arm's reports review (doc 39 §2.E): the self-report-vs-graph discrepancies
 * plus the report characterization (incl. the thin/patrol-only reasoning reports).
 */
function reportsReviewForArm(key: string, review: ReportsReview, lines: string[]): void {
  const { discrepancies, characterization: c } = review;
  lines.push(`### ${key} (${discrepancies.length} discrepanc${discrepancies.length === 1 ? 'y' : 'ies'})`);
  lines.push('');
  const modes = Object.entries(c.reasoningByMode)
    .map(([m, n]) => `${m}=${n}`)
    .join(', ');
  lines.push(
    `- reports: ${c.extractionCount} extraction / ${c.gardeningCount} gardening / ${c.reasoningCount} reasoning`,
  );
  lines.push(
    `- reasoning by mode: ${modes || 'none'}; thin/patrol-only: ${c.thinReasoningReports}/${c.reasoningCount}`,
  );
  lines.push(`- gardening actions total: ${c.gardeningActionsTotal}`);
  if (discrepancies.length === 0) {
    lines.push('- no report-vs-graph discrepancies.');
  } else {
    lines.push('- discrepancies:');
    const shown = discrepancies.slice(0, MAX_DISCREPANCIES_PER_ARM);
    for (const d of shown) lines.push(`  - [${d.kind}/${d.reportType}] ${d.detail}`);
    const hidden = discrepancies.length - shown.length;
    if (hidden > 0) lines.push(`  - … and ${hidden} more`);
  }
  lines.push('');
}

/**
 * One mode's variance bands across the N forward repeats (doc 39 §2.F,
 * nmemo-hm4.9): a metric | mean | stddev | min | max | n table. Metric rows are
 * rendered in the distribution's own insertion order (the {@link Aggregate}
 * field order the aggregator emits).
 */
function distributionsForMode(mode: string, dist: Record<string, Aggregate>, lines: string[]): void {
  lines.push(`### ${mode}`);
  lines.push('');
  lines.push('| metric | mean | stddev | min | max | n |');
  lines.push('|---|---|---|---|---|---|');
  for (const [metric, a] of Object.entries(dist)) {
    lines.push(
      `| ${metric} | ${a.mean.toFixed(2)} | ${a.stddev.toFixed(2)} | ${a.min.toFixed(2)} | ${a.max.toFixed(2)} | ${a.n} |`,
    );
  }
  lines.push('');
}

/**
 * Build the human-readable per-run report (doc 39 §3.4). Pure. `opts.trend`, if
 * provided, is inserted verbatim as the trend section (built by
 * {@link buildTrend} in the driver, which has the prior history line). Sections
 * are grouped by arm where natural; `<mode>.<order>` keys come straight from the
 * metrics maps.
 */
export function buildRunReport(
  manifest: Manifest,
  metrics: RunMetrics,
  opts?: { trend?: string },
): string {
  const lines: string[] = [];

  // Header
  lines.push(`# Comparison run ${manifest.runId}`);
  lines.push('');
  lines.push(`- commit: \`${manifest.gitCommit}\``);
  lines.push(`- corpus: ${manifest.corpus} (${manifest.chunkCount} chunks)`);
  lines.push(`- modes: ${manifest.modes.join(', ')} | orders: ${manifest.orders.join(', ')}`);
  lines.push(`- model: ${manifest.model}`);
  lines.push('');

  // Scorecards
  structuralTable(metrics.exact, lines);
  semanticTable(metrics.exact, metrics.semantic, lines);

  // Correctness vs gold (per arm/order). Empty {} when no gold authored.
  lines.push('## Correctness vs gold');
  lines.push('');
  const correctnessKeys = Object.keys(metrics.correctness).sort();
  if (correctnessKeys.length === 0) {
    lines.push('No gold reference for this corpus — correctness skipped.');
    lines.push('');
  } else {
    for (const key of correctnessKeys) correctnessForArm(key, metrics.correctness[key]!, lines);
  }

  // Graph-integrity invariants (per <mode>.<order>), with offending rows.
  lines.push('## Invariants');
  lines.push('');
  const invariantKeys = Object.keys(metrics.invariants).sort();
  if (invariantKeys.length === 0) {
    lines.push('No invariant reports.');
    lines.push('');
  } else {
    for (const key of invariantKeys) invariantsForArm(key, metrics.invariants[key]!, lines);
  }

  // Per-step instrumentation (per <mode>.<order>): contradiction gap + counters.
  lines.push('## Per-step instrumentation');
  lines.push('');
  const perStepKeys = Object.keys(metrics.perStep).sort();
  if (perStepKeys.length === 0) {
    lines.push('No per-step instrumentation.');
    lines.push('');
  } else {
    for (const key of perStepKeys) perStepForArm(key, metrics.perStep[key] as PerStepEntry, lines);
  }

  // Agent review (per <mode>.<order>) — only present when the driver ran with
  // --review (doc 39 §2.D, nmemo-hm4.7). Omitted entirely on a plain run.
  if (metrics.agentReview && Object.keys(metrics.agentReview).length > 0) {
    lines.push('## Agent review');
    lines.push('');
    for (const key of Object.keys(metrics.agentReview).sort()) {
      agentReviewForArm(key, metrics.agentReview[key]!, lines);
    }
  }

  // Reports review (per <mode>.<order>) — self-report-vs-graph discrepancies +
  // report characterization (doc 39 §2.E, nmemo-hm4.8). DETERMINISTIC, so it's
  // present on every run; older snapshots without it are skipped.
  if (metrics.reportsReview && Object.keys(metrics.reportsReview).length > 0) {
    lines.push('## Reports review');
    lines.push('');
    for (const key of Object.keys(metrics.reportsReview).sort()) {
      reportsReviewForArm(key, metrics.reportsReview[key]!, lines);
    }
  }

  // Distributions (variance across N repeats) per mode — only present when the
  // driver ran with --repeats > 1 (doc 39 §2.F, nmemo-hm4.9). Omitted on the
  // default single-forward run.
  if (metrics.distributions && Object.keys(metrics.distributions).length > 0) {
    lines.push(`## Distributions (variance across ${manifest.repeats ?? 'N'} repeats)`);
    lines.push('');
    for (const mode of Object.keys(metrics.distributions).sort()) {
      distributionsForMode(mode, metrics.distributions[mode]!, lines);
    }
  }

  // Snapshot links (relative — siblings of report.md in runs/<runId>/).
  lines.push('## Snapshots');
  lines.push('');
  for (const a of metrics.exact.arms) {
    for (const order of manifest.orders) {
      lines.push(`- ${a.mode}.${order}: \`${a.mode}.${order}.canonical.json\` / \`${a.mode}.${order}.rich.json\``);
    }
  }
  lines.push('');

  // Trend (run N vs N-1). Built by the driver from history.jsonl.
  lines.push('## Trend');
  lines.push('');
  lines.push(opts?.trend ?? 'No trend (run with a populated history.jsonl to diff vs the prior run).');
  lines.push('');

  return lines.join('\n');
}

/** Render one arm's tracked-metric delta as `prev -> curr (Δ)`. */
function deltaLine(label: string, prev: number | null | undefined, curr: number | null | undefined): string {
  const p = prev ?? null;
  const c = curr ?? null;
  if (p == null && c == null) return `  - ${label}: - -> - `;
  if (p == null) return `  - ${label}: - -> ${c!.toFixed(2)}`;
  if (c == null) return `  - ${label}: ${p.toFixed(2)} -> -`;
  const d = c - p;
  const sign = d > 0 ? '+' : '';
  return `  - ${label}: ${p.toFixed(2)} -> ${c.toFixed(2)} (Δ ${sign}${d.toFixed(2)})`;
}

/** F1 (entity/fact) delta line — diffs the fact F1, the headline number. */
function f1DeltaLine(label: string, prev: F1Pair | null | undefined, curr: F1Pair | null | undefined): string {
  return deltaLine(label, prev?.fact ?? null, curr?.fact ?? null);
}

/**
 * Diff the current run's history line against the previous one (doc 39 §3.3),
 * per arm matched by mode. Shows the delta of the tracked metrics
 * (current-state-correctness, invariant pass-rate, fact F1 vs gold, determinism
 * & litmus F1, throughput ms, predicate-sprawl) as `prev -> curr (Δ)`. Pure.
 * Returns a first-run message when `previous` is null. This is the
 * "fix shows as current-state-correctness climbing" view.
 */
export function buildTrend(current: HistoryLine, previous: HistoryLine | null): string {
  if (previous == null) return 'first run — no prior to compare.';

  const prevByMode = new Map<string, ArmHistory>();
  for (const a of previous.arms) prevByMode.set(a.mode, a);

  const lines: string[] = [];
  lines.push(`Comparing run \`${current.runId}\` (commit \`${current.gitCommit}\`) vs \`${previous.runId}\` (commit \`${previous.gitCommit}\`).`);
  lines.push('');
  for (const a of current.arms) {
    const p = prevByMode.get(a.mode) ?? null;
    lines.push(`- ${a.mode}${p == null ? ' (new arm — no prior)' : ''}:`);
    lines.push(deltaLine('current-state-correctness', p?.currentStateCorrectness, a.currentStateCorrectness));
    lines.push(deltaLine('invariant pass-rate', p?.invariantPassRate, a.invariantPassRate));
    lines.push(deltaLine('fact F1 vs gold', p?.factF1VsGold, a.factF1VsGold));
    lines.push(f1DeltaLine('determinism F1 (fact)', p?.determinismF1, a.determinismF1));
    lines.push(f1DeltaLine('litmus F1 (fact)', p?.litmusF1, a.litmusF1));
    lines.push(deltaLine('throughput ms', p?.wallClockMs, a.wallClockMs));
    lines.push(deltaLine('predicate-sprawl', p?.predicateSprawlMax, a.predicateSprawlMax));
  }
  return lines.join('\n');
}
