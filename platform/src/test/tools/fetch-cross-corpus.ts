/**
 * doc-28 — fetch two arXiv areas from OpenAlex with external concept oracle.
 * Corpus A = NLP (C204321447), Corpus B = CV (C31972630); arXiv-sourced, 2023, disjoint, N=150 each.
 * Persists corpus-A.json / corpus-B.json = [{id,title,abstract,concepts:[{id,display_name,level,score}]}]
 */
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '../../../../docs/architecture/cross-corpus-audit/convergence-artifacts');
const UA = 'mailto=bruce.mckay@hexagon.com';
const ARXIV = 'S4306400194';
const N = 150;
const MIN_ABS = 300;

function recon(inv: Record<string, number[]> | null): string {
  if (!inv) return '';
  const pos: string[] = [];
  for (const [w, ixs] of Object.entries(inv)) for (const i of ixs) pos[i] = w;
  return pos.join(' ').replace(/\s+/g, ' ').trim();
}
interface Concept { id: string; display_name: string; level: number; score: number; }
interface Doc { id: string; title: string; abstract: string; concepts: Concept[]; }

async function fetchArea(conceptId: string): Promise<Doc[]> {
  const out: Doc[] = [];
  let cursor = '*';
  while (out.length < N && cursor) {
    const url = `https://api.openalex.org/works?filter=primary_location.source.id:${ARXIV},concepts.id:${conceptId},publication_year:2023&per-page=200&cursor=${encodeURIComponent(cursor)}&${UA}`;
    const j = await (await fetch(url)).json() as { results?: any[]; meta?: { next_cursor?: string } };
    for (const w of (j.results ?? [])) {
      const abstract = recon(w.abstract_inverted_index);
      if (abstract.length < MIN_ABS || !w.title) continue;
      out.push({
        id: (w.id as string).split('/').pop()!,
        title: w.title,
        abstract,
        concepts: (w.concepts ?? []).map((c: any) => ({ id: (c.id as string).split('/').pop(), display_name: c.display_name, level: c.level, score: c.score })),
      });
      if (out.length >= N) break;
    }
    cursor = j.meta?.next_cursor ?? '';
    if (!(j.results ?? []).length) break;
  }
  return out;
}

async function main(): Promise<void> {
  console.log('fetching NLP (A)...');
  const A = await fetchArea('C204321447');
  console.log('fetching CV (B)...');
  const B = await fetchArea('C31972630');
  // disjoint: drop any id in both
  const bIds = new Set(B.map((d) => d.id));
  const aIds = new Set(A.map((d) => d.id));
  const overlap = [...aIds].filter((x) => bIds.has(x));
  const Af = A.filter((d) => !bIds.has(d.id));
  const Bf = B.filter((d) => !aIds.has(d.id));
  writeFileSync(join(OUT, 'corpus-A.json'), JSON.stringify(Af, null, 2));
  writeFileSync(join(OUT, 'corpus-B.json'), JSON.stringify(Bf, null, 2));
  console.log(`A(NLP)=${Af.length}  B(CV)=${Bf.length}  overlap-dropped=${overlap.length}`);
  console.log('A sample:', Af.slice(0, 2).map((d) => d.title.slice(0, 50)));
  console.log('B sample:', Bf.slice(0, 2).map((d) => d.title.slice(0, 50)));
  const cc = (ds: Doc[]) => (ds.reduce((s, d) => s + d.concepts.filter((c) => c.level >= 2).length, 0) / ds.length).toFixed(1);
  console.log(`avg L>=2 concepts/doc: A=${cc(Af)} B=${cc(Bf)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
