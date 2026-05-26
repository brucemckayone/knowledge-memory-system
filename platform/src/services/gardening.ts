/**
 * Gardening service — audit-log helpers for gardener agent runs.
 *
 * Bead nmemo-2yv.67: extracted from inline insert at index.ts /api/garden
 * to a shared helper so the auto-trigger path in pipeline.ts can also
 * persist its runs. Before this helper existed, only manual gardener
 * invocations wrote rows to gardening_reports — every auto-triggered
 * run from the ingest pipeline was invisible in the audit log.
 *
 * The helper is fire-and-forget at its call sites: failure to record
 * the run must NEVER block the pipeline or the HTTP response. Callers
 * either invoke this from a try/catch (auto path) or attach .catch to
 * the returned promise (manual path).
 *
 * See doc 36 §8 (gardener-agent.md) for the audit-log story across
 * manual and auto trigger surfaces, and §10 for the cross-feature
 * observability gap this helper closes.
 */
import { db } from '../db/index.js';
import { gardeningReports } from '../db/schema.js';
import type { TriggerTypeValue } from './enums.js';

export interface RecordGardeningRunOpts {
  /** Trigger surface: 'manual' = POST /api/garden; 'auto' = pipeline counter.
   *  keep in sync with src/services/enums.ts:TRIGGER_TYPE_VALUES + the
   *  `valid_trigger_type` DB CHECK (bead nmemo-2yv.69). */
  trigger: TriggerTypeValue;
  /** For 'auto' runs: graph_agent runs since the previous gardening tick */
  runsSinceLast?: number;
  /** The agent's structured Markdown report (Phase 4 output). */
  report: string;
  /** Wall-clock duration of the gardener invocation */
  durationMs: number;
}

interface ParsedReportCounts {
  sameAsCreated: number;
  mergesExecuted: number;
  factsCreated: number;
  summariesUpdated: number;
  islandsInvestigated: number;
}

/**
 * Sanity-parse the agent's Markdown report into action counts.
 *
 * The gardener prompt locks the report shape (§4 of doc 36; see
 * `=== PHASE 4: REPORT ===` in ml-services/app/gardener_agent.py). The
 * section headers used as anchors here are stable:
 *
 *   ### CONSOLIDATIONS         — same_as + merge bullets
 *   ### FACTS CREATED          — new fact bullets
 *   ### SUMMARIES UPDATED      — entity summary bullets
 *   ### ISLANDS INVESTIGATED   — island bullets
 *
 * The parser is intentionally lenient: any failure produces zeros for
 * the affected count. The bead's locked spec accepts this — "If parsing
 * is fragile, leave counts at 0 and let the existing log retention
 * story handle them." The report_text column always carries the full
 * agent output for unambiguous forensic reads.
 */
export function parseGardenerReportCounts(report: string): ParsedReportCounts {
  const zero: ParsedReportCounts = {
    sameAsCreated: 0,
    mergesExecuted: 0,
    factsCreated: 0,
    summariesUpdated: 0,
    islandsInvestigated: 0,
  };
  if (!report) return zero;

  // Split the report into sections keyed by the H3 anchors. Section names
  // are matched case-insensitively to tolerate minor agent drift.
  const sectionByName = new Map<string, string>();
  const lines = report.split(/\r?\n/);
  let currentName: string | null = null;
  let currentBody: string[] = [];
  const flush = () => {
    if (currentName !== null) {
      sectionByName.set(currentName, currentBody.join('\n'));
    }
  };
  for (const line of lines) {
    const headerMatch = /^###\s+(.+?)\s*$/.exec(line);
    if (headerMatch) {
      flush();
      currentName = headerMatch[1]!.toLowerCase();
      currentBody = [];
    } else if (currentName !== null) {
      currentBody.push(line);
    }
  }
  flush();

  const countBullets = (section: string): number => {
    return section.split(/\r?\n/).filter(l => /^\s*[-*]\s+\S/.test(l)).length;
  };

  // Consolidations section mixes same_as and merge bullets. The agent
  // uses distinct verbs ("SAME_AS" / "merged into") in each bullet.
  const consolidations = sectionByName.get('consolidations') ?? '';
  let sameAsCreated = 0;
  let mergesExecuted = 0;
  if (consolidations) {
    for (const line of consolidations.split(/\r?\n/)) {
      if (!/^\s*[-*]\s+\S/.test(line)) continue;
      if (/\bSAME_AS\b/i.test(line)) sameAsCreated++;
      else if (/\bmerged\s+into\b/i.test(line)) mergesExecuted++;
    }
  }

  return {
    sameAsCreated,
    mergesExecuted,
    factsCreated: countBullets(sectionByName.get('facts created') ?? ''),
    summariesUpdated: countBullets(sectionByName.get('summaries updated') ?? ''),
    islandsInvestigated: countBullets(sectionByName.get('islands investigated') ?? ''),
  };
}

/**
 * Persist a gardener run to the audit log.
 *
 * Returns the inserted row's id on success; throws on DB failure (the
 * caller decides whether that should propagate or be swallowed).
 *
 * Call from BOTH the manual /api/garden handler AND the pipeline
 * auto-trigger so the audit log captures the full run history. Failure
 * to record an auto-trigger run must NOT bubble up to the pipeline
 * caller — wrap this call in try/catch at the auto-trigger site.
 */
export async function recordGardeningRun(opts: RecordGardeningRunOpts): Promise<string> {
  const counts = parseGardenerReportCounts(opts.report);
  const rows = await db
    .insert(gardeningReports)
    .values({
      triggerType: opts.trigger,
      runsSinceLast: opts.runsSinceLast ?? 0,
      reportText: opts.report || '(no report)',
      durationMs: opts.durationMs,
      sameAsCreated: counts.sameAsCreated,
      mergesExecuted: counts.mergesExecuted,
      factsCreated: counts.factsCreated,
      summariesUpdated: counts.summariesUpdated,
      islandsInvestigated: counts.islandsInvestigated,
    })
    .returning({ id: gardeningReports.id });
  return rows[0]!.id;
}
