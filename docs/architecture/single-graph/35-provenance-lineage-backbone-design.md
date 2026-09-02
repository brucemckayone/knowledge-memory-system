# 35 — Provenance / lineage backbone: design (nmemo-asf.2, Phase 1.1)

**Status: DECIDED 2026-09-02 — building §5 step 1a first (prove), then first-class tables (option A, §7).**
Grounded in doc 33 (Phase 0) + a full code-path map (2026-09-02). Sequence: re-light the existing substrate
via the server-side `source_memory_id` fix and confirm `fact_sources`/`fact_units` populate on a fresh ingest
BEFORE adding `source_document`/`fragment` tables — evidence before schema.

## 1. What this is for
The acceptance criteria (bead `nmemo-asf.2`): a `fragment{fragment_id, source_document_id, parent_id, char
offsets, chunker name+version}` layer + `entity/edge → proof_fragment_ids[]` transitively resolvable to
source; the epoch path must populate fact provenance (fix NULL `source_memory_id` / empty `fact_units`);
per-claim citation. Verified by a lineage round-trip test + non-null provenance on a **fresh epoch ingest**.

Load-bearing beyond citations: the `.8` community "win" was an un-held-out-edge leak (doc 29). Correct
held-out evaluation needs to exclude a query document's own fragments — a Postgres-side operation that a
real lineage makes possible.

## 2. The headline finding: the substrate is already BUILT and dead on ONE broken link
This is **not** "build a fragment layer from scratch." doc 33 already showed the text is inline
(`facts.source_text` 100%). The code map shows the *lineage* substrate is also almost entirely built:

- **Chunker with char offsets** — `splitIntoUnits()` (`pipeline.ts:268`) emits `{text, charStart, charEnd}`
  (`pipeline.ts:284`).
- **Qdrant window + unit points** — `store()`→`storeMemoryWithUnits()` (`qdrant.ts:104`) writes a `'window'`
  parent point (`id=memoryId`) and `'unit'` satellites (`id=unitPointId(memoryId,i)`,
  `parent_window_id`, `char_start`, `char_end`) — `pipeline.ts:468-502`. **The `'unit'` point IS the
  fragment**; ids are deterministic UUIDv5 (`unitPointId` `pipeline.ts:336`, `windowPointId` `pipeline.ts:350`).
- **Link tables + writers exist:** `fact_sources` (mig 029, writer `recordFactSource` `facts.ts:80`, called
  `facts.ts:284`), `fact_units` (mig 047, writer `pipeline.ts:667`, mapper `mapFactToUnits` `pipeline.ts:379`),
  `memory_entities` (writer `linkMemoryToEntity` `entities.ts:519`, supports `mentionStart/End`).

**Why all three are empty (the single root cause + its cascade):** `facts.source_memory_id` is never set
server-side.

1. **Serial/optimistic (live) path** — the `create_fact` MCP tool trusts the LLM to echo the id back:
   it passes `toolInput.source_memory_id` (`causal-agent.ts:1995`), and the tool description just *asks* the
   model to copy the context `memory_id` (`causal-agent.ts:370-372`). The model doesn't → NULL. Yet
   `extract()` already **knows** the real `memoryId` (`invokeGraphAgent({memoryId})` `pipeline.ts:563`).
2. `recordFactSource` no-ops when `memoryId` is falsy (guard `facts.ts:87`) → **`fact_sources` = 0 rows**.
3. `extract()` re-queries created facts by `where(sourceMemoryId = memoryId)` (`pipeline.ts:643`); with the
   column NULL it returns **zero** facts, so the `fact_units` write (`pipeline.ts:667`) never fires →
   **`fact_units` = 0 rows**.
4. **Epoch (experimental) path** — `promote()` (`promotion.ts:482`) never writes `source_memory_id` at all
   and per-chunk attribution was deliberately dropped ("promotion is epoch-wide", `pipeline.ts:1088`). BUT
   the staging row carries `(source_id, chunk_index)` (mig 040:60-71), so the window id is reconstructable as
   `windowPointId(source_id, chunk_index)` (`pipeline.ts:350`) with zero Qdrant reads.

So one server-side injection re-lights `fact_sources` **and** `fact_units` on the live path; a small
`promote()` addition does the same on the epoch path.

## 3. What's genuinely missing vs the acceptance schema
Mapping the fragment schema onto what exists:

| acceptance field | today | gap |
|---|---|---|
| `fragment_id` | unit point id (`unitPointId`) | none (exists, deterministic) |
| `parent_id` | `parent_window_id` on unit payload | none |
| char offsets | `char_start/char_end` on unit + `fact_units` | none |
| `source_document_id` | window carries `source_id`+`chunk_index`; **no first-class document row** | **missing** |
| chunker name+version | `splitIntoUnits` params only, unstamped | **missing** |
| entity → proof_fragment_ids | `memory_entities` exists but `mention_start/end` NULL (tool schema `causal-agent.ts:427-448` lacks the fields; tool passes only text+context `causal-agent.ts:2091-2092`) | **wire offsets** |
| edge(fact) → proof_fragment_ids | `fact_units` (once re-lit) | none once re-lit |

So the only *new* modelling is: a **source_document** notion and a **chunker version** stamp; plus wiring
the entity-mention offsets. Everything else is re-lighting.

## 4. Recommended shape
Lean on what exists; add first-class Postgres rows only where the acceptance schema and held-out eval need
them, and key them to the **same deterministic ids** so Postgres and Qdrant never diverge.

- **`source_document`** (new, mig 059): `id UUID PK` (= `windowPointId`'s `source_id` namespace or a per-doc
  uuidv5 of `source_id`), `corpus_id`, `external_source_id TEXT`, `content_type`, `chunker_name`,
  `chunker_version`, `created_at`. One row per ingested document (a batch chunk / a `/ingest` call).
- **`fragment`** (new, mig 059): `id UUID PK` = the deterministic point id (`windowPointId` for windows,
  `unitPointId` for units — single id space shared with Qdrant), `source_document_id FK`, `parent_id UUID
  NULL` (unit→window), `kind` (`window|unit`), `char_start`, `char_end`, `chunker_name`, `chunker_version`,
  `created_at`. Populated at `store()` — offsets already computed. Text stays in Qdrant + inline
  `source_text`; `fragment` is the lineage index, not a third copy of the text.
- **Re-light the links (the load-bearing fix):**
  - Serial: inject `source_memory_id` from `context.memoryId` server-side in the `create_fact` handler
    (`causal-agent.ts:1995`) instead of trusting `toolInput` — cascades to `fact_sources` + `fact_units`.
  - Epoch: in `promote()` derive `sourceMemoryId = windowPointId(source_id, chunk_index)`, call
    `recordFactSource`, and run the `mapFactToUnits`→`fact_units` write there too.
  - Point `fact_units.unit_point_id` / `fact_sources.memory_id` / `memory_entities.memory_id` at
    `fragment.id` (they already are the same uuidv5 values — this is a documentation + FK-optional choice, not
    a data change).
- **Entity mentions:** add `mention_start/mention_end` to the `link_entity_to_memory` tool schema
  (`causal-agent.ts:427`) and pass them through (`causal-agent.ts:2091`), so entity→fragment carries offsets.
- **`proof_fragment_ids[]` transitive resolve:** a view/function `fragment_id → parent_id →
  source_document_id`; entity/edge → fragments via the link tables. This is the round-trip the acceptance
  test exercises.

Deliberately **out of scope** here (own beads): `entity_meta` populate-or-drop (doc 33 #5 → belongs with
`.5`); predicate normalization (`.5`); backfilling the existing 294-doc corpora's NULL lineage (a separate
one-shot, since the fix is forward-only — new ingests get lineage, old rows need a reconstruction pass).

## 5. Incremental plan (each step verifiable before the next)
1. **1a — re-light + prove the existing substrate. ✅ DONE 2026-09-02 (the fix + a deterministic proof).**
   Fix applied: `create_fact` now stamps `source_memory_id` from a harness-injected `context.memoryId`
   (env `MNEMO_MEMORY_ID`, carried through `getMcpEnv`/`getMcpConfigPath`/`invokeGraphAgent`, mirroring the
   epoch `sourceId`/`chunkIndex` carrier), not the LLM echo — `causal-agent.ts` (6 additive edits;
   backward-compatible; tsc held at 69).
   - **Deterministic proof (`platform/src/test/tools/prov-probe.ts`, no LLM/Claude, scratch corpus
     `_prov_probe`, self-cleaning):** with a non-null `source_memory_id`, `createFact`→`recordFactSource`
     writes the `fact_sources` row (correct `memory_id` + verbatim `source_text`); `splitIntoUnits`(3 units) +
     `mapFactToUnits` yield an `offset_overlap` link; the persisted `fact_units.unit_point_id` equals the
     deterministic `unitPointId(memoryId, idx)` and the char offsets round-trip to the source span. ALL green.
   - **Plumbing proof (deterministic):** `getMcpConfigPath('graph_agent', undefined, memoryId)` writes
     `MNEMO_MEMORY_ID` into the spawned MCP server's config env, under a per-memory filename suffix
     (concurrency-safe for optimistic batch); the no-memory call keeps the legacy filename and omits the var.
   - **Surprise banked:** a DB trigger mirrors every new fact into `causal_events` (`fact_id` FK, NO ACTION) —
     this is the mechanism behind doc 33's "7299 causal events over 212 facts" on the churny `default` corpus;
     cleanup must drop the causal mirror before facts (fixed in the probe).
   - **Not yet run:** the live Claude extraction end-to-end. Proven by construction (config carries the id →
     `resolveContext` reads env → `create_fact` stamps it → `fact_sources`/`fact_units` follow, all validated
     above); the one live run is folded into 1b's epoch acceptance ingest to spend Claude once, not twice.
2. **1b — epoch-path parity. ✅ CODE DONE 2026-09-02 (live ingest pending).** `promote()` now derives
   `source_memory_id = windowPointId(source_id, chunk_index)` from the staged fact (threaded
   `sourceId` through `StagedFact`→`PlannedFact`→the plan materializer) and calls `recordFactSource`
   (`promotion.ts`). `runEpochBatch`'s `store()` now passes `corpusId` so the epoch arm's fragments land
   in the ingested corpus. `windowPointId`/`unitPointId`/`sourceDocumentId` moved to a leaf module
   `services/point-ids.ts` (re-exported from pipeline) so `promotion.ts` derives the id without a
   pipeline↔promotion cycle. tsc held at 69 (fixed 3 test fixtures for the new required `sourceId`).
   **Scope note:** the epoch proposer emits no verbatim span (`source_text = reasoning`), so epoch
   `fact_units` offset-overlap needs a proposer change — deferred to Phase 4; the epoch path's Phase-1
   lineage gain is `source_memory_id` + `fact_sources` + fragments.
   - **Deterministic proof (`promote-probe.ts`, no LLM/Claude):** hand-seeds staging (one entity + one
     fact carrying `source_id`/`chunk_index`) and calls the real `promote()` into the scratch corpus. The
     promoted fact gets `source_memory_id == windowPointId(source_id, chunk_index)` (NULL before) and a
     matching `fact_sources` row (source_text = the staged reasoning). Self-cleaning; all green.
   - **Still not run:** the full live epoch ingest (propose() + batch glue). The deterministic proof
     exercises the real `promote()` half; `store()`/fragments (1c) and the serial link (1a) are
     independently proven. A live ingest is an optional end-to-end confirmation (Claude spend).
3. **1c — new tables + chunker stamp. ✅ DONE 2026-09-02 (deterministic proof green).** `source_document`
   + `fragment` (mig 059, applied to `cognitive_test`), populated at `store()` via `recordFragments`;
   chunker name+version stamped (`sliding-window` / `v1:128/64`). Proven by `frag-probe.ts`: parent
   chain, offsets, transitive unit→window→document resolve, idempotent re-run; self-cleaning. (Entity-
   mention offsets still to wire — `link_entity_to_memory` tool schema lacks `mention_start/end`.)
4. **1d — round-trip test + citation surface (TODO).** `entity/edge → proof_fragment_ids → source_document`
   round-trip test; per-claim citation reads through it. Also: entity-mention offsets on the tool schema.

## 6. Verification (acceptance)
- Lineage round-trip test: create a fact + entity from a known text, resolve each to `proof_fragment_ids`,
  resolve those to `source_document`, assert the char span matches the original text. New test file under
  `platform/src/test/`.
- Non-null provenance on a fresh epoch ingest: `fact_sources`/`fact_units` rows present, `source_memory_id`
  set, offsets within bounds. (Manual + a test.)
- tsc baseline stays **69** (compare, never "fix").

## 7. The one decision
**Fragment lineage as first-class Postgres tables, or reuse the Qdrant-unit fragments + link tables only?**

- **(A) Recommended — first-class `source_document` + `fragment` in Postgres (§4), keyed by the existing
  deterministic point ids.** Matches the acceptance schema literally; gives DB-native, Qdrant-independent
  lineage (needed for correct held-out eval — the `.8` leak lesson); `parent_id` models window↔unit natively.
  Cost: one migration + populate at `store()`. Low divergence risk because fragment_id = the same uuidv5.
- **(B) Minimal — no new tables; re-light `fact_sources`/`fact_units`/`memory_entities` and treat the Qdrant
  unit point as the fragment, reconstructed on demand via `splitIntoUnits`+`unitPointId`.** Smallest change,
  but "fragment" and "source_document" stay implicit (no `parent_id`/`chunker_version` row), held-out eval
  must recompute from Qdrant, and it doesn't literally satisfy the fragment schema.

Both start with the same load-bearing bug fix (§5.1), so **step 1a is worth doing regardless** — it proves
the substrate and costs almost nothing. The §7 choice only decides 1c.
