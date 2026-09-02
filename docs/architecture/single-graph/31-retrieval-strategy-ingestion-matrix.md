# 31 — Retrieval strategy → ingestion requirement matrix (literature-grounded, 2026-09-02)

**Purpose.** The "fully outlined" reference: every retrieval strategy proven in the literature, the query
intent it serves, **what it demands of ingestion / the data model**, and where our current system stands
(have / broken / missing, from doc 30). This is the menu we pick from, the derivation of the data model, and
the audit gap-list — in one place. Ingestion is designed *to* this, per the agreed principle: query
capability pulls the ingestion requirement.

**Grounding.** Three live literature sweeps (2023–2025 sources) + the verified current-state map (doc 30).
Confidence: **H** peer-reviewed/settled · **M** credible preprint/industry, limited replication · **L**
practitioner consensus. Citations in §7. Where a claim matches one of *our own* results it is marked ⟳.

---

## 1. The three conclusions that matter (read these even if you skip the matrix)

1. **The literature's own verdict matches our negatives — we tested good techniques on the wrong query
   type.** Every honest 2025 evaluation says graph structure / community summaries / rerankers earn their
   (large) cost *only* on the query types they target — relational, multi-hop, global-sensemaking, temporal,
   causal — and **tie or lose to flat vector retrieval on isolated fact-finding** (*When to use Graphs in
   RAG* 2506.05690; *RAG vs GraphRAG* 2502.11371; GraphRAG's own local/global split, 2404.16130). Our
   eval was isolated-fact-finding. So our `.4`/`.6`/`.8` negatives are *consistent with the field*, not a
   contradiction of it. ⟳
2. **The binding constraint is extraction quality + provenance, not the retrieval algorithm.** HippoRAG 2's
   error analysis puts ~44% of failures on extraction/filter, not the walk; propositions help recall (*Dense
   X*, EMNLP 2024) but over-segmentation hurts and doesn't generalize (*Factual Decomposition*, NAACL 2025) —
   exactly our doc-32 "denser extraction was dead" finding. ⟳ **Ingestion is the lever; the retriever mostly
   isn't.**
3. **Provenance/lineage is required by almost everything, and it's our #1 broken foundation.** Reranking and
   passage-dense retrieval need self-contained *text* to attend to; citations need per-claim spans (ALCE,
   EMNLP 2023); causal edges need source references for verification; and *correct held-out evaluation* needs
   to know which fragment/doc a fact came from (our `.8` leak was a provenance failure ⟳). Our NULL
   `facts.source_memory_id` / empty `fact_units` (doc 30) **starves all of these at once.**

The through-line: **build the lineage backbone + fix the wiring first (query-agnostic), then conform the
query-specific ingestion choices to whichever intents we commit to.**

---

## 2. The matrix

Legend for current state: **HAVE** = wired + usable · **HAVE-unwired** = built but no live caller ·
**PARTIAL** · **BROKEN** · **MISSING**. (Current state from doc 30.)

| Strategy | Query intent | Ingestion / data-model requirement | Current state | Our result |
|---|---|---|---|---|
| **Dense bi-encoder** (H) | semantic / paraphrase; bad at exact terms, rare names, numbers | one vector per unit, query+target same model/space; commit unit granularity at ingest; stable back-pointer | HAVE (`entities.embedding` name-only; `facts.fact_embedding`) | fusion of the two = our one PROVEN lever ⟳ |
| **Sparse BM25 / SPLADE** (H) | exact terms, identifiers, rare tokens | a **separate inverted index** over tokenized text (BM25 stats at ingest); SPLADE adds a per-unit encoder pass → sparse term-weight postings | **MISSING** (only `pg_trgm`; no BM25/tsvector in prod) | BM25 tied dense on our task ⟳ (query-type-dependent) |
| **Hybrid dense+sparse (RRF)** (H) | mixed workloads (the common real case) | **both** a vector index and a lexical index over the **same units, shared id**; RRF needs only ranks (k≈60) | **MISSING** (no lexical index to fuse) | our name⊕fact fusion is this shape, generalized ⟳ |
| **Cross-encoder rerank** (H) | precision@top, *after* a first stage; never a retriever | almost nothing new — **but each unit MUST yield self-contained passage-shaped text** to attend to | **BROKEN** (textless graph hits: NULL `source_memory_id`, empty `fact_units`) | `.4` NEGATIVE — but on textless/name-only + wrong query type ⟳ |
| **Multi-vector / ColBERT** (M/H) | high-precision, out-of-domain, token-level match | **one vector per token** + quantization + centroid-pruned index (ColBERT/PLAID); 30–100× storage; separate substrate | **MISSING** (heavy; best over raw text, not short nodes) | untested |
| **Query transform (HyDE / multi-query / decomp)** (H) | short/underspecified/multi-part queries | query-time only; needs a good index + shared unit id for fusion; HyDE wants passage-shaped units | index-dependent (no new store) | untested |
| **Chunking (recursive/semantic)** (M/H) | sets the retrievable/embeddable granularity | fragments with **char offsets into source**, chunker name+version+params; overlap → shared spans; semantic chunking often **not worth the cost** (Vectara NAACL 2025) | **PARTIAL/BROKEN** (Qdrant window+unit exist; fragment→entity/fact link broken) | — |
| **Parent-document / small-to-big** (M) | small embeds match better, large gives answer context | **two linked tiers**: child fragment (embedded) carries `parent_id`; parent stored un-embedded, addressable | **MISSING** (this IS your reconstruction requirement) | — |
| **Late chunking** (M) | keep document-global context in chunk vectors | long-context token-level encoder; embed whole doc → pool per boundary; data model unchanged (only how the vector is computed) | **MISSING** (drop-in if offsets exist; ~2–3% gain) | — |
| **RAPTOR (hierarchical summaries)** (H) | thematic / multi-step synthesis over long text | build a tree at ingest: cluster → LLM-summarize → embed summary → child links to leaves; **summaries are synthetic, must link to leaf provenance** | **MISSING** | — |
| **Contextual retrieval (Anthropic)** (M/H) | isolated chunk lacks situating context | LLM writes a 50–100-tok prefix per chunk (sees whole doc), prepend before embed+BM25; store augmented text + keep original offsets; ~$1/M tok w/ caching; −49% failure w/ BM25, −67% + rerank | **MISSING** (ingest-time LLM pass) | — |
| **GraphRAG local** (H) | entity-neighbourhood questions | typed nodes/edges + neighbourhood walk | HAVE (traversal, causal tools) | — |
| **GraphRAG global** (H) | corpus-wide *sensemaking* ("main themes") | **Leiden hierarchical communities + pre-generated community summaries at every level**; not cheap at query time | **MISSING** (`community_id` computed but **viz-only**; no summaries) | `.8` deterministic-centroid NEGATIVE — but never tested on global queries w/ summaries ⟳ |
| **KG-RAG (LightRAG / HippoRAG)** (M/H) | entity/relation QA; multi-hop associative | typed nodes/edges + **authored descriptions on nodes AND edges** + **canonicalization/dedup** + **passage nodes linked to phrases** (HippoRAG2) + PPR-navigable graph; incremental update | **PARTIAL** (canonicalization via `resolveEntity` HAVE; descriptions off-vector; passage↔fact link BROKEN) | — |
| **Multi-hop / traversal** (H) | relational / bridge / path-constrained | canonicalized entities (hops land on same node) + typed edges; only pays on **high relational share + dense graph** | HAVE-unwired-ish (`traverseFromEntities`, cross-corpus) | `.6` NEGATIVE — consistent w/ literature on sparse/low-relational graphs ⟳ |
| **Bi-temporal (Zep/Graphiti)** (M) | as-of-date, timeline, "what changed" | valid-time + transaction-time per edge; supersede/invalidate not overwrite; episodes→entities→communities | **HAVE** (Graph S facts are bi-temporal: `valid_at`/`invalid_at`/`expired_at`) | untested for retrieval |
| **Causal graph** (M) | cause→effect chains, intervention, counterfactual | explicit `(cause,effect)` typed edges (not generic relations); **mandatory provenance per edge** for verification; temporal-causal consistency at retrieval | **HAVE schema** (Graph C: `reasoning`+`source_references` mandatory) but edges **not corpus-partitioned**, underlying fact provenance BROKEN, **never evaluated** | `.7` unevaluated; arxiv has zero causal layer ⟳ |

---

## 3. Chunking & fragment sizing — the concrete answer to the sizing/overlap question

- **Default:** recursive character/token splitting, **256–512 tokens, ~10–20% overlap** (≈25–75 tok). Well
  supported; Chroma found even **200/0** competitive (88% recall) and **800/400 the worst**; Vectara (NAACL
  2025) found fixed-size **matches or beats semantic chunking** — so **don't reach for semantic/LLM chunking
  first**; chunk config moves quality *as much as embedding-model choice*.
- **Vary by intent:** factoid / dense-entity-extraction → smaller (256–384), keep overlap so entities/edges
  aren't cut mid-span; analytical / multi-hop → larger (768–1024+) **or** add a **parent-document tier**
  (embed small, return big) **or** RAPTOR summaries rather than just enlarging; long docs needing global
  context → **late chunking** or **contextual prefixes**.
- **Because we extract a KG:** overlap ≥15% and boundaries that don't split sentences — a severed
  entity/relation hurts *extraction* more than retrieval. **Pin chunker name+version+params** so offsets stay
  valid (a version bump invalidates every offset).

---

## 4. The data model this all implies (the lineage backbone)

The union of requirements above resolves to one backbone + a set of indexes. This is the "conform ingestion
to the query strategies" output.

**Fragment (the embedded/proving unit):** `fragment_id` (deterministic: hash of source+offsets+chunker
version) · `source_document_id` · `parent_id` (nullable — parent-doc tier / RAPTOR parent) · `char_start`/
`char_end` into the **source payload** (reconstructable) · overlap/prev-next links · `heading_path` ·
`chunker_name`+`version`+size/overlap · `embedding_model`+version+**granularity** + a flag if the indexed
text is **generated** (contextual prefix / RAPTOR summary) vs verbatim · raw payload retained or durably
pointed.

**Entity / edge (KG unit):** `proof_fragment_ids[]` (the fragment(s) whose span proves it — *your hard
requirement*) · transitively resolvable to `source_document_id`+span (no orphans) · optional
`extraction_reasoning`+model/version (Graph C already mandates this for causal edges — generalize it).

**Answer/citation (query time):** per-claim citation list (fragment_id → span), not one-per-answer (ALCE).

**Indexes over a shared unit id:** (1) dense vector index [HAVE], (2) a **lexical/BM25 index** [MISSING] so
hybrid is even possible, (3) optional SPLADE / ColBERT / community-summary / bi-temporal substrates **gated
by which intents we commit to** — do not build them speculatively.

**Descriptions:** attach node/edge descriptions to the **keyed/summary path** (LightRAG KV value, GraphRAG
community input), **NOT** the small-k entity retrieval vector — our n=354 result (name 0.201 > name+desc
0.138) and the literature agree the description dilutes the small-k vector while helping the summary path. ⟳
So `EMBED_DESCRIPTIONS`-into-the-entity-vector is the wrong lever; a *separate* description field feeding a
summary/keyed path is right.

---

## 5. Query-agnostic foundations (fix now — every strategy needs them, no strategy choice required)

1. **The provenance backbone** (§4) — `fragment → source` offsets + `entity/edge → proof_fragment_ids`.
   Fixes the NULL `source_memory_id` / empty `fact_units` gap; unlocks reranking, citations, and *correct
   held-out evaluation* at once.
2. **Stable shared unit id across every index** — the precondition for any fusion/hybrid.
3. **Corpus scoping on the live read path** — Qdrant unscoped, name-vec pinned to `'default'`, traversal
   all-corpora (doc 30, nmemo-4h3/-81k). Correctness bug regardless of strategy.
4. **Dedup / canonicalization at ingest** — near-duplicate units corrupt recall + tie-breaks across *every*
   strategy (our index-asc tie-break caveat ⟳); canonicalization is also load-bearing for multi-hop.
5. **Wire the proven fusion in** (doc 30 step 1) — corpus-correct `recallEntitiesFused` as an MCP tool; the
   one thing we proved isn't running.

---

## 6. Honest caveats & sequencing

- **Structure is gated by the relational share of the workload.** Communities/traversal/causal cost a lot of
  LLM indexing and only pay on relational/global/temporal/causal queries. Build them *to* the intents we
  actually commit to — which is why the **query-intent enumeration comes before the heavy ingestion build**.
- **Extraction quality is the ceiling, and denser isn't automatically better** (Dense X vs NAACL 2025; our
  doc-32). Extraction density/precision/canonicalization must be a *dial we can test per intent*, not a fixed
  choice.
- **Ingestion follows querying — but foundations don't wait.** §5 is unconditional and can start now; §2's
  query-specific substrates wait on the intent decision.
- **Least-mature cluster = causal/temporal** (mostly 2025 preprints). Our Graph C schema is actually
  *ahead* of the literature on the mandatory-provenance point — but it's unevaluated and its underlying fact
  provenance is broken.
- **This matrix is the menu, not the plan.** It says what each strategy *requires*; it does NOT say which
  intents we'll serve. That decision (the query-intent set, grounded in real usage) is the next input, and it
  selects which rows become real.

---

## 7. Sources (by cluster; confidence in §-tags above)

**Vector/lexical/rerank:** DPR (Karpukhin, EMNLP 2020); Late Chunking (Günther, 2409.04701); SPLADE-v3
(Lassance, 2403.06789); RRF (Cormack, SIGIR 2009); MonoT5 (Nogueira, EMNLP-F 2020); Lost-in-the-Middle (Liu,
TACL 2024); ColBERTv2 (Santhanam, NAACL 2022) + PLAID (CIKM 2022); HyDE (Gao, ACL 2023); Query-Optimization
survey (2412.17558).
**Chunking/provenance:** Chroma chunking eval (2024); Vectara semantic-chunking (NAACL 2025, 2410.13070);
LangChain ParentDocumentRetriever; RAPTOR (Sarthi, ICLR 2024); Anthropic Contextual Retrieval (2024); ALCE
(Gao, EMNLP 2023, 2305.14627); evidence-attribution survey (2508.15396).
**Graph/structure:** GraphRAG (Edge, 2404.16130); Graph-RAG survey (Peng, 2408.08921); When-to-use-Graphs
(2506.05690); RAG-vs-GraphRAG (2502.11371); LightRAG (Guo, 2410.05779); HippoRAG (Gutiérrez, NeurIPS 2024) +
HippoRAG 2 (2502.14802); Dense X Retrieval (Chen, EMNLP 2024, 2312.06648); Factual Decomposition (NAACL
2025); EDC canonicalization (2024); Zep/Graphiti (Rasmussen, 2501.13956); Causal-Counterfactual RAG
(2509.14435); Entity-Event KG / ChronoQA (2506.05939); Causal Graphs Meet Thoughts (2501.14892).

*Confidence note (from the sweeps): a few venue/year tags are cited from established knowledge, not a fetched
page; treat exact venue tags as M and the technique claims as H. Post-cutoff 2026 hits were deliberately not
cited.*
