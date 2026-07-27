/**
 * doc-30 — fetch citing works (cited_by) for all 294 corpus papers, for the co-citation oracle.
 * Saves cc-cociters.json = { "W-id": ["citer-W-id", ...] } capped at CAP citers/paper. Incremental.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '../../../../docs/architecture/cross-corpus-audit/convergence-artifacts');
const UA = 'mailto=bruce.mckay@hexagon.com';
const CAP = 200;

async function main(): Promise<void> {
  const A = JSON.parse(readFileSync(join(OUT, 'corpus-A.json'), 'utf8')) as Array<{ id: string }>;
  const B = JSON.parse(readFileSync(join(OUT, 'corpus-B.json'), 'utf8')) as Array<{ id: string }>;
  const ids = [...A.map((d) => d.id), ...B.map((d) => d.id)];
  const p = join(OUT, 'cc-cociters.json');
  const store: Record<string, string[]> = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  let done = 0;
  for (const id of ids) {
    done++;
    if (store[id]) continue;
    const url = `https://api.openalex.org/works?filter=cites:${id}&select=id&per-page=${CAP}&${UA}`;
    try {
      const j = await (await fetch(url)).json() as { results?: Array<{ id: string }> };
      store[id] = (j.results ?? []).map((w) => w.id.split('/').pop()!);
    } catch { store[id] = []; }
    if (done % 25 === 0) { writeFileSync(p, JSON.stringify(store)); console.log(`fetched ${done}/${ids.length}`); }
  }
  writeFileSync(p, JSON.stringify(store));
  const counts = ids.map((id) => (store[id] ?? []).length);
  const withCiters = counts.filter((c) => c > 0).length;
  console.log(`done: ${ids.length} papers, ${withCiters} have >=1 citer, mean citers(capped ${CAP})=${(counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(0)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
