/**
 * nmemo-uhp.25 (doc-21) — cross-corpus concept RECONCILIATION recall gate.
 *
 * Runs ONE blind agent-driven alignment over the two frozen concept vocabularies
 * (doc-20's cj-extracted.json), then re-scores the concept-JOIN with a 1-hop
 * traversal over the asserted relations. Graded by the EXTERNAL clang-tidy oracle
 * (cj-results.json oracleKey). No DB, no cosine seeding, no human labelling.
 *
 * Pre-registration: docs/architecture/cross-corpus-audit/21-concept-reconciliation-prereg.md
 * NOTHING in the bar (§6/§7) may change after the first number — R1.
 *
 * Run:
 *   ML_SERVICES_URL=http://127.0.0.1:8000 npx tsx src/test/tools/concept-reconcile-recall.ts
 *   (optional) --score-only  reuse a prior cr-relations.json (no Haiku calls)
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ART = join(HERE, '../../../../docs/architecture/cross-corpus-audit/concept-join-artifacts');
const SCORE_ONLY = process.argv.includes('--score-only');
const ML = process.env.ML_SERVICES_URL ?? 'http://127.0.0.1:8000';

// Direct /chat call with a long timeout (ml.generateJson caps at 60s, too short for
// claude -p which spawns a CLI per call). Parses raw JSON, tolerating code fences
// and trailing prose (balanced-brace scan) as the shipped generateJson does.
function firstBalancedJson(text: string): string | null {
  const start = text.indexOf('{'); if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}
async function chatJson<T>(prompt: string, system: string, timeoutMs = 240_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${ML}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: prompt, system_prompt: system }), signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`/chat ${resp.status}`);
    const raw = (await resp.json() as { response: string }).response;
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    for (const c of [cleaned, firstBalancedJson(raw)].filter((x): x is string => !!x)) {
      try { return JSON.parse(c) as T; } catch { /* next */ }
    }
    throw new Error(`unparseable JSON: ${raw.slice(0, 160)}`);
  } finally { clearTimeout(timer); }
}

// ---- frozen inputs (immutable; extraction does NOT re-run) ---------------------
const extracted = JSON.parse(readFileSync(join(ART, 'cj-extracted.json'), 'utf8')) as {
  codeConcepts: Record<string, { labels: string[] }>;
  ruleConcepts: Record<string, { labels: string[] }>;
};
const results = JSON.parse(readFileSync(join(ART, 'cj-results.json'), 'utf8')) as {
  guidelines: string[];
  oracleKey: Record<string, string>;
  perElement: Record<string, { cosRank: number }>;
};

const codeEls = Object.keys(extracted.codeConcepts);          // 29
const ruleIds = Object.keys(extracted.ruleConcepts);          // 27
const oracle = results.oracleKey;                             // element -> true guideline
const guidelines = results.guidelines;                        // 9

const codeLabelsOf = (e: string) => extracted.codeConcepts[e]!.labels;
const ruleLabelsOf = (r: string) => extracted.ruleConcepts[r]!.labels;

const codeVocab = [...new Set(codeEls.flatMap(codeLabelsOf))].sort();   // 61
const ruleVocab = [...new Set(ruleIds.flatMap(ruleLabelsOf))].sort();   // 50

// ---- the 5 frozen lexical-resolution merges (doc-20 baseline; cj-analysis.md) --
// These are what connected doc-20's 8/29 pairs post-resolution. Encoding them as
// baseline equivalences reproduces the un-reconciled JOIN (macro@5 0.256).
const BASELINE_MERGES: Array<[string, string]> = [
  ['unsafe-cast', 'unsafe-casting'],
  ['nested-namespace', 'namespace-nesting'],
  ['const-reference-parameter', 'pass-by-const-reference'],
  ['const-member-variable', 'const-data-member'],
  ['constexpr-constant', 'constexpr-variable'],
];

// ---- decoys (§5): real C++ concepts orthogonal to all 9 guidelines -------------
// NOTE: 'virtual-destructor' (original doc-21 §5 list) collided with a real rule concept
// (C.35 distractor) — it is NOT orthogonal, so it cannot test promiscuity. Replaced with
// 'regex-backtracking' (verified absent from both vocabularies). Recall is independent of the
// decoy set (decoys are never exhibited by real elements), so this only cleans the discrimination
// guard; it cannot change the recall number. Disclosed as a mid-run fixture fix (R26).
const DECOYS = [
  'thread-mutex-lock', 'regex-backtracking', 'lambda-capture', 'signal-handler-registration',
  'network-socket-timeout', 'template-metaprogramming-recursion', 'atomic-compare-exchange',
  'coroutine-suspension', 'rvalue-reference-forwarding', 'stack-unwinding',
];

// ---- seeded shuffle (mulberry32) ----------------------------------------------
function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(arr: T[], seed: number): T[] {
  const a = arr.slice(); const rnd = mulberry32(seed);
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a;
}

// ---- Step A: blind agent alignment --------------------------------------------
type Relation = { a: string; b: string; type: 'equivalent' | 'specializes' | 'addresses' };
const VOCAB_A = shuffle([...codeVocab, ...DECOYS], 1337);   // code + decoys, shuffled
const VOCAB_B = shuffle(ruleVocab, 7331);                    // rule concepts, shuffled
const B_BATCH = 12;

function alignmentPrompt(bBatch: string[]): string {
  return [
    'Two vocabularies of software-engineering (C++) concepts were extracted independently from two',
    'different documents. They use different wording for the same ideas. Align them.',
    '',
    'VOCABULARY A:',
    VOCAB_A.map((x) => `  - ${x}`).join('\n'),
    '',
    'VOCABULARY B (align THESE):',
    bBatch.map((x) => `  - ${x}`).join('\n'),
    '',
    'For each concept b in VOCABULARY B, find every concept a in VOCABULARY A that names the SAME',
    'mechanism or a DIRECTLY related one. Relation type:',
    '  - "equivalent": a and b are the same concept, different words (e.g. unsafe-cast / unsafe-casting).',
    '  - "specializes": a is a specific kind of b (e.g. reinterpret-cast specializes unsafe-cast).',
    '  - "addresses": a is the fix/counterpart for the problem named by b (e.g. named-constant addresses magic-constant).',
    'Assert a relation ONLY when a competent C++ engineer would agree the two refer to the same or a',
    'directly-related mechanism. Be strict: if b has no genuine match in A, omit it. Do not force matches.',
    '',
    'Return ONLY JSON: {"relations":[{"a":"<label from A>","b":"<label from B>","type":"equivalent|specializes|addresses"}]}',
  ].join('\n');
}

async function runAlignment(): Promise<Relation[]> {
  const SYS = 'You are a precise C++ domain expert. Respond ONLY with a JSON object, no prose, no code fences.';
  const validA = new Set(VOCAB_A);
  const batches: string[][] = [];
  for (let i = 0; i < VOCAB_B.length; i += B_BATCH) batches.push(VOCAB_B.slice(i, i + B_BATCH));
  const perBatch = await Promise.all(batches.map(async (batch, bi) => {
    const validB = new Set(batch);
    let parsed: { relations?: Relation[] } = {};
    try {
      parsed = await chatJson<{ relations?: Relation[] }>(alignmentPrompt(batch), SYS);
    } catch (e) {
      console.error(`  batch ${bi + 1}/${batches.length} FAILED: ${(e as Error).message}`);
    }
    const kept: Relation[] = [];
    for (const r of parsed.relations ?? []) {
      if (!r || typeof r.a !== 'string' || typeof r.b !== 'string') continue;
      if (!validA.has(r.a) || !validB.has(r.b)) continue; // drop hallucinated labels
      const type = (['equivalent', 'specializes', 'addresses'] as const).includes(r.type) ? r.type : 'equivalent';
      kept.push({ a: r.a, b: r.b, type });
    }
    console.log(`  batch ${bi + 1}/${batches.length}: ${batch.length} B-concepts -> ${kept.length} relations`);
    return kept;
  }));
  return perBatch.flat();
}

// ---- Step B: reconciled JOIN scoring (deterministic) ---------------------------
// bridge key on unordered label pair (baseline merges are symmetric; agent relations
// are code(a)->rule(b) but for scoring we only need "are these two labels linked").
const pairKey = (x: string, y: string) => (x < y ? `${x} ${y}` : `${y} ${x}`);

function buildBridgeSet(agent: Relation[], useAgent: boolean): Set<string> {
  const s = new Set<string>();
  for (const [x, y] of BASELINE_MERGES) s.add(pairKey(x, y));
  if (useAgent) for (const r of agent) s.add(pairKey(r.a, r.b));
  return s;
}

function score(el: string, rule: string, bridges: Set<string>): number {
  const cs = codeLabelsOf(el); const rs = ruleLabelsOf(rule);
  let n = 0;
  for (const c of cs) for (const r of rs) {
    if (c === r || bridges.has(pairKey(c, r))) n++;
  }
  return n;
}

// rank of the true rule, ties broken AGAINST it (doc-20 §7): true rule placed last among equals.
function rankTrueRule(el: string, bridges: Set<string>): number {
  const trueGuideline = oracle[el]!;
  const trueScore = score(el, trueGuideline, bridges);
  let better = 0, equal = 0;
  for (const r of ruleIds) {
    if (r === trueGuideline) continue;
    const sc = score(el, r, bridges);
    if (sc > trueScore) better++;
    else if (sc === trueScore) equal++;
  }
  return better + equal + 1; // conservative
}

function perGuidelineHits(bridges: Set<string>, k: number): Map<string, { hit: number; n: number }> {
  const m = new Map<string, { hit: number; n: number }>();
  for (const el of codeEls) {
    const g = oracle[el]!;
    const rank = rankTrueRule(el, bridges);
    const cur = m.get(g) ?? { hit: 0, n: 0 };
    cur.n++; if (rank <= k) cur.hit++;
    m.set(g, cur);
  }
  return m;
}

function macroAtK(bridges: Set<string>, k: number): number {
  const m = perGuidelineHits(bridges, k);
  let sum = 0; for (const g of guidelines) { const v = m.get(g)!; sum += v.hit / v.n; }
  return sum / guidelines.length;
}

// cosine macro@k from frozen cosRank (reproduces doc-20)
function cosMacroAtK(k: number): number {
  const m = new Map<string, { hit: number; n: number }>();
  for (const el of codeEls) {
    const g = oracle[el]!; const cur = m.get(g) ?? { hit: 0, n: 0 };
    cur.n++; if (results.perElement[el]!.cosRank <= k) cur.hit++;
    m.set(g, cur);
  }
  let sum = 0; for (const g of guidelines) { const v = m.get(g)!; sum += v.hit / v.n; }
  return sum / guidelines.length;
}

// per-element hit vector for bootstrap (per-guideline mean resample)
function guidelineRecallVec(bridges: Set<string>, k: number): Map<string, number> {
  const m = perGuidelineHits(bridges, k);
  const out = new Map<string, number>();
  for (const g of guidelines) { const v = m.get(g)!; out.set(g, v.hit / v.n); }
  return out;
}
function cosGuidelineRecallVec(k: number): Map<string, number> {
  const m = new Map<string, { hit: number; n: number }>();
  for (const el of codeEls) { const g = oracle[el]!; const c = m.get(g) ?? { hit: 0, n: 0 }; c.n++; if (results.perElement[el]!.cosRank <= k) c.hit++; m.set(g, c); }
  const out = new Map<string, number>(); for (const g of guidelines) { const v = m.get(g)!; out.set(g, v.hit / v.n); } return out;
}

function bootstrapDiffCI(aVec: Map<string, number>, bVec: Map<string, number>): { mean: number; lo: number; hi: number } {
  const gs = guidelines; const N = gs.length; const iters = 10000; const rnd = mulberry32(20250721);
  const diffs: number[] = [];
  for (let it = 0; it < iters; it++) {
    let sa = 0, sb = 0;
    for (let i = 0; i < N; i++) { const g = gs[Math.floor(rnd() * N)]!; sa += aVec.get(g)!; sb += bVec.get(g)!; }
    diffs.push(sa / N - sb / N);
  }
  diffs.sort((x, y) => x - y);
  const mean = diffs.reduce((a, b) => a + b, 0) / iters;
  return { mean, lo: diffs[Math.floor(0.025 * iters)]!, hi: diffs[Math.floor(0.975 * iters)]! };
}

async function main(): Promise<void> {
  console.log('# doc-21 concept-reconciliation recall gate\n');
  // plumbing invariant (R40)
  console.log(`plumbing: ${codeEls.length} code elements, ${ruleIds.length} rules, ${guidelines.length} guidelines`);
  console.log(`vocab: ${codeVocab.length} code labels, ${ruleVocab.length} rule labels (+${DECOYS.length} decoys into A)`);
  if (codeEls.length !== 29 || ruleIds.length !== 27 || guidelines.length !== 9) throw new Error('plumbing invariant FAILED');
  // decoy validity (R43): a decoy that collides with a real concept cannot test promiscuity.
  const realVocab = new Set([...codeVocab, ...ruleVocab]);
  const badDecoys = DECOYS.filter((x) => realVocab.has(x));
  if (badDecoys.length) throw new Error(`INVALID decoys collide with real vocab: ${badDecoys.join(', ')}`);
  console.log(`decoy set validated: ${DECOYS.length} decoys, none collide with real vocab`);

  // Step A
  let agent: Relation[];
  const relPath = join(ART, 'cr-relations.json');
  if (SCORE_ONLY && existsSync(relPath)) {
    agent = (JSON.parse(readFileSync(relPath, 'utf8')) as { relations: Relation[] }).relations;
    console.log(`\n[--score-only] reusing ${agent.length} relations from cr-relations.json`);
  } else {
    console.log('\nStep A: blind agent alignment (Haiku)...');
    agent = await runAlignment();
    writeFileSync(join(ART, 'cr-alignment-input.json'), JSON.stringify({ vocabA: VOCAB_A, vocabB: VOCAB_B, decoys: DECOYS, bBatch: B_BATCH }, null, 2));
    writeFileSync(relPath, JSON.stringify({ generated: 'doc-21 concept-reconcile', relations: agent }, null, 2));
  }

  // ---- guards (§6.2) ----
  const decoySet = new Set(DECOYS);
  const decoyRels = agent.filter((r) => decoySet.has(r.a));
  const realRels = agent.filter((r) => !decoySet.has(r.a));
  const decoyAligned = new Set(decoyRels.map((r) => r.a)).size;   // distinct decoys aligned
  const density = realRels.length / (codeVocab.length * ruleVocab.length);
  console.log(`\nguards: ${agent.length} relations total | ${realRels.length} real | ${decoyRels.length} on decoys`);
  console.log(`  decoy alignment: ${decoyAligned}/${DECOYS.length} distinct decoys aligned (bar <= 1)`);
  console.log(`  density: ${(density * 100).toFixed(1)}% of ${codeVocab.length}x${ruleVocab.length}=${codeVocab.length * ruleVocab.length} (bar <= 15%)`);
  const byType = agent.reduce((m: Record<string, number>, r) => ((m[r.type] = (m[r.type] ?? 0) + 1), m), {});
  console.log(`  by type: ${JSON.stringify(byType)}`);

  // ---- recall (§6.1) ----
  const baseBridges = buildBridgeSet(agent, false);   // baseline: 5 lexical merges only
  const reconBridges = buildBridgeSet(agent, true);   // + agent relations
  const ks = [1, 3, 5, 8];
  const baseMacro: Record<number, number> = {}, reconMacro: Record<number, number> = {}, cosMacro: Record<number, number> = {};
  for (const k of ks) { baseMacro[k] = macroAtK(baseBridges, k); reconMacro[k] = macroAtK(reconBridges, k); cosMacro[k] = cosMacroAtK(k); }

  console.log('\nmacro recall@k:');
  console.log('| arm | @1 | @3 | @5 | @8 |');
  console.log('|-----|----|----|----|----|');
  const fmt = (o: Record<number, number>) => ks.map((k) => o[k]!.toFixed(3)).join(' | ');
  console.log(`| JOIN baseline (un-recon) | ${fmt(baseMacro)} |`);
  console.log(`| JOIN reconciled | ${fmt(reconMacro)} |`);
  console.log(`| cosine (doc-20) | ${fmt(cosMacro)} |`);

  // consistency check: baseline should reproduce doc-20's 0.256 @5
  const reproOk = Math.abs(baseMacro[5]! - 0.2556) < 0.02;
  console.log(`\nconsistency: baseline macro@5 = ${baseMacro[5]!.toFixed(4)} vs doc-20 0.2556 -> ${reproOk ? 'REPRODUCED' : 'MISMATCH (investigate before trusting)'}`);

  // connectivity: how many of 29 elements now share >=1 bridge with their true rule
  const conn = (b: Set<string>) => codeEls.filter((el) => score(el, oracle[el]!, b) > 0).length;
  console.log(`connectivity (true pair shares >=1 link): baseline ${conn(baseBridges)}/29 -> reconciled ${conn(reconBridges)}/29`);

  // ---- bootstrap CIs (§8) ----
  const ciVsCos = bootstrapDiffCI(guidelineRecallVec(reconBridges, 5), cosGuidelineRecallVec(5));
  const ciVsBase = bootstrapDiffCI(guidelineRecallVec(reconBridges, 5), guidelineRecallVec(baseBridges, 5));
  console.log(`\nbootstrap (recon - cosine) macro@5: mean ${ciVsCos.mean.toFixed(3)} 95% CI [${ciVsCos.lo.toFixed(3)}, ${ciVsCos.hi.toFixed(3)}]`);
  console.log(`bootstrap (recon - baseline) macro@5: mean ${ciVsBase.mean.toFixed(3)} 95% CI [${ciVsBase.lo.toFixed(3)}, ${ciVsBase.hi.toFixed(3)}]`);

  // ---- the frozen bar (§6) ----
  const cond1 = reconMacro[5]! >= 0.40 && reconMacro[5]! >= 0.356;
  const cond2 = decoyAligned <= 1 && density <= 0.15;
  const pass = cond1 && cond2;
  console.log('\n=== BAR (frozen §6) ===');
  console.log(`cond1 recall recovery (recon@5 >= 0.40 AND >= 0.356): recon@5=${reconMacro[5]!.toFixed(3)} -> ${cond1 ? 'PASS' : 'FAIL'}`);
  console.log(`cond2 discrimination (decoys<=1 AND density<=15%): decoys=${decoyAligned}, density=${(density * 100).toFixed(1)}% -> ${cond2 ? 'PASS' : 'FAIL'}`);
  console.log(`\n>>> GATE ${pass ? 'PASS' : 'FAIL'} <<<`);

  // per-guideline table + which pairs reconnected
  const baseG = perGuidelineHits(baseBridges, 5), reconG = perGuidelineHits(reconBridges, 5);
  const perGuideline = guidelines.map((g) => ({
    guideline: g, n: reconG.get(g)!.n,
    baseHit5: +(baseG.get(g)!.hit / baseG.get(g)!.n).toFixed(3),
    reconHit5: +(reconG.get(g)!.hit / reconG.get(g)!.n).toFixed(3),
    cosHit5: +(() => { let h = 0, n = 0; for (const el of codeEls) if (oracle[el] === g) { n++; if (results.perElement[el]!.cosRank <= 5) h++; } return h / n; })().toFixed(3),
  }));
  console.log('\nper-guideline @5 (base -> recon vs cos):');
  for (const p of perGuideline) console.log(`  ${p.guideline} (n=${p.n}): ${p.baseHit5} -> ${p.reconHit5}  [cos ${p.cosHit5}]`);

  writeFileSync(join(ART, 'cr-results.json'), JSON.stringify({
    prereg: 'doc-21', generated: 'concept-reconcile-recall',
    guards: { relationsTotal: agent.length, realRelations: realRels.length, decoyRelations: decoyRels.length, decoyAligned, density, byType },
    macro: { baseline: baseMacro, reconciled: reconMacro, cosine: cosMacro },
    connectivity: { baseline: conn(baseBridges), reconciled: conn(reconBridges), of: 29 },
    bootstrap: { reconVsCosine: ciVsCos, reconVsBaseline: ciVsBase },
    bar: { cond1, cond2, pass }, consistencyReproduced: reproOk,
    perGuideline,
  }, null, 2));
  console.log('\nwrote cr-results.json, cr-relations.json, cr-alignment-input.json');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
