/**
 * temporal-recurrence-probe.ts — nmemo-asf.12 (doc 39: S2 + R1). DETERMINISTIC proof
 * that the single graph can now STORE recurring truth (the same (subject,predicate,
 * object) true across DISJOINT validity windows — A -> B -> A) in a per-corpus TEMPORAL
 * corpus, and READ it AS-OF a date, while a normal (non-temporal) corpus is unchanged
 * (still one active fact per (s,p,o)). No LLM / no Claude.
 *
 * Two layers:
 *  - SUBSTRATE (always runs, needs no ML service): direct INSERTs prove the mig-060
 *    functional unique index ALLOWS recurrence for temporal_corpus=true and REJECTS it
 *    (23505) for false; getEntityFactsAsOf (R1) resolves the right window per year,
 *    including the untrue gap (true->untrue->true).
 *  - WRITE-PATH (runs only if the embed service :8000 is up, else SKIPS): createFact in a
 *    temporal corpus inserts a new stint rather than corroborate-merging or superseding.
 *
 * Self-cleaning scratch corpora. Run from platform/:
 *   DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     ML_SERVICES_URL=http://localhost:8000 QDRANT_URL=http://localhost:6335 \
 *     QDRANT_COLLECTION=cognitive_test NODE_ENV=test EMBED_MODEL=nomic-embed-text \
 *     npx tsx src/test/tools/temporal-recurrence-probe.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { createFact, getEntityFactsAsOf, clearCorpusTemporalCache } from '../../services/facts.js';
import { handleToolCall } from '../../services/causal-agent.js';

const TC = '_temporal_probe';       // recurring_facts = true
const NC = '_nontemporal_probe';    // recurring_facts = false (default)

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

/** July 1 of a year, as the mid-year as-of instant (doc 39 §7 boundary convention). */
const midYear = (y: number): Date => new Date(Date.UTC(y, 6, 1));
/** Jan 1 of a year — validity-window boundary. */
const jan = (y: number): Date => new Date(Date.UTC(y, 0, 1));

async function mkEntity(corpus: string, name: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO public.entities (id, canonical_name, entity_type, corpus_id)
    VALUES (${id}::uuid, ${name}, 'thing', ${corpus})
  `);
  return id;
}

/** Direct fact insert (no embedding) — exercises the index + R1 read without the ML service. */
async function insFact(
  corpus: string, temporal: boolean, subj: string, pred: string, obj: string,
  validYear: number, invalidYear: number | null,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO public.facts (subject_entity_id, predicate, object_entity_id, valid_at, invalid_at, corpus_id, temporal_corpus)
    VALUES (${subj}::uuid, ${pred}, ${obj}::uuid, ${jan(validYear)}, ${invalidYear === null ? null : jan(invalidYear)}, ${corpus}, ${temporal})
  `);
}

async function embedServiceUp(): Promise<boolean> {
  const base = process.env.ML_SERVICES_URL ?? 'http://localhost:8000';
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function cleanup(): Promise<void> {
  const inC = sql`(${TC}, ${NC})`;
  await db.execute(sql`DELETE FROM public.causal_edges WHERE cause_event_id IN (SELECT id FROM public.causal_events WHERE corpus_id IN ${inC}) OR effect_event_id IN (SELECT id FROM public.causal_events WHERE corpus_id IN ${inC})`);
  await db.execute(sql`DELETE FROM public.fact_history WHERE fact_id IN (SELECT id FROM public.facts WHERE corpus_id IN ${inC})`);
  await db.execute(sql`DELETE FROM public.causal_events WHERE corpus_id IN ${inC}`);
  await db.execute(sql`DELETE FROM public.facts WHERE corpus_id IN ${inC}`);
  await db.execute(sql`DELETE FROM public.entities WHERE corpus_id IN ${inC}`);
  await db.execute(sql`DELETE FROM public.corpus_policies WHERE corpus_id IN ${inC}`);
}

async function main(): Promise<void> {
  const run = randomUUID().slice(0, 8);
  console.log(`[temporal-recurrence-probe] run=${run}`);
  await cleanup();

  try {
    // Seed the two corpus policies, then bust the createFact cache so it re-reads them.
    await db.execute(sql`INSERT INTO public.corpus_policies (corpus_id, recurring_facts) VALUES (${TC}, true)`);
    await db.execute(sql`INSERT INTO public.corpus_policies (corpus_id, recurring_facts) VALUES (${NC}, false)`);
    clearCorpusTemporalCache();

    // ===== SUBSTRATE: temporal corpus STORES recurrence (direct insert, no ML) =====
    const messi = await mkEntity(TC, `Messi ${run}`);
    const barca = await mkEntity(TC, `Barcelona ${run}`);
    const psg = await mkEntity(TC, `PSG ${run}`);
    // A -> B -> A: Barca 2005-2008, PSG 2008-2015, Barca AGAIN 2015-2018 (recurrence).
    await insFact(TC, true, messi, 'plays_for', barca, 2005, 2008);
    await insFact(TC, true, messi, 'plays_for', psg, 2008, 2015);
    await insFact(TC, true, messi, 'plays_for', barca, 2015, 2018); // same (s,p,o) as the first — the case a non-temporal corpus forbids
    const activeRows = (await db.execute(sql`
      SELECT count(*)::int AS n FROM public.facts
      WHERE corpus_id = ${TC} AND subject_entity_id = ${messi}::uuid AND predicate = 'plays_for' AND expired_at IS NULL
    `)) as unknown as Array<{ n: number }>;
    assert(activeRows[0]!.n === 3, `temporal: all 3 stints coexist as active incl. the recurring Barca window (got ${activeRows[0]!.n})`);

    // ===== SUBSTRATE: R1 as-of read resolves the right window per year =====
    const barcaAt = async (y: number): Promise<boolean> => {
      const rows = await getEntityFactsAsOf(messi, midYear(y), { predicate: 'plays_for', corpusId: TC });
      return rows.some((f) => f.objectEntityId === barca);
    };
    const psgAt = async (y: number): Promise<boolean> => {
      const rows = await getEntityFactsAsOf(messi, midYear(y), { predicate: 'plays_for', corpusId: TC });
      return rows.some((f) => f.objectEntityId === psg);
    };
    assert(await barcaAt(2006) && !(await psgAt(2006)), 'as-of 2006: Messi plays_for Barca (stint 1), not PSG');
    assert(await psgAt(2011) && !(await barcaAt(2011)), 'as-of 2011: Messi plays_for PSG — Barca is UNTRUE in the gap');
    assert(await barcaAt(2016) && !(await psgAt(2016)), 'as-of 2016: Messi plays_for Barca AGAIN (stint 2) — true -> untrue -> true resolved');
    const after = await getEntityFactsAsOf(messi, midYear(2020), { predicate: 'plays_for', corpusId: TC });
    assert(after.length === 0, 'as-of 2020: no plays_for window open (all closed by 2018)');

    // ===== MCP SURFACE: query_entity_facts_as_of via the real dispatch (env carrier, no ML) =====
    process.env.MNEMO_AGENT_ACTOR = 'reasoning_agent';
    process.env.MNEMO_CORPUS_ID = TC;
    const rawTool = await handleToolCall('query_entity_facts_as_of', { entity_id: messi, as_of: '2011-07-01', predicate: 'plays_for' });
    const parsed = JSON.parse(rawTool) as { facts: Array<{ objectEntityId: string | null }> };
    const toolObjs = new Set(parsed.facts.map((f) => f.objectEntityId));
    assert(toolObjs.has(psg) && !toolObjs.has(barca), 'MCP query_entity_facts_as_of @2011 via handleToolCall returns PSG, not Barca (corpus-scoped, as-of)');
    delete process.env.MNEMO_AGENT_ACTOR;
    delete process.env.MNEMO_CORPUS_ID;

    // ===== SUBSTRATE: non-temporal corpus REJECTS the identical-triple recurrence =====
    const p = await mkEntity(NC, `Person ${run}`);
    const orgA = await mkEntity(NC, `OrgA ${run}`);
    await insFact(NC, false, p, 'works_at', orgA, 2005, 2008); // first stint OK
    let rejected = false;
    try {
      await insFact(NC, false, p, 'works_at', orgA, 2015, 2018); // same (s,p,o) active -> must violate uniq index
    } catch (e) {
      rejected = (e as { code?: string })?.code === '23505';
    }
    assert(rejected, 'non-temporal: a 2nd active row for the same (s,p,o) is rejected (23505) — single-active-truth unchanged');

    // ===== WRITE-PATH: createFact honours the flag (needs the embed service) =====
    if (await embedServiceUp()) {
      const cfSubj = await mkEntity(TC, `Zidane ${run}`);
      const cfObjA = await mkEntity(TC, `ClubX ${run}`);
      const f1 = await createFact({ subjectEntityId: cfSubj, predicate: 'plays_for', objectEntityId: cfObjA, validAt: jan(1990), invalidAt: jan(1992), corpusId: TC, actor: 'system_trigger' });
      const f2 = await createFact({ subjectEntityId: cfSubj, predicate: 'plays_for', objectEntityId: cfObjA, validAt: jan(1996), invalidAt: jan(1998), corpusId: TC, actor: 'system_trigger' });
      assert(f1 !== f2, 'createFact temporal: a recurring stint (same s,p,o, new valid_at) is a NEW fact, not a corroborate-merge');
      const cfActive = (await db.execute(sql`
        SELECT count(*)::int AS n FROM public.facts
        WHERE corpus_id = ${TC} AND subject_entity_id = ${cfSubj}::uuid AND predicate = 'plays_for' AND expired_at IS NULL
      `)) as unknown as Array<{ n: number }>;
      assert(cfActive[0]!.n === 2, `createFact temporal: both stints active, none superseded (got ${cfActive[0]!.n})`);
      console.log('  (write-path section ran against the live embed service)');
    } else {
      console.log('  SKIP write-path section: embed service :8000 down (substrate proof above stands — it needs no ML)');
    }

    console.log('\n[temporal-recurrence-probe] RESULT: PASS — temporal corpus stores + reads recurring truth (true->untrue->true); non-temporal corpus unchanged.');
  } finally {
    delete process.env.MNEMO_AGENT_ACTOR;
    delete process.env.MNEMO_CORPUS_ID;
    await cleanup();
    clearCorpusTemporalCache();
    const left = (await db.execute(sql`
      SELECT (SELECT count(*) FROM public.facts WHERE corpus_id IN (${TC}, ${NC})) AS facts,
             (SELECT count(*) FROM public.entities WHERE corpus_id IN (${TC}, ${NC})) AS entities,
             (SELECT count(*) FROM public.corpus_policies WHERE corpus_id IN (${TC}, ${NC})) AS policies
    `)) as unknown as Array<{ facts: number; entities: number; policies: number }>;
    console.log(`[temporal-recurrence-probe] cleanup: leftover facts=${left[0]!.facts} entities=${left[0]!.entities} policies=${left[0]!.policies} (all must be 0)`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
