/**
 * doc-34 §6 step-0 PROBE (inspection, not a measurement — no bar, no claim).
 *
 * Question: does the production prose entity/relationship extractor produce a MEANINGFUL
 * entity+fact graph from (a) C++ code snippets and (b) arXiv abstracts? This decides which
 * corpus the first real multi-hop concept graph is built on. Read-only: hits ml-services,
 * writes nothing to the DB.
 *
 * Run: cd platform && npx tsx src/test/tools/extractor-probe.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ML = process.env.ML_SERVICES_URL ?? 'http://127.0.0.1:8000';
const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = join(HERE, '../../../../docs/architecture/cross-corpus-audit');
const OUT = join(DOCS, 'sweep-coverage-artifacts');
const N = 4;

async function post<T>(path: string, body: unknown, ms = 300_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(`${ML}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`${path} ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return (await r.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// NB: the ml-services entity field is `mention` (ml-client.ts ExtractEntitiesResponse), NOT `name`.
// Reading `.name` yields "?" for every entity, which silently produces 0 relationships downstream.
interface EntOut { entities?: Array<{ mention?: string; type?: string }> }
interface RelOut { relationships?: Array<{ subject?: string; predicate?: string; object?: string }> }

async function probe(label: string, text: string): Promise<Record<string, unknown>> {
  const e = await post<EntOut>('/extract-entities', { text });
  const names = (e.entities ?? []).map((x) => ({ name: x.mention ?? '?', type: x.type ?? '?' }));
  let rels: Array<{ subject: string; predicate: string; object: string }> = [];
  if (names.length > 0) {
    const r = await post<RelOut>('/extract-relationships', {
      content: text,
      entities: names.map((n) => ({ name: n.name, type: n.type })),
    });
    rels = (r.relationships ?? []).map((x) => ({
      subject: x.subject ?? '?', predicate: x.predicate ?? '?', object: x.object ?? '?',
    }));
  }
  console.log(`\n===== ${label} =====`);
  console.log(`  entities (${names.length}): ${names.map((n) => `${n.name}[${n.type}]`).join(', ') || '(none)'}`);
  console.log(`  facts (${rels.length}):`);
  for (const f of rels) console.log(`    ${f.subject} --${f.predicate}--> ${f.object}`);
  return { label, entities: names, facts: rels };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const code: Array<{ id: string; code: string; trueGuideline: string }> = JSON.parse(
    readFileSync(join(DOCS, 'recall-gate-artifacts/gate_code_raw.json'), 'utf8'),
  );
  const rules: Array<{ id: string; text: string }> = JSON.parse(
    readFileSync(join(DOCS, 'recall-gate-artifacts/gate_rules.json'), 'utf8'),
  );
  const arxiv: Array<{ id: string; title: string; abstract: string }> = JSON.parse(
    readFileSync(join(DOCS, 'convergence-artifacts/corpus-A.json'), 'utf8'),
  );

  const results: Record<string, unknown[]> = { code: [], rule: [], abstract: [] };
  for (let i = 0; i < N; i++) {
    results.code!.push(await probe(`CODE ${code[i]!.id} (true rule ${code[i]!.trueGuideline})`, code[i]!.code));
  }
  for (let i = 0; i < N; i++) {
    results.rule!.push(await probe(`RULE ${rules[i]!.id}`, rules[i]!.text));
  }
  for (let i = 0; i < N; i++) {
    const d = arxiv[i]!;
    results.abstract!.push(await probe(`ABSTRACT ${d.id}`, `${d.title}. ${d.abstract}`));
  }

  const count = (k: string) => {
    const rs = results[k] as Array<{ entities: unknown[]; facts: unknown[] }>;
    const e = rs.reduce((s, r) => s + r.entities.length, 0) / rs.length;
    const f = rs.reduce((s, r) => s + r.facts.length, 0) / rs.length;
    return `${k}: ${e.toFixed(1)} entities/doc, ${f.toFixed(1)} facts/doc`;
  };
  console.log(`\n----- summary -----\n${count('code')}\n${count('rule')}\n${count('abstract')}`);
  writeFileSync(join(OUT, 'extractor-probe.json'), JSON.stringify(results, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
