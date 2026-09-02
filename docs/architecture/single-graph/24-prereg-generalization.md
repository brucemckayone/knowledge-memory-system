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

## RESULTS (2026-09-02) — PRIMARY FAILS on q-bio; the failure is a query-degree MIXTURE effect, not a domain effect

**Outcome:** PRIMARY fails both oracles on `qbio` (FACTNAME − NAME strict R@10 = **−0.0106, SPANS 0** on all
three bootstraps; condensed = **+0.0000, SPANS 0**). A valid banked NEGATIVE — but the honest reading is
**not** "the lever is arxiv/CS-specific." The lever's *per-degree behaviour* largely replicates on q-bio;
only the *net aggregate* lift fails, and that is a **query-degree mixture effect** (below). Blind adversary
reproduced everything bit-for-bit and rewrote the framing (see §Adversary).

### Substrate built (§2/§3)
- corpus_id `qbio`, **320 arXiv q-bio abstracts**. **arXiv query (recorded per §2):** `search_query` = OR of
  all 10 q-bio subcategories (q-bio.BM/CB/GN/MN/NC/PE/QM/SC/TO/OT), `sortBy=submittedDate&sortOrder=descending`,
  fetched 2026-09-01 (most-recent window; arXiv ids `2608.*`). 320 kept (abstract ≥ 100 chars, deduped);
  mean abstract 1478 chars.
- **Disjointness (§2, VOID-b — does not fire):** 0 paper-id overlap with corpus-A/B (arxiv/dal are OpenAlex
  `W…` ids; qbio are arXiv ids). Vocabulary top-200 content-word Jaccard vs arxiv+dal = 0.311, and that
  overlap is generic academic/ML boilerplate; subject terms cleanly disjoint (qbio: cell, protein,
  biological, dynamics, networks; arxiv: image, text, diffusion, chatgpt, llms, vision). Adversary spot-check
  confirmed genuine biology entities/facts (`messenger rna`, `nuclear pore complex`, `pathological protein
  spreading → neurodegenerative disease`).
- **Ingest = the production epoch path** (`corpus-graph-ingest.ts`), with the **causal pass disabled** via a
  new `DISABLE_CAUSAL_PASS` kill switch (config.ts + pipeline.ts). This is **measurement-neutral**: the causal
  pass is Phase 4, runs AFTER `promote()` commits the Graph S substrate (entities/facts/fact_embedding), and
  writes ONLY Graph C (causal_events/edges), which the eval never reads. Disabled because at ~10 min/batch
  (the Claude causal agent) it dominated wall-clock + LLM cost; extraction alone is ~4 min/batch. The Graph S
  substrate is construction-identical to how arxiv/dal were built. (Ingest survived one org-monthly-spend 429
  mid-run; resumed cleanly from the ledger after reset — no duplication.)
- **Final graph: 3670 entities / 6955 facts** (all active + embedded; 3670/3670 entities have ≥1 fact).
  Denser than arxiv (1230–1282 entities / ~2860 facts) — q-bio abstracts name more distinct entities.

### Wiring anchor (§7 VOID) — PASS (bit-for-bit, adversary-verified)
`arxiv-fusion.ts` reproduces R4 to full float precision: NAME strict `0.19121447028423771`, FACTNAME strict
`0.26356589147286824`, FACTNAME−NAME byPair `0.07235142118863053`, n=387. Harness did not drift.

### PRIMARY (§6) — FAILS both oracles
- **n=94** query pairs (> 30 floor → not underpowered-VOID; CIs wide, ≈ ±0.06–0.07).
- **Strict FACTNAME − NAME = −0.0106, SPANS 0** (pair [−0.0745, 0.0532], entity [−0.0778, 0.0485],
  doc [−0.0745, 0.0526]). Integer hits @10: NAME 34, FACTMAX 24, FACTNAME 33 (of 94); Δ = (33−34)/94.
- **Condensed FACTNAME − NAME = +0.0000, SPANS 0** all three.
- **No complementarity here:** fusion (33) is BELOW its best component NAME (34) — opposite of arxiv (fusion
  102 > max 86). FACTMAX (24) is strictly dominated by NAME (34), so RRF only dilutes the stronger signal.
- **Tie-break INVARIANT** (adversary): 33/94 query targets have a duplicated canonical_name, but recomputing
  under index-DESC gives an identical delta (NAME 34, FACTNAME 33, Δ −0.0106). This negative does NOT ride on
  the index-asc tie-break the project warns about — unlike absolute R@10 levels elsewhere.
- Note: q-bio's NAME baseline is unusually high (strict R@10 0.362 vs arxiv 0.191) and its mean relevant
  fraction low (0.5% vs arxiv 2.5%) — name-only is already strong, so there is structurally little headroom.

### SECONDARY (§6) — degree curve + the cross-domain decomposition (the real finding)
FACTNAME − NAME strict R@10 by **held-out** fact-degree, q-bio vs arxiv (arxiv reproduced with the committed
`arxiv-degree.ts`, warm cache, same engine):

| held-out degree | q-bio Δ (n) | arxiv Δ (n) |
|---|---|---|
| 1     | −0.0345 (29)  | −0.0462 (65)  SPANS 0 |
| 2–3   | −0.0500 (40)  | +0.0685 (73)  ABOVE 0 |
| 4–7   |  0.0000 (13)  |  0.0000 (85)  SPANS 0 |
| 8+    | **+0.1667 (12)** CI [0.000, 0.417] (touches 0) | **+0.1585 (164)** CI [0.104, 0.220] ABOVE 0 |
| query-mix | **73% degree 1–3 / 13% degree 8+** | 36% degree 1–3 / **42% degree 8+** |

**The per-degree lift largely replicates across domains:** the degree-8+ lift is ~+0.16 in BOTH (q-bio
+0.167 vs arxiv +0.158), and both go negative at degree 1. The only real divergence is the 2–3 bin (arxiv
+0.069 vs q-bio −0.050). What differs decisively is the **query-mix**: arxiv's held-out query targets are
degree-rich (42% at 8+, where the lift is large), q-bio's are degree-poor (73% at 1–3, where fusion ties or
hurts; only 13% at 8+). The arxiv aggregate nets to +0.072 and q-bio to ≈0 **as a mixture of the same
per-degree curve over different bin weights** — not because the lever behaves differently in biology.

### Disposition (per §6)
PRIMARY fails both oracles → banked NEGATIVE, framed honestly:
- **The fusion lever's per-degree behaviour GENERALIZES to q-bio; its net aggregate lift does NOT — because
  q-bio's held-out query targets are degree-poor.** The failure is **query-degree-mix-specific, not
  domain/vocabulary-specific.** Do NOT read this as "the lever is CS-specific."
- **Caveat 2 (degree-concentration): SUPPORTED**, chiefly by the cross-domain replication of the per-degree
  curve — the high-degree lift (~+0.16) survives a genuinely different domain. It is NOT "confirmed" off a
  single q-bio bin: the q-bio 8+ bin CI touches 0 (n=12, not individually significant).
- **Caveat 1 (extraction-only independence): partially closed.** A genuinely new, disjoint domain was tested;
  R4's fusion win is now understood as degree-gated + mix-dependent, not a universal or arxiv-vocabulary
  property.
- **Honest limits:** n=94, wide CIs → "no net lift detected on this query mix," not "proven zero." One domain.
  The causal-pass disable is a pipeline deviation (Graph-S-neutral by construction).

### Deployment implication
Fusing dense-names ⊕ dense-facts pays off **only where retrieval targets are well-connected entities**
(degree ≳ 8). It is safe (≈ tie, mild dilution risk) elsewhere. On corpora whose *query* entities are
paper-specific / sparse (like this q-bio slice), it will not move aggregate recall even though the graph is
dense overall — gate it on target degree, or expect a wash.

### Adversary (§8) — blind, independent; verdict SUPPORTED with required wording corrections (adopted above)
All seven checks PASS: (1) wiring anchor bit-for-bit; (2) qbio reproduced exactly (re-ran the tool); (3)
domain disjoint (0 id overlap, biology spot-check); (4) held-out guard real (`factSignals` excludes
query-doc facts from score AND `entCnt`; degree bins use post-exclusion `targetFactCount`); (5) arms correct
(NAME/FACTMAX/FACTNAME = RRF-60); (6) spec froze first (`git show aa850bf` added only the prereg; working-tree
prereg byte-identical to the freeze — no HARKing); (7) negative is a genuine null, not a substrate artifact,
and is tie-break invariant. The adversary's two corrections — (a) "degree-concentrated *confirmed*" →
"*supported* by cross-domain replication, not by any single q-bio bin"; (b) reframe the headline from
"does not generalize to q-bio" (reads domain-specific) to "query-degree-mix-specific" — are **adopted in the
disposition above**. The adversary also produced the arxiv-vs-qbio per-degree decomposition, reproduced here
independently via `arxiv-degree.ts`.

### Artifacts
`prereg-artifacts/qbio-fusion-results.json`, `qbio-run.txt`, `arxiv-degree-results.json`;
`qbio-embed-cache.json` (nomic entity-name + query-doc vectors). Tools: `qbio-fusion.ts`, `arxiv-degree.ts`.
Corpus: `convergence-artifacts/corpus-C.json`. Ledger/attribution: `multihop-artifacts/{ingest-ledger,attribution}-qbio.json`.
