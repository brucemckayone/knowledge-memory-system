/**
 * nmemo-lpy — Window-size extraction-COMPLETENESS sweep (deferred from yxj.5).
 *
 * AXIS: the AGENT-PROCESSING window (the outer chunk the Haiku graph agent
 * extracts from), NOT the 128/64 embedding unit (fixed; that was yxj.1's
 * retrieval-recall axis). With small-unit embeddings (epic yxj) the window is no
 * longer nomic-bound, so its size is a pure extraction-quality / Haiku-call-cost
 * choice. yxj.4 froze the shared default at 6000 chars across the three chunking
 * sites; THIS sweep tunes that number empirically.
 *
 * METHOD: for each window size, chunk a small fixed corpus at that size (the
 * SAME turn-boundary policy as benchmarks/longmemeval/run.py chunk_session),
 * ingest every window through the REAL pipeline (store units + Haiku graph
 * agent) under a per-size stream_id (so sizes never cross-contaminate), then
 * query the facts table for that stream's USER speaker and score how many of a
 * small hand-built GOLD fact set were extracted (tolerant predicate/object
 * substring matching to absorb Haiku predicate-normalisation variance).
 *
 * METRICS per window size:
 *   - completeness = goldHit / goldTotal (the fraction of obvious user facts the
 *     agent recovered).
 *   - cost = window count (= number of graph-agent invocations; this is exactly
 *     the Haiku-call-count axis yxj.4 froze — extract() runs the agent ONCE per
 *     window). totalFacts is recorded as a secondary observable.
 *
 * COST BUDGET (hard, P2 tuning): TWO window sizes {3000, 6000}; ONE tiny corpus
 * (the first 5 turns of the real q[0] degree session, through the degree turn —
 * 6333 chars); gold set ~6 obvious USER first-person facts. Window counts:
 * 3000 -> 4 windows, 6000 -> 2 windows = 6 real-agent ingests total, at the
 * <=6 budget cap. No third size (would blow the budget).
 *
 * ISOLATION: vitest integration test -> DATABASE_URL=cognitive_test +
 * QDRANT_COLLECTION=memories_test (setup.ts). The real ml-services (:8000) must
 * itself be pointed at test infra (bead agf mcp_config) — verified up by the
 * task. Gates on isMLServiceAvailable()/isQdrantAvailable() and SKIPS cleanly
 * when down. Writes results to benchmarks/results/lpy_window_sweep.{json,md}.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  testDb,
  isMLServiceAvailable,
  isQdrantAvailable,
  skipCtx,
} from '../setup.js';
import { ingest } from '../../pipeline.js';
import { findOrCreateSpeaker } from '../../services/entities.js';

interface Fixture {
  question_id: string;
  question: string;
  answer: string;
  answer_session_id: string;
  session_date: string | null;
  chunks: string[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture: Fixture = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/q0-degree-session.json'), 'utf-8'),
);

// --- Corpus: reconstruct the session turns, take the first 5 (through the
//     degree turn) to bound cost. Reconstructing turns from the fixture chunks
//     (which already carry repeated date headers) lets us re-window cleanly at
//     each size with the SAME turn-boundary policy run.py uses. ---
const SESSION_HEADER = fixture.session_date
  ? `[Session date: ${fixture.session_date}]`
  : '';

function reconstructTurns(): string[] {
  // Strip the repeated leading date header from each chunk, rejoin, split on
  // turn boundaries (a blank line followed by USER:/ASSISTANT:).
  const joined = fixture.chunks
    .map((c) => c.replace(/^\[Session date:[^\]]*\]\s*/, ''))
    .join('\n\n')
    .trim();
  return joined
    .split(/\n\n(?=(?:USER|ASSISTANT):)/)
    .map((t) => t.trim())
    .filter(Boolean);
}

const ALL_TURNS = reconstructTurns();
const DEGREE_TURN_IDX = ALL_TURNS.findIndex((t) =>
  /business administration/i.test(t),
);
// Slice through (and including) the degree turn — keeps every gold fact present
// while bounding the corpus to the smallest meaningful multi-window span.
const CORPUS_TURNS = ALL_TURNS.slice(0, DEGREE_TURN_IDX + 1);

/**
 * Window-level chunker — mirrors benchmarks/longmemeval/run.py chunk_session():
 * pack whole turns into windows <= maxChars, break at turn boundaries, repeat
 * the session-date header on each window. A single over-budget turn is flushed
 * then hard char-split (matches run.py's degenerate-turn handling).
 */
function chunkAtWindow(turns: string[], maxChars: number): string[] {
  const head = SESSION_HEADER;
  const headLen = head.length + (head ? 2 : 0);
  const blobs: string[] = [];
  let cur: string[] = [];
  let curLen = headLen;
  const flush = () => {
    if (cur.length) {
      const body = cur.join('\n\n');
      blobs.push(head ? `${head}\n\n${body}` : body);
    }
    cur = [];
    curLen = headLen;
  };
  for (const line of turns) {
    if (headLen + line.length > maxChars) {
      flush();
      const budget = Math.max(1, maxChars - headLen);
      for (let i = 0; i < line.length; i += budget) {
        const piece = line.slice(i, i + budget);
        blobs.push(head ? `${head}\n\n${piece}` : piece);
      }
      continue;
    }
    if (cur.length && curLen + line.length + 2 > maxChars) flush();
    cur.push(line);
    curLen += line.length + 2;
  }
  flush();
  return blobs;
}

// --- GOLD fact set: the obvious USER first-person facts present in the corpus
//     slice. Tolerant matchers (predicate regex OR an object-substring set) so
//     Haiku's variable predicate normalisation (graduated_with / has_degree /
//     studied / works_as ...) still scores a hit. Each gold entry hits when ANY
//     of its object substrings appears in a fact's predicate+object on the USER
//     entity (we concatenate predicate+object_value because Haiku sometimes
//     packs the salient noun into either field). ---
interface GoldFact {
  label: string;
  // hit if the fact's combined "predicate object_value" text contains ALL of
  // `requireAll` (lowercased substring) — kept to one or two tight tokens.
  any: string[][]; // OR over AND-groups
}
const GOLD: GoldFact[] = [
  { label: 'degree: Business Administration', any: [['business administration'], ['business', 'administration']] },
  { label: 'started a new job / new role', any: [['new job'], ['new role'], ['started', 'job']] },
  { label: 'works a 9-to-5 schedule', any: [['9-to-5'], ['9 to 5'], ['nine to five']] },
  { label: 'will use Todoist', any: [['todoist']] },
  { label: 'will use Trello', any: [['trello']] },
  { label: 'used a planner', any: [['planner']] },
];

interface SweepRow {
  windowSize: number;
  windows: number;
  windowLens: number[];
  totalFacts: number;
  goldHit: number;
  goldTotal: number;
  completeness: number;
  hits: string[];
  misses: string[];
  degreeFactFound: boolean;
}

const results: SweepRow[] = [];
// Per-size streams: created entities are tracked for teardown.
const createdEntityIds = new Set<string>();
const streamIds: string[] = [];
const runStamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// The two window sizes (cost budget: exactly 6 agent ingests total).
const WINDOW_SIZES = [3000, 6000];

function scoreGold(
  rows: Array<{ predicate: string; object_value: string | null }>,
): { hits: string[]; misses: string[] } {
  const haystacks = rows.map((r) =>
    `${r.predicate ?? ''} ${r.object_value ?? ''}`.toLowerCase(),
  );
  const hits: string[] = [];
  const misses: string[] = [];
  for (const g of GOLD) {
    const matched = g.any.some((andGroup) =>
      haystacks.some((h) => andGroup.every((tok) => h.includes(tok))),
    );
    (matched ? hits : misses).push(g.label);
  }
  return { hits, misses };
}

describe('window-size extraction-completeness sweep (nmemo-lpy)', () => {
  beforeAll(async (ctx) => {
    if (!(await isMLServiceAvailable()) || !(await isQdrantAvailable())) {
      skipCtx(ctx);
      return;
    }

    for (const windowSize of WINDOW_SIZES) {
      const stream = `lpy-w${windowSize}-${runStamp}`;
      streamIds.push(stream);
      // Pre-seed the USER speaker deterministically (3f9.1) so we can anchor the
      // fact query to it; findOrCreateSpeaker is idempotent so the pipeline
      // reuses this exact entity for first-person facts.
      const userEntityId = (await findOrCreateSpeaker(stream, 'user', 'user')).id;
      createdEntityIds.add(userEntityId);

      const windows = chunkAtWindow(CORPUS_TURNS, windowSize);
      console.log(
        `[lpy] window=${windowSize} -> ${windows.length} windows (lens=${windows.map((w) => w.length)})`,
      );

      // Ingest EVERY window through the real agent (serial — the agent writes
      // the shared graph; deterministic ordering).
      for (let i = 0; i < windows.length; i++) {
        const res = await ingest(windows[i]!, {
          source: `lpy-sweep:${fixture.answer_session_id}:w${windowSize}/c${i}`,
          contentType: 'conversational',
          streamId: stream,
        });
        res.entities.forEach((e) => createdEntityIds.add(e.id));
      }

      // Score: pull all facts on this stream's USER entity.
      const rows = await testDb<
        Array<{ predicate: string; object_value: string | null }>
      >`SELECT predicate, object_value
        FROM public.facts
        WHERE subject_entity_id = ${userEntityId}`;
      const totalFacts = rows.length;
      const { hits, misses } = scoreGold(rows);
      const degreeFactFound = hits.includes('degree: Business Administration');

      const row: SweepRow = {
        windowSize,
        windows: windows.length,
        windowLens: windows.map((w) => w.length),
        totalFacts,
        goldHit: hits.length,
        goldTotal: GOLD.length,
        completeness: hits.length / GOLD.length,
        hits,
        misses,
        degreeFactFound,
      };
      results.push(row);
      console.log(
        `[lpy] window=${windowSize} completeness=${row.completeness.toFixed(2)} (${hits.length}/${GOLD.length}) windows=${row.windows} facts=${totalFacts} degree=${degreeFactFound}`,
      );
    }

    // --- Write results (house style: JSON + MD into benchmarks/results) ---
    const recommended = recommendWindow(results);
    const benchResults = resolve(__dirname, '../../../../benchmarks/results');
    try {
      mkdirSync(benchResults, { recursive: true });
      writeFileSync(
        join(benchResults, 'lpy_window_sweep.json'),
        JSON.stringify(
          {
            generated: new Date().toISOString(),
            bead: 'nmemo-lpy',
            axis: 'agent-processing window size (chars); embedding unit fixed 128/64',
            corpus: {
              source: 'q0-degree-session.json first 5 turns (through degree turn)',
              turns: CORPUS_TURNS.length,
              chars: CORPUS_TURNS.join('\n\n').length,
            },
            goldSet: GOLD.map((g) => g.label),
            windowSizes: WINDOW_SIZES,
            results,
            recommended,
            currentDefault: 6000,
          },
          null,
          2,
        ),
        'utf-8',
      );
      writeFileSync(
        join(benchResults, 'lpy_window_sweep.md'),
        renderMd(results, recommended),
        'utf-8',
      );
      console.log(`[lpy] wrote results to ${benchResults}/lpy_window_sweep.{json,md}`);
    } catch (err) {
      console.warn('[lpy] failed to write results file (continuing):', err);
    }
  }, 30 * 60 * 1000);

  afterAll(async () => {
    // Clean up ONLY what this run created in test infra.
    try {
      const ids = [...createdEntityIds];
      if (ids.length > 0) {
        await testDb`DELETE FROM public.entities WHERE id = ANY(${ids})`;
      }
      for (const s of streamIds) {
        await testDb`DELETE FROM public.stream_participants WHERE stream_id = ${s}`;
      }
    } catch {
      // best-effort teardown; never fail the run on cleanup
    }
  });

  it('swept >=2 window sizes', () => {
    expect(results.length).toBeGreaterThanOrEqual(2);
    for (const r of results) {
      expect(r.windows).toBeGreaterThanOrEqual(1);
      expect(r.goldTotal).toBe(GOLD.length);
    }
  });

  it('recorded completeness + cost per window size with a recommendation', () => {
    for (const r of results) {
      // completeness is a fraction in [0,1]; cost (window count) is recorded.
      expect(r.completeness).toBeGreaterThanOrEqual(0);
      expect(r.completeness).toBeLessThanOrEqual(1);
      expect(Number.isFinite(r.windows)).toBe(true);
    }
    const rec = recommendWindow(results);
    expect(WINDOW_SIZES).toContain(rec.windowSize);
    console.log(
      `[lpy] RECOMMENDATION: window=${rec.windowSize} — ${rec.rationale}`,
    );
  });

  it('extraction is scoreable (the degree needle landed in at least one size)', () => {
    // Tolerant sanity gate: if the obvious degree fact never extracts at ANY
    // window size, scoring is noise — fail loudly so we HALT rather than ship a
    // meaningless sweep (per the bead HALT condition). This is the ONE
    // non-completeness assertion; per-size completeness numbers are recorded,
    // not gated, because Haiku varies.
    const anyDegree = results.some((r) => r.degreeFactFound);
    if (!anyDegree) {
      console.error(
        '[lpy] degree fact not found at ANY window size — extraction too flaky to score. results=',
        JSON.stringify(results, null, 2),
      );
    }
    expect(anyDegree, 'the obvious degree fact must extract at >=1 window size').toBe(true);
  });
});

/**
 * Recommend the window maximising completeness at acceptable cost. Tie-break:
 * prefer the LOWER window count (fewer Haiku calls) when completeness is within
 * a small epsilon; otherwise take the strictly-higher completeness. If both tie
 * on completeness, the cheaper (fewer-windows) size wins.
 */
function recommendWindow(rows: SweepRow[]): {
  windowSize: number;
  rationale: string;
} {
  if (rows.length === 0) return { windowSize: 6000, rationale: 'no data; default' };
  const CURRENT_DEFAULT = 6000;
  const EPS = 0.001;
  const current = rows.find((r) => r.windowSize === CURRENT_DEFAULT);

  // Cost-aware rule (this is a P2 tuning analysis — "acceptable cost" matters,
  // not raw completeness). A smaller/more-expensive window only displaces the
  // current default when its completeness gain clears a MEANINGFUL margin per
  // extra Haiku call. On one tiny corpus with Haiku variance a thin +0.1 gain
  // at 2x cost is noise, so we keep the cheaper default unless the gain is
  // large (>=0.25 absolute, i.e. ~1.5 of the 6 gold facts) AND cheaper sizes
  // never win on cost alone.
  const MARGIN = 0.25;
  const byCompleteness = [...rows].sort((a, b) => {
    if (Math.abs(a.completeness - b.completeness) > EPS) return b.completeness - a.completeness;
    return a.windows - b.windows; // tie -> fewer windows (cheaper)
  });
  const best = byCompleteness[0]!;

  // If the current default exists and no alternative beats it by the margin,
  // validate the default (cheapest acceptable). Otherwise take the clear winner.
  if (current) {
    const beatsBy = best.completeness - current.completeness;
    if (best.windowSize === CURRENT_DEFAULT || beatsBy < MARGIN) {
      return {
        windowSize: CURRENT_DEFAULT,
        rationale: `default ${CURRENT_DEFAULT} validated — best alternative (${best.windowSize}) gains only +${beatsBy.toFixed(2)} completeness for ${best.windows}/${current.windows}x the Haiku-call cost, below the +${MARGIN.toFixed(2)} margin worth a 2x cost change on a single small corpus`,
      };
    }
    return {
      windowSize: best.windowSize,
      rationale: `${best.windowSize} beats default ${CURRENT_DEFAULT} by +${beatsBy.toFixed(2)} completeness (${best.goldHit}/${best.goldTotal} vs ${current.goldHit}/${current.goldTotal}) — exceeds the +${MARGIN.toFixed(2)} margin justifying the ${best.windows}/${current.windows}x cost`,
    };
  }
  return {
    windowSize: best.windowSize,
    rationale: `highest completeness ${best.completeness.toFixed(2)} (${best.goldHit}/${best.goldTotal}) at ${best.windows}-window cost`,
  };
}

function renderMd(rows: SweepRow[], rec: { windowSize: number; rationale: string }): string {
  const lines: string[] = [];
  lines.push('# nmemo-lpy — Window-size extraction-completeness sweep');
  lines.push('');
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push('- Axis: AGENT-PROCESSING window size (chars). Embedding unit fixed at 128/64 (yxj.1).');
  lines.push(
    `- Corpus: q0-degree-session first ${CORPUS_TURNS.length} turns (through degree turn), ${CORPUS_TURNS.join('\n\n').length} chars`,
  );
  lines.push(`- Gold set (${GOLD.length} obvious USER facts): ${GOLD.map((g) => g.label).join('; ')}`);
  lines.push('- Cost = window count = graph-agent (Haiku) invocations (extract() runs once/window).');
  lines.push('');
  lines.push('## Completeness vs window size');
  lines.push('');
  lines.push('| window_size | windows (cost) | completeness | gold hit | total facts | degree? |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of rows) {
    lines.push(
      `| ${r.windowSize} | ${r.windows} | ${r.completeness.toFixed(2)} | ${r.goldHit}/${r.goldTotal} | ${r.totalFacts} | ${r.degreeFactFound ? 'yes' : 'no'} |`,
    );
  }
  lines.push('');
  lines.push('### Misses per size');
  for (const r of rows) {
    lines.push(`- window ${r.windowSize}: ${r.misses.length ? r.misses.join(', ') : '(none)'}`);
  }
  lines.push('');
  lines.push('## Recommendation');
  lines.push('');
  lines.push(`- **window_size=${rec.windowSize}** — ${rec.rationale}`);
  lines.push(`- Current shared default (yxj.4): 6000.`);
  lines.push(
    rec.windowSize === 6000
      ? '- The 6000 default is VALIDATED by this sweep; no constant change needed.'
      : `- CHANGE the shared constant to ${rec.windowSize} together: config.yaml max_ingest_chars + capture-turn MAX_WINDOW_LENGTH + run.py default (per yxj.4).`,
  );
  lines.push('');
  return lines.join('\n');
}
