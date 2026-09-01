/**
 * retrieval-eval — substrate loading, identical across all five harnesses.
 *
 *  - loadPairsAndEntities: the held-out query-pair construction (an entity that
 *    appears in >=2 papers becomes a query for every paper AFTER its first in
 *    ingest order; the target is the entity). Pair emission order is preserved
 *    exactly (corpus order, then paperToEntities key order, then ingest order)
 *    because the bootstrap consumes units in this order.
 *  - RelevanceModel: the condensed-oracle relevance set per query document —
 *    Tier A (attribution / fact-endpoint) ∪ Tier B (verbatim canonical-name
 *    match in title+abstract, name length >= 3). Tier B records name length +
 *    token count so e0's {min3,min5,min8,multi} sensitivity configs are pure
 *    filters; the primary (and the only config the other four use) is min3.
 *  - loadFactStates: active embedded facts per corpus, RAW pgvector -> L2-norm,
 *    with the integrity counters the fact arms gate on.
 *
 * bead nmemo-u8j.2
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { rawQuery } from '../../../db/raw.js';
import { dot, norm, normalise, parseVec, nameMatcher, mean } from './core.js';

export interface Doc { id: string; title: string; abstract: string }
export interface Ent { id: string; name: string; description: string | null }
export interface Pair { entityId: string; docId: string; corpusId: string }
export interface FactRow { id: string; subj: string; obj: string; emb: string }
export interface FactState { vecs: number[][]; paper: string[]; entFacts: Map<number, number[]> }

export interface SubstratePaths {
  arcDir: string;       // attribution-*.json + ingest-ledger-*.json
  corporaDir: string;   // corpus-*.json (docs)
  docFileFor: Record<string, string>;
}

export interface Substrate {
  docsById: Map<string, Doc>;
  entsByCorpus: Map<string, Ent[]>;
  attrByCorpus: Map<string, Record<string, string[]>>;
  factToPaperByCorpus: Map<string, Record<string, string>>;
  pairs: Pair[];
}

export async function loadPairsAndEntities(corpora: readonly string[], paths: SubstratePaths): Promise<Substrate> {
  const docsById = new Map<string, Doc>();
  const entsByCorpus = new Map<string, Ent[]>();
  const attrByCorpus = new Map<string, Record<string, string[]>>();
  const factToPaperByCorpus = new Map<string, Record<string, string>>();
  const pairs: Pair[] = [];
  for (const c of corpora) {
    const docs: Doc[] = JSON.parse(readFileSync(join(paths.corporaDir, paths.docFileFor[c]!), 'utf8'));
    for (const d of docs) docsById.set(d.id, d);
    const attrFull = JSON.parse(readFileSync(join(paths.arcDir, `attribution-${c}.json`), 'utf8')) as {
      paperToEntities: Record<string, string[]>; factToPaper: Record<string, string>;
    };
    attrByCorpus.set(c, attrFull.paperToEntities);
    factToPaperByCorpus.set(c, attrFull.factToPaper);
    const order: string[] = JSON.parse(readFileSync(join(paths.arcDir, `ingest-ledger-${c}.json`), 'utf8'));
    const pos = new Map(order.map((id, i) => [id, i]));
    const e2p = new Map<string, string[]>();
    for (const [paper, ents] of Object.entries(attrFull.paperToEntities)) for (const e of ents) {
      const l = e2p.get(e) ?? []; l.push(paper); e2p.set(e, l);
    }
    for (const [entityId, ps] of e2p) {
      const uniq = [...new Set(ps)].filter((p) => docsById.has(p) && pos.has(p));
      if (uniq.length < 2) continue;
      uniq.sort((a, b) => pos.get(a)! - pos.get(b)!);
      for (const docId of uniq.slice(1)) pairs.push({ entityId, docId, corpusId: c });
    }
    entsByCorpus.set(c, await rawQuery<Ent>(sql`
      SELECT id::text AS id, canonical_name AS name, description FROM public.entities
      WHERE corpus_id = ${c} ORDER BY id`));
  }
  return { docsById, entsByCorpus, attrByCorpus, factToPaperByCorpus, pairs };
}

interface MatchedName { idx: number; nameLen: number; multi: boolean }

/** Condensed-oracle relevance sets, with Tier-B sensitivity as a pure filter. */
export class RelevanceModel {
  private readonly tierA = new Map<string, Set<number>>();
  private readonly tierBMatched = new Map<string, MatchedName[]>();
  readonly tierBSizes: number[] = [];        // Tier-B size per query doc (min3)
  readonly relevantFracs: number[] = [];     // |relevant(min3)| / |corpus| per query doc

  constructor(corpora: readonly string[], sub: Substrate) {
    const queryDocs = new Map<string, Set<string>>();
    for (const p of sub.pairs) { const s = queryDocs.get(p.corpusId) ?? new Set<string>(); s.add(p.docId); queryDocs.set(p.corpusId, s); }
    for (const c of corpora) {
      const ents = sub.entsByCorpus.get(c)!;
      const idxOf = new Map(ents.map((e, i) => [e.id, i]));
      const matchers = ents.map((e, i) => {
        const nm = (e.name ?? '').trim();
        return nm.length < 3 ? null : { idx: i, re: nameMatcher(nm.toLowerCase()), nameLen: nm.length, multi: /\s/.test(nm) };
      });
      const p2e = sub.attrByCorpus.get(c)!;
      for (const docId of queryDocs.get(c) ?? []) {
        const d = sub.docsById.get(docId)!;
        const text = `${d.title} ${d.abstract}`.toLowerCase();
        const a = new Set<number>();
        for (const eid of p2e[docId] ?? []) { const i = idxOf.get(eid); if (i !== undefined) a.add(i); }
        const matched: MatchedName[] = [];
        for (const m of matchers) {
          if (!m) continue;
          if (a.has(m.idx)) continue; // Tier A takes precedence
          if (m.re.test(text)) matched.push({ idx: m.idx, nameLen: m.nameLen, multi: m.multi });
        }
        const key = `${c}#${docId}`;
        this.tierA.set(key, a);
        this.tierBMatched.set(key, matched);
        this.tierBSizes.push(matched.length);
        this.relevantFracs.push((a.size + matched.length) / ents.length);
      }
    }
  }

  /** Relevant set for a query doc: Tier A ∪ Tier B filtered by name length / token count. */
  relevant(key: string, minLen = 3, multiOnly = false): Set<number> {
    const out = new Set<number>(this.tierA.get(key) ?? []);
    for (const m of this.tierBMatched.get(key) ?? []) {
      if (m.nameLen < minLen) continue;
      if (multiOnly && !m.multi) continue;
      out.add(m.idx);
    }
    return out;
  }

  /** Just Tier A for a query doc (attribution endpoints). Returns a COPY, so a
   *  caller mutating it cannot corrupt the model (matches relevant()'s copy). */
  tierAOf(key: string): Set<number> { return new Set<number>(this.tierA.get(key) ?? []); }

  /** Just the Tier-B filtered set (excludes Tier A). */
  tierBOf(key: string, minLen = 3, multiOnly = false): Set<number> {
    const out = new Set<number>();
    for (const m of this.tierBMatched.get(key) ?? []) {
      if (m.nameLen < minLen) continue;
      if (multiOnly && !m.multi) continue;
      out.add(m.idx);
    }
    return out;
  }

  get meanTierBPerDoc(): number { return mean(this.tierBSizes); }
  get meanRelevantFrac(): number { return mean(this.relevantFracs); }
}

export interface FactLoadResult {
  factStateByCorpus: Map<string, FactState>;
  dimViol: number;
  meanRawNorm: number;
  selfDotViol: number;
}

export async function loadFactStates(
  corpora: readonly string[], entsByCorpus: Map<string, Ent[]>, factToPaperByCorpus: Map<string, Record<string, string>>,
): Promise<FactLoadResult> {
  const factStateByCorpus = new Map<string, FactState>();
  let rawNormSum = 0; let rawNormCount = 0; let selfDotViol = 0; let dimViol = 0;
  for (const c of corpora) {
    const ents = entsByCorpus.get(c)!;
    const idxOf = new Map(ents.map((e, i) => [e.id, i]));
    const rows = await rawQuery<FactRow>(sql`
      SELECT id::text AS id, subject_entity_id::text AS subj, object_entity_id::text AS obj, fact_embedding::text AS emb
      FROM public.facts WHERE corpus_id = ${c} AND expired_at IS NULL AND invalid_at IS NULL AND fact_embedding IS NOT NULL`);
    const f2p = factToPaperByCorpus.get(c)!;
    const vecs: number[][] = []; const paper: string[] = []; const entFacts = new Map<number, number[]>();
    for (const row of rows) {
      const raw = parseVec(row.emb);
      if (raw.length !== 768 || raw.some((x) => !Number.isFinite(x))) { dimViol += 1; continue; }
      rawNormSum += norm(raw); rawNormCount += 1;
      const nv = normalise(raw);
      if (Math.abs(dot(nv, nv) - 1) > 1e-6) selfDotViol += 1;
      const fi = vecs.length; vecs.push(nv); paper.push(f2p[row.id] ?? '');
      for (const eid of [row.subj, row.obj]) { const ei = idxOf.get(eid); if (ei !== undefined) { const l = entFacts.get(ei) ?? []; l.push(fi); entFacts.set(ei, l); } }
    }
    factStateByCorpus.set(c, { vecs, paper, entFacts });
    console.log(`${c}: ${rows.length} active embedded facts, ${entFacts.size}/${ents.length} entities with >=1 fact`);
  }
  return { factStateByCorpus, dimViol, meanRawNorm: rawNormSum / Math.max(1, rawNormCount), selfDotViol };
}
