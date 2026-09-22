# Bead triage 2026-09-22 — CONSOLIDATED verdicts and proposed actions

**Scope set by the user:** retrieval optimisation + Graph C only; get the codebase tight and secure.
Cross-corpus (`nmemo-uhp` tree, 6 beads) CLOSED as dropped. Benchmarks (`nmemo-bki` tree, 4 beads)
DEFERRED/parked.

Every verdict below was verified against live code and the live `cognitive_test` DB by one of five
read-only agents, and the load-bearing claims were independently re-checked by the main session.
Per-cluster detail: `2026-09-22-{isolation,graphc,provenance,stale,reliability,asf-u8j-5co}.md`.

**Headline: 4 beads were already FIXED, 3 have a dead premise, 15 need re-scoping because the bead text
is materially wrong, 9 stand as filed, and 12 genuinely new findings surfaced.** The tracker was
substantially out of date — but not in the direction I guessed. Most of my own stale-guesses were
wrong, and the real problems were under-described rather than over-described.

---

## 1. CLOSE — verified already fixed (4)

| bead | evidence |
|---|---|
| `nmemo-cki` | `entities.ts:258` now has `eq(entities.corpusId, corpusId)` plus a corpus-keyed advisory lock; landed `029f653`. Re-verified by the main session. |
| `nmemo-hxg` | AGE retired (`ca60276`); `graph.ts` has zero `catch`, zero empty-array swallows, zero `cypher(`; `findConnectedEntities` delegates to the recursive-CTE `traverseFromEntities`. |
| `nmemo-xt1` | `cleanFixtureEntities()` runs in `beforeEach` and `afterAll`, deleting in FK order; live DB has 0 leaked fixture entities. |
| `nmemo-zro` | Both live LongMemEval harnesses are header-documented "Deterministic + Claude-free"; no `claude -p` reference remains. Premise gone. |

## 2. CLOSE — premise dead or decided against (3)

| bead | evidence |
|---|---|
| `nmemo-w2p` | Predicate fold measured at 3.7% against a 60% bar, merge precision 0.43; CLAUDE.md records the fold stays OFF. **Spawn a follow-up** for the booby trap — see NEW-6. |
| `nmemo-5co.13` | `causal_patterns` = 0 rows, and re-running detection would still yield 0: max template-cluster size **1** across all 142 two-hop chains against `instanceThreshold=3`. |
| `nmemo-5co.4` | There is no `predicates` table. `fact_predicates` = **48 rows with no embedding column**, against roughly 1,074 distinct predicates per corpus. Nothing to vectorise into. |

## 3. RE-SCOPE — still real, but the bead text is materially wrong (15)

| bead | what is actually true |
|---|---|
| `nmemo-ecn` (P0) | Number is **bit-exact** (68.7%: 2,240 distinct / 1,539 hapax / 5,714 facts) and **generalises** — qbio 74.5%, arxiv-nlp 70.4%, dal-cv 70.1%, dal-nlp 70.0%, arxiv-cv 67.2% — while the `_cronqa` non-LLM control is **8.9%**, localising the defect to the LLM extraction path. **But "domain-LOCKED" is the wrong diagnosis**: `facts.predicate` is a bare `varchar(255)` with **0** FK/CHECK constraints, and only **162 of 17,846 (0.91%)** research facts use a registry predicate. The sprawl comes from the ABSENCE of a gate, not a narrow one. Retitle. Fix = write-path gate + `corpus_id` on the catalogue + repair `recordPredicateUsage`, whose only caller is `createFact` (which the epoch path bypasses, hence `usage_count` sums to 0). |
| `nmemo-m8d` | **The specified fix is impossible.** Staged confidence averages 0.933 with only **11 of 3,149** rows below 0.8 — there is no signal to threshold. Needs rewriting, not implementing. |
| `nmemo-4h3` | **27** unscoped readers, not roughly 39 — because only **9 of 52** public tables carry a `corpus_id` column at all. Reframe as a schema gap plus a scoped-read helper, not "add a predicate in 39 places". `graph-canonical-semantic.ts` was listed in error (it does no DB access). |
| `nmemo-7ra` | **Premise survives** — `recallViaGraph` is live, gated on `flatRetrievalFailed` in `POST /api/reason/query`. Blocked by the provenance substrate (`source_memory_id` NULL on 343,018 of 343,018 rows; `fact_units` 0 rows), not stale. Re-scope onto provenance. |
| `nmemo-an9` | Half **stale**: `find_causal_ghosts` has a live caller on the `reasoning-patrol` cron. Half **stands**: ghost-filling *as an action* is impossible by construction — `create_causal_edge` was removed from `GRAPH_TOOLS`, and `propose_causal_edge` throws for `reasoning_agent` because no `epochId` is passed. Reword. |
| `nmemo-eue` | **Not completed by docs 42/43** — those are Claude-free, retrieval-only, and explicitly exclude abstention, the one required criterion. Park by user decision; do NOT close as done. See NEW-6 for the fake number. |
| `nmemo-x8b` | Indexes exist (`idx_causal_events_embedding`, `idx_causal_patterns_embedding`) but are **16 kB empty metapages** — pgvector skips NULL vectors, so there is essentially **no write-amplification**. Downgrade to cosmetic. Resolve jointly with `5co.13`: x8b wants the column dropped, 5co.13 wanted it wired. |
| `nmemo-umf` | Delta-scoping is real and the cap **is saturated** (median batch 194 against `CAUSAL_PASS_SCOPE_CAP`=200; 39 of 93 batches exceed it, holding 50.7% of events). Cross-batch edges: 15 co-scoped, **0 non-co-scoped**. **But causation of doc 44's thinness is NOT established** — the graph is 86% one-hop even *within* single batches, where scoping is not a constraint, and the co-scope class is confounded with genuine causal relatedness. Re-scope to the two one-line fixes (NEW-7) plus an honest design question. |
| `nmemo-u70` | Mig 060 replaced the index; temporal corpora get identity `(s,p,o,valid_at)` and it works live. **The live part is the omission**: the merge-dedup co-evolution the bead demanded was never done — see NEW-2. |
| `nmemo-du2` | AGE half **FIXED** (`clearAgeGraph()` runs on both endpoints; `cognitive` AGE is now 0 nodes). The staging/audit half is now a *documented deliberate decision*, not silent drift. |
| `nmemo-wyb` | Mechanism built and attributed (`isWordPrefix`, `promotion-plan.ts:344-352`), but no test encodes the acceptance, the fixture is gone from both DBs, and the fix is type-gated — live qbio still holds `helix`(structure) and `helix`(concept) unmerged. |
| `nmemo-1tc` | Driver half **FIXED** (`compare-ingestion.ts:447-462` drains the dispatcher and cites the bead). The ml-services stability half is unverifiable with :8000 down. **Split it.** |
| `nmemo-p0t` | Items 1 and 3 **FIXED** by `2df6416`; item 2 **re-drifted exactly as the bead predicted** (`EXPECTED_WRITE_TOOLS` 22 against `GRAPH_TOOLS.filter(mutates)` 23 — `propose_bridge_edge` missing). Apply the bead's own advice and delete the duplicate guard. |
| `nmemo-xhn` | **STILL-BROKEN but latent** — 8 strings / 110 facts reproduced exactly, though the true blast radius in that run was 14, not 110. It is the **gate** on `w2p`, so not closable. Relabel or merge into `w2p`. |
| `nmemo-w6o` + `nmemo-0o6` | Both **STILL-BROKEN**, and they compound: the multi-hop correctness anchor runs on the unsafe 100k default (true size roughly 137,922 pairs) AND prints PASS on two empty sets. **Merge into one item.** |

## 4. KEEP as filed — verified still broken (9)

`nmemo-81k` (verified verbatim: the `handleBatch` body type has no `corpusId`, and no ingest route accepts one) ·
`nmemo-mdc` (live Qdrant payload is `char_start`/`char_end`/`parent_window_id`/`point_type`/`stream_id`/`unit_text` —
**no corpus key** — across 20,395 points from every corpus; the largest real leak risk) ·
`nmemo-bju` (`causal-agent.ts:2039-2042` drops `corpusId`; the sibling at `:2007-2012` passes it) ·
`nmemo-ghc` · `nmemo-l8d` (3 of 3 dangling fact refs flagged, 1 of 1 dangling entity ref unflagged) ·
`nmemo-r51` (0 rows, all three indexes `idx_scan=0`) · `nmemo-5fa` (`LEGACY_SURFACE` excludes the merge tools) ·
`nmemo-x4s` · `nmemo-kgy` · `nmemo-gnt` (the silent-fallback half is **Python-only**; the TS side does reject unknowns) ·
`nmemo-3aq` (the fast path is in `resolve_predicate.py:119`, not the TS function the bead names) ·
`nmemo-jcj` (**materially worse**: 43 colliding numbers across 4 trees; "doc 23" has 8 candidates; docs 44-47 added to it).

### `nmemo-x4s` — the cause is now pinned exactly
Excess duplicate rows against excess rows in multi-type name-groups: **160/160, 132/132, 118/118,
113/113, 105/105**, and **zero** same-name/same-type duplicate groups anywhere. `entity_type` being part
of identity is the **entire** cause, which makes relaxing type **the** fix rather than one option among
several. `asf.11`'s examples verified exactly (`chatgpt` = 21 rows / 21 types; `large language models` =
16/16); its "26-37% of facts" figure is **overstated** — the true range is **8.2% to 37.1%**,
corpus-dependent.

## 5. NEW findings that warrant beads (12)

| # | finding | size |
|---|---|---|
| 1 | **`get_neighbourhood_profile` is unscoped** (`causal-agent.ts:2918`, registered `:859`) — seven reads in one `Promise.all` with `context.corpusId` passed to none, while nine sibling handlers do pass it. `bju`'s proposed probe fix would miss this because it is a graph tool, not a causal one. | one-function |
| 2 | **`mergeEntities` did not co-evolve with mig 060 — latent data loss.** `entities.ts:806-812` partitions the pre-re-point dedup without `valid_at` or a `temporal_corpus` branch, while the live index keys temporal rows on `valid_at`. A merge in a `recurring_facts` corpus would expire every recurring window but one. | one-function |
| 3 | **The epoch path does not honour temporal mode** — `promotion.ts:505-521` inserts with no `temporalCorpus`, so a promoted fact in a `recurring_facts` corpus lands `false` and collapses to single-active-truth. | one-line |
| 4 | **`entity_type` is not case-normalised** — `LLM_model` against `LLM_Model`, `Category` against `category`, treated as distinct identity components. Collision groups: arxiv-nlp 39, qbio 14, dal-nlp 12, arxiv-cv 8, dal-cv 3. A cheap down-payment on `x4s` that does not need the full identity decision. | one-line |
| 5 | **ROOT CAUSE behind three beads: the 48-row catalogue gap.** `causal_events` carries **6,652 distinct predicates** against 48 catalogue rows, so only **162 of 17,847 (0.9%)** resolve a `predicate_category`. This silently disables pattern detection, makes `findCausalGhosts` return empty for every entity, and kills the Tier-2 story. It is currently filed as symptoms across `an9`, `x8b` and `5co.13`. | needs-design |
| 6 | **RECORD INTEGRITY.** `docs/benchmarks/results/longmemeval.md:11` renders `overall_accuracy=0.524, sanity_pass=True, n=21, correct=11` with **no dry-run marker**, but `run.py:145` is `score = 1.0 if idx % 2 == 0 else 0.0` with `judge_prompt_version="dry-run"` — a synthetic number presented as a measurement. Separately, `39-known-truths.md:48` still instructs readers to run `backfill-predicate-embeddings.ts`; following our own doc enables a fold measured at 0.43 merge precision, and **no flag prevents it** (`promotion.ts:714` calls the fold unconditionally). | docs + one-line guard |
| 7 | **Two one-line causal-pass fixes**, independent of `umf`'s design question: `causal-pass.ts:157-160` slices `newEvents` first, so the neighbourhood — the only cross-batch bridge — is dropped entirely when a batch mints 200 or more events (39 of 93 batches); and `:172` passes `neighbourhoodEdges` unsliced while their endpoint events are dropped, showing the agent edges that point at events it cannot see. | 2 x one-line |
| 8 | `corpus_policies` is not in `CLEARABLE_TABLES`, so a reset leaves `recurring_facts=true` behind and the next load into that `corpus_id` silently inherits temporal identity. | one-line |
| 9 | **The `cognitive` DB was never migrated** — it still carries the pre-060 four-column `uniq_facts_active_triple`, so anyone reproducing temporal behaviour there gets the old semantics. | migration run |
| 10 | Stale build artifacts on disk: `platform/.causal-mcp-config.json`, `platform/dist/services/causal-mcp.{js,js.map,d.ts,d.ts.map}`, `platform/dist/test/harness/causal-mcp.test.*`, and a worktree copy of the deleted test. `services/causal-mcp.ts` was deliberately deleted in `99c435e`. Also `corpus-ingest.ts:8-11` still justifies its own existence with the now-false claim that createEntity dedups globally. | delete |
| 11 | `corpus_id='default'` holds **246 rows** of pure test-fixture debris in the live `cognitive_test` DB. | cleanup |
| 12 | **The topology feature is half-dead**: `topology_compute_runs`=1, `topology_bridges`=12, **`entity_topology`=0 rows**, and nothing in the retrieval path reads it. This also kills `5co.7` ("promote pagerank to PPR") — there is no pagerank to promote. | delete or build |

## 6. Recommended sequencing

1. **Ship `nmemo-v3g`** — the one demonstrated retrieval win (doc 46), gated only on its unrun adversary.
2. **Record integrity (NEW-6)** — cheapest item here, and it stops a fake number and a dangerous
   instruction from propagating further.
3. **The isolation cluster** — `mdc` (real leak risk), then `4h3` (needs the schema decision first),
   then `81k`, then `bju` plus NEW-1.
4. **`x4s` / `asf.11`** — now that type is proven the sole cause, relax type and then backfill-merge;
   NEW-4 is the cheap down-payment. This is also a plausible retrieval lever, since fragmentation
   starves the fact-side signal the doc-46 fusion depends on — though that link is inference, not
   measured, and a merge-then-remeasure would test it.
5. **Graph C** — NEW-5 (the catalogue root cause), then NEW-7's two one-liners, then re-scope `umf`.
6. **Hygiene** — NEW-10, NEW-11, NEW-12, and `jcj`.
