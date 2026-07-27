/**
 * doc-29 Part 3 — free-navigation arm (autonomous graph exploration; user-requested).
 * A scripted agent loop: Haiku drives multi-hop traversal of the concept graph (NO embedding), reading titles
 * of what it reaches, then ranks related B-docs. Full corpus B (147), not a pre-filtered pool.
 * Scored vs OpenAlex oracle; compared to mechanical JOIN-full-B / EMB-full-B on the same 20 queries.
 * Run: ML_SERVICES_URL=http://127.0.0.1:8000 npx tsx src/test/tools/cross-corpus-freenav.ts
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ML = process.env.ML_SERVICES_URL ?? 'http://127.0.0.1:8000';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '../../../../docs/architecture/cross-corpus-audit/convergence-artifacts');
const SPLIT = new Set(['C204321447', 'C31972630']);
const N_QUERIES = 20, MIN_RELATED = 3, MAX_ROUNDS = 4, REACH_CAP = 60, MENU_CAP = 40;

function load<T>(n: string): T | null { const p = join(OUT, n); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as T : null; }
function save(n: string, o: unknown): void { writeFileSync(join(OUT, n), JSON.stringify(o, null, 2)); }
function cosine(a: number[], b: number[]): number { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; } return d / (Math.sqrt(na) * Math.sqrt(nb) || 1); }
function firstBalancedJson(t: string): string | null { const s = t.indexOf('{'); if (s < 0) return null; let d = 0, q = false, e = false; for (let i = s; i < t.length; i++) { const c = t[i]!; if (q) { if (e) e = false; else if (c === '\\') e = true; else if (c === '"') q = false; continue; } if (c === '"') q = true; else if (c === '{') d++; else if (c === '}') { if (--d === 0) return t.slice(s, i + 1); } } return null; }
async function chatJson<T>(prompt: string, system: string, ms = 150_000): Promise<T | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(`${ML}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: prompt, system_prompt: system }), signal: ctrl.signal });
      if (!r.ok) throw new Error(`${r.status}`);
      const raw = (await r.json() as { response: string }).response;
      const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      for (const c of [cleaned, firstBalancedJson(raw)].filter((x): x is string => !!x)) { try { return JSON.parse(c) as T; } catch { /**/ } }
      throw new Error('parse');
    } catch { await new Promise((res) => setTimeout(res, 1000 * (attempt + 1))); } finally { clearTimeout(timer); }
  }
  return null;
}

interface Doc { id: string; title: string; abstract: string; concepts: Array<{ id: string; level: number; score: number }>; }
const oracleAt = (d: Doc, L: number) => new Set(d.concepts.filter((c) => c.level >= Math.max(2, L) && c.score >= 0.3 && !SPLIT.has(c.id)).map((c) => c.id));

async function main(): Promise<void> {
  const A = load<Doc[]>('corpus-A.json')!, B = load<Doc[]>('corpus-B.json')!, seeded = load<Record<string, string[]>>('cc-seeded.json')!, demb = load<Record<string, number[]>>('cc-docemb.json')!;
  const nB = B.map((d) => [...new Set(seeded[`B:${d.id}`] ?? [])]), nA = A.map((d) => [...new Set(seeded[`A:${d.id}`] ?? [])]);
  const eB = B.map((d) => demb[`B:${d.id}`]!), eA = A.map((d) => demb[`A:${d.id}`]!);
  // concept -> B indices
  const c2b = new Map<string, number[]>(); nB.forEach((cs, j) => cs.forEach((c) => { if (!c2b.has(c)) c2b.set(c, []); c2b.get(c)!.push(j); }));
  const relAt = (qi: number, L: number) => { const qo = oracleAt(A[qi]!, L); const r: number[] = []; B.forEach((d, j) => { const co = oracleAt(d, L); for (const c of qo) if (co.has(c)) { r.push(j); break; } }); return r; };
  const sample: number[] = []; for (let qi = 0; qi < A.length && sample.length < N_QUERIES; qi++) if (relAt(qi, 2).length >= MIN_RELATED) sample.push(qi);
  console.log(`free-nav sample: ${sample.length} queries`);

  const NAV_SYS = 'You explore a concept graph to find related papers. Respond ONLY with JSON.';
  const cache = load<Record<string, { ranked: number[]; rounds: number; expanded: number; reached: number }>>('cc-freenav-cache.json') ?? {};
  for (const qi of sample) {
    if (cache[`q${qi}`]) continue;
    const q = A[qi]!;
    const reached = new Set<number>(); const expanded = new Set<string>();
    let available = [...nA[qi]!];
    let rounds = 0;
    for (let r = 0; r < MAX_ROUNDS; r++) {
      const menu = available.filter((c) => !expanded.has(c)).slice(0, MENU_CAP);
      if (!menu.length) break;
      const reachedTitles = [...reached].slice(0, 40).map((j) => `${j}: ${B[j]!.title.slice(0, 80)}`);
      const prompt = ['You are finding Computer-Vision papers related to an NLP QUERY paper by expanding concepts in a shared concept graph.',
        `QUERY: "${q.title}" | ${q.abstract.slice(0, 350)}`, '',
        `Concepts already expanded: ${[...expanded].join(', ') || '(none)'}`,
        `CV papers reached so far (${reached.size}): ${reachedTitles.join(' || ') || '(none)'}`, '',
        `AVAILABLE concepts to expand (expanding one reveals CV papers tagged with it):`, menu.join(', '), '',
        'Pick the concepts most likely to reveal GENUINELY related CV papers (1-5). Stop when further expansion would only add unrelated papers.',
        'Return ONLY: {"expand":["concept-a",...],"done":false}  (done=true to stop).'].join('\n');
      const resp = await chatJson<{ expand?: string[]; done?: boolean }>(prompt, NAV_SYS);
      rounds++;
      const picks = (resp?.expand ?? []).filter((c) => menu.includes(c));
      for (const c of picks) { expanded.add(c); for (const j of (c2b.get(c) ?? [])) { if (reached.size < REACH_CAP) reached.add(j); } }
      // grow available with concepts of newly reached docs
      const freq = new Map<string, number>(); for (const j of reached) for (const c of nB[j]!) if (!expanded.has(c)) freq.set(c, (freq.get(c) ?? 0) + 1);
      available = [...new Set([...nA[qi]!.filter((c) => !expanded.has(c)), ...[...freq.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0])])];
      if (resp?.done) break;
    }
    // final rank
    const reachedList = [...reached];
    let ranked: number[] = [];
    if (reachedList.length) {
      const items = reachedList.slice(0, 50).map((j) => `${j}: ${B[j]!.title.slice(0, 90)}`);
      const rankPrompt = [`QUERY: "${q.title}" | ${q.abstract.slice(0, 400)}`, '',
        'From these reached CV papers, return those GENUINELY related to the query, ranked most-related first:', ...items, '',
        'Return ONLY: {"related":[id,...]} (integers).'].join('\n');
      const rr = await chatJson<{ related?: number[] }>(rankPrompt, NAV_SYS);
      ranked = (rr?.related ?? []).map(Number).filter((n) => reached.has(n));
    }
    cache[`q${qi}`] = { ranked, rounds, expanded: expanded.size, reached: reached.size };
    save('cc-freenav-cache.json', cache);
    console.log(`  q${qi}: rounds=${rounds} expanded=${expanded.size} reached=${reached.size} ranked=${ranked.length}`);
  }

  // score
  const recallK = (rk: number[], rel: Set<number>, k: number) => { if (!rel.size) return NaN; let h = 0; for (let i = 0; i < Math.min(k, rk.length); i++) if (rel.has(rk[i]!)) h++; return h / rel.size; };
  const precK = (rk: number[], rel: Set<number>, k: number) => { let h = 0; for (let i = 0; i < Math.min(k, rk.length); i++) if (rel.has(rk[i]!)) h++; return h / k; };
  const mrr = (rk: number[], rel: Set<number>) => { for (let i = 0; i < rk.length; i++) if (rel.has(rk[i]!)) return 1 / (i + 1); return 0; };
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const df = new Map<string, number>(); [...nA, ...nB].forEach((cs) => cs.forEach((c) => df.set(c, (df.get(c) ?? 0) + 1)));
  const idf = (c: string) => Math.log((A.length + B.length) / (df.get(c) ?? 1));
  const out: any = { prereg: 'doc-29 Part 3', levels: {} };
  for (const L of [2, 3]) {
    const rows = sample.map((qi) => {
      const rel = new Set(relAt(qi, L));
      const fn = cache[`q${qi}`]!.ranked;
      const joinFull = [...B.keys()].sort((x, y) => { const s = (a: number) => nA[qi]!.reduce((t, c) => t + (nB[a]!.includes(c) ? idf(c) : 0), 0); return s(y) - s(x); });
      const embFull = [...B.keys()].sort((x, y) => cosine(eA[qi]!, eB[y]!) - cosine(eA[qi]!, eB[x]!));
      return { rel, fn, joinFull, embFull, nav: cache[`q${qi}`]! };
    }).filter((r) => r.rel.size > 0);
    const M = (sel: (r: any) => number[], fn: any, k?: number) => mean(rows.map((r) => fn === mrr ? mrr(sel(r), r.rel) : fn(sel(r), r.rel, k)));
    out.levels[`L>=${L}`] = {
      queries: rows.length,
      navBehavior: { meanRounds: +mean(rows.map((r) => r.nav.rounds)).toFixed(1), meanExpanded: +mean(rows.map((r) => r.nav.expanded)).toFixed(1), meanReached: +mean(rows.map((r) => r.nav.reached)).toFixed(1), meanRanked: +mean(rows.map((r) => r.fn.length)).toFixed(1) },
      recall10: { freenav: +M((r) => r.fn, recallK, 10).toFixed(4), join: +M((r) => r.joinFull, recallK, 10).toFixed(4), emb: +M((r) => r.embFull, recallK, 10).toFixed(4) },
      precision5: { freenav: +M((r) => r.fn, precK, 5).toFixed(4), join: +M((r) => r.joinFull, precK, 5).toFixed(4), emb: +M((r) => r.embFull, precK, 5).toFixed(4) },
      mrr: { freenav: +M((r) => r.fn, mrr).toFixed(4), join: +M((r) => r.joinFull, mrr).toFixed(4), emb: +M((r) => r.embFull, mrr).toFixed(4) },
    };
  }
  save('cc-freenav-result.json', out);
  console.log(JSON.stringify(out.levels, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
