# Pre-registration 23 — embedding upgrade: bge-m3 vs nomic-embed-text (A/B on arxiv)

**Bead:** nmemo-u8j.5 · **Depends on:** nmemo-u8j.1 (fusion read path), nmemo-u8j.2 (eval engine)
**Status:** FROZEN. Append results below the line; do not edit above it.
**Committed before computing:** yes — committed before any bge-m3 re-embedding is scored.

## 1. Question

`nomic-embed-text` (137M params, 768-dim) is the lightweight/weak embedder; bge-m3 (568M, 1024-dim) leads
it on MTEB retrieval. The confirmed lever is the two-signal fusion `RRF-60(dense-names, dense-facts)`. A
stronger embedder could lift the NAME signal, the FACT signal, and thus the fusion, across the board — but
it also forces a full re-embed, a pgvector dim change (768→1024), and an HNSW rebuild before any production
swap.

**On the arxiv substrate, does bge-m3 lift NAME retrieval and the confirmed FACTNAME fusion over
nomic-embed-text, measured on the identical task, oracle, held-out guard, and RRF?** Per the epic gate:
MEASURE-FIRST; a production swap is a SEPARATE gated task, never done on this alone.

## 2. Substrate & harness

Identical query pairs, held-out fact guard, oracles, RRF, and tie-break as R4 / candidate-breadth /
doc 20/22. The ONLY thing that varies between the two arms of the A/B is the embedder. Thin config over
the eval engine.

- **Substrate:** arxiv-nlp + arxiv-cv ONLY (n≈387 pairs) — the R4-confirmed extraction and the corpus the
  bead scopes. dal is NOT re-embedded (nomic stays; out of scope). Well-populated (every entity ≥1 fact).
- **nomic arm = the frozen R4 arm**, read from the existing caches / stored `fact_embedding` (integrity
  anchor: must reproduce R4 bit-for-bit).
- **bge-m3 arm** re-embeds three text sets with bge-m3 into a SEPARATE writable cache
  (`prereg-artifacts/bge-m3-embed-cache.json`), calling Ollama `/api/embed` (model `bge-m3`) directly.
  **The frozen `embed-cache.json` and `arxiv-embed-cache.json` are NEVER written.** L2-normalised, so dot
  = cosine, exactly as the nomic path.
  1. entity name text = `entityEmbedTextFor(canonical_name, description, 'name')` (= the name; the shipped
     read path embeds the name only).
  2. query text = `${title} ${abstract}` (the same string nomic embedded).
  3. fact text = `factEmbedTextFor(source_text, predicate, object_value)` (the exact string the stored
     `fact_embedding` was built from; all arxiv facts have `source_text`, so it is the source text). The
     fact SET is identical to the nomic arm (same `expired_at IS NULL AND invalid_at IS NULL AND
     fact_embedding IS NOT NULL` filter, same held-out exclusion, same subject/object adjacency).

## 3. Arms (all on arxiv, index-asc tie-break, both oracles)

- **NAME_nomic** — full name-vector ranking, nomic (baseline; integrity anchor).
- **FACTNAME_nomic** — `RRF-60(NAME_nomic, FACT_nomic)`, the frozen R4 fusion (integrity anchor).
- **NAME_bge** — full name-vector ranking, bge-m3.
- **FACTNAME_bge** — `RRF-60(NAME_bge, FACT_bge)`, bge-m3 for both signals.

FACT_x = fact-max over ALL held-out facts, using embedder x's vectors for both the query and the fact
text; aggregated to endpoint entities by max, exactly as R4.

## 4. Metric & statistics

- **R@10**, both oracles: **strict** and **condensed** (min-3 Tier-A∪Tier-B). Primary = **condensed**
  (nmemo-u8j.10). Both shown.
- **Deltas** (embedder A/B, paired per query — same target, oracle, tie-break, so the delta is clean):
  `NAME_bge − NAME_nomic`, `FACTNAME_bge − FACTNAME_nomic`, and (lever-preservation)
  `FACTNAME_bge − NAME_bge`.
- **Cluster bootstrap** by pair AND entity AND document (seed 20260831, 10,000 resamples).
- **Cost (descriptive):** count of texts re-embedded and wall-clock; dim 768→1024; note the pgvector
  column + HNSW rebuild a production swap would require.

## 5. Pre-registered bars & decision rule

- **PRIMARY (does bge lift the confirmed fusion):** `FACTNAME_bge − FACTNAME_nomic`, **condensed** R@10,
  **byPair** CI lower bound **> 0** on arxiv ⇒ bge-m3 is a measured upgrade for the fusion read path;
  recommend opening a production-swap bead (dim migration + HNSW rebuild + re-embed), gated separately.
- **SECONDARY:** `NAME_bge − NAME_nomic` condensed byPair (does bge lift the name signal alone); and
  `FACTNAME_bge − NAME_bge` condensed byPair > 0 (is the R4 fusion lever PRESERVED under a different
  embedder — a cross-embedder robustness check on R4 itself).
- **Decision:**
  - PRIMARY clears (byPair > 0; ideally all-three-bootstraps for DEMONSTRATED) ⇒ bge is worth a swap;
    open the gated swap bead and record the per-arm lift + cost.
  - PRIMARY spans 0 ⇒ no measured fusion lift from bge on this substrate; do NOT swap (the re-embed +
    dim-migration + HNSW-rebuild cost buys nothing measured). Report the per-arm deltas honestly.
  - PRIMARY below 0 ⇒ bge is WORSE here; definitely no swap; document.
  - Report SECONDARY regardless (name-signal lift; lever preservation).

## 6. Kill / VOID conditions

- **VOID (mis-wired):** NAME_nomic / FACTNAME_nomic do NOT reproduce the frozen R4 numbers bit-for-bit on
  arxiv (NAME strict `0.19121447028423771`, cond `0.24289405684754523`; FACTNAME strict
  `0.26356589147286824`, cond `0.29198966408268734`; `FACTNAME−NAME` strict byPair `0.07235142118863053`).
- **VOID (bge mis-embedded):** any bge vector is not length 1024, not finite, or not unit-norm after
  normalisation (self-dot ≠ 1 within 1e-6); or the bge fact SET differs in size from the nomic fact set
  (a different held-out population would confound the A/B).
- **VOID (cache contamination):** the frozen `embed-cache.json` or `arxiv-embed-cache.json` mtime/size
  changes during the run — the bge arm must write ONLY to `bge-m3-embed-cache.json`.

## 7. Adversary

Blind adversary before banking: (a) confirm the nomic integrity anchors reproduce R4 live; (b) verify the
bge cache is 1024-dim, unit-norm, and that the two frozen caches are byte-unchanged (A/B did not
contaminate nomic); (c) verify the bge FACT arm re-embeds the SAME fact set (same held-out guard) and the
fact text is the faithful `factEmbedTextFor` string, not a different field; (d) re-derive the PRIMARY
`FACTNAME_bge − FACTNAME_nomic` condensed delta as an integer hit-count; (e) check the A/B changes ONLY
the embedder (same pairs, oracle, RRF-60, tie-break) — no second confound; (f) confirm the spec froze
before the bge scoring.

---

<!-- RESULTS APPENDED BELOW THIS LINE -->
