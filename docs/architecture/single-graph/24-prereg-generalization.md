# Pre-registration 24 — fusion generalization: new-domain corpus + sparse-graph stress test

**Bead:** nmemo-u8j.3 · **Depends on:** nmemo-u8j.1 (fusion read path), nmemo-u8j.2 (eval engine)
**Status:** FROZEN. Append results below the line; do not edit above it.
**Committed before computing:** yes. **THIS IS PRE-REGISTRATION ONLY — the ingest is ATTENDED-ONLY and
must NOT be run in the unattended overnight loop** (multi-hour, shared-DB write into `cognitive_test`).

## 1. Question

R4 (doc 16) confirmed the two-signal fusion `RRF-60(dense-names, dense-facts)` beats name-only —
**+0.0724 strict R@10, above 0 on all three bootstraps** — but with two banked caveats that this
experiment exists to close:

1. **Independence is EXTRACTION-ONLY.** arxiv and dal are the SAME 294 papers extracted twice; a genuinely
   different-domain corpus has never been tried. If the fusion win is a property of CS-paper vocabulary /
   this extraction, it may not transfer.
2. **The gain is DEGREE-CONCENTRATED** (may shrink on sparse graphs). R4 never stratified the lift by
   entity fact-degree.

**Does `FACTNAME − NAME` reproduce a positive strict-R@10 lift (all three bootstraps > 0) on a
genuinely different-domain, well-populated corpus; and how does the lift decay as target entity
fact-degree falls (the sparse-graph stress)?**

## 2. New-domain corpus (the substrate to build — ATTENDED)

- **Domain:** arXiv **q-bio (quantitative biology)** abstracts — deliberately outside cs.CL / cs.CV, so
  the vocabulary, entities, and relations are genuinely different from arxiv/dal, while the title+abstract
  format is identical so the production extraction path runs unchanged. (Any genuinely non-CS arXiv
  category — econ, cond-mat, astro-ph — is an acceptable substitute; q-bio is the a-priori pick.)
- **Size:** ~300 abstracts (matches the ~294-paper scale of arxiv/dal, so "well-populated" is comparable
  and the query-pair count is in the same range).
- **corpus_id:** `qbio` (new; MUST NOT collide with any existing corpus). Disjointness from arxiv/dal is
  required — verify no shared paper ids before ingest.
- **Acquisition (attended):** fetch ~300 q-bio abstracts into
  `docs/architecture/cross-corpus-audit/convergence-artifacts/corpus-C.json` as a
  `[{id,title,abstract}]` array (same shape as corpus-A/B.json). The fetch is an attended step; record
  the arXiv query (category + date window) used, for reproducibility.

## 3. Staged ingest (ATTENDED — the single command; DO NOT run in the loop)

The ingest tool `corpus-graph-ingest.ts` reads its source file from a fixed `CORPORA` map. Staging is two
lines then one command:

1. Place `corpus-C.json` (from §2).
2. Add ONE entry to `CORPORA` in `platform/src/test/tools/corpus-graph-ingest.ts`:
   ```ts
   C: { file: 'convergence-artifacts/corpus-C.json', corpusId: 'qbio' },
   ```
3. **The single staged ingest command:**
   ```bash
   cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
     QDRANT_URL=http://localhost:6335 ML_SERVICES_URL=http://localhost:8000 \
     NODE_ENV=test npx tsx src/test/tools/corpus-graph-ingest.ts --corpus=C --corpusId=qbio --batch=10 --concurrency=4
   ```
   Resumable (ledger `multihop-artifacts/ingest-ledger-qbio.json`); writes attribution to
   `multihop-artifacts/attribution-qbio.json` per batch. Corpus-scoped, non-destructive (a NEW corpus_id;
   never deletes or unscoped-writes existing corpora).

**Why attended-only:** the epoch pipeline runs the real LLM extraction over ~300 docs — multi-hour, heavy,
and it writes to the shared `cognitive_test` DB and the single Ollama. The overnight loop's hard rule is
one heavy job at a time and no unscoped writes; this ingest is exactly the kind of long shared-resource
write that must be supervised.

## 4. Eval (ATTENDED, after ingest) — a thin config over the eval engine

Reuse the R4 arms unchanged, pointed at `qbio`:
- Query pairs, held-out fact guard, both oracles (strict + condensed, min-3), RRF-60, index-asc — the same
  engine (`retrieval-eval/{core,data}`, `services/fusion`) that produced R4/doc 20/22.
- Entity name vectors + fact vectors are nomic (as ingested); a bge-m3 arm is out of scope here (that is
  nmemo-u8j.5).
- **Arms:** NAME, FACT, FACTNAME (= `RRF-60(NAME, FACT)`).
- **Degree stratification:** bin every query target by its held-out fact-degree {1, 2–3, 4–7, 8+};
  report `FACTNAME − NAME` (strict AND condensed) per bin — the decay curve that tests caveat 2.

## 5. Metric & statistics

- **R@10**, both oracles. Primary comparison = `FACTNAME − NAME`.
- **Deltas**, cluster bootstrap by pair AND entity AND document (seed 20260831, 10,000 resamples).
- Degree-stratified deltas (per §4) with per-bin n reported.

## 6. Pre-registered bars & decision rule

- **PRIMARY (generalization — matches the bead acceptance):** `FACTNAME − NAME`, **strict** R@10,
  **> 0 on ALL THREE bootstraps** (pair/entity/doc) on `qbio` ⇒ the fusion lever GENERALIZES to a new
  domain (DEMONSTRATED, the same bar R4 cleared). Condensed reported alongside.
- **SECONDARY (sparse-graph decay):** report the degree-stratified lift curve; the a-priori expectation
  (caveat 2) is the lift is largest in high-degree bins and smallest/zero in the degree-1 bin. This is a
  characterization, not a pass/fail gate.
- **Decision:**
  - PRIMARY clears ⇒ the fusion win is not an arxiv/dal artifact; R4 generalizes; note the degree decay as
    a deployment caveat (fusion helps most on well-connected entities).
  - PRIMARY strict fails but condensed clears ⇒ generalizes only on the promotable oracle; document the
    oracle dependence honestly (as candidate-breadth did for dal).
  - PRIMARY fails both ⇒ the lever does NOT transfer to this domain; document the limit honestly (the bead
    explicitly allows "or the limit documented honestly"). A negative is a valid banked outcome.

## 7. Kill / VOID conditions

- **VOID (underpowered):** the `qbio` extraction yields too few query pairs (target < ~30) for an
  informative bootstrap ⇒ do NOT report a pass/fail; document the substrate limit and stop (a bigger
  corpus is then the fix, not a claim).
- **VOID (not a new domain):** `corpus-C.json` paper ids overlap arxiv/dal, or the extracted vocabulary is
  not materially disjoint ⇒ the domain-shift premise fails; re-source the corpus.
- **VOID (wiring):** the eval harness, when pointed at arxiv, no longer reproduces the frozen R4 numbers
  bit-for-bit (NAME strict `0.19121447028423771`, FACTNAME strict `0.26356589147286824`,
  `FACTNAME−NAME` strict byPair `0.07235142118863053`) ⇒ the harness drifted; fix before trusting `qbio`.
- **Degeneracy guard:** if `qbio` entities are nearly all degree-0/1 (no real graph), the fusion has no
  fact signal to fuse — report as a sparse-substrate limit, not a fusion failure.

## 8. Adversary (ATTENDED, before banking)

Blind adversary: (a) confirm the eval reproduces R4 on arxiv (wiring anchor); (b) confirm `qbio` is a
genuinely disjoint domain (no paper-id overlap; spot-check vocabulary); (c) re-derive the PRIMARY
`FACTNAME − NAME` strict delta as an integer hit-count on `qbio`; (d) verify the held-out fact guard; (e)
check the degree bins are computed on HELD-OUT degree (not leaking the query doc's facts); (f) confirm the
spec froze before the `qbio` numbers existed.

## 9. Overnight-loop disposition

**Pre-registration committed. The ingest + eval + adversary + bank are ATTENDED and were NOT run in the
overnight loop** (per the goal's out-of-scope list). The next attended session runs §3, then §4, then §8.

---

<!-- RESULTS APPENDED BELOW THIS LINE -->
