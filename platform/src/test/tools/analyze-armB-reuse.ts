/**
 * doc-24 Arm B diagnostic: is the vocabulary reuse GENUINE or LUMPING?
 *
 * Replays seeded-extractions.json in stream order, rebuilds the vocabulary, and
 * for every reuse event records which document shared which label. Emits:
 *  - reuse events by provenance (base/verbatim/paraphrase/distinct)
 *  - the verbatim-probe detail (cond3): reused vs new labels per verbatim doc
 *  - the distinct-field detail (cond2): distinct concepts that matched a base-origin label (over-merge)
 *  - a sample of the most-reused labels with the doc ids that share them (spot-check for lumping)
 *
 * Read-only over committed artifacts. Run after arm B completes.
 * Run: npx tsx src/test/tools/analyze-armB-reuse.ts
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ART = join(HERE, '../../../../docs/architecture/cross-corpus-audit/convergence-artifacts');
const load = <T>(n: string): T => JSON.parse(readFileSync(join(ART, n), 'utf8')) as T;

interface Corpus { base: Array<{ id: string; text: string }>; distinct: Array<{ id: string; text: string }>; verbatimIds: string[]; paraphrase: Array<{ id: string; text: string; ofId: string }>; }
const corpus = load<Corpus>('corpus.json');
const seeded = load<Record<string, string[]>>('seeded-extractions.json');

// rebuild the same stream order as the harness
const stream: Array<{ key: string; provenance: string }> = [];
for (const b of corpus.base) stream.push({ key: 'base:' + b.id, provenance: 'base' });
for (const vid of corpus.verbatimIds) stream.push({ key: 'verb:' + vid, provenance: 'verbatim' });
for (const p of corpus.paraphrase) stream.push({ key: 'para:' + p.id, provenance: 'paraphrase' });
for (const d of corpus.distinct) stream.push({ key: 'dist:' + d.id, provenance: 'distinct' });

const origin: Record<string, string> = {};   // label -> provenance that introduced it
const originDoc: Record<string, string> = {}; // label -> doc key that introduced it
const sharedBy: Record<string, string[]> = {}; // label -> doc keys that used it (incl origin)
const vocab = new Set<string>();

const reuseByProv: Record<string, { reuse: number; total: number }> = {};
const verbDetail: Array<{ key: string; reused: string[]; fresh: string[] }> = [];
const overMerge: Array<{ key: string; label: string; introBy: string }> = [];

for (const { key, provenance } of stream) {
  const labels = seeded[key] ?? [];
  reuseByProv[provenance] ??= { reuse: 0, total: 0 };
  const reused: string[] = [], fresh: string[] = [];
  for (const label of labels) {
    reuseByProv[provenance]!.total++;
    (sharedBy[label] ??= []).push(key);
    if (vocab.has(label)) {
      reuseByProv[provenance]!.reuse++;
      reused.push(label);
      if (provenance === 'distinct' && origin[label] === 'base') overMerge.push({ key, label, introBy: originDoc[label]! });
    } else {
      vocab.add(label); origin[label] = provenance; originDoc[label] = key; fresh.push(label);
    }
  }
  if (provenance === 'verbatim') verbDetail.push({ key, reused, fresh });
}

console.log('# Arm B reuse diagnostic\n');
console.log(`docs in seeded cache: ${Object.keys(seeded).length} / ${stream.length}`);
console.log(`vocab size: ${vocab.size}\n`);

console.log('## reuse rate by provenance (reuse = label already in vocab when seen)');
for (const prov of ['base', 'verbatim', 'paraphrase', 'distinct']) {
  const r = reuseByProv[prov]; if (!r) continue;
  console.log(`  ${prov.padEnd(11)} ${r.reuse}/${r.total} reused (${(100 * r.reuse / (r.total || 1)).toFixed(0)}%)`);
}

console.log('\n## cond3 verbatim detail (each verbatim doc = identical text to a base doc → should reuse ALL)');
for (const v of verbDetail) console.log(`  ${v.key}: reused ${v.reused.length}, fresh ${v.fresh.length}${v.fresh.length ? '  NEW: ' + v.fresh.join(', ') : ''}`);

console.log(`\n## cond2 over-merge detail: distinct-field concepts that matched a BASE-origin label (${overMerge.length} events)`);
for (const o of overMerge) console.log(`  ${o.key} reused "${o.label}" (introduced by ${o.introBy})`);
if (!overMerge.length) console.log('  (none — no distinct-field concept absorbed into a base-origin label)');

console.log('\n## most-reused labels (spot-check: are the sharing docs really about the same concept?)');
const ranked = Object.entries(sharedBy).filter(([, ds]) => ds.length >= 3).sort((a, b) => b[1].length - a[1].length).slice(0, 25);
for (const [label, ds] of ranked) console.log(`  "${label}" ×${ds.length}: ${[...new Set(ds)].slice(0, 8).join(' ')}`);
