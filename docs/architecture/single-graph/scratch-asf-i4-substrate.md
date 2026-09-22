# scratch — I4 causal substrate: ground truth (2026-09-17)

Read-only pre-work investigation for intent **I4 — Causal / explanatory**. Nothing was written to any
database; no source file was modified. Every data claim below is a `SELECT` I ran myself against
`cognitive_test` / `cognitive` on `127.0.0.1:5433` (via `docker exec nmemo-postgres-1 psql`, no local
`psql` on PATH).

Label key: **[V]** = verified by my own query/read this session · **[D]** = claimed by a doc, not
independently true until marked · **[I]** = inferred from V facts, reasoning stated.

---

## BOTTOM LINE

1. **Real? YES.** **[V]** 1043 `causal_edges` over 17,847 `causal_events` in `cognitive_test`, all written
   by one method (`extraction_method='causal_promotion'`), backed by a fully built writer pipeline
   (agent → staging → deterministic promotion). Not theatre, not fixtures.
2. **Provenanced? YES, genuinely.** **[V]** 1043/1043 distinct `reasoning` strings (min 163 / mean 315 /
   max 570 chars, all substantive prose — samples quoted in §B4); 2353 `source_references` entries
   (mean 2.26/edge), **2349/2353 (99.83%) resolve** to a live `facts`/`entities` row; every one carries a
   non-empty `relevance` note. Zero placeholders, zero `{}`.
3. **Evidence text? YES — and this is the surprise.** **[V]** The 1873 distinct cited facts have
   `source_text` **1873/1873 = 100%**, against **17,846/343,018 = 5.2%** graph-wide. Graph C does **not**
   inherit the "evidence with no text" hole; it cites exactly the text-bearing slice.
4. **Chained? BARELY — this is the binding constraint.** **[V]** Max path = **4 hops** (3 such paths);
   1043 one-hop, 142 two-hop, 12 three-hop. **Largest connected component = 7 event nodes**; the graph is
   747 fragments (542 isolated pairs). Only **125 of 17,847 events (0.7%)** have both in- and out-degree.
5. **Answerable? ~18% on one corpus, ~0% on three.** **[V]** Facts for which "what caused X" returns ≥1
   cause: **dal-cv 464/2565 (18.1%)**, dal-nlp 399/2612 (15.3%), qbio 43/6955 (0.62%), arxiv-nlp 14/2862
   (0.49%), **arxiv-cv 0/2852 (0%)**. Of 920 answerable roots, **794 (86%) bottom out at exactly one hop**.
6. **Readable deterministically? NO.** **[V]** `event_embedding` is NULL on **17,847/17,847** rows and is
   written by **nothing** and read by **nothing** (`grep` hits are schema comment + one schema test). The
   only entry point into Graph C is an **id** (`fact_id` / `entity_id`), never a query string. No SQL/vector
   retrieval path reaches causal edges: `retrieval.ts` and `fusion.ts` contain **zero** causal references.
7. **Readable at all? ONLY via the LLM agent.** **[V]** `traceCauses` / `projectTrajectory` /
   `getEntityCausalHistory` / `getCausalDelta` exist and are correct, but their sole production callers are
   the MCP tool handlers in `causal-agent.ts` (+ the writer pass itself). The one query-time route is
   `POST /api/reason/query` → reasoning agent → MCP `trace_causes`. **I4 has no free read path today.**
8. **Doc 33 / doc 34 §I4 per-corpus numbers are STALE and materially wrong.** **[V]** A one-shot backfill
   (`backfill-causal-event-corpus.sql`, nmemo-asf.10) re-stamped the ~7299 mis-stamped `default`-corpus
   events onto their facts' real corpora after doc 33 was written. Truth now: **dal-cv 521 · dal-nlp 454 ·
   qbio 51 · arxiv-nlp 17 · arxiv-cv 0 · default 0**. "dal-nlp 175" → 454; "default 296" → **0**; "arxiv has
   none" → arxiv-nlp has 17. Only the dal-cv 521 and qbio 51 figures survive.

Secondary but load-bearing: **the AGE `causal_graph` is dead** (§A5) — it is not even registered in
`ag_catalog.ag_graph`, its label tables hold 0 rows, and the sync trigger swallows every failure in a
`WHEN OTHERS` handler. **`temporal_span` is NULL on all 1043 edges and 1027/1043 have
`cause.occurred_at == effect.occurred_at`** (§B7) — the causal graph carries no usable time axis.
**`strength` is ~constant at 0.6 (1012/1043)** (§B7) — `minStrength` filtering is a no-op.

---

## A. Schema — what is actually there

### A1. Migrations that build the causal layer

| File | What it adds |
|---|---|
| `platform/src/db/migrations/002_causal_graph.sql` | `causal_patterns`, `causal_events`, `causal_edges`, AGE `causal_graph`, 2 sync triggers |
| `platform/src/db/migrations/010_source_ref_index.sql` | `edge_source_refs` (derived reverse index of `causal_edges.source_references`) + backfill |
| `platform/src/db/migrations/012_pattern_rejected.sql` | adds `'rejected'` to `valid_pattern_status` |
| `platform/src/db/migrations/044_causal_pass.sql` | `staging_causal_edges`; adds `causal_edges.stale_citation`, `.stale_citation_reason` |
| `platform/src/db/migrations/051_causal_corroboration_idempotency.sql` | `causal_edge_corroborations` (replay-idempotency ledger) |
| `platform/src/db/migrations/052_corpus_scoping.sql` | `causal_events.corpus_id TEXT NOT NULL DEFAULT 'default'` + index + immutability trigger |
| `platform/src/db/migrations/009_audit_trail.sql` | `causal_edge_history` (see §A4) |
| `platform/src/db/migrations/011_contradictions.sql` | `contradictions` (FKs to `causal_edges`) |

**[V]** Every table declared in migrations **exists in the live DB, in both `cognitive_test` and
`cognitive`**, with the declared column counts:

```sql
SELECT c.relname, (SELECT count(*) FROM pg_attribute a
                   WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS ncols
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE '%causal%';
```
→ `causal_edge_corroborations` 3 · `causal_edge_history` 13 · `causal_edges` 22 · `causal_events` 12 ·
`causal_patterns` 19 · `staging_causal_edges` 8 — identical in both DBs. **No migration/live drift.**

### A2. `public.causal_edges` (22 cols) — **[V]** `\d public.causal_edges`

| Column | Type | Null | Note |
|---|---|---|---|
| `id` | uuid | NOT NULL | PK, `gen_random_uuid()` |
| `cause_event_id` | uuid | **NOT NULL** | **FK → `causal_events(id)`** |
| `effect_event_id` | uuid | **NOT NULL** | **FK → `causal_events(id)`** |
| `strength` | float8 | NOT NULL | default 0.5; `CHECK 0..1` |
| `temporal_span` | interval | null | |
| `extraction_method` | varchar(20) | NOT NULL | |
| `reasoning` | **text** | **NOT NULL** | the doc-01 invariant |
| `source_references` | **jsonb** | **NOT NULL** | the doc-01 invariant |
| `pathway_event_ids` | uuid[] | null | |
| `source_memory_id` | uuid | null | **no FK** |
| `source_text` | text | null | |
| `corroboration_count` | int | NOT NULL | default 1 |
| `last_corroborated` | timestamptz | NOT NULL | |
| `initial_strength` | float8 | NOT NULL | `CHECK 0..1` |
| `decay_applied` | bool | NOT NULL | |
| `pattern_id` | uuid | null | FK → `causal_patterns(id)` |
| `pattern_position` | int | null | |
| `created_at` | timestamptz | NOT NULL | |
| `expired_at` / `expire_reason` | timestamptz / text | null | tombstone |
| `stale_citation` | bool | NOT NULL | default false (mig 044) |
| `stale_citation_reason` | text | null | (mig 044) |

**`corpus_id`: ABSENT.** **[V]** — confirming doc 34's "Edges not corpus-partitioned". `causal_events`
**does** have it (§A3), so the de-facto edge partition is *its endpoints' corpora* (§B3).

Indexes **[V]**: `causal_edges_pkey`; partial btrees on `cause_event_id`, `effect_event_id`,
`strength DESC` (all `WHERE expired_at IS NULL`); `pattern_id WHERE NOT NULL`;
`idx_causal_edges_unique UNIQUE (cause_event_id, effect_event_id) WHERE expired_at IS NULL`.
Checks: `cause_event_id <> effect_event_id`, both strength ranges.
Referenced by: `causal_edge_corroborations`, `causal_edge_history`, `contradictions` (×2),
`edge_source_refs`. Trigger: `trigger_sync_causal_edge AFTER INSERT ... WHEN (expired_at IS NULL)`.

### A3. `public.causal_events` (12 cols) — **[V]**

`id` uuid PK · `fact_id` uuid **FK → facts(id)**, nullable · `transition_type` varchar(20) NOT NULL
(`CHECK IN created|strengthened|weakened|expired|invalidated`) · `subject_entity_id` uuid **FK →
entities(id)**, nullable · `predicate` varchar(255) · `delta_confidence` float8 · `occurred_at`
timestamptz NOT NULL default `NOW()` · **`event_embedding vector(768)`** · `source_memory_id` uuid (no
FK) · `source_text` text · `created_at` timestamptz NOT NULL · **`corpus_id` TEXT NOT NULL DEFAULT
`'default'`** (mig 052).

Indexes **[V]**: PK; `corpus_id`; **`idx_causal_events_embedding hnsw (event_embedding
vector_cosine_ops)`**; `(subject_entity_id, occurred_at DESC)`; `fact_id`; `occurred_at DESC`.
Triggers: `trg_corpus_immutable BEFORE UPDATE` (mig 052); `trigger_sync_causal_event AFTER
INSERT OR UPDATE`.

### A4. The rest — **[V]**

- **`causal_edge_history`** (13 cols): `edge_id` FK, `event_type` (`CHECK IN created|corroborated|
  strengthened|weakened|revised|expired|decayed`), before/after strength + reasoning,
  `added_source_refs` jsonb, `reasoning TEXT NOT NULL`, `actor` (checked enum, includes `'promotion'`),
  `occurred_at`, `pre_expire_blast_radius` jsonb, `reasoning_report_id` FK (ON DELETE SET NULL).
- **`staging_causal_edges`** (8 cols): `epoch_id NOT NULL`, `cause_event_id`/`effect_event_id`
  **deliberately un-FK'd** (`044` header: ref-resolution is a *disposal* step), `reasoning`/
  `source_references` NOT NULL **with structural CHECKs** (`length(btrim(reasoning))>0`;
  `jsonb_typeof=array AND jsonb_array_length>0`), `proposed_by` default `'causal_agent'`.
  **No `corpus_id`.**
- **`edge_source_refs`**: PK `(edge_id, ref_type, ref_id)`, `ref_type CHECK IN memory|fact|entity`,
  `relevance TEXT`, FK to `causal_edges` ON DELETE CASCADE; indexes on `(ref_type, ref_id)` and `edge_id`.
- **`causal_edge_corroborations`**: PK `(edge_id, corroboration_key)`.
- **`causal_patterns`** (19 cols): identity/template/topology/lifecycle/frequency + `pattern_embedding
  vector(768)` with an HNSW index. **0 rows in both DBs** (§B2).

### A5. The AGE causal graph is DEAD — **[V]**, and it matters

```sql
SELECT name, namespace FROM ag_catalog.ag_graph;        -- → knowledge_graph ONLY
SELECT count(*) FROM causal_graph._ag_label_vertex;     -- → 0
SELECT count(*) FROM causal_graph._ag_label_edge;       -- → 0
```

The `causal_graph` **schema** exists with 2 orphan AGE label tables, but the graph is **not registered**
in `ag_catalog.ag_graph`, so `cypher('causal_graph', ...)` cannot resolve. Both sync trigger functions
(`002_causal_graph.sql:208-210`, `:240-242`) end in `EXCEPTION WHEN OTHERS THEN RAISE WARNING ...; RETURN
NEW;` — so **all 17,847 event syncs and all 1043 edge syncs silently failed** and the inserts committed
regardless. Independently corroborated by the project's own backfill script
(`platform/src/db/backfills/backfill-causal-event-corpus.sql:19-20`), which says the trigger "only warns
`graph causal_graph does not exist` — a no-op". Consistent with CLAUDE.md's "AGE is retired from the read
path", but note it is *worse* than retired here: never populated at all.

---

## B. Live data — what is actually populated

### B1. Row counts, both DBs — **[V]**

```sql
SELECT 'causal_edges' t, count(*) FROM public.causal_edges
UNION ALL SELECT 'causal_events', count(*) FROM public.causal_events
UNION ALL SELECT 'causal_patterns', count(*) FROM public.causal_patterns
UNION ALL SELECT 'causal_edge_history', count(*) FROM public.causal_edge_history
UNION ALL SELECT 'causal_edge_corroborations', count(*) FROM public.causal_edge_corroborations
UNION ALL SELECT 'staging_causal_edges', count(*) FROM public.staging_causal_edges
UNION ALL SELECT 'edge_source_refs', count(*) FROM public.edge_source_refs
UNION ALL SELECT 'contradictions', count(*) FROM public.contradictions;
```

| table | `cognitive_test` | `cognitive` |
|---|---|---|
| `causal_events` | **17,847** | 2 |
| `causal_edges` | **1,043** | **0** |
| `staging_causal_edges` | 1,251 | 0 |
| `edge_source_refs` | 2,353 | 0 |
| `causal_edge_history` | 1,083 | 0 |
| `causal_edge_corroborations` | 1,083 | 0 |
| `causal_patterns` | **0** | **0** |
| `contradictions` | **0** | **0** |
| (context) `entities` / `facts` / `fact_units` | 135,210 / 343,018 / **0** | 4 / 2 / 2 |

**`cognitive` is empty of causal substrate** (2 leftover events, 0 edges). All I4 work must run on
`cognitive_test`, as CLAUDE.md says. There is **no `memories` table** in either DB
(`source_document` 0 rows, `fragment` 0 rows) **[V]**.

### B2. Everything past "create + corroborate" is unexercised — **[V]**

```sql
SELECT count(*) FILTER (WHERE pattern_id IS NOT NULL)        AS edges_with_pattern,   -- 0
       count(*) FILTER (WHERE pathway_event_ids IS NOT NULL) AS with_pathway,         -- 0
       count(*) FILTER (WHERE decay_applied)                 AS decayed,              -- 0
       count(*) FILTER (WHERE expired_at IS NOT NULL)        AS expired,              -- 0
       count(*) FILTER (WHERE initial_strength <> strength)  AS strength_drifted      -- 31
FROM public.causal_edges;
SELECT event_type, count(*) FROM public.causal_edge_history GROUP BY 1;
-- created 1043 · corroborated 40
```
0 patterns, 0 pattern memberships, 0 pathways, 0 decay, 0 expiries, 0 contradictions. The meta-causal
pattern layer (`causal_patterns`, `detectCausalPatterns`, `promotePatterns`) has **never run on this
data**. Only corroboration has fired (40 events over 31 edges; `corroboration_count` mean 1.04, max 5).

### B3. Per-corpus edges — the doc-34 claim VERIFIED IN PART and CORRECTED

`causal_edges` has no `corpus_id`, so I partitioned through both endpoint events:

```sql
SELECT ce.corpus_id AS cause_corpus, ee.corpus_id AS effect_corpus, count(*) AS edges
FROM public.causal_edges e
JOIN public.causal_events ce ON ce.id = e.cause_event_id
JOIN public.causal_events ee ON ee.id = e.effect_event_id
GROUP BY 1,2 ORDER BY 3 DESC;
```

**[V]** | cause | effect | edges |
|---|---|---|
| dal-cv | dal-cv | **521** |
| dal-nlp | dal-nlp | **454** |
| qbio | qbio | **51** |
| arxiv-nlp | arxiv-nlp | **17** |

Total 1043. **Zero cross-corpus edges** — every edge is within one corpus, and 0/2197 fact
`source_references` cite a fact outside the edge's corpus **[V]**. So although the column is missing, the
data is *de facto* cleanly partitioned.

Events per corpus **[V]**: qbio 6955 · arxiv-nlp 2863 · arxiv-cv 2852 · dal-nlp 2612 · dal-cv 2565.
**No `default`-corpus causal events exist at all.**

**Verdict on doc 34 §I4 / doc 33 §4:**

| claim | status |
|---|---|
| "dal-cv **521** edges" | **[V] CORRECT — exactly 521** |
| "qbio **0.7%**" | **[V] CORRECT — 51/6955 = 0.73% event→edge density; 51 edges** |
| "substrate ... and **default**" / doc 33 "default 296" | **[V] WRONG — `default` has 0 events and 0 edges** |
| "**arxiv has none**" / doc 33 "arxiv-cv/nlp 0" | **[V] HALF WRONG — arxiv-cv 0 ✓, but arxiv-nlp has 17 edges over 2863 events** |
| doc 33 "dal-nlp **175**" | **[V] WRONG — 454 edges (2.6×), over 2612 events not 1028** |
| "Edges not corpus-partitioned" | **[V] CORRECT as schema; misleading as data (0 cross-corpus edges)** |

**Root cause of the drift [V, mechanism inferred from the script's own header]:**
`platform/src/db/backfills/backfill-causal-event-corpus.sql` (bead nmemo-asf.10) — a one-shot hand-run
`UPDATE` that re-stamped `causal_events.corpus_id` from the joined fact, because the
`createCausalEvent` mirror in `services/facts.ts` historically never stamped it and the column took its
`'default'` default. Doc 33's numbers sum to exactly today's total (qbio 6955 + dal-cv 2565 + dal-nlp
1028 + default 7299 + arxiv 0 = **17,847** = today's count) **[V]**, so **no events were minted or
deleted — 7299 were re-attributed.** The edge creation timeline corroborates it exactly **[V]**:
edges created 2026-07-30 (8) + 08-24 (9) = 17 → the arxiv-nlp events created on those days;
08-31 (975) = 521 dal-cv + 454 dal-nlp; 09-01 (51) = qbio. Doc 33 was verified 2026-09-02, *before* the
backfill. **Doc 34 §I4 inherits doc 33's pre-backfill numbers.**

**Practical consequence for I4:** **dal-nlp is a second viable corpus** (454 edges, 87% of dal-cv), not
the near-empty one doc 33 described. `default` is *not* a substrate. arxiv-cv is genuinely unusable.

### B4. `reasoning` and `source_references` are REAL, not junk — **[V]**

```sql
SELECT count(*) AS edges,                                              -- 1043
  count(*) FILTER (WHERE length(btrim(reasoning))=0) AS empty,         -- 0
  min(length(reasoning)), round(avg(length(reasoning))), max(length(reasoning)),
                                                                       -- 163 / 315 / 570
  count(DISTINCT reasoning) AS distinct_reasoning,                     -- 1043
  count(*) FILTER (WHERE source_references::text IN ('{}','[]','null','""')) AS refs_trivial, -- 0
  count(*) FILTER (WHERE jsonb_typeof(source_references)='array') AS refs_array,              -- 1043
  count(*) FILTER (WHERE source_text IS NULL) AS src_text_null,        -- 1043
  count(*) FILTER (WHERE source_memory_id IS NULL) AS src_mem_null     -- 1043
FROM public.causal_edges;
```

**1043 distinct reasoning strings out of 1043 edges** — no template reuse. Verbatim samples
(`ORDER BY md5(id::text) LIMIT 8`, truncated to 400 chars):

> **dal-cv, strength 0.6** — "SAM's failure to generalize to out-of-distribution medical images created a
> specific problem that motivated the development of AutoSAM. AutoSAM was designed as an adaptation of SAM
> to directly address this failure by replacing SAM's prompt encoder with one that operates directly on
> input images, eliminating the need for manual prompts that led to poor performance in the medical domain."
> `source_references` = `[{"id":"b5e09c9c-…","type":"fact","relevance":"Documents that SAM fails to
> reproduce segmentation results for medical images (out-of-distribution domain)"},
> {"id":"978db527-…","type":"fact","relevance":"Establishes AutoSAM is designed to solve image segmentation
> tasks where SAM fails, particularly for medical images"},
> {"id":"8ac2e594-…","type":"fact","relevance":"Confirms AutoSAM is an adaptation of SAM that replaces the
> prompt encoder"}]`

> **dal-nlp, 0.6** — "ChatGPT's observed behavior of preferring to change surface expressions rather than
> making minimal corrections directly causes it to be underestimated by automatic evaluation metrics.
> Automatic metrics expect minimal corrections aligned with reference solutions; ChatGPT's
> paraphrasing-based approach diverges from these references, resulting in lower automatic scores despite
> potentially superior li[…]"
> refs = `[{"id":"ab320cab-…","type":"fact","relevance":"ChatGPT prefers changing surface expressions over
> minimal corrections"},{"id":"08b6c8c2-…","type":"fact","relevance":"ChatGPT severely underestimated by
> automatic evaluation metrics"}]`

> **arxiv-nlp, 0.6** — "Generating the ~217k interactive summaries from free-text radiology reports is what
> produced the dataset that was then used for fine-tuning; the generation step is a precondition/cause of
> the dataset's use."
> refs = `[{"id":"bf762156-…","type":"fact","relevance":"describes generation of ~217k summaries"},
> {"id":"4eb36d54-…","type":"fact","relevance":"describes summaries used for fine-tuning to enhance LLM
> performance"}]`

> **qbio, 0.6** — "The empirical configuration of HELM-BERT paired with Extra Trees under specific
> evaluation conditions (leave-target-out) causally produces the finding about top configuration shift.
> The configuration, when tested, generates the empirical result that reveals how configurations perform
> differently under different conditions than under others."

> **dal-nlp, 0.6** — "The documented problem of expensive and time-consuming human annotation in medical
> information extraction tasks directly motivates the development and adoption of hybrid LLM+human
> approaches. The cost and effort barriers to manual annotation drive the innovation of more efficient
> data labeling methodologies."
> refs = `[{"id":"a2f74771-…","type":"entity","relevance":"The human annotation process characterized as
> both time-consuming and costly"},{"id":"490fd4ed-…","type":"entity","relevance":"The LLM+human hybrid
> approach that emerges as a solution to the annotation problem"},{"id":"6e7f26d7-…","type":"fact",
> "relevance":"Explicit documentation of annotation burden as motivation"}]`

Two more (dal-cv PerSAM training-free personalisation; dal-cv LLaMA-Adapter/ImageBind cross-modal) are
the same shape. **[I]** This is model-authored, corpus-grounded, mechanism-stating prose with
per-reference relevance annotations — not placeholder text. The doc-01 mandatory-provenance invariant is
**honoured in substance, not just in `NOT NULL`**.

Caveats **[V]**: `source_text` and `source_memory_id` are **NULL on all 1043 edges** (the edge-level
free-text/memory provenance slots are unused — provenance lives entirely in `source_references`).
Both were also NULL-by-default in the canonical insert path; `extraction_method` is uniformly
`'causal_promotion'` (1043/1043).

### B5. `source_references` DO resolve — Graph C does **not** have the fact-provenance hole

```sql
WITH refs AS (SELECT e.id AS edge_id, r->>'type' AS ref_type, (r->>'id')::uuid AS ref_id,
                     r->>'relevance' AS relevance
              FROM public.causal_edges e CROSS JOIN LATERAL jsonb_array_elements(e.source_references) r)
SELECT ref_type, count(*) n,
  count(*) FILTER (WHERE ref_type='fact'   AND EXISTS (SELECT 1 FROM public.facts f    WHERE f.id=ref_id)),
  count(*) FILTER (WHERE ref_type='entity' AND EXISTS (SELECT 1 FROM public.entities x WHERE x.id=ref_id)),
  count(*) FILTER (WHERE relevance IS NULL OR length(btrim(relevance))=0)
FROM refs GROUP BY 1;
```
**[V]** `fact` 2200 → **2197 resolve**, 0 empty relevance · `entity` 153 → **152 resolve**, 0 empty
relevance. Refs per edge: min 1 / mean **2.26** / max 6; **all 1043 edges have ≥1 ref**.
`edge_source_refs` holds exactly 2200 + 153 = **2353** rows — the derived index is **in perfect sync
with the JSONB**, i.e. the drift failure mode the `source-refs-drift-patrol` scheduler exists for
(`platform/src/scheduler.ts:136-202`) has not occurred.

**The load-bearing contrast [V]:**

```sql
WITH refs AS (SELECT DISTINCT (r->>'id')::uuid AS ref_id FROM public.causal_edges e
              CROSS JOIN LATERAL jsonb_array_elements(e.source_references) r WHERE r->>'type'='fact')
SELECT count(*) cited_facts,                                                       -- 1873
  count(*) FILTER (WHERE f.source_text IS NOT NULL AND length(btrim(f.source_text))>0), -- 1873
  count(*) FILTER (WHERE f.source_memory_id IS NOT NULL),                          -- 0
  count(*) FILTER (WHERE f.fact_embedding IS NOT NULL),                            -- 1873
  count(*) FILTER (WHERE f.expired_at IS NOT NULL)                                 -- 0
FROM refs JOIN public.facts f ON f.id=refs.ref_id;
SELECT count(*), count(*) FILTER (WHERE source_text IS NOT NULL) FROM public.facts;
-- 343018 total, 17846 with source_text (5.2%)
```

- CLAUDE.md's known hole is **re-confirmed**: `facts.source_memory_id` is NULL on **0/343,018**
  non-null → all NULL; `fact_units` 0 rows; `fact_sources` 0 rows; `source_document` 0; `fragment` 0 **[V]**.
- **But the causal layer routes around it.** 100% of cited facts carry inline `facts.source_text` and a
  `fact_embedding`, against 5.2% graph-wide. **[I]** Cause: the causal-event mirror is built over exactly
  the text-bearing slice — verified exactly:
  ```sql
  SELECT (SELECT count(*) FROM public.facts WHERE source_text IS NOT NULL),               -- 17846
         (SELECT count(DISTINCT fact_id) FROM public.causal_events WHERE fact_id IS NOT NULL), -- 17846
         (SELECT count(*) FROM public.facts f WHERE f.source_text IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM public.causal_events ev WHERE ev.fact_id=f.id));  -- 0
  ```
  **Perfect 1:1, zero exceptions.** So a Graph C answer resolves to readable evidence text, and
  additionally `causal_events.source_text` is populated on **17,847/17,847** rows **[V]**.
- Nuance **[V]**: `causal_events.source_text` is a short extraction rationale, not verbatim document
  prose. Samples: *"Paper identifies multimodal-to-text generation as one of three types of
  vision-language models covered"*; *"Text states LightGaussian is evaluated on Mip-NeRF 360 dataset"*;
  *"Source specifies 128-channel EEG system used in EMD data collection"*; *"Paper describes Zero123++ as
  'an image-conditioned diffusion model'"*. One-line, paraphrased, sometimes quoting a fragment.

**The 4 dangling refs are a WORKING mechanism, not rot [V]:**

```sql
-- 3 dangling fact refs, all flagged:
a574f57e… → "cites invalidated fact(s): e1405f13-3213-4339-ab94-9b3f2187e5c9 — re-ground or expire next
             delta pass (never auto-repointed)"
8e898aac… → "cites invalidated fact(s): 38b8fab6-f336-41ff-9f08-72d681c3e604 — …"
f94c2ca6… → "cites invalidated fact(s): 68e29fa5-9a59-d39a-9eac-73836ecf9c57 — …"
```
`SELECT id, stale_citation_reason FROM causal_edges WHERE stale_citation;` returns **exactly those 3**.
The mig-044 stale-citation design fired correctly. Note `68e29fa5-9a59-**d**39a-…` has an invalid UUID
version nibble — **[I]** almost certainly an agent-hallucinated id that the cited-fact-status branch
caught. **One gap [V]:** the 1 dangling *entity* ref (`46d5885f-a444-4feb-95aa-a1ef3785d134` on edge
`d6b7cfee-…`) is **not** flagged — `stale_citation` covers fact refs only.

### B6. What the edges point at, and distribution — **[V]**

**Endpoints are `causal_events`, never facts or entities directly** (both FKs enforced → no dangling
endpoints possible, and none observed). Each event carries `fact_id` (non-null on 17,847/17,847) and
`subject_entity_id` (non-null on 17,847/17,847), so the path to Graph S is
`causal_edges → causal_events → facts/entities`, two joins deep.

```sql
WITH d AS (SELECT ev.id,
  (SELECT count(*) FROM causal_edges e WHERE e.cause_event_id=ev.id  AND e.expired_at IS NULL) outdeg,
  (SELECT count(*) FROM causal_edges e WHERE e.effect_event_id=ev.id AND e.expired_at IS NULL) indeg
  FROM causal_events ev)
SELECT count(*) FILTER (WHERE outdeg+indeg>0)          AS events_in_graph,   -- 1790  (10.0% of 17847)
       count(*) FILTER (WHERE outdeg>0 AND indeg>0)    AS hop_capable,       --  125  ( 0.7%)
       count(*) FILTER (WHERE outdeg>0 AND indeg=0)    AS pure_sources,      --  870
       count(*) FILTER (WHERE indeg>0 AND outdeg=0)    AS pure_sinks,        --  795
       max(outdeg), max(indeg) FROM d;                                       --    4 / 4
```
- **1790/17,847 events (10.0%)** touch any edge; **125 (0.7%)** are hop-capable (in *and* out degree).
- Max degree **4** in either direction. No hubs.
- **714 distinct entities** and **1790 distinct facts** participate **[V]**.
- Entity coverage by corpus **[V]**: dal-cv 364/1262 (28.8%) · dal-nlp 298/1133 (26.3%) ·
  qbio 39/3670 (1.1%) · arxiv-nlp 13/1230 (1.1%) · arxiv-cv **0/1282** · default **0/382**.
- Cross-entity vs intra-entity **[V]**: 461 edges (44%) link events with *different* subject entities;
  582 (56%) link two events on the *same* entity.

### B7. Chains — the structural verdict

```sql
WITH RECURSIVE paths AS (
  SELECT e.cause_event_id AS start_id, e.effect_event_id AS cur_id, 1 AS len,
         ARRAY[e.cause_event_id, e.effect_event_id] AS visited
  FROM public.causal_edges e WHERE e.expired_at IS NULL
  UNION ALL
  SELECT p.start_id, e.effect_event_id, p.len+1, p.visited || e.effect_event_id
  FROM paths p JOIN public.causal_edges e ON e.cause_event_id = p.cur_id AND e.expired_at IS NULL
  WHERE NOT e.effect_event_id = ANY(p.visited) AND p.len < 12)
SELECT len, count(*) n_paths, count(DISTINCT start_id) FROM paths GROUP BY 1 ORDER BY 1;
```
**[V]** | hops | paths | distinct starts |
|---|---|---|
| 1 | 1043 | 995 |
| 2 | **142** | 137 |
| 3 | **12** | 12 |
| 4 | **3** | 3 |
| ≥5 | **0** | 0 |

Per corpus **[V]**: dal-cv 521/73/10/3 · dal-nlp 454/57/2/0 · qbio 51/11/0/0 · arxiv-nlp 17/1/0/0.

**Connected components (undirected)** — **[V]** the decisive number:
```
comp_size 7 → 7 nodes (1 component) · 6 → 54 (9) · 5 → 55 (11) · 4 → 152 (38)
            · 3 → 438 (146)        · 2 → 1084 (542)
total 1790 nodes in ~747 components
```
**The largest connected component in the entire causal graph is 7 event nodes.** 542 of 747
components are isolated pairs.

**Answerability of "what caused X"** — **[V]** the I4 headline:
```sql
SELECT ev.corpus_id, count(DISTINCT ev.fact_id) AS facts_with_event,
  count(DISTINCT ev.fact_id) FILTER (WHERE EXISTS (SELECT 1 FROM causal_edges e
    WHERE e.effect_event_id=ev.id AND e.expired_at IS NULL)) AS facts_with_a_CAUSE,
  count(DISTINCT ev.fact_id) FILTER (WHERE EXISTS (SELECT 1 FROM causal_edges e
    WHERE e.cause_event_id=ev.id  AND e.expired_at IS NULL)) AS facts_with_an_EFFECT
FROM public.causal_events ev WHERE ev.fact_id IS NOT NULL GROUP BY 1;
```
| corpus | facts | has a CAUSE | has an EFFECT |
|---|---|---|---|
| **dal-cv** | 2565 | **464 (18.1%)** | 501 (19.5%) |
| **dal-nlp** | 2612 | **399 (15.3%)** | 428 (16.4%) |
| qbio | 6955 | 43 (0.62%) | 50 (0.72%) |
| arxiv-nlp | 2862 | 14 (0.49%) | 16 (0.56%) |
| arxiv-cv | 2852 | **0** | **0** |

Depth reachable from each answerable root **[V]**: 794 roots bottom out at 1 hop, 114 at 2, 9 at 3,
3 at 4. **86% of "what caused X" answers are a single edge.**

**The time axis is degenerate — [V]:**
```sql
SELECT count(*),                                                          -- 1043
  count(*) FILTER (WHERE ce.occurred_at <  ee.occurred_at),               --   15
  count(*) FILTER (WHERE ce.occurred_at =  ee.occurred_at),               -- 1027
  count(*) FILTER (WHERE ce.occurred_at >  ee.occurred_at),               --    1
  count(*) FILTER (WHERE e.temporal_span IS NULL),                        -- 1043
  count(DISTINCT date_trunc('minute', ce.occurred_at))                    --   34
FROM causal_edges e JOIN causal_events ce ON ce.id=e.cause_event_id
                    JOIN causal_events ee ON ee.id=e.effect_event_id;
```
`temporal_span` NULL on **all** edges; **1027/1043 causes are simultaneous with their effects**; only 34
distinct cause-minutes across 1043 edges (and one edge where the cause is *after* the effect).
**[I]** `occurred_at` is the ingest-batch `NOW()`, not event time — so Graph C carries **no usable
temporal ordering** and any I4 × I3 cross (doc 34 §"when-in-the-causal-chain") has no substrate.

**`strength` carries almost no information — [V]:** 1012/1043 edges are exactly **0.6** (=
`config.CAUSAL_PROMOTION_STRENGTH` default, `causal-promotion.ts:126`); 26 at 0.65, 2 at 0.70, 2 at 0.75,
1 at 0.80 — all corroboration bumps. `minStrength` filtering on the read path is effectively a no-op.

### B8. Staging → canonical disposal, and the agent's hallucination rate — **[V]**

```sql
SELECT count(*) staged,                                                                    -- 1251
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM causal_edges e
     WHERE e.cause_event_id=s.cause_event_id AND e.effect_event_id=s.effect_event_id)),    -- 1045
  count(*) FILTER (WHERE s.cause_event_id=s.effect_event_id) AS self_loop,                 --    4
  count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM causal_events ev WHERE ev.id=s.cause_event_id)
                     OR NOT EXISTS (SELECT 1 FROM causal_events ev WHERE ev.id=s.effect_event_id)), -- 165
  count(*) - count(DISTINCT (s.cause_event_id, s.effect_event_id)) AS dup_pairs            --    3
FROM public.staging_causal_edges s;
```
1251 proposals across **35 distinct `epoch_id`s**, all `proposed_by='causal_agent'`.
**165/1251 (13.2%) were dropped because an event id did not resolve** — i.e. a hallucinated or stale id;
4 self-loops; 3 duplicate pairs. Staged reasoning quality matches canonical (min 138 / mean 314 chars;
min 1 / mean 2.20 refs). **[I]** The deterministic disposal step is doing real work and is the thing
keeping the canonical table clean.

---

## C. Code — what writes it and what reads it

### C1. WRITERS — all built, all real

| File | Role |
|---|---|
| `platform/src/services/causal-pass.ts` (198 ln) | `runCausalPass(epochId, promotion)` — post-promotion orchestrator: loads minted events, gathers neighbourhood via `getEntityCausalHistory` (`:132`), evaluates the pure trigger, pushes a capped scope to the agent, then calls `applyCausalPromotion` |
| `platform/src/services/causal-pass-trigger.ts` (96 ln) | `hasCausalLanguage(text)`, `shouldRunCausalPass(signals, cfg)` — **the conditional trigger EXISTS**: (a) causal language in source text, (b) ≥ `CAUSAL_PASS_FACT_THRESHOLD` (default **5**) promoted facts, (c) touched entity has prior causal history |
| `platform/src/services/causal-agent.ts` (4593 ln) | `invokeCausalAgent(epochId, scope)` (`:4084`), the full `GRAPH_TOOLS` array, `handleToolCall` (`:1710`), actor allowlists |
| `ml-services/app/causal_agent.py` (165 ln) | `POST /causal-agent` — FastAPI endpoint, `CAUSAL_AGENT_SYSTEM_PROMPT`, drives Claude Code over the MCP config |
| `platform/src/services/causal-promotion.ts` (166 ln) | `applyCausalPromotion(epochId)` — deterministic disposal: ref-resolve, self-loop drop, dedup, cited-fact status, stamps `strength = config.CAUSAL_PROMOTION_STRENGTH` (`:126`) and `extractionMethod='causal_promotion'` (`:129`) |
| `platform/src/services/causal-promotion-plan.ts` (147 ln) | `planCausalPromotion(...)` — pure planner; `CitedFactStatus = active|superseded|invalidated` |
| `platform/src/services/causal.ts` (1195 ln) | `mintCausalEvent` (`:205`), `createCausalEdge` (`:224`), `expireCausalEdge` (`:443`), `reviseCausalEdge` (`:513`), `cascadeFactExpiry` (`:618`), `applyConfidenceDecay` (`:746`) |
| `platform/src/services/causal-patterns.ts` (1266 ln) | `collectChains`, `normaliseChain`, `detectCausalPatterns`, `promotePatterns`, `nameCandidatePatterns`, `matchEdgeToPattern`, `activePatterns`, `findCausalGhosts` — **fully built, 0 rows of output (§B2)** |
| `platform/src/services/audit.ts:243-247` | syncs `source_references` JSONB → `edge_source_refs` after every insert/corroboration |
| `platform/scripts/verify-causal-live.ts` (195 ln) | E6 live verification against the real Haiku agent; seeds a funding→relocation scenario; runs on the `cognitive` DB |

**Docs-vs-reality on the writer side:**

- **[D→FALSE] `services/causal-mcp.ts` does not exist.** It was **deliberately deleted** —
  `git log --diff-filter=D` → commit `99c435e "nmemo-2yv.124: delete causal-mcp.ts + dead
  CAUSAL_AGENT_TOOLS export"`. `platform/dist/services/causal-mcp.js` is a **stale build artifact**;
  `platform/.causal-mcp-config.json` is a stale config; `src/test/harness/causal-mcp.test.ts` survives but
  imports from `services/causal-agent.js`, not the deleted file.
- **[D→PARTLY FALSE] "7 causal tools exposed as an MCP server".** The causal read tools are folded into
  the **single** `graph-mcp.ts` surface alongside ~50 others. The causal-specific ones are **4**:
  `get_causal_history`, `trace_causes`, `project_trajectory`, `get_causal_delta` (`causal-agent.ts:274`,
  `:290`, `:314`, `:338`), plus 2 causal mutators (`expire_causal_edge :1035`, `revise_causal_edge :1049`)
  and 1 proposer (`propose_causal_edge :1349`). The test at `causal-mcp.test.ts:24` itself now asserts
  *"exposes the **six** causal-reasoning read tools"*. `create_causal_edge` was **removed** from every
  agent surface in E7 (`causal-agent.ts:1610`).
- **[D→TRUE] the conditional trigger exists** and matches the documented (a)/(b)/(c) shape
  (`causal-pass-trigger.ts:81`, thresholds in `config.ts:126-128`). `DISABLE_CAUSAL_PASS`
  (`config.ts:136`) can switch the whole pass off for bulk ingests.
- **[D→TRUE] the agent is the only proposer and holds no canonical-write tool**
  (`CAUSAL_SURFACE = READ_ONLY_TOOL_NAMES + ['propose_causal_edge']`, `causal-agent.ts:1617-1621`).

### C2. READERS — the key question

**Read primitives that exist** (`platform/src/services/causal.ts`):
`traceCauses` (`:858`) · `projectTrajectory` (`:975`) · `getEntityCausalHistory` (`:1085`) ·
`getCausalDelta` (`:1130`) · `findEdgesCitingReference` (`:1176`).

`traceCauses` is a **correct** recursive CTE over `public.facts`-style plain SQL (no AGE): base row =
`causal_events WHERE fact_id = $1`, recursive step joins `causal_edges edge ON edge.effect_event_id =
chain.event_id AND edge.expired_at IS NULL AND edge.strength >= $minStrength`, with cycle protection via
a `path uuid[]` accumulator (`causal.ts:901, 922, 930`) and optional corpus filters on both the base and
the recursive parent (`:863-864, 904, 928`). `projectTrajectory` is its mirror.

**Every production caller [V] (`grep` across `platform/src`, `viz`, `benchmarks`):**

| Caller | Path |
|---|---|
| `causal-agent.ts:1976` | MCP `get_causal_history` → `getEntityCausalHistory` (**passes `corpusId`**) |
| `causal-agent.ts:2007` | MCP `trace_causes` → `traceCauses` (**passes `corpusId`**) |
| `causal-agent.ts:2039` | MCP `project_trajectory` → `projectTrajectory` (**does NOT pass `corpusId`** — see C4) |
| `causal-agent.ts:2069` | MCP `get_causal_delta` → `getCausalDelta` (no corpus param exists) |
| `causal-agent.ts:2934` | internal neighbourhood assembly |
| `causal-pass.ts:132` | the **writer** pass reading history for agent context |
| `impact.ts:643` | `findEdgesCitingReference` → blast radius (`analyzeImpact`) |
| `src/test/harness/causal-queries.test.ts`, `src/test/tools/corpus-isolation-probe.ts` | tests/probes |

**What does NOT read Graph C [V]:**

- **`services/retrieval.ts` — ZERO causal references.** Its whole export surface is
  `recallEntitiesByFactSimilarity` (`:65`) and `recallEntitiesFused` (`:94`).
- **`services/fusion.ts` — ZERO causal references.** (The confirmed doc-16/R4 two-signal read path
  therefore does not touch Graph C at all.)
- **`services/graph.ts` — no causal reads** (one comment at `:352`).
- **`platform/viz/**` — ZERO** matches for `causal` across all JS/HTML.
- **`benchmarks/**` — ZERO** causal references except an unrelated `_common/client.py` hit.

**HTTP surface [V]** (`grep -a` over `platform/src/index.ts`, which ripgrep skips as binary). The causal
routes that exist are all **write / admin / viz / inspect**, none of them retrieval:
`POST /api/decay` (`:980`) · `GET /api/impact/:type/:id` (`:1016`) · `GET|POST /api/contradictions*`
(`:1068, :1086, :1131`) · `POST /api/patterns/detect|promote` (`:1176, :1196`) · `GET /api/patterns`
(`:1208`) · `GET /api/patterns/:id/instances` (`:1225`, raw SQL over `causal_edges`) ·
`GET /api/causal-edges/:id/history` (`:1265`) · `GET /api/ghosts/:entityId` (`:1277`) ·
`GET /api/viz/unified` (`:313`, dumps events+edges with `.limit(500)`) · `GET /api/viz/stats` (`:1389`,
counts only).

**`traceCauses` / `projectTrajectory` / `getEntityCausalHistory` / `getCausalDelta` are NOT exposed on
any HTTP route.** **[V]**

**The one query-time path to Graph C [V]:** `POST /api/reason/query` (`index.ts:1494`) →
`invokeReasoningAgent({mode:'query', question, corpusId})` → actor `reasoning_agent` → `LEGACY_SURFACE`
(= every tool bar 3 retired + 2 arbiter-only, `causal-agent.ts:1587-1591`) → the agent *may choose* to
call `trace_causes`. That is **LLM-mediated and non-deterministic**, and it pre-computes flat retrieval
evidence first (`computeQueryFallbackEvidence`) which never consults Graph C.

**[I] Conclusion for I4:** there is no deterministic, free, query-anchored read path over Graph C. The
substrate is reachable only (a) by an already-known `fact_id`/`entity_id`, or (b) through an LLM agent's
tool choice. Any I4 retrieval evaluation must first build an entry point — resolve query → fact_id(s) →
`traceCauses` — because none exists.

### C3. Embeddings on Graph C: none, in the strongest sense — **[V]**

`grep -rn "event_embedding|eventEmbedding" platform/src --include=*.ts` returns exactly **two** hits:
- `platform/src/db/schema.ts:443` — a comment: *"Note: event_embedding handled directly via SQL
  (pgvector), not in Drizzle"*
- `platform/src/test/harness/causal-schema.test.ts:93` — `expect(colNames).toContain('event_embedding')`

**Nothing writes it and nothing reads it**, and it is NULL on 17,847/17,847 rows despite an HNSW index
existing. `causal_patterns.pattern_embedding` likewise has an HNSW index and 0 rows. This is a strictly
worse version of the `fact_embedding` finding (which was at least *written*). **Access to Graph C is
purely structural: SQL recursive CTE.**

### C4. Incidental code findings (read-only observations, not fixed)

1. **`project_trajectory` leaks across corpora.** `causal-agent.ts:2038-2042` passes `maxDepth` and
   `minStrength` but **omits `corpusId`**, while `trace_causes` at `:2007-2012` passes it
   (`// nmemo-asf.3: keep the causal walk inside the injected corpus`). The function supports it
   (`causal.ts:979-981`). `src/test/tools/corpus-isolation-probe.ts` asserts corpus isolation for
   `traceCauses` only — `projectTrajectory` is untested there, so the gap is silent.
2. **`getCausalDelta` has no corpus option at all** (`causal.ts:1130-1133`: `options: { entityId?: string }`),
   so MCP `get_causal_delta` is unscopable. Same for `findEdgesCitingReference`
   (`causal.ts:1176-1179`: `options: { includeExpired?: boolean }`) and therefore for blast radius.
3. **The dangling-entity-ref case is unflagged** — `stale_citation` only covers fact refs (§B5).
4. `rawQuery` snake→camel rewriting (CLAUDE.md trap) is handled correctly in `traceCauses`: the result
   type is declared in camelCase (`eventId`, `subjectEntityId`, …) at `causal.ts:866-884`. No bug here.

---

## D. What could be measured for FREE (no LLM spend)

All of the following are deterministic SQL or local-embedding only, on `cognitive_test`. They are the
measurements that would settle "is Graph C real or theatre" without an LLM call.

**D1. I4 coverage ceiling per corpus — the single most decisive free number.** Already computed above
(§B7): 18.1% / 15.3% / 0.62% / 0.49% / 0%. Extend it to a per-corpus **answerable-question inventory**:
for each of the 464 dal-cv facts with a cause, emit the tuple (effect fact triple + `source_text`, the
edge `reasoning`, the cause fact triple + `source_text`). That is a **ready-made, provenance-complete,
zero-cost I4 question set of 464 items on dal-cv and 399 on dal-nlp** — built entirely from the graph,
no annotation. Its hop distribution (86% single-hop) tells you up front that it tests one-hop lookup, not
transitive reasoning.

**D2. Is the "cause" retrievable by the existing two-signal read path?** For each of the 464 dal-cv
effect→cause pairs, embed the effect fact's `source_text` (local nomic/bge, already cached in
`prereg-artifacts/*embed-cache.json`) and measure whether the cause fact/entity appears in the top-k of
(a) dense-over-names, (b) dense-over-facts, (c) their RRF-60 fusion. If fusion already retrieves the
cause, **Graph C adds nothing to retrieval** and its value is explanation-only. This is the direct
analogue of the doc-31 concept-layer test and costs nothing but local embedding.

**D3. Cosine of cause↔effect `fact_embedding`.** Both endpoints have `fact_embedding` populated
(1873/1873). Compute the distribution. If causally-linked pairs are high-cosine, Graph C is
**embedding-shadowed** (the doc-30/31 failure mode); the low-cosine tail is Graph C's genuine blind-spot
contribution and is exactly the slice worth testing. Free, deterministic, and it pre-empts the
"embedding-correlated oracle" critique that killed doc 30.

**D4. Edge-vs-null-model discrimination.** 1043 real edges vs N sampled non-edges drawn from the same
(corpus, ingest-batch) strata. Compare the two populations on: `fact_embedding` cosine, shared-entity
rate (real: 56% same subject entity), co-occurrence in the same `facts` neighbourhood via
`traverseFromEntities`, predicate-pair frequency. If real edges are indistinguishable from stratified
random pairs on every free feature, the LLM added no structure. Pure SQL + local vectors.

**D5. Structural saturation / ceiling audit.** Already partly done: largest component 7, 0.7% hop-capable,
max degree 4, zero paths ≥5 hops. Extend to: (a) transitive-closure size per root (how many distinct
causes are reachable at all — currently ≤4); (b) how many of the 142 two-hop paths are genuine chains
vs. a fan-in/fan-out artifact at a shared middle node; (c) fraction of components that are a single
cause with multiple effects (star) vs. a path. This bounds any possible I4 multi-hop result *before*
running it.

**D6. Provenance integrity battery (cheap, repeatable).** Re-run: JSONB↔`edge_source_refs` parity
(2353 = 2353 today); ref resolution rate (2349/2353); cited-fact `source_text` coverage (1873/1873);
`stale_citation` vs actual dangling refs (3 flagged / 4 dangling — the entity gap). This is a
regression harness for the doc-01 invariant that needs no model.

**D7. Agent proposal quality from the existing staging table.** `staging_causal_edges` (1251 rows,
35 epochs) is a **free, already-paid-for record of agent behaviour**. Measurable now: unresolvable-id
rate 13.2% (165/1251), self-loop rate 0.3%, duplicate-pair rate 0.2%, landing rate 83.5% (1045/1251),
per-epoch variance in those rates, reasoning-length and ref-count distributions vs canonical. This is the
closest thing to a causal-agent precision proxy that costs nothing.

**D8. The degeneracy audit (kills invalid experiment designs cheaply).** Confirm and quantify:
`temporal_span` NULL 1043/1043; simultaneous cause/effect 1027/1043; `strength` = 0.6 on 1012/1043;
`event_embedding` NULL 17,847/17,847; `pattern_id` NULL 1043/1043. Any I4 pre-registration that plans to
filter on `minStrength`, order by `occurred_at`, search by `event_embedding`, or group by pattern is
**void on arrival** — these five counts are the guard.

**D9. Corpus-scoping leak test (extends the existing probe, no LLM).** `src/test/tools/
corpus-isolation-probe.ts` already asserts `traceCauses` isolation. The same fixture can assert
`projectTrajectory` and `getCausalDelta` — which would fail today (§C4.1–2). Deterministic, local.

**D10. `cognitive` vs `cognitive_test` confirmation.** One-line guard for any harness:
`cognitive.causal_edges = 0`. Pointing an I4 run at `cognitive` silently measures nothing.

---

## Appendix — provenance of the numbers

All SQL run via `docker exec nmemo-postgres-1 psql -U cognitive -d {cognitive_test|cognitive}`
(no local `psql`; Postgres is `nmemo-postgres-1`, `0.0.0.0:5433->5432`). **SELECT-only**, plus one
`SET search_path` in a read session. No writes; no source file modified; the single file written is this
one.

Traps respected: `platform/src/index.ts` searched with `grep -a` (NUL bytes make ripgrep treat it as
binary); `rawQuery`'s snake→camel rewrite accounted for when reading `causal.ts`; no capability
attributed to Apache AGE (which is in fact empty *and* unregistered for `causal_graph`, §A5).
