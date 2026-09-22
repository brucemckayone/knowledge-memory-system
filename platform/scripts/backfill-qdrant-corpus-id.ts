/**
 * One-shot backfill: stamp `corpus_id` onto the Qdrant memory points written
 * before bead nmemo-mdc (the cross-corpus raw-source leak).
 *
 * WHY. `store()` writes raw source text to Qdrant as one `window` point plus N
 * `unit` satellites. Until nmemo-mdc neither payload carried a corpus key, so a
 * semantic search over source text could return text from ANY corpus whatever
 * the caller's scope. The read path (`searchMemoriesByUnit`) now accepts a
 * `corpusId` and pushes a `corpus_id` clause onto its filter — but a Qdrant
 * `match` on an ABSENT payload key matches nothing, so a scoped search over
 * un-stamped points would answer zero rows. `assertCorpusScopeReady()`
 * therefore REFUSES every scoped read until this script has run.
 *
 * WHAT IT KEYS ON. Postgres offers no memory -> corpus link for this data:
 * `source_document` and `fragment` are EMPTY, `facts.source_memory_id` is NULL
 * on all 343k facts, `fact_sources` / `fact_units` are empty, and
 * `memory_entities` has 8 rows. `stream_id` is 'default' on ~every point. The
 * only real signal is inside the Qdrant payload itself:
 *
 *   - WINDOW points carry `source`, which the corpus ingester writes as
 *     `${corpusId}:batch${N}` (src/test/tools/corpus-graph-ingest.ts:178).
 *     A window is attributed ONLY when its `source` matches that exact shape;
 *     the prefix is then the corpus id verbatim. Any other `source` shape is
 *     left unattributed rather than guessed at.
 *   - UNIT points carry `parent_window_id`, so a unit inherits its parent
 *     window's corpus. A unit whose parent is missing, or whose parent is
 *     itself unattributable, stays unattributed.
 *
 * UNATTRIBUTABLE POINTS are stamped with the `__unattributed__` sentinel, NOT
 * with a guessed corpus. The sentinel is not a corpus: no ingest path writes it
 * and `corpusScopeClause()` throws if a search asks for it, so those points are
 * unreachable from every corpus-scoped read while still carrying the key that
 * `assertCorpusScopeReady()` requires.
 *
 * Reads Qdrant only — no Postgres, no embeddings, no ml-services / Ollama.
 * Idempotent: points that already carry `corpus_id` are skipped unless --force.
 *
 *   cd platform
 *   npx tsx scripts/backfill-qdrant-corpus-id.ts                  # DRY RUN (default)
 *   npx tsx scripts/backfill-qdrant-corpus-id.ts --apply          # write payloads
 *   npx tsx scripts/backfill-qdrant-corpus-id.ts --apply --force  # restamp everything
 */

import { qdrant, COLLECTIONS, UNATTRIBUTED_CORPUS_ID } from '../src/services/qdrant.js';

/** The exact shape `corpus-graph-ingest.ts` writes into `source`. */
const SOURCE_RE = /^(.+):batch\d+$/;

const SET_PAYLOAD_BATCH = 2000;

interface RawPoint {
  id: string | number;
  payload: Record<string, unknown>;
}

async function scrollAll(): Promise<RawPoint[]> {
  const out: RawPoint[] = [];
  let offset: unknown;
  for (;;) {
    const res = await qdrant.scroll(COLLECTIONS.MEMORIES, {
      limit: 1000,
      with_payload: true,
      with_vector: false,
      ...(offset !== undefined && offset !== null ? { offset: offset as never } : {}),
    });
    for (const p of res.points) {
      out.push({ id: p.id, payload: (p.payload ?? {}) as Record<string, unknown> });
    }
    offset = res.next_page_offset;
    if (offset === undefined || offset === null) break;
  }
  return out;
}

const TAG = '[backfill-qdrant-corpus-id]';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const force = process.argv.includes('--force');

  console.log(`${TAG} collection=${COLLECTIONS.MEMORIES} mode=${apply ? 'APPLY' : 'DRY RUN'} force=${force}`);

  const points = await scrollAll();
  console.log(`${TAG} scrolled ${points.length} point(s)`);

  // Pass 1 - window points. `source` is the only corpus signal.
  const windowCorpus = new Map<string, string>(); // window point id -> corpus or sentinel
  const badSources = new Map<string, number>();
  let windows = 0;
  for (const p of points) {
    if (p.payload.point_type !== 'window') continue;
    windows++;
    const source = typeof p.payload.source === 'string' ? p.payload.source : '';
    const m = SOURCE_RE.exec(source);
    if (m && m[1]) {
      windowCorpus.set(String(p.id), m[1]);
    } else {
      windowCorpus.set(String(p.id), UNATTRIBUTED_CORPUS_ID);
      const key = source || '<no source>';
      badSources.set(key, (badSources.get(key) ?? 0) + 1);
    }
  }

  // Pass 2 - assign every point a corpus.
  const perCorpus = new Map<
    string,
    { windows: number; units: number; other: number; ids: Array<string | number> }
  >();
  const reasons = new Map<string, number>();
  let alreadyStamped = 0;
  let orphanUnits = 0;

  const bump = (corpus: string, kind: 'windows' | 'units' | 'other', id: string | number) => {
    const e = perCorpus.get(corpus) ?? { windows: 0, units: 0, other: 0, ids: [] };
    e[kind]++;
    e.ids.push(id);
    perCorpus.set(corpus, e);
  };
  const reason = (why: string) => reasons.set(why, (reasons.get(why) ?? 0) + 1);

  for (const p of points) {
    if (!force && typeof p.payload.corpus_id === 'string' && p.payload.corpus_id.length > 0) {
      alreadyStamped++;
      continue;
    }
    const type = p.payload.point_type;
    if (type === 'window') {
      const corpus = windowCorpus.get(String(p.id))!;
      if (corpus === UNATTRIBUTED_CORPUS_ID) {
        reason('window: source does not match "<corpus>:batch<N>"');
      }
      bump(corpus, 'windows', p.id);
    } else if (type === 'unit') {
      const parent = typeof p.payload.parent_window_id === 'string' ? p.payload.parent_window_id : '';
      const corpus = windowCorpus.get(parent);
      if (corpus === undefined) {
        orphanUnits++;
        reason('unit: parent_window_id resolves to no window point');
        bump(UNATTRIBUTED_CORPUS_ID, 'units', p.id);
      } else {
        if (corpus === UNATTRIBUTED_CORPUS_ID) reason('unit: parent window is itself unattributable');
        bump(corpus, 'units', p.id);
      }
    } else {
      reason(`point_type=${String(type)} (neither window nor unit)`);
      bump(UNATTRIBUTED_CORPUS_ID, 'other', p.id);
    }
  }

  console.log(`${TAG} window points: ${windows}`);
  if (alreadyStamped > 0) {
    console.log(`${TAG} already stamped (skipped; --force to restamp): ${alreadyStamped}`);
  }

  console.log(`${TAG} --- would stamp, per corpus ---`);
  const rows = [...perCorpus.entries()].sort(
    (a, b) =>
      b[1].windows + b[1].units + b[1].other - (a[1].windows + a[1].units + a[1].other),
  );
  let total = 0;
  for (const [corpus, e] of rows) {
    const n = e.windows + e.units + e.other;
    total += n;
    const other = e.other ? ` / ${e.other} other` : '';
    console.log(
      `${TAG}   ${corpus.padEnd(18)} ${String(n).padStart(6)} point(s)  (${e.windows} window / ${e.units} unit${other})`,
    );
  }
  console.log(`${TAG}   ${'TOTAL'.padEnd(18)} ${String(total).padStart(6)} point(s)`);

  const u = perCorpus.get(UNATTRIBUTED_CORPUS_ID);
  const unattributable = u ? u.windows + u.units + u.other : 0;
  console.log(
    `${TAG} --- unattributable: ${unattributable} point(s) -> '${UNATTRIBUTED_CORPUS_ID}' (NOT guessed into a corpus) ---`,
  );
  for (const [why, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`${TAG}   ${n} x ${why}`);
  }
  if (badSources.size > 0) {
    const listed = [...badSources.entries()].map(([s, n]) => `${JSON.stringify(s)} x${n}`).join(', ');
    console.log(`${TAG}   non-conforming window source values: ${listed}`);
  }
  if (orphanUnits > 0) console.log(`${TAG}   orphan units (no parent window point): ${orphanUnits}`);

  if (!apply) {
    console.log(`${TAG} DRY RUN - nothing written. Re-run with --apply to write these payloads.`);
    return;
  }

  let written = 0;
  for (const [corpus, e] of rows) {
    for (let i = 0; i < e.ids.length; i += SET_PAYLOAD_BATCH) {
      const slice = e.ids.slice(i, i + SET_PAYLOAD_BATCH);
      await qdrant.setPayload(COLLECTIONS.MEMORIES, {
        payload: { corpus_id: corpus },
        points: slice as never,
        wait: true,
      });
      written += slice.length;
      console.log(`${TAG}   wrote corpus_id='${corpus}' -> ${written}/${total}`);
    }
  }

  // Post-condition: exactly what assertCorpusScopeReady() gates on.
  const { count: stillMissing } = await qdrant.count(COLLECTIONS.MEMORIES, {
    filter: { must: [{ is_empty: { key: 'corpus_id' } }] } as never,
    exact: true,
  });
  console.log(`${TAG} done. points still missing corpus_id: ${stillMissing}`);
  if (stillMissing > 0) {
    throw new Error(
      `${TAG} ${stillMissing} point(s) still have no corpus_id - corpus-scoped reads will keep ` +
        `refusing. Re-run (a concurrent ingest may have landed mid-backfill).`,
    );
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`${TAG} failed:`, err);
    process.exit(1);
  },
);
