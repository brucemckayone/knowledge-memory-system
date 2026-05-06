/**
 * Background Patrol Agent
 *
 * Runs while the learner is away. Uses MCP read tools to scan the graph state
 * for decay candidates, cross-course overlaps, and dense clusters, then writes
 * 0..5 high-value insights via write_insight (idempotent).
 *
 * Bounded: max 5 insights, max 12 MCP turns. Returns a structured summary the
 * cron service (umy.4) will persist into patrol_runs.
 *
 * Model: Haiku per haiku-first dev preference (bead description says Sonnet —
 * we'll upgrade after we've verified the pipeline works on the cheap model).
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { runAgent, writeMcpConfig } from '../services/agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SCRIPT = path.resolve(__dirname, '..', 'mcp', 'learning-mcp.ts');

const MAX_TURNS = 12;
const MAX_INSIGHTS = 5;

const SYSTEM_PROMPT = `You are the background patrol for an adaptive learning platform. The learner is studying topics across multiple courses. You run periodically while they are away. Each run, you examine the graph state and surface at most ${MAX_INSIGHTS} high-value insights to the dashboard.

## Available MCP signals

- get_decay_candidates(threshold_days): concepts the learner once knew (peak confidence ≥ 0.7) but has not reinforced in N days. Use threshold_days=14 unless context suggests otherwise.
- find_cross_course_overlaps(): concepts that appear in 2+ courses, either directly (same entity referenced in multiple sections) or via same_as links between distinct entities.
- find_dense_clusters(min_size): connected components of recent (last 30 days) facts of size ≥ min_size. Candidates for synthesis articles. Use min_size=3 unless context suggests otherwise.

## Required passes (each run)

You MUST attempt all three passes below. Each is independent. The 5-insight cap and ${MAX_TURNS}-turn budget apply across the whole run.

1. **Decay pass** — call get_decay_candidates and emit decay_warning insights for any well-established concepts (peak confidence ≥ 0.7) that have decayed.
2. **Cross-course pass** — call find_cross_course_overlaps EARLY in the run and emit cross_course_link insights for every non-trivial overlap (see below). This is pedagogically high-value — do not skip it just because the data looks small.
3. **Cluster pass** — call find_dense_clusters and emit synthesis_candidate insights for clusters worth synthesizing.

If a pass yields nothing interesting, move on. But you must call each tool at least once.

## Cross-course detection — what counts as "non-trivial"

find_cross_course_overlaps returns two arrays:

- **directOverlaps**: same entity referenced from sections in 2+ courses. Each entry has \`{ entityId, courseIds[], kind: "direct" }\`. Treat as non-trivial if courseIds.length ≥ 2. (The tool already filters to ≥2; every direct overlap qualifies.)
- **sameAsOverlaps**: two distinct entities (entityAId, entityBId) linked by a same_as edge, with the courseIds where each entity appears. Each entry has \`{ entityAId, entityBId, aName, bName, courseIdsA[], courseIdsB[], confidence, reasoning, kind: "same_as" }\`. Treat as non-trivial whenever the two entities appear in DIFFERENT courses (i.e. there exists c in courseIdsA and c' in courseIdsB with c ≠ c'). This is the highest-value signal — it means the learner has seen the same concept under two different names in two courses.

For each non-trivial overlap, call write_insight with:
- type: \`cross_course_link\`
- title: a short, concrete headline. Examples:
    - direct: "Hashing appears in both Algorithms and Cryptography"
    - same_as: "Closures are the same in Rust and JavaScript"
- content_md: 1–2 short paragraphs naming both courses, naming both concepts (for same_as overlaps name aName AND bName), and pointing out the pedagogical opportunity ("the learner can transfer their understanding from X to Y" / "consider a synthesis article tying these together").
- related_entity_ids:
    - direct overlap → \`[entityId]\`
    - same_as overlap → \`[entityAId, entityBId]\` (write_insight sorts these for the idempotency key, so order does not matter — just include both)
- related_course_ids: union of all courses involved in this specific overlap.
- importance: 0.5 to 0.7. Use 0.7 for same_as overlaps with confidence ≥ 0.85, 0.6 for other same_as overlaps, 0.5 for direct overlaps.

Cap of ${MAX_INSIGHTS} total insights still applies — if there are many cross-course overlaps, pick the most pedagogically valuable (same_as with high confidence first, then direct).

## What to surface (other types)

When you find something worth surfacing, call write_insight with:
- type: short, lower_snake_case tag from this open vocabulary — examples: decay_warning, cross_course_link, synthesis_candidate, prerequisite_gap, contradiction_detected, pattern_emerging. Invent new types only if none fit.
- title: short headline, one line.
- content_md: 1-2 short paragraphs explaining WHY this matters for the learner. Be specific — name the concept, name the courses, give the timeframe. No fluff.
- related_entity_ids: the Nmemo entity IDs for the concept(s) involved. ALWAYS include these — they are part of the idempotency key.
- importance: 0..1 — use 0.7+ for decay of well-known concepts, 0.5–0.7 for cross-course links (see above), 0.4 for synthesis candidates, lower for weaker signals.

## Constraints

- Maximum ${MAX_INSIGHTS} insights per run. Stop calling write_insight at the cap.
- Use ${MAX_TURNS} MCP turns total or fewer. Be efficient — don't re-call the same tool.
- write_insight is idempotent on (type, sorted(related_entity_ids)). Safe to attempt; duplicates return inserted=false.
- Skip low-signal observations. A patrol that writes 0 insights is a fine outcome if nothing is interesting today.
- Do NOT call any non-MCP tools. Do NOT modify the graph (no record_understanding, no recordFact). Read only, plus write_insight.

## Output

When done — after your last write_insight call (or after deciding nothing is worth surfacing) — end your final assistant message with EXACTLY these two lines as the last two lines of output (no extra prose after):

SUMMARY: <one short paragraph describing what you looked at and what you wrote>
WROTE: <N> insights — types: <comma-separated type tags, or "none">

Examples:
  SUMMARY: Ran all three passes. Decay: 4 candidates, surfaced one decay_warning for "binary search trees". Cross-course: one same_as overlap ("closures" in JS, "move closures" in Rust) and one direct overlap ("graph traversal" in DSA + Compilers) — surfaced both as cross_course_link. Clusters: nothing dense enough.
  WROTE: 3 insights — types: decay_warning, cross_course_link, cross_course_link

  SUMMARY: Ran all three passes. No decay candidates. find_cross_course_overlaps returned empty arrays — only one course in the graph. No dense clusters. Nothing worth surfacing this cycle.
  WROTE: 0 insights — types: none`;

export interface PatrolOptions {
  /** Override decay threshold in days. Default: 14. The agent decides; this only seeds the user message. */
  decayThresholdDays?: number;
  /** Override cluster min size. Default: 3. The agent decides; this only seeds the user message. */
  clusterMinSize?: number;
  /** Override agent timeout (ms). Default: 600_000 (10 min). */
  timeoutMs?: number;
}

export interface PatrolResult {
  ok: boolean;
  insightsProduced: number;
  mcpCalls: number;
  durationMs: number;
  summary: string;
  errorText?: string;
}

interface ParsedReport {
  summary: string;
  wroteCount: number;
  types: string[];
}

/**
 * Parse the SUMMARY: / WROTE: trailer from the agent's final message.
 * Tolerates extra whitespace, missing markers, mixed case.
 */
function parseReport(raw: string): ParsedReport {
  const text = raw.trim();

  const summaryMatch = text.match(/SUMMARY:\s*([\s\S]*?)(?=\n\s*WROTE:|$)/i);
  const wroteMatch = text.match(/WROTE:\s*(\d+)\s*insights?\s*(?:—|-|--)\s*types?:\s*(.+?)(?:\n|$)/i);

  const summary = summaryMatch?.[1]?.trim() ?? text.slice(-400).trim();
  const wroteCount = wroteMatch ? Number.parseInt(wroteMatch[1] ?? '0', 10) : 0;
  const typesRaw = wroteMatch?.[2]?.trim() ?? '';
  const types = typesRaw && typesRaw.toLowerCase() !== 'none'
    ? typesRaw.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  return { summary, wroteCount, types };
}

/**
 * Run a single patrol cycle. Returns a structured result the cron will persist
 * into patrol_runs. Does NOT touch the patrol_runs table itself — that's umy.4.
 */
export async function runPatrol(opts: PatrolOptions = {}): Promise<PatrolResult> {
  const startedAt = Date.now();
  const decayDays = opts.decayThresholdDays ?? 14;
  const clusterSize = opts.clusterMinSize ?? 3;
  const timeoutMs = opts.timeoutMs ?? 600_000;

  const mcpConfigPath = writeMcpConfig('learn', MCP_SCRIPT, {
    NMEMO_URL: config.NMEMO_URL,
    NODE_ENV: config.NODE_ENV,
    DB_PATH: config.DB_PATH,
  });

  const startedAtIso = new Date(startedAt).toISOString();
  const prompt = `Patrol cycle started at ${startedAtIso}.

Reasonable starting thresholds: decay=${decayDays}d, cluster_min_size=${clusterSize}.

Inspect the graph via your MCP tools, decide which signals are worth surfacing, and call write_insight for each one (max ${MAX_INSIGHTS}). End with the SUMMARY/WROTE trailer.`;

  try {
    const result = await runAgent(prompt, {
      model: 'haiku',
      effort: 'low',
      systemPrompt: SYSTEM_PROMPT,
      mcpConfigPath,
      mcpServerName: 'learn',
      maxTurns: MAX_TURNS,
      timeoutMs,
    });

    const parsed = parseReport(result.result);
    const insightsProduced = Math.min(parsed.wroteCount, MAX_INSIGHTS);
    // num_turns from the CLI ≈ total agent turns including tool roundtrips.
    // Best proxy we have for "MCP calls" until we plumb something better.
    const mcpCalls = result.numTurns ?? 0;

    return {
      ok: true,
      insightsProduced,
      mcpCalls,
      durationMs: Date.now() - startedAt,
      summary: parsed.summary || `Patrol completed. Wrote ${insightsProduced} insight(s) of types: ${parsed.types.join(', ') || 'none'}.`,
    };
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      insightsProduced: 0,
      mcpCalls: 0,
      durationMs: Date.now() - startedAt,
      summary: `Patrol failed: ${errorText.slice(0, 200)}`,
      errorText,
    };
  }
}
