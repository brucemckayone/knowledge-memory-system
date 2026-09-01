# Pre-registration — entity+fact fusion, confirmation on an independent extraction (experiment R4)

**Status:** FROZEN pre-registration. Written and committed BEFORE any number was computed.
**Date:** 2026-09-01 · **Branch:** `feat/single-graph-retrieval`
**Confirms:** `14-results-fact-level-retrieval.md` — the R3 secondary FACTNAME (name ⊕ fact-level RRF) beat
ARM-NAME: **robustly on the condensed oracle** (all three bootstraps > 0) and **borderline on strict**
(byPair/byDoc > 0, entity-cluster CI touched 0). A pre-registered secondary whose primary tied is a lead,
not a demonstration; this is its promotion attempt.

---

## 1. What this confirms, and the honest limit of "independent"

R3 found the one lever that separates after three single-substrate ties: **fusing entity-name retrieval
and fact-level retrieval** (two signals that share 0% of their top-10). R4 tests whether that survives a
**completely different extraction** of the corpus.

**The independence is in the EXTRACTION dimension, not the document dimension — stated plainly so it is
not overclaimed.** `arxiv-nlp` / `arxiv-cv` are the **same 147 + 147 papers** as `dal-nlp` / `dal-cv`
(ingest-ledger paper sets are identical), but a **separate ingest** (2026-08-24, before the
`EMBED_DESCRIPTIONS` re-ingest) with a different entity set (1230 / 1282, all descriptions NULL), a
different fact set (2862 / 2852, all embedded, all active), different attribution, and therefore a
**different set of query pairs** (~387 vs dal's 354). So R4 asks: *does the fusion advantage reproduce on
an independently extracted graph over the same documents?* It does **not** test generalisation to new
documents or new domains — that would need a different corpus and is out of scope here.

## 2. The question

On the arxiv extraction, does FACTNAME = RRF-60(ARM-NAME, FACT-MAX) retrieve the held-out target entity at
R@10 more often than ARM-NAME — and does it clear the bar R3 could only reach byPair?

## 3. Design — identical machinery to R3, new substrate

Exact cosine in-process (not HNSW). Fact vectors from the DB's stored `fact_embedding` (raw → L2-normalised).
Entity name vectors embedded via the same nomic path as R1–R3 (Ollama), cached in a **separate**
`arxiv-embed-cache.json` (the frozen doc-05 `embed-cache.json` is not modified). Query-doc vectors
(`${title} ${abstract}`, same papers) are reused from the frozen cache.

- **ARM-NAME:** entity vector = `embed(entityEmbedTextFor(name, null, 'name'))` = bare name (arxiv
  descriptions are NULL, so this is the only entity-vector arm available and needs none).
- **FACT-MAX:** entity score = max over its active facts (excluding facts sourced from the query doc d via
  `factToPaper`) of `cosine(query, normalise(fact_embedding))`.
- **FACTNAME (PRIMARY):** retrieved-set RRF-60 of the ARM-NAME ranking and the FACT-MAX ranking.

Query pairs: entity e attributed to ≥ 2 docs, d not e's first-attributing doc (ingest-ledger order). Both
oracles: **strict** (fact-endpoint attribution) and **condensed** (E0 Tier-B min-3, verbatim-name +
co-relevant condensation). Held-out fact guard as R3 — on arxiv `factToPaper` covers **100%** of active
facts (verified), so there is no unmapped-fact residual.

## 4. Bars — pre-registered, ALL THREE bootstraps (the R3 lesson)

Paired bootstrap CI, 10,000 resamples, seed **20260831**, resampling **query pairs, entities, and
documents** — all three computed for every headline (R3's harness omitted the cluster bootstraps for
secondaries; that will not recur).

- **PRIMARY — strict oracle, `FACTNAME R@10 − ARM-NAME R@10`:**
  - **CI above 0 on ALL THREE bootstraps → fusion DEMONSTRATED on target-finding.** (byPair alone is
    explicitly insufficient — this is exactly the standard R3 failed to meet on strict.)
  - above 0 on some but not all three → **PARTIAL / borderline** (replicates R3's strict pattern).
  - spans 0 on byPair → **not confirmed on strict**.
- **CO-PRIMARY — condensed oracle, same delta:** DEMONSTRATED on the relevance-set task iff above 0 on all
  three bootstraps (this is the R3 result being replicated).
- **Secondary:** `FACT-MAX − ARM-NAME` (expect tie); the fusion-complementarity decomposition (does
  FACTNAME hits > max(component hits)?); per-corpus split; k-ladder R@1/5/10/20.

**Pre-committed reading of the joint outcome:**

| strict (all 3) | condensed (all 3) | conclusion |
|---|---|---|
| above 0 | above 0 | fusion is a robust lever on BOTH tasks, and it generalises across extractions — the strongest result available here |
| borderline | above 0 | fusion is a robust **relevance-set** lever; its target-finding gain is real but marginal (replicates R3) |
| — | not above 0 | the R3 fusion win was **extraction-specific and does not replicate** — the lead is withdrawn |

## 5. Kill / void conditions

- **No doc-05 regression gate** — this is a different graph, so no bit-exact anchor exists. Instead:
  - **n < 100** query pairs → UNDERPOWERED (expect ~387).
  - **Fact-vector integrity:** every active fact parses to a finite 768-dim vector, else VOID; mean raw
    norm ≠ 1 (normalisation real) and post-normalise self-dot ∈ [1−1e-6, 1+1e-6], else VOID (the
    forgot-to-normalise silent no-op).
  - **Arms non-trivial:** ARM-NAME and FACT-MAX R@10 each in (0, 1) and not equal to each other's ranking
    — a clean 0.0000 or 1.0000, or a degenerate equality, is verified two ways before belief.
  - **Retrievability ceiling** reported (fraction of targets with ≥1 eligible fact after the guard).
  - **Arm-identity degeneracy:** FACT-MAX top-10 = ARM-NAME top-10 for > 95% → no conclusion.
- **Embedding coverage:** every arxiv entity name must embed to a non-empty vector (fail-loud, never
  degrade to `[]` — the doc-05 §9.5 zero-arm trap).

## 6. Process commitments

- Committed before the harness exists; not edited once numbers exist except to append results in a marked
  section. Harness audited against this text before numbers are read — **including that all three
  bootstraps are computed for the primary and co-primary** (the specific gap the R3 adversary caught).
- Deterministic set arithmetic; no LLM in the measurement path; bootstrap seeded (20260831).
- A **blind adversary** reviews before banking, tasked in **both** directions, and specifically tasked to
  check that the arxiv entity-name embeddings are genuine (not a cache collision with dal names), that the
  guard holds on the new extraction, and whether any FACTNAME win is fusion or one-arm dominance.
