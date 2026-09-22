# Triage: provenance / temporal correctness / entity integrity

Date: 2026-09-22. Branch `feat/single-graph-retrieval` @ `bcb95a7`. Read-only verification.
Live substrate: `cognitive_test` (135,210 entities / 343,018 facts). Comparison DB: `cognitive` (4 entities / 2 facts).

Every claim below is tagged **[V]** verified by my own read/query, **[B]** claimed by the bead or a doc
(unverified by me), or **[I]** inference.

## Verdict table

| Bead | Verdict | One-line evidence |
|---|---|---|
| nmemo-ygk | **PARTIAL** | `fact_sources`/`source_memory_id` half FIXED in code (`promotion.ts:495-526`, commit `e330501`, 2026-09-02 16:16Z) but **every** epoch fact in the DB predates it (latest = qbio 2026-09-02 00:14Z), so 0 rows is stale data not a live bug; the `memory_entities` half is **untouched** — `promotion.ts` contains zero `memory_entities` references |
| nmemo-u70 | **PARTIAL** | Mig 060 replaced the index in place; temporal corpora get identity `(s,p,o,valid_at)` and it works live (`_cronqa`: 20,751 triples with >1 active row, max 42, incl. 1 group holding a current **and** a past-`invalid_at` row). Non-temporal path is byte-identical to 037, so SC-17 as written still throws 23505. The merge-dedup co-evolution the bead demanded was **not** done |
| nmemo-r51 | **STILL-BROKEN** | `public.entity_type_history` exists, 0 rows, all 3 indexes `idx_scan = 0`; `schema.ts:281` is the only non-test reference; no code anywhere sets `entity_type` after insert |
| nmemo-du2 | **PARTIAL** | AGE half **FIXED** — `clearAgeGraph()` (`index.ts:1355-1363`) now runs on both endpoints and `cognitive` AGE is 0 nodes vs 4 entities (bead measured 1,067 vs 4). Staging/audit half still uncleared, but is now a documented deliberate decision (`index.ts:1321-1330`), not silent drift |
| nmemo-x4s | **STILL-BROKEN** | Reproduced the bead's numbers exactly: arxiv-nlp 241/1,230 = **19.6%** name-duplicate rows, `chatgpt` present **21x** across `LLM`/`llm_model`/`LLM_Model`/`SoftwareTool`/`artifact`/`tool`/`system`/... . **100%** of duplicate rows in every research corpus are cross-type. `entity_merges` = 0 in all 6 research corpora |
| nmemo-5fa | **STILL-BROKEN** | `gardener_agent: LEGACY_SURFACE` (`causal-agent.ts:1645`), which excludes `execute_merge`/`create_same_as_link`/`resolve_contradiction` **and** `propose_identity_verdict`/`propose_conflict_resolution`. A disposer now exists (`promotion.ts:363` calls `mergeEntities`) but only the arbiter can feed it; the gardener has no merge propose path |
| nmemo-wyb | **PARTIAL** | Mechanism built and explicitly attributed to this bead (`isWordPrefix`, `promotion-plan.ts:344-352`: "merges the doc-41 `nmemo-wyb` helix / helix-robotics duplicate"). But: no test encodes the acceptance, the E8 harness fixture is gone from both DBs (no `Elena Vasquez`, no `helix robotics`), and the fix is **type-gated** — live `qbio` still holds `helix`(structure) + `helix`(concept) unmerged |

## Surprises worth their own beads

1. **`mergeEntities` did not co-evolve with mig 060 — latent data loss in a temporal corpus.** [V]
   `entities.ts:806-812` partitions the pre-re-point dedup by
   `(pm_subject, predicate, pm_object_entity, object_value)` with **no `valid_at` and no
   `temporal_corpus` branch**, while the live index keys temporal rows on `valid_at`. Merging two
   entities in a `recurring_facts` corpus would expire every recurring window but one. This is exactly
   the "Option A ripples into the merge dedup" hazard nmemo-u70 flagged as a precondition — mig 060
   shipped the relaxation (via `valid_at` rather than `invalid_at`) without it. Commit `178a035` touched
   `facts.ts` + `causal-agent.ts` only; `entities.ts` is not in its file list. [V] Latent today
   (`entity_merges` = 0 in `_cronqa`), so severity is low-now / high-if-merges-are-restored.
   Fix size: one-function.
2. **The epoch path does not honour temporal mode either.** [V] `promotion.ts:505-521` inserts facts
   with no `temporalCorpus` field, so a promoted fact in a `recurring_facts` corpus lands
   `temporal_corpus = false` (column default) and collapses to single-active-truth — the flag only
   works via `createFact` (`facts.ts:195`) and the bulk `cronqa-load.ts` loader. Fix size: one-line.
3. **`entity_type` is not even case-normalised.** [V] `arxiv-nlp` carries `LLM_model` **and**
   `LLM_Model`, `Category` **and** `category`, `Technology` **and** `technology` as distinct identity
   components. A `lower()` on the type in `resolveEntities`' `priorByType`/cluster keys is a cheap
   partial win against nmemo-x4s that does not require the full "type as attribute" decision.
4. **AGE drifted the other way.** [V] `cognitive_test` now has **6,046** AGE nodes against 135,210
   entities — under-populated, not over. The 324,926-fact `_cronqa` bulk load bypassed the sync
   triggers (they fail silently: `EXCEPTION WHEN OTHERS THEN RAISE WARNING`). Harmless, since nothing
   reads AGE, but it kills AGE as any kind of cross-check.
5. **`_cronqa` is a large temporal corpus nobody's triage list mentions.** [V] 324,926 facts /
   125,523 entities loaded 2026-09-08 by `test/tools/cronqa-load.ts` with `recurring_facts = true`. It
   dominates every whole-DB count and is the reason `facts.invalid_at IS NOT NULL` is 324,833 rows.
   Any bead that quotes a whole-`cognitive_test` number from before 2026-09-08 is now wrong.

---

## 1. nmemo-ygk — epoch path writes no `fact_sources` / `memory_entities`

**Verdict: PARTIAL.** Severity: medium (provenance still absent on the live graph, and the fix has
never been exercised on it). Fix size for the remaining half: one-function.

### Resolving the contradiction

The bead's premise held when filed (2026-08-28). The `fact_sources` half was fixed four days later.

- [V] `promotion.ts:495-503` reconstructs the parent window id from the staged source boundary:
  `const windowId = f.sourceId != null && f.chunkIndex != null ? windowPointId(f.sourceId, f.chunkIndex) : null;`
  then stamps `sourceMemoryId: windowId` on the insert (line 512) and calls
  `recordFactSource(tx, factId, windowId, f.reasoning, f.confidence)` at line 526.
- [V] `recordFactSource` (`facts.ts:107-135`) is a real `INSERT INTO public.fact_sources ... ON CONFLICT
  DO UPDATE ... RETURNING (xmax = 0)`. It persists to `public.fact_sources`. It early-returns
  `{added:false}` when `memoryId` is falsy — that is the only no-op branch.
- [V] `git log -S recordFactSource -- platform/src/services/promotion.ts` returns exactly one commit:
  `e330501` "feat(35): provenance/lineage backbone Phase 1.1 — re-light fact links + fragment tables
  (nmemo-asf.2)", **2026-09-02 17:16:07 +0100** (16:16Z). Same commit added mig 059 and
  `test/tools/promote-probe.ts`.

So why are the tables empty? Because no epoch run has happened since:

| corpus | last fact `created_at` | vs fix (2026-09-02 16:16Z) |
|---|---|---|
| `_cronqa` | 2026-09-08 11:53Z | after — but **not the epoch path** (see below) |
| `qbio` | 2026-09-02 00:14Z | 16h before |
| `dal-cv` / `dal-nlp` | 2026-08-31 | before |
| `default` | 2026-08-31 14:16Z | before |
| `arxiv-cv` / `arxiv-nlp` | 2026-08-25 / 08-24 | before |

[V] All six epoch-path corpora predate the fix. The only post-fix write is `_cronqa`, which comes from
`test/tools/cronqa-load.ts:113` — a bulk `INSERT INTO public.facts (subject_entity_id, predicate,
object_entity_id, valid_at, invalid_at, corpus_id, temporal_corpus, extraction_method, confidence)`.
It never goes through `promote()` or `createFact`, so it writes no provenance by construction. [V]

Corroborating: [V] `staging_proposed_facts` still holds 3,149 rows from 2026-09-01/02, **all 3,149 with
both `source_id` and `chunk_index` non-null** — the inputs `windowPointId` needs were already being
staged before the fix; only the reconstruction was missing.

So: **0 rows is a historical artifact, not a live defect, for `fact_sources` + `source_memory_id`.**
[I] I did not *prove* the fix works, because proving it requires a write. `promote-probe.ts` exists
precisely for this and asserts `source_memory_id == windowPointId(source_id, chunk_index)` and exactly
one `fact_sources` row — it is a deterministic, self-cleaning, no-LLM probe. Running it is the
one-command close-out and it was out of scope here (read-only).

### What is still broken

- **`memory_entities`: no epoch writer at all.** [V] `grep -n memoryEntit platform/src/services/promotion.ts`
  returns no matches. The only writers are (a) `pipeline.ts:612`, which links **only** the SELF entity on the
  default stream in the serial `extract()` path, and (b) `entities.ts:526`, the `link_entity_to_memory`
  MCP tool the legacy graph agent calls. Neither is on the propose/promote arm.
- [V] The 8 live `memory_entities` rows are all synthetic fixtures — `mention_text` is `Entity A` /
  `B mention`, created 2026-07-17 and 2026-07-20. Nothing real has ever been linked. This half of the
  bead is fully intact.
- **`source_document` and `fragment` are also 0 rows.** [V] Mig 059 created them; `recordFragments`
  (`pipeline.ts:380`) writes them; neither has ever run on this substrate. `fact_units` is 0 too, and
  `promotion.ts:522-525` says so explicitly ("the epoch path emits no verbatim span, so unit-grained
  `fact_units` offset spans stay a Phase-4 extraction change"). [I] So graph-anchored retrieval still
  returns evidence with no text, as CLAUDE.md records — the `fact_sources` fix gives a
  fact-to-window-point-id pointer, not text, and the text lives in Qdrant.

### Recommended bead rewrite

Split it: (a) *verify* the shipped `fact_sources` fix by running `promote-probe.ts` and then a real
epoch batch, and backfill nothing (the old corpora's staging is long gone — `cleanupAbandonedStaging`
at `promotion.ts:690` with `STAGING_TTL_MS` default 1h, `pipeline.ts:1042`, is unchanged, so the
recovery chain the bead described really did expire). (b) A new bead for `memory_entities` on the epoch
path, which nothing has addressed.

## 2. nmemo-u70 — `uniq_facts_active_triple` vs bi-temporal supersession

**Verdict: PARTIAL.** Severity: low for extraction corpora (the design holds there), medium for the
merge hazard in finding #1. Fix size: needs-design for the remaining half (it is the same model call
the bead posed), one-function for the merge co-evolution.

### The index as it exists now

[V] Live in `cognitive_test`:

```
CREATE UNIQUE INDEX uniq_facts_active_triple ON public.facts USING btree (
  subject_entity_id, predicate,
  COALESCE(object_entity_id, '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(object_value, ''::text),
  (CASE WHEN temporal_corpus THEN COALESCE(valid_at, '-infinity'::timestamptz)
        ELSE '-infinity'::timestamptz END))
WHERE (expired_at IS NULL)
```

[V] `cognitive` still carries the pre-060 four-column version — that DB has not been migrated. Worth
knowing before anyone reproduces anything there.

[V] Mig 060 (`060_temporal_corpus_mode.sql`) does the replacement in place under the same index name,
deliberately, so 037's `CREATE ... IF NOT EXISTS` (which re-runs on every journal-less migrate) cannot
re-add the plain version. 037 itself was also amended — its duplicate-expiry `PARTITION BY` now
includes `valid_at`.

### What changed, and what did not

The bead proposed narrowing the predicate on `invalid_at`. **Mig 060 did something different**: it
added a per-corpus opt-in (`corpus_policies.recurring_facts`, denormalised to `facts.temporal_corpus`)
that switches identity to `(s, p, o, valid_at)` — not `invalid_at`. So:

- [V] **Temporal corpora: the collision is gone, and this is live.** In `_cronqa`
  (`temporal_corpus = t`): **20,751** `(s,p,o)` groups hold more than one active row, max **42**, and
  **1** group holds a current row and a past-`invalid_at` row simultaneously — the precise SC-17 shape,
  sitting in the database.
- [V] **Non-temporal corpora: byte-identical to 037.** All six non-temporal corpora show
  `max_active_per_triple = 1` and **0** groups with a current + past-`invalid_at` row. `valid_at`
  collapses to the `-infinity` constant, so two rows differing only in `valid_at`/`invalid_at` still
  share one key.
- [V] **SC-17 therefore still throws.** `test/integration/fact-supersession-chains.test.ts:226-245`
  inserts fact 1 (`validAt` 2024-01-01, no `invalidAt`) and fact 2 (`validAt` 2023-01-01,
  `invalidAt` 2024-01-01) for the same triple, both with `expired_at` NULL. `createTestFact`
  (`test/setup.ts:646`) writes raw SQL with no `corpus_id`, so both land in `default`
  (`recurring_facts = f`, so `temporal_corpus = false`), identical index key, 23505 on the second
  insert. Unchanged. [I] I did not run the test (that writes); the collision follows deterministically
  from the index definition and the fixture.

### The bead's OPEN QUESTION is now answered

The bead said the severity turns on "does any production ingest path actually insert a fact with
`invalid_at` set in the past alongside an active same-triple row?" [V] **Yes** — `cronqa-load.ts`
does, at scale (324,813 rows with `invalid_at` non-null), and mig 060 was built specifically to let it.
That path opts into temporal mode, so it is correct. What remains is narrower than the bead assumed:
the default single-active-truth model still cannot express "was true, no longer true" via `invalid_at`
with `expired_at` NULL. That is closer to the bead's Option B (history goes through `expired_at`, or
through temporal mode) having been chosen implicitly, and the honest close is to state it and rework or
retire SC-17 — not to narrow the index again.

But do not close it without finding #1: the merge-dedup co-evolution the bead made a precondition of
Option A was never done, and mig 060 introduced exactly the divergence it warned about.

## 3. nmemo-r51 — `entity_type_history` dead end-to-end

**Verdict: STILL-BROKEN.** Severity: cosmetic (a misleading schema comment; no correctness impact).
Fix size: one-line (delete the table + index + comment) or needs-design (build reclassification).

Every part of the bead reproduces:

- [V] Table exists, **in `public`** (not `ag_catalog` — the search_path trap did bite here once:
  `test/global-setup.ts:176` still carries `DROP TABLE IF EXISTS ag_catalog.entity_type_history CASCADE;`
  as a cleanup for that historical mislanding, and there is nothing left in `ag_catalog` but `ag_graph`
  and `ag_label`).
- [V] 0 rows in both `cognitive_test` and `cognitive`.
- [V] `pg_stat_user_indexes`: `entity_type_history_pkey`, `idx_entity_type_history_entity`,
  `idx_entity_type_history_time` all `idx_scan = 0`. (Caveat: `pg_stat_user_tables.n_live_tup` reads 0
  for `memory_entities`, which actually has 8 rows, so these stats are partly stale — the code evidence
  below is the load-bearing part, not the counter.)
- [V] Non-test references: exactly one, `db/schema.ts:281`. The promising comment is at
  `schema.ts:275-279` ("When an entity is reclassified, the old type is preserved here").
- [V] No writer, because reclassification does not exist. Every `UPDATE ... entities` in the service
  layer sets something else: `entities.ts:513` `last_seen_at`; `entities.ts:1138` `merged_from` +
  `last_seen_at`; `corpus-ingest.ts:93` `description`/`embedding`/`last_seen_at`;
  `corpus-ingest.ts:226` and `promotion.ts:432/450/476` `embedding`; `promotion.ts:446/461`
  `description`. **None** touches `entity_type`. [V] `grep` for a `set`/`update` on `entityType` across
  `services/` and `pipeline.ts` returns nothing.
- [V] Ironic corroboration at `entities.ts:1134`: "No audit — entities has no history table."

## 4. nmemo-du2 — `/api/reset` + `/api/viz/clear` not a clean slate

**Verdict: PARTIAL** — the AGE half is fixed, the table-list half is now a recorded decision.
Severity: low. Fix size: one-function (derive from a registry) if the decision is revisited.

### Fixed

- [V] `index.ts:1355-1363` adds `clearAgeGraph()`, which runs
  `SELECT * FROM cypher('knowledge_graph', $$ MATCH (n) DETACH DELETE n $$)` inside a try/catch, and
  `clearGraphTables()` (line 1369) calls it. Both `POST /api/viz/clear` (1372) and `POST /api/reset`
  (1380) route through it. Its docstring names this as "Blocker 5 of the single-graph keep list" and
  quotes the same 1,071-vs-4 measurement as the bead.
- [V] It worked: `cognitive` AGE is now **0 nodes** against 4 entities (bead: 1,067 vs 4).

### Not fixed, but no longer drift

- [V] `CLEARABLE_TABLES` (`index.ts:1331-1338`) is still a hand-maintained 17-entry list:
  `reasoning_reports, gardening_reports, same_as_links, extraction_reports, merge_candidates,
  entity_meta, memory_entities, entity_aliases, contradictions, fact_history, causal_edge_history,
  causal_edges, causal_events, causal_patterns, facts, entity_merges, entities`.
- [V] `cognitive_test` has **52** `public` base tables. Still omitted: the 3 `staging_*` tables,
  `arbiter_verdicts`, `edge_source_refs`, `fact_sources`, `fact_units`, `fact_predicates`,
  `source_document`, `fragment`, `bridge_edges`, `bridge_source_refs`, `element_embeddings`,
  `code_elements`, `rule_elements`, `corpus_policies`, `entity_type_history`, `entity_clusters`,
  `entity_topology`, `entity_drift_*`, `graph_stats`, `derived_freshness`, `cross_cluster_runs`,
  `stream_participants`, `capture_idempotency`, `llm_usage`, `notification_cards`,
  `causal_edge_corroborations`, the `*_compute_runs` tables.
- [V] The bead's Phase-A worry came true — `bridge_edges`, `element_embeddings` and friends all
  exist now and none were added. But `index.ts:1321-1330` now carries an explicit docstring: "NOTE,
  hand-maintained and therefore drifting: this list does NOT include `fact_units`, the `staging_*`
  tables, `bridge_edges`, `element_*`, `arbiter_verdicts`, `causal_edge_corroborations`,
  `fact_sources` or `fact_predicates`, so those survive a 'reset'. Widening it changes what a
  destructive endpoint destroys, so it is left alone here deliberately."

[I] So this is no longer a silent-omission bug; it is a recorded choice awaiting a decision. Re-file as
a decision bead ("do reset/clear mean *all* derived state?") rather than a defect. Note `corpus_policies`
in particular: a reset that leaves it behind leaves `recurring_facts = true` set for a corpus whose
facts are gone, and the next load into that `corpus_id` silently inherits temporal identity.

## 5. nmemo-x4s — entity fragmentation is a one-way ratchet

**Verdict: STILL-BROKEN.** Severity: high (it caps what every downstream retrieval measurement can
show). Fix size: needs-design for the identity model; one-line for the case-folding sub-win.

### Reproduced, to the digit

[V] The bead's own metric (rows that are members of a duplicate-name group):

| corpus | entities | dup-member rows | pct |
|---|---|---|---|
| arxiv-nlp | 1,230 | 241 | **19.6%** |
| dal-nlp | 1,133 | 199 | 17.6% |
| arxiv-cv | 1,282 | 189 | 14.7% |
| dal-cv | 1,262 | 179 | 14.2% |
| qbio | 3,670 | 221 | 6.0% |

Exactly the bead's 19.6% for arxiv-nlp. [V] Its example is verbatim: `chatgpt` appears **21x** in
arxiv-nlp under `AI model, ai_system, AI_System, artifact, language model, language_model, Language
Model, Large language model, Large Language Model, LargeLanguageModel, LLM, LLM model, LLM_model,
LLM_Model, model, software, software_model, software_tool, SoftwareTool, system, tool`. Also
`large language models` 16x, `llama` 5x, `few-shot learning` 5x, `gpt-3.5` 5x.

**New, sharper evidence than the bead has:** [V] in *every* research corpus, the number of excess
duplicate rows equals the number of excess rows whose group spans **more than one `entity_type`**
(arxiv-nlp 160/160, dal-nlp 132/132, arxiv-cv 113/113, dal-cv 105/105, qbio 118/118). Not one
same-name/same-type duplicate exists. Fragmentation is **entirely** a consequence of type being part
of identity — which is a stronger statement of the bead's mechanism than the bead makes, and it means
relaxing type is not one candidate fix among several, it is *the* fix.

[V] Type vocabulary, free-text and unbounded: qbio 631 distinct types over 3,670 entities; arxiv-nlp
267; dal-nlp 185; arxiv-cv 135; dal-cv 131.

### The reuse logic today (the bead's `promotion.ts:313` has moved)

[V] Resolution lives in `promotion-plan.ts:418-560` (`resolveEntities`), and it is **richer** than the
bead's "exact-type reuse" description. Per `(normalizeName(name), type)`:

1. anchored proposals inherit `anchorCanonicalId`;
2. exact normalised-name match within the same type;
3. **word-prefix match** either direction within the same type (`isWordPrefix`,
   `promotion-plan.ts:353`): a unique match auto-binds in an `assimilating` corpus; 2 or more matches (or a
   single match in a `comparative` corpus) escalate to the arbiter, whose verdict promotion then
   executes as a real `mergeEntities` call or a `same_as` insert;
4. otherwise fresh, with word-prefix-connected same-type clusters folded into one mint.

[V] So there **is** now a merge disposer on the epoch arm — `promotion.ts:363` calls `mergeEntities`
inside the promotion transaction, single-writer. The bead's "no cleanup path" is too strong.

But it does not touch this failure mode: [V] `priorByType`, the cluster key, and `freshByType` are all
keyed on `e.type` **raw** — no lowercasing, no canonicalisation. So `chatgpt|LLM` and
`chatgpt|SoftwareTool` never enter the same bucket, never word-prefix-match, never escalate, and never
become a merge candidate. And `LLM_model` vs `LLM_Model` fragment purely on capitalisation. [V]
`entity_merges` joined to the target's corpus: 77 rows in `default`, 5 in `_concepts`, **0** in
arxiv-nlp / arxiv-cv / dal-nlp / dal-cv / qbio / `_cronqa`. [V] And all 82 are test fixtures —
`merge_reason` is `Duplicate detected` or `EMC-010 audit-trail integration test`, `merged_by = system`,
all from 2026-07-17/20. The ratchet has never once been released on real data.

[V] `merge_candidates` = 0 and `same_as_links` = 0 in `cognitive_test`, consistent with the bead's
claim that `detectMergeCandidates` is off the epoch path (`pipeline.ts:728` sits in the serial/barrier
arm; `pipeline.ts:1024` and `:1224` both document the removal).

## 6. nmemo-5fa — gardener has no merge/same_as disposer

**Verdict: STILL-BROKEN.** Severity: medium. Fix size: needs-design (it is a surface decision), then
one-function to wire.

- [V] `causal-agent.ts:1645`: `gardener_agent: LEGACY_SURFACE`.
- [V] `LEGACY_SURFACE` (`causal-agent.ts:1588-1592`) = every tool in `GRAPH_TOOLS` **minus**
  `RETIRED_TO_PROMOTION` (`execute_merge`, `create_same_as_link`, `resolve_contradiction`) **minus**
  `ARBITER_VERDICT_TOOLS` (`propose_identity_verdict`, `propose_conflict_resolution`).
- [V] E5 criterion 2 is therefore still honoured, and `test/harness/destructive-tools-dispatch.test.ts`
  exists to enforce it.
- [V] The consequence the bead named is intact and is now *sharper* than the bead states: the disposer
  the bead asked for **has been built** — `promotion.ts:356-380` executes arbiter-decided merges via
  `mergeEntities` and inserts `same_as_links` in canonical (a before b) order, single-writer — but the only
  key into it is a `propose_identity_verdict` verdict, and that tool is arbiter-only. The gardener can
  detect duplicates (it has every read tool) and can `resolve_candidate` (`causal-agent.ts:2620`),
  which only stamps `merge_candidates.status = 'resolved'` and writes no canonical change. Its
  long-range dedup is still a no-op.

The cheapest close is probably to grant `gardener_agent` the `propose_identity_verdict` tool — the
propose/dispose plumbing the bead asked for already exists, so this is a surface decision, not a build.
[I] That is my read, not a doc-41 position; check section 8a.5 before acting, since it frames verdicts as the
arbiter's alone.

## 7. nmemo-wyb — `helix` vs `helix robotics` not merged

**Verdict: PARTIAL.** Severity: low as filed. Fix size: none for the mechanism; one-function to close
properly (write the regression test).

- [V] The mechanism exists and names this bead. `promotion-plan.ts:344-352`: "Word-prefix test: is
  `short` a token-boundary prefix of `long` (or equal)? `helix` is a prefix of `helix robotics` (true);
  `helix` is not a prefix of `helixology` (false). This is the conservative containment rule that merges
  the doc-41 `nmemo-wyb` helix / helix-robotics duplicate without over-merging unrelated names."
  `isWordPrefix(short, long)` returns `short === long || long.startsWith(short + ' ')`. Rule 3 of
  `resolveEntities` binds a unique word-prefix match in an `assimilating` corpus
  (`promotion-plan.ts:496-500`), so `helix` resolves onto `helix robotics` and one `works_at` survives.
  That is the bead's acceptance criterion, implemented.
- [V] The acceptance was never *verified*. `grep -rn helix platform/src` finds the two design comments
  plus `group-supersession.test.ts` and `predicate-canonicalization.test.ts`, which use "helix" only as
  a throwaway entity name for unrelated supersession assertions. There is no test asserting that two
  word-prefix entity proposals collapse to one, and no `Elena Vasquez` case anywhere.
- [V] The data is gone. Neither DB has an `Elena Vasquez`, a `helix robotics`, or any `%vasquez%`
  entity. The epoch/corpus10 run (`runId 2026-06-02T14-16-04-143Z`) is unreproducible; `test-data/`
  holds only `frankenstein.txt` and `lotr.txt`.
- [V] One residual is live and matters: the fix is **type-gated**, so `qbio` today holds
  `helix` as `structure` (b0039605) *and* `helix` as `concept` (99f28320), created 3h20m apart,
  unmerged — plus `collagen triple helix` (`molecular_structure`) and `helix-linker optimization`
  (`technique`). The bead's own shape recurs whenever the proposer picks different types, which is
  nmemo-x4s.

[I] Honest close: mark the mechanism done, cite `isWordPrefix` + rule 3, add one unit test over
`resolveEntities` (it is a pure function — no DB, no LLM) covering `helix` + `helix robotics` at the
same type, and move the residual to nmemo-x4s. Do not close on the harness case; the fixture no longer
exists.

---

## Method notes / caveats

- [V] All DB work via `docker exec -i nmemo-postgres-1 psql -U cognitive -d cognitive_test` (and
  `-d cognitive`), `SELECT` only. No writes, no test runs, no migrations.
- [I] Two claims rest on reasoning rather than execution, because confirming them requires a write:
  that `promote-probe.ts` would pass (nmemo-ygk) and that SC-17 still throws 23505 (nmemo-u70). Both
  follow deterministically from the code and the live index definition, but neither was executed.
- [V] `pg_stat_user_tables.n_live_tup` is unreliable here (reads 0 for `memory_entities`, which has 8
  rows; `pg_stat_database.stats_reset` is NULL). `idx_scan = 0` for `entity_type_history` is therefore
  supporting evidence only — the decisive evidence is the absent code path.
- [V] `platform/src/index.ts` needs `grep -a` (NUL bytes); confirmed, and all `index.ts` line numbers
  above come from `grep -a -n`.
