/**
 * cronqa-load.ts — nmemo-asf.8 (doc 41). Bulk-load the CronQuestions KG (full.txt) onto
 * a TEMPORAL scratch corpus `_cronqa` (doc 39 recurring-facts mode). Deterministic,
 * embeds-free (fact_embedding NULL — the temporal arm is a structured index read, never a
 * vector read), so it bypasses createFact entirely. Re-runnable (cleans `_cronqa` first).
 *
 * Faithful load rules (doc 41 / scratch-asf8-investigation §C):
 *  - entity id = uuidv5(qid) (canonical_name is NOT unique); name = label; type 'thing'.
 *  - fact: predicate = PID, valid_at = Jan1(start), invalid_at = Jan1(end+1) (end>2021 ->
 *    NULL open-ended; end<start dropped), temporal_corpus = true (MANDATORY — flips the
 *    mig-060 unique index to (s,p,o,valid_at) so recurring windows coexist).
 *  - DEDUP the rows that collide on (s,p,o,valid_at=start): keep-MAX-end per (s,p,o,start).
 *  - user triggers on entities+facts DISABLED for the load (AGE sync + freshness bump) —
 *    inside the tx, re-enabled before commit (rolls back cleanly on failure).
 *
 * Run from platform/ (no ML needed):
 *   DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test NODE_ENV=test \
 *     npx tsx src/test/tools/cronqa-load.ts
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';

const CORPUS = '_cronqa';
const NS = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'; // same namespace as utils/context-uuid.ts
const KG = 'C:/Users/bruce.mckay/dev/nmemo/benchmarks/cronqa/upstream/data/wikidata_big/kg';

/** RFC-4122 v5 (SHA-1), mirrors platform/src/utils/context-uuid.ts. qid -> stable UUID. */
function qidUuid(qid: string): string {
  const h = createHash('sha1').update(Buffer.from(NS.replace(/-/g, ''), 'hex')).update(qid).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const jan = (y: number): Date => new Date(Date.UTC(y, 0, 1));

function loadLabels(path: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.indexOf('\t');
    if (t > 0) m.set(line.slice(0, t), line.slice(t + 1).replace(/\r$/, ''));
  }
  return m;
}

interface FactRow { s: string; p: string; o: string; start: number; end: number | null }

async function main(): Promise<void> {
  const t0 = Date.now();
  const labels = loadLabels(`${KG}/wd_id2entity_text.txt`);
  console.log(`[cronqa-load] entity labels: ${labels.size}`);

  // Parse + clean + dedup keep-max-end per (s,p,o,start).
  const best = new Map<string, FactRow>();
  const entityQids = new Set<string>();
  let rows = 0; let droppedBadWindow = 0; let droppedSelfRef = 0;
  for (const line of readFileSync(`${KG}/full.txt`, 'utf8').split('\n')) {
    if (!line) continue;
    const [s, p, o, startS, endS] = line.split('\t');
    if (!s || !p || !o || startS === undefined || endS === undefined) continue;
    rows++;
    if (s === o) { droppedSelfRef++; continue; }                 // facts.no_self_reference forbids self-loops
    const start = parseInt(startS, 10);
    const endRaw = parseInt(endS, 10);
    if (!Number.isFinite(start) || !Number.isFinite(endRaw)) continue;
    if (endRaw < start) { droppedBadWindow++; continue; }        // empty window
    const end = endRaw > 2021 ? null : endRaw;                    // sentinel "ongoing" -> open-ended
    const key = `${s}\t${p}\t${o}\t${start}`;
    const prev = best.get(key);
    // keep MAX end per (s,p,o,start); null = open-ended = widest, never replaced.
    if (!prev || (prev.end !== null && (end === null || end > prev.end))) {
      best.set(key, { s, p, o, start, end });
    }
    entityQids.add(s); entityQids.add(o);
  }
  const facts = [...best.values()];
  console.log(`[cronqa-load] parsed ${rows} rows -> ${facts.length} facts after dedup (dropped ${droppedBadWindow} end<start, ${droppedSelfRef} self-ref); entities ${entityQids.size}`);

  const missingLabel = [...entityQids].filter((q) => !labels.has(q));
  if (missingLabel.length) console.log(`[cronqa-load] WARNING ${missingLabel.length} entities without a label (using QID as name)`);

  await db.transaction(async (tx) => {
    // Clean any prior _cronqa first (re-runnable).
    await tx.execute(sql`DELETE FROM public.facts WHERE corpus_id = ${CORPUS}`);
    await tx.execute(sql`DELETE FROM public.entities WHERE corpus_id = ${CORPUS}`);
    await tx.execute(sql`DELETE FROM public.corpus_policies WHERE corpus_id = ${CORPUS}`);

    // Disable per-row user triggers (AGE sync + freshness) for the bulk load.
    await tx.execute(sql`ALTER TABLE public.entities DISABLE TRIGGER USER`);
    await tx.execute(sql`ALTER TABLE public.facts DISABLE TRIGGER USER`);
    try {
      // Corpus policy FIRST so temporal_corpus is meaningful.
      await tx.execute(sql`INSERT INTO public.corpus_policies (corpus_id, recurring_facts) VALUES (${CORPUS}, true)`);

      // Entities.
      const ents = [...entityQids];
      const EB = 4000;
      for (let i = 0; i < ents.length; i += EB) {
        const chunk = ents.slice(i, i + EB);
        const vals = chunk.map((q) => sql`(${qidUuid(q)}::uuid, ${labels.get(q) ?? q}, 'thing', ${CORPUS})`);
        await tx.execute(sql`INSERT INTO public.entities (id, canonical_name, entity_type, corpus_id) VALUES ${sql.join(vals, sql`, `)}`);
      }
      console.log(`[cronqa-load] inserted ${ents.length} entities`);

      // Facts.
      const FB = 3000;
      for (let i = 0; i < facts.length; i += FB) {
        const chunk = facts.slice(i, i + FB);
        const vals = chunk.map((f) => sql`(${qidUuid(f.s)}::uuid, ${f.p}, ${qidUuid(f.o)}::uuid, ${jan(f.start)}, ${f.end === null ? null : jan(f.end + 1)}, ${CORPUS}, true, 'kg_load', 1.0)`);
        await tx.execute(sql`INSERT INTO public.facts (subject_entity_id, predicate, object_entity_id, valid_at, invalid_at, corpus_id, temporal_corpus, extraction_method, confidence) VALUES ${sql.join(vals, sql`, `)}`);
        if ((i / FB) % 20 === 0) console.log(`   facts ${i}/${facts.length}`);
      }
      console.log(`[cronqa-load] inserted ${facts.length} facts`);
    } finally {
      await tx.execute(sql`ALTER TABLE public.entities ENABLE TRIGGER USER`);
      await tx.execute(sql`ALTER TABLE public.facts ENABLE TRIGGER USER`);
    }
  });

  const cnt = (await db.execute(sql`
    SELECT (SELECT count(*) FROM public.entities WHERE corpus_id = ${CORPUS}) AS e,
           (SELECT count(*) FROM public.facts WHERE corpus_id = ${CORPUS}) AS f
  `)) as unknown as Array<{ e: number; f: number }>;
  console.log(`[cronqa-load] DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s — entities=${cnt[0]!.e} facts=${cnt[0]!.f} in corpus ${CORPUS}`);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
