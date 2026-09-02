/**
 * frag-probe.ts — nmemo-asf.2 (doc 35 §5 step 1c): DETERMINISTIC proof that
 * store()'s lineage writer (recordFragments -> source_document + fragment, mig
 * 059) populates correctly, with the window<-unit parent chain, char offsets, a
 * reproducible chunker stamp, and an idempotent re-run. No LLM, no Claude, no
 * Qdrant (calls recordFragments directly with a synthetic window id). Scratch
 * corpus '_prov_probe', self-cleaning via source_document CASCADE. Run:
 *
 *   cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     NODE_ENV=test npx tsx src/test/tools/frag-probe.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { config } from '../../config.js';
import { splitIntoUnits, unitPointId, sourceDocumentId, recordFragments } from '../../pipeline.js';

const CORPUS = '_prov_probe';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function main(): Promise<void> {
  const run = randomUUID().slice(0, 8);
  const sourceId = `probe-src-${run}`;
  const content =
    `Grace Hopper popularised the term "debugging" after a moth was found in the Harvard Mark II relay. ` +
    `She also led the team that built the first compiler, and championed machine-independent programming languages. ` +
    `Her work fed directly into the design of COBOL.`;
  const memoryId = randomUUID(); // synthetic window point id
  const units = splitIntoUnits(content);
  const expectedVersion = `v1:${config.EMBED_UNIT_CHARS}/${config.EMBED_UNIT_OVERLAP}`;
  const docId = sourceDocumentId(CORPUS, sourceId);

  console.log(`[frag-probe] run=${run} corpus=${CORPUS} memoryId=${memoryId} units=${units.length}`);

  try {
    await recordFragments(memoryId, content, units, { corpusId: CORPUS, sourceId, contentType: 'prose' });

    // === source_document ===
    const docs = (await db.execute(sql`
      SELECT id, corpus_id, external_source_id, content_type, chunker_name, chunker_version
      FROM public.source_document WHERE corpus_id = ${CORPUS}
    `)) as unknown as Array<{ id: string; corpus_id: string; external_source_id: string; content_type: string; chunker_name: string; chunker_version: string }>;
    assert(docs.length === 1, `source_document has exactly 1 row (got ${docs.length})`);
    assert(docs[0]!.id === docId, 'source_document.id == deterministic sourceDocumentId(corpus, sourceId)');
    assert(docs[0]!.external_source_id === sourceId, 'source_document.external_source_id == the batch sourceId');
    assert(docs[0]!.chunker_name === 'sliding-window', 'chunker_name stamped');
    assert(docs[0]!.chunker_version === expectedVersion, `chunker_version == ${expectedVersion} (reproducible offsets)`);

    // === fragment: window ===
    const win = (await db.execute(sql`
      SELECT id, parent_id, kind, char_start, char_end, source_document_id
      FROM public.fragment WHERE id = ${memoryId}::uuid
    `)) as unknown as Array<{ id: string; parent_id: string | null; kind: string; char_start: number; char_end: number; source_document_id: string }>;
    assert(win.length === 1 && win[0]!.kind === 'window', 'window fragment exists (kind=window)');
    assert(win[0]!.parent_id === null, 'window fragment has NULL parent_id');
    assert(win[0]!.char_start === 0 && win[0]!.char_end === content.length, `window spans [0, ${content.length})`);
    assert(win[0]!.source_document_id === docId, 'window.source_document_id -> the document');

    // === fragment: units (parent chain + offsets + deterministic ids) ===
    const frags = (await db.execute(sql`
      SELECT id, parent_id, kind, char_start, char_end FROM public.fragment
      WHERE parent_id = ${memoryId}::uuid ORDER BY char_start
    `)) as unknown as Array<{ id: string; parent_id: string; kind: string; char_start: number; char_end: number }>;
    assert(frags.length === units.length, `unit fragments == ${units.length}`);
    for (let i = 0; i < frags.length; i++) {
      const f = frags[i]!;
      const idx = units.findIndex((u) => u.charStart === f.char_start && u.charEnd === f.char_end);
      assert(idx >= 0, `unit [${f.char_start},${f.char_end}) matches a real unit`);
      assert(f.id === unitPointId(memoryId, idx), `unit id == deterministic unitPointId(memoryId, ${idx})`);
      assert(f.parent_id === memoryId && f.kind === 'unit', 'unit fragment parent_id -> window, kind=unit');
    }

    // === transitive resolve: unit -> window -> source_document (the round-trip) ===
    const chain = (await db.execute(sql`
      SELECT sd.corpus_id AS corpus, sd.external_source_id AS src
      FROM public.fragment u
      JOIN public.fragment w ON w.id = u.parent_id
      JOIN public.source_document sd ON sd.id = w.source_document_id
      WHERE u.parent_id = ${memoryId}::uuid LIMIT 1
    `)) as unknown as Array<{ corpus: string; src: string }>;
    assert(chain.length === 1 && chain[0]!.corpus === CORPUS && chain[0]!.src === sourceId,
      'a unit fragment resolves transitively to its source_document (corpus + sourceId)');

    // === idempotency: a re-store writes nothing new ===
    await recordFragments(memoryId, content, units, { corpusId: CORPUS, sourceId, contentType: 'prose' });
    const after = (await db.execute(sql`
      SELECT (SELECT count(*) FROM public.source_document WHERE corpus_id = ${CORPUS}) AS d,
             (SELECT count(*) FROM public.fragment f JOIN public.source_document sd ON sd.id = f.source_document_id WHERE sd.corpus_id = ${CORPUS}) AS f
    `)) as unknown as Array<{ d: number; f: number }>;
    assert(Number(after[0]!.d) === 1, 'idempotent: still 1 source_document after re-run');
    assert(Number(after[0]!.f) === 1 + units.length, `idempotent: still ${1 + units.length} fragments after re-run`);

    console.log('\n[frag-probe] RESULT: PASS — source_document + fragment lineage populates with parent chain, offsets, chunker stamp, transitive resolve, and idempotent re-run.');
  } finally {
    // source_document CASCADE deletes its fragments.
    await db.execute(sql`DELETE FROM public.source_document WHERE corpus_id = ${CORPUS}`);
    const left = (await db.execute(sql`
      SELECT (SELECT count(*) FROM public.source_document WHERE corpus_id = ${CORPUS}) AS d,
             (SELECT count(*) FROM public.fragment WHERE id = ${memoryId}::uuid) AS w
    `)) as unknown as Array<{ d: number; w: number }>;
    console.log(`[frag-probe] cleanup: leftover source_document=${left[0]!.d} window_fragment=${left[0]!.w} (both must be 0)`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
