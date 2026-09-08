# 39 — Temporal fact model: recurring truth + as-of-validity reads (I3 substrate gap)

**Status: DESIGN / not built. 2026-09-04.** A grounded plan, no code. Every claim below was verified
against the code this session (line refs in §2); §7 lists what is still owed before a build.

## 1. Why this doc

Wiring the I3 (temporal / as-of-state) benchmark surfaced a real substrate gap before any harness code
was written. Loading CronQuestions (the committed I3 benchmark, doc 34) means loading a temporal KG whose
facts recur: the *same* subject-predicate-object is true across several disjoint year-spans (an athlete
rejoining a club; an award won in many separate years). Measured on the CronQuestions KG: **328,635 rows
but only 284,892 distinct (s,p,o) triples** — ~43,700 rows (13%) are extra validity windows on **22,343
triples** (one triple has 70 windows). Distinct full 5-column rows (327,353) ≈ total, so these are
genuinely different time spans, not duplicate rows.

Doc 34 recorded I3's substrate as "HAVE — facts are already bi-temporal, never evaluated." That is half
right: the `valid_at`/`invalid_at` **fields** exist, but the fact **identity + read model** assume a
single current truth per statement and cannot represent or answer recurring truth. This doc is the plan to
close that gap. It is Phase-4 I3 substrate work (doc 32 §Phase 4: "temporal → evaluate the existing
bi-temporal substrate"). It is **also a general capability + MCP-surface gap** (§6), independent of the
benchmark.

**Scope boundary (says what this is NOT):** the limit is narrow. An entity may have any number of facts
and relationships; different objects or predicates never collide. The gap is *only* the identical
subject+predicate+object recurring over time (A → B → A returning to A). A → B → C never breaks.

## 2. What we verified (the current model, with evidence)

Two clocks, standard bi-temporal:

- **Validity time** — `valid_at` / `invalid_at`: when the fact was true *in reality*. `invalidateFact`
  sets `invalid_at` (`facts.ts:710`).
- **Transaction time** — `created_at` / `expired_at`: when the system *held* it as the active assertion.
  `expireFact` sets `expired_at = NOW()` (`facts.ts:615-617`); supersession uses it (below).

| Fact | Evidence |
|---|---|
| ≤1 **active** fact per identical (s,p,o) | `uniq_facts_active_triple` UNIQUE (subject, predicate, COALESCE(object_entity_id,…), COALESCE(object_value,'')) WHERE `expired_at IS NULL` — mig `037_fact_triple_unique.sql:31`. No `valid_at` in the key. |
| Recurrence collapses two ways | (a) **Exclusive-group supersession** expires all-but-latest-valid via `expireFact` (`facts.ts:315-358`). (b) **Non-exclusive dedup fast path** — `findActiveTriple` keys on (s,p,o) only and *corroborates* (merges) a re-assertion instead of inserting (`facts.ts:172-236`), so a second same-object stint is silently absorbed. |
| Every read is "true **now**" | Traversal `LIVE_FACT = expired_at IS NULL AND (invalid_at IS NULL OR invalid_at > NOW())` (`graph.ts:83`); `searchFactsByVector` same filter (`facts.ts:981-982`); `get_entity_current_facts` same (`001_consolidated.sql:319-320`). None take an as-of date. |
| An as-of query exists at the DB layer but is unusable here | `facts_at_time(query_time)` (`001_consolidated.sql:300-310`) ties the as-of instant to **both** clocks: `created_at <= query_time AND (expired_at IS NULL OR expired_at > query_time) AND valid_at <= query_time AND (invalid_at IS NULL OR invalid_at > query_time)`. For a KG loaded in 2026, `created_at <= 2007` is false → it returns nothing for historical years. It answers "what did we *know in* 2007," not "what was *true in* 2007 as we know today." |
| It is orphaned | `facts_at_time` is called by **no** app code — only tests (`performance.bench.ts:130`, test plans/integration). No MCP tool exposes it. |
| No MCP as-of read | 40+ graph tools; `query_entity_facts` is "all **active** facts" (`causal-agent.ts:98-101`); `create_fact` captures `valid_at` on write (`:401`) but nothing reads by it; `get_fact_history` is the change-log, not an as-of query. |
| The uniqueness index is load-bearing | Relied on by the dedup fast path + P1 race recovery (`facts.ts:172,304-309`), the racing-INSERT note (`pipeline.ts:1166`), epoch promotion corroboration (`promotion-plan.ts:175`), entity-merge fact repoint (`entities.ts:779,879`), the actionable-error surface (`mcp-errors.ts:17`). |

## 3. The gap, precisely

1. **Storage.** Two live (`expired_at IS NULL`) rows with identical (s,p,o) are forbidden. To store N
   recurring windows, N−1 must carry a non-null `expired_at` — i.e. be marked "no longer held," which is
   *false* for a window that was genuinely true of its span.
2. **Read.** The correct "what was true in year Y per today's knowledge" query is validity-only:
   `valid_at <= Y AND (invalid_at IS NULL OR invalid_at > Y) AND expired_at IS NULL`
   (the canonical predicate in `test/plans/temporal-boundary-precision.md:16`). It requires `expired_at IS
   NULL` — so any window we expired to satisfy the index (item 1) is invisible to it. Net: only one of the
   recurring windows is answerable. **True → untrue → true is not faithfully answerable today.**
3. **The extraction tension (why we can't just drop the constraint).** Single-active-truth is *correct*
   for the extraction use case — a person's current employer should have one value, and a new one should
   supersede the old. The same rule is *wrong* for a pre-built temporal KG where recurrence is data, not a
   correction. Any fix must keep extraction's behaviour intact.

## 4. Design options

### Storage / identity
- **S1 — Add `valid_at` to the identity.** Change `uniq_facts_active_triple` to key on (s, p, o,
  valid_at); teach `findActiveTriple` the same. Recurring windows coexist as live. **Cost/blast radius:**
  changes extraction dedup (two "works at Google" mentions with different `valid_at` become two rows, not
  one corroboration), the P1 race recovery, epoch promotion corroboration, and merge fact-repoint (§2 last
  row). Global behaviour change; must re-verify supersession still expires the prior employer (it keys on
  validity-overlap in `find_superseding_facts`, `001_consolidated.sql:326-337`, so likely yes — verify).
- **S2 — Per-corpus temporal policy.** Keep the global single-active-truth model; let a corpus opt into a
  "temporal-KG" mode where recurrence is allowed (a partial index that exempts flagged corpora, or a
  corpus-scoped identity that includes `valid_at`). Extraction corpora are untouched. **Cost:** more
  machinery + a policy flag; but the blast radius is contained to temporal corpora. Cleanest separation of
  the two use cases.
- **S3 — Validity-interval column.** One fact row carries a set of [start,end] intervals for a recurring
  statement. Truest model of "recurs." **Cost:** largest — new column + read rewrite; breaks the "one row =
  one assertion" audit/provenance model (fact_history, fact_sources, causal mirror all assume one row per
  assertion). Not recommended now.

### Read / as-of
- **R1 — A proper as-of-validity read.** New query (and a fixed/renamed `facts_at_time`) that pins
  transaction time to NOW and filters validity only: `valid_at <= Y AND (invalid_at IS NULL OR invalid_at
  > Y) AND expired_at IS NULL`. Needs S1 or S2 so the recurring slices are live. This is the honest target.
- **R2 — History-scanning as-of (no storage change).** An as-of read that scans *all* rows including
  expired, picks per (s,p,o) the window containing Y, ignoring `expired_at`. Works even while older slices
  stay expired — so it needs no index change. **Cost:** semantically muddy (`expired_at` no longer means
  "not visible to reads"); must define tie-breaks when windows overlap; and the vector/traversal reads
  would each need the variant. A pragmatic bridge, not the clean model.

## 5. Recommendation — DECIDED 2026-09-07: S2 + R1 + MCP tool

**Chosen direction: S2 (per-corpus temporal mode) + R1 (as-of-validity read) + the MCP tool (§6).**
The user picked S2 over S1/R2 to keep the shipped single-active-truth extraction pipeline untouched and
contain the change to temporal-KG corpora. Original rationale retained below.

**S2 + R1 + the MCP tool (§6).** Rationale: the extraction single-active-truth model is correct and
load-bearing across five call sites (§2) — disturbing it globally (S1) risks regressions in the shipped
pipeline for a benchmark-driven need. A per-corpus temporal policy contains the change to temporal-KG
corpora, lets CronQuestions load faithfully, and gives a clean as-of-validity read (R1) that is the real
I3 capability. If S2's machinery proves heavier than its worth, **S1 is the simpler fallback** — but only
after measuring the extraction-dedup impact (§7). R2 is the escape hatch if we need a number without any
schema change (e.g. to unblock the flat baseline).

This also cleanly separates the two remaining tracks: the **time-blind flat baseline** (bead `.7`) needs
none of this — it retrieves the answer entity ignoring time — so `.7` can still proceed independently; the
**temporal lift** (this doc → `.8`) is where S2/R1/MCP land and must beat that baseline on the temporal
question buckets.

## 5.1 S2 concrete mechanism (grounded 2026-09-07)

- **Home for the flag:** `public.corpus_policies` already exists (mig `055_corpus_policies.sql`:
  `corpus_id PK, mode assimilating|comparative`). The temporal axis is orthogonal to the fuse-stance
  `mode`, so add a **new column** (e.g. `recurring_facts BOOLEAN NOT NULL DEFAULT false`), not a new `mode`
  value. `default` and every extraction corpus stay `false` → unchanged.
- **Making uniqueness corpus-conditional** (a partial index cannot join another table): denormalize the
  flag onto `facts` (a `temporal_corpus BOOLEAN` stamped at insert from the corpus policy), then split
  `uniq_facts_active_triple` into two partial indexes:
  - non-temporal (unchanged identity): `... WHERE expired_at IS NULL AND temporal_corpus = false`
    (byte-identical to today for every existing corpus);
  - temporal (validity in the key): `(subject, predicate, object…, valid_at) WHERE expired_at IS NULL AND
    temporal_corpus = true`.
  Extraction's index is literally untouched; only temporal-corpus rows get the relaxed rule.
- **Paired app change:** `createFact`'s dedup fast path (`findActiveTriple`, `facts.ts:172-236`) must, for a
  temporal corpus, either key on `valid_at` too or skip corroboration — otherwise a second stint is merged
  before the index is even consulted (§2). Exclusive-group supersession must also be suppressed/relaxed for
  temporal corpora (a recurrence is data, not a correction).
- **Caveat of record:** the quick "same-(s,p,o) among active rows" recurrence count is 0 *by construction*
  (the active-triple index forbids it) — it is NOT evidence about S1's dedup impact. The real measure (over
  all rows incl. expired, or fact_history) is still owed (§7).

## 5.2 AS BUILT (2026-09-08, bead nmemo-asf.12)

Implemented + proven deterministically (probe `platform/src/test/tools/temporal-recurrence-probe.ts`,
PASS, self-cleaning; tsc held at the 69 baseline throughout):

- **Migration `060_temporal_corpus_mode.sql`** — `corpus_policies.recurring_facts` + `facts.temporal_corpus`
  + the policy re-sync. **Refinement vs §5.1's "two indexes":** replaced `uniq_facts_active_triple`
  **in place (same name)** with ONE *functional* unique index whose 5th key is
  `CASE WHEN temporal_corpus THEN COALESCE(valid_at,'-infinity') ELSE '-infinity' END` — non-temporal rows
  collapse to `(s,p,o)` exactly as before, temporal rows key on `valid_at`. Keeping the name means mig
  037's `CREATE ... IF NOT EXISTS` never re-adds the plain version.
- **Edited mig 037's dedup pre-step** to append `valid_at` to its `PARTITION BY` — required for RE-RUN
  SAFETY (the runner re-applies every file each run; without it, a re-run would expire temporal recurrence
  windows). Verified empirically: re-applying 037+060 leaves the functional index intact, no errors, no
  data loss.
- **`createFact`** (`services/facts.ts`) — resolves `corpusAllowsRecurring(corpusId)` (cached), stamps
  `temporal_corpus`, gates exclusive-group supersession OFF and adds `valid_at` to the dedup active-triple
  key for temporal corpora. `clearCorpusTemporalCache()` exported for probes/tests.
- **R1 read `getEntityFactsAsOf(entityId, asOf, {predicate?, corpusId?})`** — `valid_at <= asOf <
  invalid_at AND expired_at IS NULL`, transaction pinned to NOW (NOT the doubly-historical
  `facts_at_time`).
- **MCP tool `query_entity_facts_as_of`** (`causal-agent.ts`, `mutates:false` → auto-exposed) + dispatch
  case (corpus-scoped via `context.corpusId`) + reasoning-agent prompt (I3 primitive). Proven via the real
  `handleToolCall` dispatch in the probe.

**OWED (one item):** the probe's `createFact` write-path section SKIPS when the embed service (:8000) is
down (it was, this session). The `createFact` gating is proven-by-construction + tsc-clean and the index
it relies on is proven, but exercising the write path end-to-end (a recurring stint via `createFact` stays
distinct, not merged/superseded) needs Ollama :11434 + ml :8000 up. Re-run the same probe with the service
up to close it.

## 6. MCP tooling notes (the load-bearing product surface)

The read model is what the external agent drives (doc 32 §4: "the MCP tool surface is the product"). Today
the agent **cannot ask a temporal question** — every fact read returns "true now." The temporal capability
is only real once it is a tool. Plan:

- **New read tool `query_entity_facts_as_of`** (`mutates:false` → auto-exposed to every actor on both
  transports via the `GRAPH_TOOLS`/`mutates` derivation, no allow-list edits — the `recall_entities_fused`
  precedent, doc 37). Params: entity, `as_of` (ISO date), optional predicate. Corpus-scoped via
  `context.corpusId` (the env carrier, doc 36), **not** a tool arg. Backed by R1.
- Consider an optional `as_of` param on the existing `query_entity_facts` rather than a second tool —
  decide by whether "active now" and "as of Y" want to stay visibly distinct in the surface (leaning: a
  separate tool, so "active" stays the obvious default and the temporal read is explicit).
- Add it to the reasoning-agent prompt (`ml-services/app/reasoning_agent.py`) as the **I3 temporal
  primitive**, the way `recall_entities_fused` was added as the I1 recall primitive.
- The composite reasoning queries doc 34 flagged (causal × temporal, "where things are moving") compose
  *this* tool with `trace_causes`/`project_trajectory` at the agent layer — so getting the as-of primitive
  right is a prerequisite for that whole class.

## 7. Pre-build verification — RUN 2026-09-07

- **Extraction-recurrence impact — MEASURED, zero.** Over **all** rows incl. expired: **0 of 18,084
  distinct (s,p,o) groups** have >1 distinct `valid_at` (8 groups have >1 row, all at the *same*
  `valid_at` = ordinary supersession/corroboration, not recurrence). So extraction never produces
  same-statement recurrence in the substrate. Genuine (spans expired rows), not the tautological
  active-row count. Confirms S2's containment is clean and that even S1 would have had zero data impact —
  the S2-over-S1 case rests on code-path blast radius (§2), not data frequency.
- **Consumer enumeration — DONE.** Active-triple assumption consumers: `createFact` dedup + P1 race
  (`facts.ts:172-236,304-309`); the pipeline racing-INSERT note (`pipeline.ts:1166`, no separate
  mechanism); **entity-merge pre-re-point dedup** (`entities.ts:792-820`, PARTITION BY (s,p,o) with no
  `valid_at`); **epoch promotion corroboration** (`promotion-plan.ts:175`, `PlannedCorroboration` on
  matching active triple); the error surface (`mcp-errors.ts:17`). For **temporal** corpora, the merge
  dedup and epoch corroboration would each need `valid_at` in their grouping key or they'd fold recurrence
  windows together — **latent-not-active** for a direct-write KG load (no merge / no epoch on the loaded
  KG), but a correctness note for S2 if either ever runs on a temporal corpus.
- **Supersession under S2 — resolved by design.** `find_superseding_facts`
  (`001_consolidated.sql:326-337`) is only invoked when `participatesInExclusiveGroup` (`facts.ts:163-168`).
  S2 gates the exclusive-group path OFF for temporal corpora, so it is never called for them → no
  interference; non-temporal behaviour is byte-identical.
- **`valid_at` non-null on load — enforced by the load script.** CronQuestions gives every fact a start
  year; the direct-write load sets `valid_at` non-null (a NULL `valid_at` is an as-of error state,
  `temporal-boundary-precision.md:24`).
- **`invalid_at` boundary — PINNED.** CronQuestions `[start,end]` years are inclusive. Convention:
  `valid_at = Jan 1 of start-year`; `invalid_at = Jan 1 of (end-year + 1)` (exclusive upper bound);
  open-ended windows → `invalid_at` NULL. As-of query for year Y evaluates at **July 1 of Y** (mid-year,
  avoids Jan-1 boundary ambiguity) against `valid_at <= Yts AND (invalid_at IS NULL OR invalid_at > Yts)`.

## 8. Sequencing / beads

- This doc feeds **`nmemo-asf.8`** (Phase 4: I3 temporal retrieval experiment). The build here (S2/R1 +
  MCP tool) is the *substrate* `.8` needs before it can pre-register the temporal-lift experiment.
- `.7` (flat-baseline harness) is **not blocked** by this — it is time-blind. It can proceed in parallel
  or wait, at the user's discretion.
- Dedicated substrate bead filed: **`nmemo-asf.12`** (temporal-model fix), gated (schema/write-path
  touching), landing S2/R1/MCP with a deterministic probe (load a small recurring-fact fixture; assert the
  as-of read returns the right window for each year across a true→untrue→true sequence) before any
  benchmark run.
