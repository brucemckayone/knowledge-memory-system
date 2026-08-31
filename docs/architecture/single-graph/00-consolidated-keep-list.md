# Single-graph refinement — consolidated keep list

**Date:** 2026-08-31 · **Branch:** `feat/cross-corpus-audit`
**Direction:** optimise **retrieval and knowledge synthesis on one graph**. Deep refinement; learn what
works and what does not. iOS is out of scope (branch-management pull-over, being stripped). LongMemEval
is parked.

**Why a new tree.** `truth-graph/` and `cross-corpus-audit/` both run a 38–42 series, so "doc 39" has
three candidate files and "doc 42" has two. Beads cite bare `doc 39 §4`. That ambiguity mis-resolved
twice during this survey. New work starts here.

**Basis.** Seven parallel surveys: arc docs 00–19 and 20–38, the truth-graph/token-usage/benchmark
trees, the iOS+MCP surfaces, the arc's 86 source files + migrations 051–057, 559 beads + 53 memories,
and ~155 raw experiment artifacts. Every load-bearing claim below was re-verified by hand against code,
the live DB, or the artifact. Tags: **[M]** measured · **[C]** read off code · **[I]** inferred · **[U]** untested.

---

## 0. The two findings that reframe everything

**0.1 The corpus partition has no production entry point. [C]**
`index.ts:226` — `handleBatch`'s request body type is
`{chunks?, source?, sourceId?, contentType?, concurrency?, stream_id?}`. **No `corpusId`.** It is never
parsed and never forwarded to `ingestBatch`. `corpusId` is settable only by in-process callers, i.e. the
harnesses in `src/test/tools/`. So **every production ingest lands in `corpus_id='default'`**, and the
entire migration-052 partition — plus everything built on it (audit pass, bridges, element catalogs,
concept layer, `corpus_policies`) — is reachable in production only against a single corpus, which is
the one configuration in which it has nothing to do.

Consequence for this direction: **the single graph is already the only graph.** The isolation work is
real in the service layer and inert at the edge. It drops to low priority until multi-graph is actually
wanted, and when it is, the entry point is the first task, not the read-path audit.

**0.2 The fact-vector layer is broken at both ends. [C][M]**
This is the load-bearing retrieval finding.

- **Write end:** `promotion.ts:250` gates fact embedding on `EMBED_DESCRIPTIONS`, which `config.ts:35`
  defaults to `false` and which is set nowhere. So `facts.fact_embedding` is NULL on the epoch path.
- **Read end:** `searchFacts` (`facts.ts:896`) is the **only** reader of `facts.fact_embedding`, and it
  has **zero callers** anywhere in the tree.

So the column is neither written nor read. `config.ts:29-31` states purpose (b) of the flag as "so
epoch-minted edges are visible to vector recall" — pointing at a reader that does not exist. Doc 39 §7's
"the fact-vector keystone already ships" is false on both counts.

---

## 1. BLOCKERS — fix before measuring any retrieval change

Nothing about retrieval quality can be trusted until these close. Each is small.

| # | what | where | why it blocks measurement |
|---|---|---|---|
| 1 | Fact vectors unwritten **and** unread | `promotion.ts:250`, `facts.ts:896` | §0.2. Any "vector recall is weak" result today is measuring an empty index through a function nobody calls. **[C]** |
| 2 | `EMBED_DESCRIPTIONS=false` turns the flag **ON** | `config.ts:35` | `z.coerce.boolean()` applies `Boolean(value)`, and `Boolean("false") === true`. Verified. The only value an operator would type to disable it enables it. It is currently off solely because the variable is unset. **[M]** |
| 3 | Entity descriptions discarded | `promotion-plan.ts:534` (`summary: null`) | The single push site. 92% of staged proposals carry a real summary; all 2,512 canonical entities have `description` NULL. Every entity vector embeds a **bare name**, and `entities.description` is never populated either — so it is not just the vector. This is the one retrieval lever the whole arc kept calling untested, and it was *silently unavailable*. **[C][M]** |
| 4 | `fact_units` never written on the epoch path | only writer is inside `extract()`; `runEpochBatch` never calls it | Graph-anchored fallback retrieval reads `factUnits`, finds none, returns `[]`, and logs `fallback_skipped_no_anchor` — **the wrong diagnosis**, since anchors were found. The one deterministic retrieval booster that exists is fed by a table production never fills, and it fails silently with a misleading message. **[C]** |
| 5 | AGE is desynced, unprunable, and cannot represent expiry | no DELETE trigger; `/api/reset` omits it | Live `cognitive`: **4 entities / 2 facts** in Postgres against ~1,071 AGE nodes / 2,000 edges. Ghosts accumulate monotonically across every reset. Any traversal-ranked retrieval reads phantoms. Use SQL recursion over `public.facts` instead. **[M]** |
| 6 | Migration failures are swallowed; the runner always exits 0 | `db/migrate.ts:43-49` | No journal, not run on boot, no rethrow, then "🏁 All migrations processed" + `exit(0)`. `startup-validation.ts` checks no arc table. **Every DB-level guarantee in this document is conditional on a migration state nothing verifies.** **[C]** |
| 7 | `promote()` hard-fails if migration 055 is absent | `promotion.ts:169` | `getCorpusPolicy` sits in a `Promise.all` with no try/catch. On a DB lagging migrations — the documented normal state — the whole epoch arm dies with `42P01`. `audit-ledger.ts:76` self-ensures precisely to avoid this; the promote path did not. **[C]** |
| 8 | ML timeout silently degrades extraction quality | `ml-client.ts` own-timeout is never retried; `predicate-resolve.ts:156` catches and keeps the raw predicate | A code comment says the case "cannot occur". Five production callers sit on a 60s path while embed/extract get 600s. Recorded only in bead `nmemo-kgy`. **[C]** |

**Bead hygiene, same tier:** `nmemo-yq1` and `nmemo-86z` are the same defect on the same line — close one.

---

## 2. KEEP — the substrate to build retrieval and synthesis on

**2.1 Ingestion and correctness**

| what | where | why |
|---|---|---|
| Epoch propose/promote: agents propose into staging, **one deterministic writer, one transaction** | `pipeline.ts:1001` → `promotion.ts`; migs 040–043 (**inherited**) | Order-independent and replayable **[M]**. The reason every experiment on this branch is reproducible. Keep as the rule: agents propose, code disposes. |
| Pure planner / applier separation | `promotion-plan.ts` ↔ `promotion.ts`; `planBridgePromotion` ↔ `applyBridgePromotion` | Keeps planners DB-free and unit-testable; it is what makes the order-independence litmus possible. |
| `embedForWrite` (throws) vs `embedForQuery` (returns `[]`) | `embed.ts` | The PC8-1 fix for silent NULL-embedding entities. Correct fail-loud contract — and note `concept-extraction.ts:200` violates it. |
| Pure embed-text helpers | `embed-text.ts` | `entityEmbedTextFor` / `factEmbedTextFor`. Sound; both consumers are currently neutered by blockers 1–3. |
| `graph-invariants.ts` — 5 pure, DB-free, LLM-free integrity checks returning offending rows | `graph-invariants.ts:96-316` | Built to catch exactly the cross-predicate sprawl the ontology misses. **26 unit tests green.** Doc 39's specified sixth invariant ("one audit row per mutation") is not implemented. |
| Validity harness: gold-graph P/R, per-step instrumentation, invariants, LLM-judge, reports-review | `graph-correctness.ts`, `graph-review.ts`, `reports-review.ts`, `benchmark-*.ts`; `scripts/compare-ingestion.ts` | **67 unit tests green [M]** — the only correctness instrument the project has. Three cheap fixes make it a gate: commit the input corpora (**no run is currently reproducible** — the golds are committed, the corpora never were), surface `factF1VsGold` in the report, wire one arm to a trigger. Nothing invokes it today; no CI exists. |
| Causal corroboration ledger | mig `051` + `causal.ts:96-107` | The only fully-live arc migration, and the correct idempotency pattern — a two-column ledger, not a single slot. |
| Resumable ingest + session-limit resilience | `ingest-ledger.ts`, `scripts/ingest-resumable.ts`, `session-limit.ts` | Parses the reset time instead of retry-looping. The reason the 294-doc run finished at all. |
| Cost tracking | mig `050`, `usage.ts`, `usage-report.ts` (**inherited**) | Shipped and works — 74/74 tests green. But it has captured **nothing in two months**: newest row is 2026-06-30, because the arc's harnesses bypass the instrumented `agentFetch` path. Wire the harnesses, and add usage echo to `audit_agent.py`. |

**2.2 Retrieval — what the evidence says to build**

| what | status | evidence |
|---|---|---|
| **Hybrid BM25 + vector, with retrieved-set RRF** | Harness built (`recall-hybrid.ts`), production **unbuilt**; bead `nmemo-uhp.18` filed **P2** | The most-supported retrieval change in the project, and four independent results back it, none cited on the bead: token-Jaccard reproduced a "semantic" win exactly; BM25@3 0.880 ≥ embedding 0.838; embedding R@1 39–44% vs **BM25 72%** (prefixes did not rescue it); blind retrieved-set RRF **0.648** vs cosine 0.467, better at every k, k-robust. **Raise to P1.** The 0.648 is filed under a FAIL because it was post-hoc — it deserves a clean pre-registered re-run. **[M]** |
| **SQL recursion over `public.facts`** as the traversal primitive | Built inside `concept-multihop.ts` | The **only expiry-correct traversal path in the codebase** — AGE returns phantoms (blocker 5). Extract the recursive-CTE traversal from the concept experiment and keep it; drop the concept mediation. Fix its `maxPairs = 100_000` default, which warns to stderr only and once hid a run's actual headline by dropping 86.4% of pairs. **[C]** |
| **Tier 0 / 1 / 2 query architecture** | **DESIGNED-ONLY** — `truth-graph/39-natural-language-graph-querying.md`; epic `nmemo-5co`, **0 of 13** built | The design target. Its core reframe is verified sound: no text-to-Cypher — every Cypher skeleton is built in TypeScript with UUID validation, clamped depth/limit and a regex-gated relationship type, so the LLM plans and synthesises but never writes queries. Best idea in it: collapse the three tiers into **one effort-budget dial** (Tier 0 = budget 0). **[C]** |
| Tier 0's **output half already exists** | `GET /api/hero` + `voice-c-composer.ts` (**inherited, being stripped — extract first**) | A fully deterministic LLM-free anchored-subgraph read, and a deterministic prose composer. `nmemo-5co.8` (response shape) and `.11` (Tier 1) have working precedents to copy; `.2` and `.3` (fact-query API, constraint extractor) are the real greenfield. **[C]** |
| **Source-traced synthesis spans** | `voice-c-composer.ts` (~80 lines, zero deps) | Prose composed from parts where each sourced phrase records its UTF-16 offset, plus a guard that throws if multi-sentence output carries no attributions. This is grounded synthesis with provenance and it is the only implementation in the repo. **Extract the pattern before stripping iOS.** |
| Structured fact-query API | **DESIGNED-ONLY** | `getEntityFacts` still hardcodes `NOW()`; `searchFacts` accepts only `{limit, threshold}`; `facts_at_time()` is referenced only from tests. Needs `{asOfStart, asOfEnd, predicate, subjectId, objectEntityType}`. |

**2.3 Agent surface**

| what | where | why |
|---|---|---|
| MCP tool surface + per-actor allowlist | `graph-mcp.ts`, `causal-agent.ts:1468-1606` | Strong **capability** control: derived from a per-tool `mutates` flag so it cannot drift, deny-by-default on unknown actors, enforced at both transports and independent of prompt content. A proposer structurally cannot hold a canonical-write tool. |
| The allowlist audit test | `test/services/actor-tool-allowlist.test.ts:47-118` | Deliberately breaks its own circular oracle — `CANONICAL_WRITES` is a hardcoded literal, *not* derived from `mutates`, so a write tool mislabelled `mutates:false` is caught. Unusually well built; keep the pattern. |
| Actionable MCP errors | `mcp-errors.ts:13-29` | Five SQLSTATEs → recovery instructions. Pure, unit-testable. |
| **Gap:** the allowlist has no **scope** dimension | — | It gates which verbs, never which rows. Only `resolve_anchor` honours the injected corpus. Low priority under single-graph; blocking for multi-graph. |

**2.4 Reusable measurement harnesses (7 of ~33)**

`recall-service.ts` · `audit-recall-smoke.ts` · `audit-adjudicate-smoke.ts` (the **only** end-to-end
exercise of the real `invokeAuditAgent` chain, which has zero unit coverage) · `corpus-graph-ingest.ts`
(the only caller that can create a non-default graph — effectively the missing HTTP route) ·
`multihop-identity-check.ts` (a real reduction invariant — **add the `S.size > 0` guard**, its vacuous
`0 pairs / 0 pairs / PASS` trap is still live) · `extractor-probe.ts` (cheap domain-fitness gate before
ingesting any new corpus) · `sweep-coverage.ts`.

**2.5 The 294-document substrate**

2,512 entities / 5,714 facts across two corpora with **100% attribution [M]**. Available for any future
retrieval question with no new ingest cost, and it doubles as the **name-only control** for a
description-aligned re-run once blocker 3 is fixed.

**2.6 Process**

Pre-register the metric and bar, freeze to git, then a blind adversary reviews before banking. Across
this arc it caught **12–13** over-statements in docs 20–38 alone (doc 39 says six), and today's surveys
found two more of mine. Two of the largest findings were features **reporting success while doing
nothing** — hunt for silent no-ops specifically.

---

## 3. DROP

| what | why |
|---|---|
| **iOS surface** — `hero.ts`, `notifications.ts`, `voice-c-composer.ts`, `routes/hero.ts`, `routes/notifications.ts`, mig `049` | User's call: bad branch management, not of interest. **Extract the span-attribution pattern first (§2.2).** Also: its ASK register (`_research/backend-asks.md`) and `design/03-home.md` are cited in code and absent from all 850 commits, so its spec is lost anyway. 1,458 lines, zero tests. |
| **Concept layer** — mig `057`, `concept-extraction.ts`, `concept-resolution.ts` | Retrieval thesis settled dead across sparse/dense, mechanical/agentic, every oracle. `_concepts` is a **globally shared corpus** — a read-path leak by construction. Mints entities with NULL embedding, violating the `embedForWrite` contract. Its relation vocabulary is unreachable in production anyway (`propose_bridge_edge` hard-rejects `exhibits`/`addresses`). **Keep the recursive-CTE traversal from `concept-multihop.ts`; drop the concept mediation.** |
| **Element catalogs** — mig `053`, `element-catalogs.ts` | Superseded by its own successor: mig 056 widened bridge endpoints to `'entity'` because the v1 linker recalls over the full entity/fact graph. All three tables are **empty in the production path**. `recallByConcept` is default-open on corpus (omit the arg, get every corpus). |
| `bridge_source_refs` + the 5 unwritten anchor columns on `bridge_edges` | Write-only table, no readers. `code_location`, `source_commit`, `source_ast_hash`, `rule_set_hash`, `model_version` are never written by any producer — so a bridge can never say which file it is about. |
| Migration `056`'s kinds half | Dead on arrival: `057` drops and re-adds the identical vocabulary, and the filename sort guarantees 057 runs after. Fold the surviving `ref_type` widening into 054. |
| `doc-attribution.ts` | Self-declared dead in its own first line — `cleanupAbandonedStaging()` GCs the staging rows it reads. |
| ~26 one-shot experiment harnesses | Hardcoded artifact names, frozen corpora, already-adjudicated bars. Archive with the docs; do not maintain. Full list in the arc-source survey. |
| 8 dead `package.json` `benchmark:*` targets | Point at `platform/src/benchmark/`, deleted 2026-04-02. |
| `docs/handoff/**` (13), `docs/work-packets/**` (45), `docs/architecture/{current,v2-design,ml-services-design,multi-source-processing}.md`, `docs/INDEX.md` | Fossils describing the stripped KARMA / pg-boss / Telegram architecture. |

---

## 4. PARK

- **Corpus partition + policy presets** (migs 052/055, `corpus-policy.ts`). Genuinely good machinery — composite FKs, immutability triggers, an 8/8 acceptance suite, and it caught a real breach. But §0.1: no HTTP entry point, `setCorpusPolicy` has no production caller, so `'comparative'` mode and the D5 escalation branch it feeds are unreachable. Revive when multi-graph is wanted; entry point first.
- **`bridge_edges` family** (migs 054/056, `bridge-promotion.ts`). Mandatory `reasoning` + `source_references`, endpoints validated by existence, replay-idempotent corroboration. The only built mechanism for relating two graphs *without* fusing them — and the right primitive if "several graphs per user" returns. Two defects to fix first: its D4 idempotency is a **single slot, not a ledger** (A-bumps, B-bumps, A replays → double count), and `planBridgePromotion` has no self-loop drop.
- **Audit pass** (`audit-pass.ts`, `audit-ledger.ts`, `audit_agent.py`). A cross-corpus product, not single-graph. Its concept leg (`recallConceptCandidates`) is **structurally inert** — always `[]`. `invokeAuditAgent` uses bare `fetch`: no timeout, no usage accounting, one LLM invocation per cell up to `maxCells=2000`. And per doc 15 the intelligence lived in *authoring*, not adjudication — a 12-line regex reproduced 7/7.
- **Predicate machinery** (mig 045 + 6 modules). Architecturally sound: deterministic, model-free, stateless, well-tested. **Do not turn it on** — 3.7% collapse at 0.43 merge precision, and merges are lossy and unrecoverable while over-minting is gardener-recoverable. Root cause is arithmetic: with `cos=1, tov=1, cn=0` the score maxes at 0.85 under a 0.89 threshold, so the weight-0.10 jaro-winkler term is *necessary* for any merge — it is a string-edit matcher with a semantic gate. Fix the weights (`nmemo-4g9`, P0) before the backfill (`nmemo-w2p`, correctly demoted to P2). Also: `recordPredicateUsage` has one caller, inside `createFact`, which the epoch path never calls — so the staging→canonical growth path is **unreachable**, not merely unexercised.
- **`doc 08`'s per-edge assimilate/compare DAG.** The design for many-graphs-per-user, and forward-compatible: flat `corpus_id` stays, add `corpus_relationships` later. Fusion candidates = transitive closure of *assimilate* edges; *compare* edges get bridges. Names its own trap — blending into two independent anchors transitively fuses unrelated graphs, so blend up **one** lineage and bridge to others. **The one thing to preserve for free: keep "fuse" vs "bridge" explicit in the vocabulary.**
- **Graph C / causal layer.** Does not populate at production batch size — `WinError 206`, **9 edges from 147 papers**, silent because non-fatal by design. Zero product consumers. Bead `nmemo-8rm` should be **P0**, and `nmemo-4fd`/`nmemo-9hp` need a hard dependency on it: run today they would measure an empty layer and return a **false negative that reads as a capability verdict**.

---

## 5. Corrections of record

Claims that circulated in this project — several of which I repeated — and what is actually true.

| claim | correction |
|---|---|
| "LongMemEval scored 0.524 accuracy at n=21" | **A dry run.** `run.py` builds 21 stubs and assigns `score = 1.0 if idx % 2 == 0 else 0.0`; 11/21 = 0.5238, and 2/3 = 0.6667 for the abstention figure. The artifact's own field reads `"judge_prompt_version": "dry-run"`, which the dashboard never renders. All five real runs are n=1. `sanity_pass` is structurally unreachable (abstention items start at index 64; runs sample `questions[:N]`). Parked by user decision. **[M]** |
| "Dense embedding is the retrieval engine, including inside its own blind spot" (doc 39 §5.4) | **Backwards.** Inside the band, JOIN ≈ embedding ≈ **random** — embedding is genuinely disabled there. The finding is that *nothing* works in the blind spot, and adding the concept leg via RRF does not help. **[M]** |
| "STRUCT lost at L=3" (doc 39 §5.3) | **A tie.** `ci_p5_struct_minus_text = [-0.225, +0.0125]`, spans zero, n=16. Verified. **[M]** |
| "doc 33 failed" (doc 39 §5.1 lumps it into the negative) | **Both its frozen bars were MET** at the `FRAGILE_DOMINANCE` grade. Undisclosed: the dominance window is only ~24 cells wide — cosine overtakes arm C just above C's budget. |
| "Density adds hub-noise; dense AUC 0.579 < sparse 0.596" (doc 32) | **Both cut.** The AUC delta CI is `[-0.064, +0.030]` — a tie. The pre-registered hub diagnostic was never run; run now, **dense beats sparse at every exclusion level** — sparse is the more hub-dependent arm. The "both-populated" neutralisation compares different populations; on the matched set it is **9.23% vs 9.23%**, an exact tie. The *verdict* (density does not lift the hard-slice ceiling to 25%) survives. |
| "This arc records six over-statements" (doc 39 §8) | **12–13** in docs 20–38 alone, and since doc 24 the **majority have been pessimistic**-direction. |
| "The predicate ontology is domain-locked to personal memory" (`nmemo-ecn` title, P0) | Refuted twice, once by direct measurement. It is arithmetic: seed type pairs are `person/*`, so `type_pair_overlap` caps at 0.5 and **0 of 3,963 keys could reach even "ambiguous"** against a seed. Retitle; the surviving content is a measurement, not a fix. |
| "Entity-type fragmentation is upstream of the predicate fold" (mine, doc 41 first draft) | **Cut.** 1,551 of 2,241 scored keys (69.2%) already had a `tov=1.0` candidate available and only 88 merged. The type gate was open. |
| "`inverse_predicate` is inert" (doc 01, PC-7, and a memory file) | **Live** — read and written across the predicate path. Corrected in `pc8-readiness-audit.md` PC8-5; doc 01 was never amended. Note `nmemo-4g9`: live code, dead effect — only 2 of 2,240 corpus predicates are within the guard's reach. |
| "Concepts beat prose by 0.778" (doc 11) | Stale — use doc 12's **0.681**; the win was largely lexical and tokenizer-sensitive. |
| "The multi-hop arms tested 1 and 2 hops" | `hops` is **per-side**. "M2 = 2 hops" contains ~432k pairs (58.6%) at total path length **3–4**. Any depth conclusion inherited from doc 37 needs re-reading. |
| "214 commits of cross-corpus work" (my doc 42, first draft) | The arc is **140 commits from `4d3c0b8` (2026-06-30)**. Migrations 037–050 — epoch-v2, predicates, iOS, cost tracking — are **inherited**, not arc-owned. CLAUDE.md names the wrong base branch, which is what caused the error. |

---

## 6. Suggested order

1. **Blockers 1–3** (fact vectors both ends, the `z.coerce.boolean` bug, entity descriptions). Small, and until they land every retrieval measurement is of an empty index.
2. **Blockers 6–7** (migration runner honesty, `promote()`'s hard dependency). Cheap, and everything else's guarantees rest on them.
3. **Re-measure the description-aligned retrieval lever** on the 294-doc substrate, using the existing name-only graph as the control. This is the one retrieval lever never tested, and §0.2/blocker 3 explain why.
4. **Blockers 4–5** (`fact_units` on the promote path; AGE prune-or-retire). Then graph-anchored retrieval can be measured at all.
5. **Build hybrid BM25 + retrieved-set RRF** with a pre-registered bar. Best-supported change available.
6. **`nmemo-5co.1`** — measure `/api/reason/query` latency. The whole tiered design is motivated by latency and none of it is quantified. Then `.2`/`.3` (fact-query API, constraint extractor) as the real greenfield.
7. **Predicate scorer recalibration** (`nmemo-4g9`) before any predicate backfill.
8. Fix CLAUDE.md's base-branch claim, and note the doc-numbering collision.

**One caution for the refinement work.** `expandFromAnchors` is a round-trip storm: per anchor, one
fresh AGE walk *per depth level* (re-issued at depth 1 then 2 purely to recover each neighbour's hop),
then one `getEntityFacts` SQL query per reachable entity per anchor. At defaults that is 10 Cypher walks
plus O(anchors × reachable) sequential round-trips. The hop-recovery re-walk is pure waste — one walk
returning depth removes half the Cypher calls.

---

## 7. Graph C — why parallel/batched ingestion emptied the causal layer

Raised as a concern, and it is provably the mechanism rather than a correlation. Three distinct
batching-induced failures, in descending severity.

### 7.1 The batch size overflows the command line, and the failure is silent [C][M]

The chain, each step verified:

1. Batched ingest at `batch=10` produces an epoch scope of ~195 facts.
2. `causal-pass.ts` builds the settled delta scope and pushes it to `/causal-agent` as an **HTTP JSON
   body** (`causal-agent.ts:3937-3942`). Fine — no limit here.
3. `causal_agent.py:83` `_build_causal_prompt(scope)` renders **every scope event, predicate and source
   text into one prompt string**.
4. `ml-services/app/core/llm.py:349-350`:
   ```python
   cmd = [
       "claude", "-p", prompt,
   ```
   The user prompt is passed **as an argv element**. Windows `CreateProcess` caps the command line at
   32,767 characters.
5. Every batch of the 294-document run logged
   `Causal agent failed: [WinError 206] The filename or extension is too long`.
6. The causal pass is **non-fatal by design**, so the epoch reported success and the layer stayed empty.
   **147 papers produced 9 causal edges.**

**The fix already exists fourteen lines below the bug.** `llm.py:363-364` reads:

```python
# System prompt (replaces default Claude Code prompt entirely)
# Use --system-prompt-file for long prompts to avoid CLI length limits
```

The codebase already knows about CLI length limits and already solved it — for the *system* prompt, via
`--system-prompt-file`. The *user* prompt never got the same treatment. Write the rendered prompt to a
temp file (or pass it on stdin) and this failure disappears. It is a one-line class of change and it
unblocks the entire causal layer.

**This is a batch-size-dependent bug, which is why it never showed up in development.** At `batch=1` the
scope is small enough to fit; at production batch sizes it never fits. Single-document tests pass, every
real run fails, and nothing surfaces because the failure is swallowed. Same defect class as the inert
predicate fold: a feature reporting success while doing nothing.

### 7.2 Delta scoping makes cross-batch causality structurally invisible [C]

Independent of 7.1, and it survives fixing it.

The causal pass is **delta-scoped per epoch** (`causal-pass.ts:2`, `:97-105`): it sees the epoch's newly
minted events plus the touched entities' causal neighbourhood, then hard-caps the total at
`CAUSAL_PASS_SCOPE_CAP`, default **200** (`config.ts:126`), truncating with a warning
(`causal-pass.ts:156-165` — at least this one is not silent).

So with `batch=10`, a cause ingested in batch 1 and its effect in batch 5 are **never in the same
scope**. The neighbourhood lookup is the only bridge, and it is capped. Worse, per bead `nmemo-an9`
**there is no global causal re-sweep any more** — Phase-4 replaced it, and the ghost-filling path lost
its only caller. Nothing ever revisits the graph to find the links the per-epoch windows could not see.

The larger the batch and the more parallel the ingest, the more causal structure falls between windows.
That is a design consequence of batching, not a bug, and it needs an explicit answer: either a
periodic global sweep, or a scope that follows causal-candidate entities rather than epoch boundaries.

### 7.3 Replay under parallel promotion inflated corroboration counts [M]

Already fixed, and worth recording because it is the one place this hazard was caught properly. PC-3 was
**elevated to a Blocker** specifically because Phase-A clones perform corroborate-or-insert: on epoch
replay a causal edge's `corroboration_count` inflated, and **the test only checked the row set, not the
counts**. Migration `051_causal_corroboration_idempotency.sql` fixed it with a two-column ledger
(`edge_id`, `corroboration_key`) rather than a single slot, and it is the only fully-live arc migration.

Note the contrast worth carrying forward: the **bridge** path kept the weaker single-slot form
(`bridge-promotion.ts:477-487`) while citing 051 as its precedent, so A-bumps, B-bumps, A-replays
double-counts there. Same hazard, fixed in one place and not the other.

### 7.4 Other causal defects found in this survey

- **`causal_events.corpus_id` is never written.** `mintCausalEvent` (`causal.ts:192-208`) omits it from
  the insert; all three call sites pass params with no such field. Migration 052 gave the table a column,
  an index, *and* an immutability trigger — all guarding a column no code sets. **[C]**
- **`event_embedding` and `pattern_embedding` are dead columns carrying live HNSW indexes** — never
  written, never read, so every causal insert pays write amplification for nothing. The
  `schema.ts` comment claiming they are "handled directly via SQL" is stale; no such SQL exists. **[C]**
- **The Graph C reality check has never been written.** `docs/benchmarks/plan.md:221` specifies it — does
  the causal layer lift over a no-memory baseline — and `landscape.md:275` calls it the test of whether
  Graph C is "performance theatre". No code, no result. **[C]**
- **The two Graph-C benchmark beads would currently produce a false negative.** `nmemo-4fd` (Corr2Cause)
  and `nmemo-9hp` (CLadder) exist to answer exactly that question, and neither has a dependency edge to
  `nmemo-8rm`. Run today they measure 9 edges and return a null that reads as a capability verdict.

### 7.5 What this means for the plan

Graph C has **never been evaluated on a populated graph**. Every impression of it — including any sense
that it underperforms — is an impression of a layer that was empty for mechanical reasons. So:

1. **Fix 7.1 first** (prompt via file or stdin). One line, unblocks everything.
2. **Re-ingest a corpus and confirm the layer actually populates** before forming any view of its value.
   Expect a real number, not 9.
3. **Then decide the 7.2 scoping question** — periodic global sweep, or candidate-following scope.
4. **Only then** run the Corr2Cause / CLadder checks, with a hard dependency on 8rm, and write the
   `plan.md:221` no-memory-baseline comparison that decides whether the layer earns its complexity.
5. Drop the two dead embedding columns and their indexes; set `causal_events.corpus_id` or drop the
   trigger and index guarding it.

Sequencing note: 7.1 and 7.2 are both prerequisites to *measuring* Graph C, and they sit alongside §1's
retrieval blockers rather than behind them — the causal layer is the other half of "knowledge synthesis"
and it is blocked by a bug of the same kind.
