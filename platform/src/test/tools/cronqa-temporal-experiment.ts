/**
 * cronqa-temporal-experiment.ts — nmemo-asf.8 (doc 41). The I3 temporal experiment:
 * AS-OF (time-aware, doc-39 R1) vs STRUCTURAL time-blind, on the simple_entity test cut,
 * slots held constant (both arms get the same oracle anchor/pid/year from `annotation`).
 * Deterministic, embeds-free (structured index reads). Requires the KG loaded via
 * cronqa-load.ts into corpus `_cronqa`. Run from platform/:
 *   DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test NODE_ENV=test \
 *     npx tsx src/test/tools/cronqa-temporal-experiment.ts
 *
 * WHAT THIS MEASURES (doc 41): CronQuestions gold is a deterministic function of the KG,
 * so as-of's ceiling is 100% BY CONSTRUCTION — this measures (a) load+read faithfulness
 * and (b) the LIFT of time-aware over time-blind, NOT reasoning. Inverted kill logic: a
 * low as-of number = a load/read bug, not a refutation.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { getEntityFactsAsOf } from '../../services/facts.js';

const CORPUS = '_cronqa';
const NS = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const CUT = 'C:/Users/bruce.mckay/dev/nmemo/benchmarks/cronqa/temporal-experiment-simple-entity.json';
const RESULTS_DIR = 'C:/Users/bruce.mckay/dev/nmemo/benchmarks/results/cronqa/runs';

function qidUuid(qid: string): string {
  const h = createHash('sha1').update(Buffer.from(NS.replace(/-/g, ''), 'hex')).update(qid).digest();
  h[6] = (h[6]! & 0x0f) | 0x50; h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
const midYear = (y: number): Date => new Date(Date.UTC(y, 6, 1));
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

interface Q { uniq_id: number; direction: 'forward' | 'reverse'; anchor_qid: string; pid: string; year: number; answer_qids: string[] }

/** All active windows for (anchor, pid) in the given direction, most-recent first (ignores time). */
async function structuralWindows(anchor: string, pid: string, forward: boolean): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT ${forward ? sql`object_entity_id` : sql`subject_entity_id`} AS endpoint
    FROM public.facts
    WHERE ${forward ? sql`subject_entity_id` : sql`object_entity_id`} = ${anchor}::uuid
      AND predicate = ${pid} AND corpus_id = ${CORPUS} AND expired_at IS NULL
    ORDER BY valid_at DESC
  `)) as unknown as Array<{ endpoint: string | null }>;
  return rows.map((r) => r.endpoint).filter((e): e is string => !!e);
}

async function main(): Promise<void> {
  const cut = JSON.parse(readFileSync(CUT, 'utf8')) as Q[];
  // Falsification control (doc 41): with YEAR_OFFSET != 0 the as-of arm queries the
  // WRONG year. If the temporal filter is real, as-of Hits@1 must COLLAPSE; if it stays
  // ~1.0 the filter is a no-op and the headline number is a bug, not a lift.
  const YEAR_OFFSET = parseInt(process.env.YEAR_OFFSET ?? '0', 10);
  console.log(`[cronqa-temporal] ${cut.length} simple_entity questions  YEAR_OFFSET=${YEAR_OFFSET}`);

  const asof: number[] = []; const struct: number[] = [];
  const dir: string[] = []; const ambiguous: boolean[] = [];
  let missingAnchor = 0;

  for (const q of cut) {
    const forward = q.direction === 'forward';
    const anchor = qidUuid(q.anchor_qid);
    const gold = new Set(q.answer_qids.map(qidUuid));

    // AS-OF (time-aware): the window valid at the asked year; pick most-recent (facts are valid_at DESC).
    const asofFacts = await getEntityFactsAsOf(anchor, midYear(q.year + YEAR_OFFSET), {
      predicate: q.pid, asSubject: forward, asObject: !forward, corpusId: CORPUS,
    });
    const asofPick = asofFacts.length
      ? (forward ? asofFacts[0]!.objectEntityId : asofFacts[0]!.subjectEntityId)
      : null;

    // STRUCTURAL time-blind: ignore the year; most-recent-ever window's endpoint (same pick rule).
    const windows = await structuralWindows(anchor, q.pid, forward);
    const structPick = windows[0] ?? null;
    if (windows.length === 0 && asofFacts.length === 0) missingAnchor++;

    asof.push(asofPick && gold.has(asofPick) ? 1 : 0);
    struct.push(structPick && gold.has(structPick) ? 1 : 0);
    dir.push(q.direction);
    ambiguous.push(new Set(windows).size > 1); // >1 distinct all-time answer = time disambiguates
  }

  const sub = (pred: (i: number) => boolean) => (v: number[]) => v.filter((_, i) => pred(i));
  const fwd = sub((i) => dir[i] === 'forward');
  const rev = sub((i) => dir[i] === 'reverse');
  const amb = sub((i) => ambiguous[i]!);
  const r4 = (x: number) => Number(x.toFixed(4));

  const report = {
    overall: { n: cut.length, asof: mean(asof), structural: mean(struct), lift: mean(asof) - mean(struct) },
    forward: { n: fwd(asof).length, asof: mean(fwd(asof)), structural: mean(fwd(struct)), lift: mean(fwd(asof)) - mean(fwd(struct)) },
    reverse: { n: rev(asof).length, asof: mean(rev(asof)), structural: mean(rev(struct)), lift: mean(rev(asof)) - mean(rev(struct)) },
    ambiguous: { n: amb(asof).length, asof: mean(amb(asof)), structural: mean(amb(struct)), lift: mean(amb(asof)) - mean(amb(struct)) },
    missing_anchor: missingAnchor,
  };

  console.log('');
  for (const [k, v] of Object.entries(report)) {
    if (k === 'missing_anchor') { console.log(`missing anchors: ${v}`); continue; }
    const s = v as { n: number; asof: number; structural: number; lift: number };
    console.log(`${k.padEnd(10)} n=${String(s.n).padStart(5)}  as-of Hits@1=${r4(s.asof)}  structural=${r4(s.structural)}  LIFT=${r4(s.lift)}`);
  }

  const asofOverall = mean(asof);
  const liftOverall = mean(asof) - mean(struct);
  const pass = asofOverall >= 0.98 && liftOverall >= 0.30;
  console.log(`\nBAR: as-of>=0.98 (${r4(asofOverall)}) AND lift>=+0.30 (${r4(liftOverall)}) => ${pass ? 'MET' : 'NOT MET'}`);
  if (asofOverall < 0.98) console.log('  NOTE: as-of < 0.98 indicates a LOAD/READ bug (doc 41 inverted kill logic), not a refutation.');

  const out = {
    benchmark: 'cronqa-temporal-experiment', bead: 'nmemo-asf.8',
    prereg: 'docs/architecture/single-graph/41-cronqa-temporal-experiment-prereg.md',
    timestamp: new Date().toISOString(), corpus: CORPUS,
    metric: 'Hits@1, shared most-recent-window pick rule; as-of (time-aware) vs structural time-blind',
    report: JSON.parse(JSON.stringify(report, (_, x) => (typeof x === 'number' ? r4(x) : x))),
    bar_met: pass,
    notes: 'Gold is a deterministic function of the loaded KG -> as-of ceiling is 100% by construction. Measures load+read faithfulness + the temporal lift, NOT reasoning. Slots held constant across arms (oracle anchor/pid/year from annotation).',
  };
  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  const suffix = YEAR_OFFSET === 0 ? '' : `-offset${YEAR_OFFSET}`;
  const outPath = join(RESULTS_DIR, `${new Date().toISOString().slice(0, 10)}-temporal-experiment${suffix}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${outPath}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
