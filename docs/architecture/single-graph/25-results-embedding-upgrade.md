# Results 25 — embedding upgrade: bge-m3 vs nomic-embed-text (POSITIVE, condensed oracle)

**Bead:** nmemo-u8j.5 · **Pre-registration:** doc 23 (frozen, committed 85e068b before computing)
**Verdict:** **PRIMARY PASS on the promotable (condensed) oracle — DEMONSTRATED.** bge-m3 lifts the
confirmed fusion `FACTNAME_bge − FACTNAME_nomic` condensed R@10 = **+0.0930, above 0 on all three
bootstraps**. Strict is a positive point estimate but spans 0. Recommend opening a gated production-swap
bead. This does NOT itself swap the embedder (dim migration + HNSW rebuild is a separate task, per the bead).
**Adversary:** **CONFIRMED (DEMONSTRATED)** — blind; re-derived the +0.0930 as 149 vs 113 = +36/387
integer hit-counts, and decomposed the lift as 72% genuine target-finding / 28% relevant-set rescue (not
an artifact).
**Artifact:** `prereg-artifacts/embedding-upgrade-results.json` + `embedding-upgrade-run.txt` +
`bge-m3-embed-cache.json` (the new cache; the frozen `embed-cache.json` / `arxiv-embed-cache.json` were
NOT written). **Harness:** `platform/src/test/tools/embedding-upgrade.ts`.

## What was tested

An embedder A/B on arxiv (arxiv-nlp + arxiv-cv, n=387). The nomic arm is the frozen R4 arm (reads the
existing caches / stored `fact_embedding`; reproduces R4 bit-for-bit). The bge arm re-embeds three text
sets with bge-m3 (1024-dim) via Ollama into a separate cache: entity names, query docs, and fact
source-texts (`factEmbedTextFor`, all arxiv facts have `source_text`). The fact SET is identical (same
held-out filter + adjacency; `bgeFactSizeMatch` true both corpora). The ONLY thing that varies is the
embedder — same pairs, oracles, held-out guard, RRF-60, index-asc tie-break.

## Numbers (R@10)

| arm | strict | condensed |
|---|---|---|
| NAME_nomic | 0.1912 | 0.2429 |
| FACTNAME_nomic | 0.2636 | 0.2920 |
| NAME_bge | 0.2145 | 0.3152 |
| FACTNAME_bge | 0.2997 | 0.3850 |

**Deltas (all three cluster bootstraps, seed 20260831):**

| delta | condensed | strict |
|---|---|---|
| **PRIMARY FACTNAME_bge − FACTNAME_nomic** | **+0.0930 [pair 0.0491, ent 0.0387, doc 0.0485 lows] — ABOVE 0 on all 3** | +0.0362 [pair −0.0078, ent −0.0156, doc −0.0052] — spans 0 |
| SEC NAME_bge − NAME_nomic | +0.0724 ABOVE 0 on all 3 (pair [0.0336,0.1137]) | +0.0233 spans 0 |
| SEC lever FACTNAME_bge − NAME_bge | +0.0698 ABOVE 0 on all 3 (pair [0.0336,0.1085]) | (not gated) |

## Against the pre-registered bars (doc 23 §5)

- **PRIMARY (condensed byPair > 0):** +0.0930, byPair lower 0.0491 > 0 — **CLEARS**, and it is
  **DEMONSTRATED** (all three bootstraps above 0). bge-m3 is a measured upgrade for the fusion read path
  on the promotable oracle.
- **SECONDARY (name-signal lift):** NAME_bge − NAME_nomic condensed +0.0724, above 0 on all three — bge
  lifts the name signal too.
- **SECONDARY (lever preservation):** FACTNAME_bge − NAME_bge condensed +0.0698, above 0 on all three —
  the R4 fusion lever holds under a DIFFERENT embedder. A cross-embedder robustness confirmation of R4
  itself (the fusion beats name-only regardless of which dense embedder produces the two signals).

## Integrity (VOID guards, doc 23 §6 — all clear)

- nomic arm reproduces frozen R4 bit-for-bit (NAME strict/cond, FACTNAME strict/cond, FACTNAME−NAME strict
  byPair — 5/5 MATCH).
- Frozen caches byte-unchanged (size/mtime snapshot before==after).
- bge vectors 1024-dim, unit-norm (spot-check); bge fact-set size matches nomic on both corpora.

## Decision (per doc 23 §5)

**bge-m3 is worth a production swap — open the gated swap bead.** The condensed lift is DEMONSTRATED on
all three bootstraps and the fusion lever is preserved. The swap is a SEPARATE gated task (not done here):
it requires a pgvector dimension migration (768→1024 on `entities`/`facts` vector columns), a full
re-embed of every corpus (entity names + fact source-texts) — far larger than the 7975 arxiv texts
embedded here — and an HNSW index rebuild, plus a startup-validation update. The swap bead should also
re-run the A/B on a SECOND substrate (dal) before flipping the default, to close the single-substrate gap
below.

## Caveats (banked plainly)

1. **The lift is DEMONSTRATED on the condensed (promotable) oracle; STRICT spans 0.** FACTNAME strict
   delta is +0.0362 (positive point estimate) but its CI includes 0 on all three bootstraps — not
   significant. So "bge lifts the fusion" is a condensed-oracle claim (the oracle the loop promotes on,
   per nmemo-u8j.10). It must NOT be read as "bge lifts the strict +0.0724 R4 result" — that is a positive
   trend here, not a demonstrated gain. Same oracle-dependence shape as candidate-breadth's dal pass.
2. **Single substrate (arxiv only).** dal was not re-embedded (bead scope). The bge lift's generalization
   to another corpus is untested; the swap bead must re-measure on dal (and ideally the qbio corpus from
   nmemo-u8j.3) before a default flip.
3. **The condensed oracle is not arm-neutral (doc 12 §3), but the lift is mostly genuine.** The adversary
   decomposed the +36/387 condensed win: **26/36 (72%) is genuine target-finding** (the target itself
   enters the strict top-10 under bge where nomic missed even the condensed hit) and **10/36 (28%) is
   relevant-set-density rescue** (target stays outside strict top-10 but condensed forgives Tier-A∪Tier-B
   entities above it). So it is majority a real improvement, not primarily a density artifact.
4. **Cost not paid, and this is an UPPER BOUND on the deployed gap.** ~7975 arxiv texts re-embedded for
   the eval; a production swap re-embeds the whole DB and rebuilds HNSW — a real migration, correctly
   deferred to the gated bead. Note (adversary): the eval is brute-force EXACT dot-product over cached
   vectors, so it measures the embedder's intrinsic quality gap — approximate HNSW search in production
   could erode some of the +0.0930. The gated swap bead must re-measure end-to-end, not assume this number.

## Adversary (blind, before banking) — CONFIRMED

Independent re-derivation, blind to this write-up. Verdict: **PRIMARY + both SECONDARIES CONFIRMED on the
condensed oracle; not overclaimed.**

- **Provenance:** prereg committed 85e068b (18:11) with only the prereg file, byte-identical to the
  working tree; `bge-m3-embed-cache.json` mtime 18:20 (after the commit) — spec froze before compute.
  PRIMARY (condensed) grounded in prior decision nmemo-u8j.10, not post-hoc.
- **Integrity:** live re-run reproduces R4 5/5 bit-for-bit (nomic arm IS the R4 arm); harness re-run
  identical to the committed JSON except `bgeNewlyEmbedded 7975→0` (cache pre-populated); tsc 69.
- **No contamination:** the two frozen caches unchanged before/after; bge arm wrote only its own cache.
- **bge vectors:** all 7975 are dim-1024, finite, unit-norm (worst ‖v‖ dev 2.2e-15); independent curl
  re-embed of a real fact source_text matches the cache at cosine 1.0.
- **Same fact set (ids, not counts):** identical fact ids both arms (2862/2852); 0 facts lack source_text
  so `factEmbedTextFor` never hits the fallback. Decisive no-confound check: the stored nomic
  `fact_embedding` equals a fresh nomic embed of the same source_text at cosine 1.0 — both arms embed
  identical text; the sole variable is the embedder.
- **PRIMARY re-derived by hand:** condensed 149 (bge) vs 113 (nomic) = +36/387 = +0.093023 (exact match);
  strict 116 vs 102 = +14/387 = +0.036176 (exact). The +36 decomposes 72% genuine target-finding / 28%
  relevant-set rescue — a real improvement, not primarily an artifact.
- **Does NOT establish:** strict/exact-target significance (both strict deltas span 0); generalization
  (single arxiv substrate, well-populated); production end-to-end (exact dot-product is an upper bound;
  HNSW + the 768→1024 migration are unpaid). Recommendation: bank as CONFIRMED-on-condensed, frame the
  decision as "worth a gated re-measure on a second substrate," not a demonstrated end-to-end win.

Housekeeping: adversary removed its temp diagnostic and restored the results JSON to committed bytes.
