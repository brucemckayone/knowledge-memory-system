/**
 * doc-30 — fetch referenced_works for all 294 corpus papers (citation oracle substrate).
 * Saves cc-citations.json = { "W-id": ["W-ref1", ...] }. Independent of our pipeline and of embedding.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '../../../../docs/architecture/cross-corpus-audit/convergence-artifacts');
const UA = 'mailto=bruce.mckay@hexagon.com';

async function main(): Promise<void> {
  const A = JSON.parse(readFileSync(join(OUT, 'corpus-A.json'), 'utf8')) as Array<{ id: string }>;
  const B = JSON.parse(readFileSync(join(OUT, 'corpus-B.json'), 'utf8')) as Array<{ id: string }>;
  const ids = [...A.map((d) => d.id), ...B.map((d) => d.id)];
  const refs: Record<string, string[]> = {};
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const url = `https://api.openalex.org/works?filter=ids.openalex:${batch.join('|')}&select=id,referenced_works&per-page=50&${UA}`;
    const j = await (await fetch(url)).json() as { results?: Array<{ id: string; referenced_works?: string[] }> };
    for (const w of (j.results ?? [])) refs[w.id.split('/').pop()!] = (w.referenced_works ?? []).map((r) => r.split('/').pop()!);
    console.log(`fetched ${Object.keys(refs).length}/${ids.length}`);
  }
  writeFileSync(join(OUT, 'cc-citations.json'), JSON.stringify(refs, null, 2));
  const withRefs = Object.values(refs).filter((r) => r.length > 0).length;
  const meanRefs = Object.values(refs).reduce((s, r) => s + r.length, 0) / Object.keys(refs).length;
  console.log(`done: ${Object.keys(refs).length} works, ${withRefs} have >=1 ref, mean refs=${meanRefs.toFixed(0)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
