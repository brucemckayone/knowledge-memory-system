# 33 — Graph-structure analysis (Phase 0 of nmemo-asf, verified 2026-09-02)

**What this is.** The data-level health picture of `cognitive_test`, per corpus — the complement to doc 30
(code-level) — plus the flagged confusions/anomalies that steer Phase 1. Read-only battery + spot-checks;
numbers verified at the DB. Feeds the epic `nmemo-asf` foundation priorities.

## Corpus inventory
Research corpora (batteried): **qbio 3670 · arxiv-cv 1282 · dal-cv 1262 · arxiv-nlp 1230 · dal-nlp 1133**.
Others: `_concepts` 668 (reserved concept corpus, 0 facts, bridge-connected — `bridge_edges` has 4417 rows);
`default` 382 (synthetic test data — exclude from real analysis); `cj-*`/`cr_*` tiny audit scaffolds.

## Headline (research corpora; verified)
| corpus | active facts | dup-name % | %fact_emb | %entity desc | %src_mem_id | deg median/mean/max | %deg1 | %deg≥8 | pred hapax % | causal events / edges |
|---|---|---|---|---|---|---|---|---|---|---|
| qbio | 6955 | 6.0 | 100 | **99.8** | 0 | 2 / 2.91 / 30 | 39 | 6.7 | 74.5 | 6955 / 51 |
| arxiv-cv | 2852 | 14.7 | 100 | **0.0** | 0 | 2 / 3.43 / 47 | 44 | 12.9 | 67.2 | 0 / 0 |
| dal-cv | 2565 | 14.2 | 100 | 99.4 | 0 | 2 / 3.19 / 32 | 43 | 11.3 | 70.1 | 2565 / 521 |
| arxiv-nlp | 2862 | 19.6 | 100 | **0.0** | 0 | 2 / 3.59 / 89 | 41 | 11.5 | 70.4 | 0 / 0 |
| dal-nlp | 2612 | 17.6 | 100 | 98.9 | 0 | 2 / 3.47 / 81 | 44 | 12.3 | 70.0 | 1028 / 175 |

Entity embedding coverage 100% on all five. Inline `facts.source_text` 100% populated on all five.

## Confirmed anomalies / confusions (with Phase-1 implications)

1. **arxiv extractions have ZERO entity descriptions; dal & qbio have ~99%.** Verified: arxiv-nlp 1230/1230
   NULL, arxiv-cv 1282/1282 NULL; dal-cv 1255/1262, dal-nlp 1120/1133, qbio 3661/3670 populated. **This
   reframes the "arxiv vs dal = same 294 papers, different extraction" story** (docs 02/16): they differ in a
   load-bearing way — descriptions absent vs present. R4 (the headline fusion, arxiv) had **no description
   text at all**, so `EMBED_DESCRIPTIONS` was structurally untestable there. **Implication:** any
   description/summary-path work (doc 31's "descriptions on the keyed path") must use dal/qbio or backfill
   arxiv; do not compare naively across the description gap.

2. **CORRECTION to docs 30/31 ("textless graph hits starve rerankers"): inline evidence text EXISTS.**
   `facts.source_text` is 100% populated on every research corpus (arxiv-nlp: 2862/2862). What is missing is
   **not the text but the normalized, reconstructable LINEAGE**: `source_memory_id` 100% NULL,
   `fact_sources` 0 rows, `fact_units` 0 rows (all verified). **Implication:** Phase 1.1's real task is
   narrower and clearer than "recover missing text" — it is **add the fragment→char-offset→source lineage +
   entity/edge→fragment links** (the user's reconstructability requirement). Reranking/citation can already
   attend to inline `source_text` today; the lineage is what unlocks held-out eval, parent-document
   reconstruction, and true provenance.

3. **The predicate "ontology" is effectively free-text.** Hapax (used-once) predicate rate 67–75% across
   research corpora; top predicate ≤3.3% share; qbio has **3508 distinct predicates over 6955 facts**; and a
   live normalization split exists (`is_instance_of` vs `instance_of` both present). Confirms nmemo-ecn
   (domain-locked ontology) / nmemo-xhn (predicate fold). **Implication:** Phase 1.3 (canonicalization) should
   cover **predicate normalization**, not just entity dup-names; extraction-quality work (Phase 4) must treat
   the open predicate vocabulary as a variable.

4. **Graph C exists only on dal + default; arxiv has none, qbio is near-empty.** causal_edges: dal-cv 521,
   default 296, dal-nlp 175, qbio 51 (0.7% event→edge density), **arxiv-cv/nlp 0**. Reasoning +

   > **CORRECTION OF RECORD (2026-09-17, verified by SQL twice — doc 44).** The per-corpus split above is
   > **STALE**. A one-shot hand-run backfill (`platform/src/db/backfills/backfill-causal-event-corpus.sql`,
   > nmemo-asf.10) re-stamped the ~7,299 mis-stamped `default`-corpus events onto their facts' real
   > corpora *after* this doc was verified. Nothing was minted or deleted — only re-attributed (the old
   > numbers sum to today's 17,847 total). **Truth now: dal-cv 521 · dal-nlp 454 · qbio 51 · arxiv-nlp 17
   > · arxiv-cv 0 · default 0.** So "dal-cv 521" and "qbio 51" still hold, but **dal-nlp is 454 (2.6x the
   > 175 above)**, **`default` has 0 edges and 0 events**, and **"arxiv has none" is half wrong —
   > arxiv-nlp has 17.** The `causal events / edges` column of the table above is stale for the same
   > reason. Doc 34 §I4 inherited these figures and is corrected there too.

   source_references 100% non-empty (NOT NULL enforced). **Implication:** the causal intent (Phase 4) must run
   on **dal-cv** (richest), never arxiv; confirms the `.7` feasibility finding (doc 28).

5. **`entity_meta` is EMPTY (0 rows) DB-wide** — the centroid / mention_count / fact_count meta layer is
   unpopulated. Another built-but-dead substrate (like the element/concept catalogs, doc 30). Orphan/degree
   stats had to come from `facts` directly. **Implication:** decide populate-or-drop; do not rely on
   `entity_meta.fact_count` anywhere.

6. **Duplicate `canonical_name` 15–20% on arxiv/dal** (arxiv-nlp 19.6%: chatgpt×21, large language models×16)
   — confirms the tie-break driver (doc `.9`). qbio lower (6.0%). **Implication:** feeds Phase 1.3; deltas
   stay the trustworthy metric, absolute R@10 does not.

7. **qbio is the structurally sparsest** real corpus (mean degree 2.91, %deg≥8 6.7%, giant component 2.6% per
   doc 28) — the honest sparse-graph stress substrate. Entity-type vocabulary is open/fine-grained (qbio 631
   distinct types) — not a fixed enum.

8. **`default` is synthetic** (77% dup-name, 0% embeddings, 33.8% orphans, 7299 causal events over 212 facts =
   re-ingest churn) — exclude from real analysis.

## Net for Phase 1
- **Provenance backbone (1.1) is confirmed the right first foundation, and is now precisely scoped:** the text
  is already inline; build the *lineage* (fragment id + char offsets + source doc, entity/edge →
  proof_fragment_ids). It unblocks held-out eval + reconstructability, not text recovery.
- **Canonicalization (1.3) must include predicate normalization**, not just entity names.
- **Substrate choices are now data-grounded:** description-path work → dal/qbio (not arxiv); causal work →
  dal-cv; sparse-graph stress → qbio; the tie-break caveat holds on arxiv/dal.
- **Two dead layers to resolve:** `entity_meta` (empty) and the element/concept catalogs (doc 30) — populate
  or drop, don't design over them.

*Battery gathered by a read-only subagent; the load-bearing surprises (arxiv-no-descriptions, inline-text-
present, empty lineage/meta tables) were re-verified directly at the DB.*
