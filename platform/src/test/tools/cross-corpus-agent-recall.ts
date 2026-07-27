/**
 * doc-29 Part 2 — matched-pool agent ranking (graph-vs-reading confound control).
 * Per query, build a pool = union(embedding top-15 B, JOIN top-15 B) capped 30 (recall-matched; pool-recall reported).
 * Four arms rank the SAME pool, scored on the OpenAlex oracle (L=2 primary, L=3 sensitivity):
 *   STRUCT (Haiku, sees {title, concept nodes, shared-with-query concepts})  — graph representation
 *   TEXT   (Haiku, sees {title, abstract})                                    — raw reading, no concepts
 *   JOIN   (mechanical IDF shared-node overlap on the pool)
 *   EMB    (mechanical doc-embedding cosine on the pool)
 * Run: ML_SERVICES_URL=http://127.0.0.1:8000 npx tsx src/test/tools/cross-corpus-agent-recall.ts
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ML = process.env.ML_SERVICES_URL ?? 'http://127.0.0.1:8000';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '../../../../docs/architecture/cross-corpus-audit/convergence-artifacts');
const SPLIT = new Set(['C204321447', 'C31972630']);
const N_QUERIES = 40, MIN_RELATED = 3, POOL_CAP = 30, EMB_K = 15, JOIN_K = 15;

function load<T>(n: string): T | null { const p = join(OUT, n); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as T : null; }
function save(n: string, o: unknown): void { writeFileSync(join(OUT, n), JSON.stringify(o, null, 2)); }
function cosine(a: number[], b: number[]): number { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; } return d / (Math.sqrt(na) * Math.sqrt(nb) || 1); }
function firstBalancedJson(t: string): string | null { const s = t.indexOf('{'); if (s < 0) return null; let d = 0, q = false, e = false; for (let i = s; i < t.length; i++) { const c = t[i]!; if (q) { if (e) e = false; else if (c === '\\') e = true; else if (c === '"') q = false; continue; } if (c === '"') q = true; else if (c === '{') d++; else if (c === '}') { if (--d === 0) return t.slice(s, i + 1); } } return null; }
async function chatJson<T>(prompt: string, system: string, ms = 150_000): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(`${ML}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: prompt, system_prompt: system }), signal: ctrl.signal });
      if (!r.ok) throw new Error(`/chat ${r.status}`);
      const raw = (await r.json() as { response: string }).response;
      const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      for (const c of [cleaned, firstBalancedJson(raw)].filter((x): x is string => !!x)) { try { return JSON.parse(c) as T; } catch { /**/ } }
      throw new Error('unparseable');
    } catch { await new Promise((res) => setTimeout(res, 1000 * (attempt + 1))); } finally { clearTimeout(timer); }
  }
  return {} as T;
}

interface Doc { id: string; title: string; abstract: string; concepts: Array<{ id: string; level: number; score: number }>; }
const oracleAt = (d: Doc, L: number) => new Set(d.concepts.filter((c) => c.level >= Math.max(2, L) && c.score >= 0.3 && !SPLIT.has(c.id)).map((c) => c.id));

async function main(): Promise<void> {
  const A = load<Doc[]>('corpus-A.json')!, B = load<Doc[]>('corpus-B.json')!, seeded = load<Record<string, string[]>>('cc-seeded.json')!, demb = load<Record<string, number[]>>('cc-docemb.json')!;
  const nB = B.map((d) => new Set(seeded[`B:${d.id}`] ?? [])), nA = A.map((d) => new Set(seeded[`A:${d.id}`] ?? []));
  const eB = B.map((d) => demb[`B:${d.id}`]!), eA = A.map((d) => demb[`A:${d.id}`]!);
  const Ndoc = A.length + B.length; const df = new Map<string, number>();
  for (const d of [...A, ...B]) for (const c of (seeded[`${A.includes(d) ? 'A' : 'B'}:${d.id}`] ?? [])) df.set(c, (df.get(c) ?? 0) + 1);
  // df needs correct keying:
  df.clear(); A.forEach((d) => { for (const c of nA[A.indexOf(d)]) df.set(c, (df.get(c) ?? 0) + 1); }); B.forEach((d, j) => { for (const c of nB[j]) df.set(c, (df.get(c) ?? 0) + 1); });
  const idf = (c: string) => Math.log(Ndoc / (df.get(c) ?? 1));
  const joinScore = (qn: Set<string>, cn: Set<string>) => { let s = 0; for (const c of qn) if (cn.has(c)) s += idf(c); return s; };

  const cache = load<Record<string, string[]>>('cc-agent-cache.json') ?? {};
  const results: any = { prereg: 'doc-29', levels: {} };
  // build query set once (L=2 defines the sample per §5)
  const relAt = (qi: number, L: number) => { const qo = oracleAt(A[qi]!, L); const r: number[] = []; B.forEach((d, j) => { const co = oracleAt(d, L); for (const c of qo) if (co.has(c)) { r.push(j); break; } }); return r; };
  const sample: number[] = []; for (let qi = 0; qi < A.length && sample.length < N_QUERIES; qi++) if (relAt(qi, 2).length >= MIN_RELATED) sample.push(qi);
  console.log(`query sample: ${sample.length} (>=${MIN_RELATED} related @L2)`);

  for (const L of [2, 3]) {
    const rows: Array<{ pool: number[]; rel: Set<number>; poolRel: number; ranks: Record<string, number[]> }> = [];
    for (const qi of sample) {
      const rel = new Set(relAt(qi, L)); if (!rel.size) continue;
      const embRank = [...B.keys()].sort((x, y) => cosine(eA[qi]!, eB[y]!) - cosine(eA[qi]!, eB[x]!));
      const joinRank = [...B.keys()].sort((x, y) => joinScore(nA[qi]!, nB[y]!) - joinScore(nA[qi]!, nB[x]!)).filter((j) => joinScore(nA[qi]!, nB[j]!) > 0);
      const pool = [...new Set([...embRank.slice(0, EMB_K), ...joinRank.slice(0, JOIN_K)])].slice(0, POOL_CAP);
      const poolRel = pool.filter((j) => rel.has(j)).length;
      // mechanical rankings restricted to pool
      const jRank = [...pool].sort((x, y) => joinScore(nA[qi]!, nB[y]!) - joinScore(nA[qi]!, nB[x]!));
      const eRank = [...pool].sort((x, y) => cosine(eA[qi]!, eB[y]!) - cosine(eA[qi]!, eB[x]!));
      // agent arms
      const qConcepts = [...nA[qi]!];
      const structItems = pool.map((j) => { const shared = [...nB[j]!].filter((c) => nA[qi]!.has(c)); return `${j}: "${B[j]!.title.slice(0, 90)}" | concepts: ${[...nB[j]!].join(', ')} | SHARED with query: ${shared.join(', ') || '(none direct)'}`; });
      const textItems = pool.map((j) => `${j}: "${B[j]!.title.slice(0, 90)}" | ${B[j]!.abstract.slice(0, 400)}`);
      const askStruct = ['A QUERY paper (from an NLP corpus) and CANDIDATE papers (from a Computer Vision corpus). Using the concept structure, return the candidate IDs that are GENUINELY topically related to the query (share real subject matter), ranked most-related first. Beware: a shared concept LABEL can be a false friend (same word, different meaning) — judge real relatedness.',
        '', `QUERY concepts: ${qConcepts.join(', ')}`, '', 'CANDIDATES:', ...structItems, '', 'Return ONLY: {"related":[id,id,...]} (integers, most related first, only those genuinely related).'].join('\n');
      const askText = ['A QUERY paper (from an NLP corpus) and CANDIDATE papers (from a Computer Vision corpus). Return the candidate IDs that are GENUINELY topically related to the query (share real subject matter), ranked most-related first.',
        '', `QUERY: "${A[qi]!.title}" | ${A[qi]!.abstract.slice(0, 500)}`, '', 'CANDIDATES:', ...textItems, '', 'Return ONLY: {"related":[id,id,...]} (integers, most related first, only those genuinely related).'].join('\n');
      const ck = (arm: string) => `q${qi}:${arm}`; // prompt is L-independent (pool+query only) — cache once, reuse across L
      for (const [arm, prompt] of [['struct', askStruct], ['text', askText]] as const) {
        if (!cache[ck(arm)]) { const r = await chatJson<{ related?: number[] }>(prompt, 'You judge cross-corpus topical relatedness. Respond ONLY with JSON.'); cache[ck(arm)] = (r.related ?? []).map(Number).filter((n) => pool.includes(n)).map(String); save('cc-agent-cache.json', cache); }
      }
      const structRank = (cache[ck('struct')] ?? []).map(Number);
      const textRank = (cache[ck('text')] ?? []).map(Number);
      rows.push({ pool, rel, poolRel, ranks: { struct: structRank, text: textRank, join: jRank, emb: eRank } });
    }
    // metrics
    const recallK = (rk: number[], rel: Set<number>, k: number) => { if (!rel.size) return NaN; let h = 0; for (let i = 0; i < Math.min(k, rk.length); i++) if (rel.has(rk[i]!)) h++; return h / rel.size; };
    const precK = (rk: number[], rel: Set<number>, k: number) => { let h = 0; for (let i = 0; i < Math.min(k, rk.length); i++) if (rel.has(rk[i]!)) h++; return h / k; };
    const mrr = (rk: number[], rel: Set<number>) => { for (let i = 0; i < rk.length; i++) if (rel.has(rk[i]!)) return 1 / (i + 1); return 0; };
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    const arms = ['struct', 'text', 'join', 'emb'] as const;
    const M = (fn: (rk: number[], rel: Set<number>) => number, arm: typeof arms[number]) => mean(rows.map((r) => fn(r.ranks[arm]!, r.rel)));
    const p5 = (arm: typeof arms[number]) => rows.map((r) => precK(r.ranks[arm]!, r.rel, 5));
    function bootCI(x: number[], y: number[]): [number, number] { const n = x.length; const d: number[] = []; let s = 29 * 1000 + n; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; for (let b = 0; b < 10000; b++) { let a = 0; for (let i = 0; i < n; i++) { const k = Math.floor(rnd() * n); a += x[k]! - y[k]!; } d.push(a / n); } d.sort((a, c) => a - c); return [d[250]!, d[9750]!]; }
    results.levels[`L>=${L}`] = {
      queries: rows.length, meanPoolRecall: +mean(rows.map((r) => r.poolRel / r.rel.size)).toFixed(3), meanRelInPool: +mean(rows.map((r) => r.poolRel)).toFixed(1), meanRel: +mean(rows.map((r) => r.rel.size)).toFixed(1),
      precision5: Object.fromEntries(arms.map((a) => [a, +M((rk, rl) => precK(rk, rl, 5), a).toFixed(4)])),
      recall10: Object.fromEntries(arms.map((a) => [a, +M((rk, rl) => recallK(rk, rl, 10), a).toFixed(4)])),
      mrr: Object.fromEntries(arms.map((a) => [a, +M(mrr, a).toFixed(4)])),
      ci_p5_struct_minus_text: bootCI(p5('struct'), p5('text')).map((v) => +v.toFixed(4)),
      ci_p5_struct_minus_join: bootCI(p5('struct'), p5('join')).map((v) => +v.toFixed(4)),
    };
  }
  save('cc-agent-result.json', results);
  console.log(JSON.stringify(results.levels, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
