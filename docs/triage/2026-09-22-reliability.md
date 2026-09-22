# Bead re-verification — RELIABILITY / CONFIG SAFETY / EXTRACTION QUALITY / TEST HYGIENE

Date: 2026-09-22 · Branch: `feat/single-graph-retrieval` · Read-only pass (no source edits, SELECT-only DB).
Substrate: `cognitive_test` on Postgres :5433 (up). **Ollama :11434 and ml-services :8000 were DOWN** — no
embedding, no live ingest, no live `/resolve-predicate` call was possible. Where that blocked a claim it is
said so explicitly.

Claim labels used below: **(V)** verified by my own reading/query · **(B)** claimed by the bead or a doc,
carried forward unverified · **(I)** inference.

## Verdict table

| Bead | Verdict | One-line evidence |
|---|---|---|
| **nmemo-ecn** (P0) | **STILL-BROKEN** | 68.7% hapax reproduces **bit-exact** on `arxiv-cv`+`arxiv-nlp` (2240 distinct / 1539 hapax / 5714 facts / 26.9% of facts on a hapax predicate); ontology is 48 hard-coded personal/CRM rows with 0 embeddings, 0 usage, and **no `corpus_id` column** — but the title's causal claim is still wrong. Priority: **demote to P1 + retitle**. |
| **nmemo-kgy** | **STILL-BROKEN** | `ml-client.ts:149` — the comment `// Abort by caller — don't retry` and the un-retried `throw new MlClientError(endpoint, 0, 'Request timed out')` are both still there; `/chat` still 60s (`:326`) vs 600s siblings. |
| **nmemo-1tc** | **PARTIAL** | Driver half **FIXED** (`compare-ingestion.ts:447-462` drains the undici dispatcher instead of `process.exit`, comment cites nmemo-1tc). ml-services stability half unaddressed in code (no supervisor) and **not reproducible live** — :8000 is down. |
| **nmemo-gnt** | **STILL-BROKEN** | Python still silently falls back: `ml-services/app/core/llm.py:1041` default `"claude"`, `create_llm_client()` returns `ClaudeCodeProvider()` for any unknown value with only `logger.info`. TS default is still `'pi'` (`startup-validation.ts:108`). File moved (`llm.py` to `app/core/llm.py`), line numbers shifted. |
| **nmemo-3aq** | **STILL-BROKEN** | `resolve_predicate.py:119-130` fast path returns `decision="merge", canonical=base` (self-resolution); `predicate-resolve.ts:147-150` books it as `stats.reused++` with no self-vs-redirect check; `promotion.ts:715-717` still logs only `reused/minted/deferred`. |
| **nmemo-m8d** | **STILL-BROKEN** | No precision gate anywhere on the proposer-to-promote path: zero confidence filters in `promotion-plan.ts`/`promotion.ts` (confidence is a tiebreak/max only), and the proposer prompt still says *"Spend the budget on RELATE (propose_fact): every proposed fact is real output"*. F1 numbers not re-measured (services down). |
| **nmemo-p0t** | **PARTIAL** | Items 1 and 3 **FIXED** by commit `2df6416` (`VALID_ACTORS.size` now `toBe(9)`, count guard now self-referential). Item 2 has **re-drifted**: `EXPECTED_WRITE_TOOLS` holds 22 names, `GRAPH_TOOLS.filter(mutates)` is now **23** — `propose_bridge_edge` is missing. |
| **nmemo-xt1** | **FIXED** | `cleanFixtureEntities()` added (`epoch-propose-tools.test.ts:70-93`), run in `beforeEach` **and** `afterAll`; live DB has **0** leaked `Globex` / `Acme Inc` / `Helix Corp` / `Dr. Elena Vasquez` rows. |
| **nmemo-zro** | **STALE-PREMISE** | Nothing live depends on `claude -p` for LongMemEval: both current harnesses are header-documented *"Deterministic + Claude-free"*, and grep for `claude -p` / `graph-agent` / `session` across them returns nothing. The generic pause-and-resume machinery was separately built (`session-limit.ts` + `scripts/ingest-resumable.ts`). |

---

## 1. nmemo-ecn (P0) — the number holds; the title does not

### 1a. The 68.7% figure reproduces exactly (V)

The bead's measurement corpus is `arxiv-cv` + `arxiv-nlp` (2,852 + 2,862 = **5,714 facts**, matching the
bead's stated total exactly). On that slice today:

```
distinct_pred | hapax | pct_hapax | facts | pct_facts_on_hapax
         2240 |  1539 |      68.7 |  5714 |               26.9
```

Every one of the bead's four numbers is bit-exact: 2,240 distinct, 1,539 hapax, **68.7%**, **26.9%** of facts
on a once-used predicate. Nobody had re-checked it; it is correct.

It also **generalises across every research corpus** (V) — this is new, the bead only measured arXiv:

| corpus | facts | distinct pred | hapax | % hapax | % facts on hapax |
|---|---|---|---|---|---|
| qbio | 6,955 | 3,508 | 2,612 | **74.5** | 37.6 |
| arxiv-nlp | 2,862 | 1,323 | 932 | **70.4** | 32.6 |
| arxiv-cv | 2,852 | 1,168 | 785 | **67.2** | 27.5 |
| dal-nlp | 2,612 | 1,252 | 877 | **70.0** | 33.6 |
| dal-cv | 2,565 | 1,074 | 753 | **70.1** | 29.4 |
| pooled (5) | 17,846 | 6,652 | 4,717 | **70.9** | 26.4 |
| `_cronqa` | 324,926 | 202 | 18 | **8.9** | 0.0 |

The entity half also holds and is **worse** than recorded (V): 980 distinct `entity_type` values over the 5
corpora, 489 hapax = **49.9%** (bead said 338 / 47.3% — it measured arXiv only).

`_cronqa` is the control that proves the defect is in the extraction path, not the schema (V): its
`extraction_method` is `kg_load` (bulk Wikidata P-ids), not `llm`, and its predicate distribution is healthy
(8.9% hapax, 0.0% of facts on a hapax). Every `llm`-extracted corpus is in the 67-75% band.

### 1b. The collapsibility sizing needs a caveat (V)

The bead's "top 100 heads = 75% of edges, top 50 = 62.3%" does **not** hold for full predicate strings — on
the same arXiv slice, top-50 strings = 32.0% and top-100 = 41.1% of edges. It only holds under head-word
grouping: taking `split_part(predicate,'_',1)` gives 615 distinct heads, **top-50 heads = 70.4%**,
**top-100 heads = 80.1%**. So the sizing is directionally right but is a statement about *head words*, not
about a 100-entry predicate ontology. Anyone scoping an ontology off that number will undersize it (I).

### 1c. The code claim: the ontology is hard-coded, global, and never exercised (V)

- `platform/src/services/predicate-ontology.ts:30` — `export const CANONICAL_ONTOLOGY` is a literal record.
  Its own header comment reads: *"Categories: professional, personal, location, education, creation, skills,
  events"*. Seeded into the DB by `platform/src/db/migrations/001_consolidated.sql:160` onward.
- `public.fact_predicates` holds exactly **48 rows** (27 `canonical`, 21 `rejected`, 0 `staging`, 0
  `candidate`). `subject_type`/`object_type` span only `person`/`company`/`place`/`concept`/`event`.
- **`fact_predicates` has NO `corpus_id` column** — the registry is a single global table. There is no
  per-corpus ontology mechanism to seed or swap, as the bead says.
- `sum(usage_count) = 0` and `max(last_used_at) IS NULL` across all 48 rows. The bead comment's
  "max `last_used_at` in the live DB is 2026-06-30" is now stale — it is NULL. Confirmed cause: the epoch
  path writes facts via `tx.insert(facts)` directly (`promotion.ts:506`), never `createFact`, and
  `recordPredicateUsage` has exactly one caller — `facts.ts:415`, inside `createFact`. The growth path is
  unreachable, not merely unexercised.
- `count(embedding) = 0` on all 48 rows, so `loadPredicateCandidates` (`predicate-resolve.ts:42`,
  `WHERE embedding IS NOT NULL`) still returns empty and `canonicalizeStagedPredicates` still takes its
  graceful no-op at `predicate-resolve.ts:130-133`. `platform/scripts/backfill-predicate-embeddings.ts`
  exists and has still never been run here. The bead's own CORRECTION note remains accurate.
- There is still **no loud signal** for the empty-candidate no-op: `startup-validation.ts` validators are
  `qdrant_dim`, `ml_services`, `transport`, `ports`, `hnsw_iterative_scan`, `schema_tables` — no predicate
  check. The "process finding" in the bead's note is untouched.
- **No write-path constraint exists at all**: `facts.predicate` is a bare `varchar(255)` with no FK to
  `fact_predicates` and no CHECK (`\d public.facts`). So the free-text sprawl is not caused by a *lock* —
  it is caused by the *absence* of any gate.

### 1d. New evidence the bead does not have — the domain mismatch is real at the coverage level (V)

The bead's comments record the domain-mismatch story as "SECONDARY AND **UNTESTED**". A coverage measurement
settles the coverage question (it does not resurrect the causal claim):

Of the 17,846 research-corpus facts, only **162 (0.91%)** use a predicate that exists in the 48-row
registry, and only **33 (0.18%)** fall into an exclusive/augmentation group. The scientific edge vocabulary
(`enables` 331, `evaluated_on` 298, `uses` 258, `uses_technique` 210, `outperforms` 193, `trained_on` 129)
is **99.1% outside the ontology**.

That 0.18% also means the supersession machinery is effectively inert on these corpora: the groups are
`AUGMENTATION_GROUPS` in `exclusive-groups.ts:55`, namely `role_title` (`job_title`, `ceo_of`, `cto_of`, ...)
and `location` (`headquartered_in`, `lives_in`, `relocated_to`, ...) — purely personal/CRM (V). This is a
downstream consequence the bead does not name.

Also (V): entity types were **not** collapsed to the personal-memory list.
`ml-services/app/extract_entities.py:154-159` does enforce
`['person','company','project','concept','place','event','other']` — but nothing in `platform/src/` ever
passes `valid_types` (only `ml-client.ts:282,288` and its own tests reference it), and the research corpora
came through the proposer path instead, which places no constraint on `entity_type` at all. The live types
are `concept` 1358, `technique` 708, `method` 499, `task` 489, `model` 305, `dataset` 294. So for the entity
half the defect is **unconstrained**, not **domain-locked** — the opposite framing to the bead's title.

### 1e. Is P0 still justified?

**No — recommend P1 plus a retitle**, agreeing with the two existing bead comments and adding the coverage
number above as the missing evidence.

- The *measurement* is real, reproducible, and generalises to every `llm`-extracted corpus. Keep it.
- The *title's causal claim* ("domain-locked, 68.7% hapax **on any new domain**") is refuted three ways
  now: the fold never attempted a match (0 embeddings, V); seed type pairs cap `type_pair_overlap` at 0.5 so
  0/3,963 keys could reach `ambiguous` (B, doc 41); and there is no write-path gate for a domain ontology to
  act through (V).
- As written, an open P0 directs work at authoring a domain ontology, which the evidence says is neither
  sufficient nor first. Sequence after `nmemo-4g9` (the jaro-winkler scoring term).
- Two concrete blockers to fold into any seeded-ontology plan: `recordPredicateUsage` is unreachable from
  the epoch path (so a new ontology can never accumulate usage or promote candidates), and
  `fact_predicates` has no `corpus_id` (so "per-corpus ontology" is a schema change, not a data change).

**Severity read:** real, but it is a *capability gap* (the semantic backbone is unusable for any
relation-type generalisation on non-personal corpora), not a live failure — nothing crashes, and current
retrieval is dense/fusion over names+facts, which does not read predicates. **Fix size: needs-design**
(schema + write-path gate + growth path + seeding), which is itself an argument against P0.

## 2. nmemo-kgy — STILL-BROKEN

All four parts of the bead verify at HEAD (V):

- `mlFetch` constructs its own controller and timer (`ml-client.ts:118`); no caller signal is ever threaded
  in.
- `ml-client.ts:148-151` still reads, verbatim:
  ```ts
  // Abort by caller — don't retry
  if (error instanceof DOMException && error.name === 'AbortError') {
    throw new MlClientError(endpoint, 0, 'Request timed out');
  }
  ```
  The comment describes a case that cannot occur, and the branch is above the retry block — so a
  self-inflicted timeout fails immediately while an ordinary network error retries to `MAX_ATTEMPTS = 3`
  with `BACKOFF_MS = [500, 1000]` (`:79-80`). Still inverted.
- `/chat` is still `60_000` (`:326`) against `/resolve-predicate` `120_000` (`:277`) and `/embed`,
  `/extract-entities`, `/extract-relationships` at `600_000` (`:237,291,307`).
- The harness workaround is still local and still the only mitigation:
  `platform/src/test/tools/link-corpus-concepts.ts:77-80` `isRetryableLinkError` adds
  `/request timed out/i` on top of `isRetryableAgentError`, used at `:171`. Shared
  `isRetryableAgentError` (`concurrency.ts:89-102`) still does not cover it.

**Severity:** real but currently latent — the five `/chat` callers (`causal-patterns.ts`,
`concept-extraction.ts`, `concept-resolution.ts`, `corpus-ingest.ts`, `element-authoring.ts`) are all off
the active retrieval path, and the one harness that hit it is patched. The nastiest exposure the bead names
stands: `predicate-resolve.ts:158-163` catches and keeps the raw predicate, so a `/chat` timeout there is
silent quality loss, not an error (V). **Fix size: one-function** (retry the internal abort once when
`timeoutMs <= 120_000`, and correct the comment).

## 3. nmemo-1tc — PARTIAL

**FIXED half (V):** `platform/scripts/compare-ingestion.ts:447-462` now ends with

```ts
// Exit cleanly. Forcing process.exit() while undici's keep-alive sockets are
// mid-teardown trips Node's `UV_HANDLE_CLOSING` assertion (exit 9) — which on a
// failed arm crashed the driver *before* the error detail flushed (nmemo-1tc).
main().catch(err => { console.error(...); process.exitCode = 1; })
      .finally(async () => { try { await dispatcher.close(); } catch { await dispatcher.destroy(); } });
```

A 500 now becomes `throw new Error('ingest <mode> failed (<status>): <detail>')` at `:161-166`, which
propagates to that `.catch`, prints the stack, sets `exitCode = 1`, and drains the dispatcher. The libuv
assertion path the bead describes is gone, and the comment names the bead.

**NOT verifiable half:** live reproduction of "ml-services :8000 dies under sustained graph-agent load" was
**not possible** — :8000 and Ollama :11434 are both down, and the repro needs a full corpus10 3-arm run with
~40-50 `claude -p` spawns. At code level nothing addresses it (V): `ml-services/app/core/llm.py:462` still
uses a blocking `subprocess.run` per invocation behind a 6-worker `ResourcePool`
(`core/concurrency.py:34,131`), and there is no health probe, supervisor, or auto-restart anywhere for
ml-services itself.

**Recommendation:** split the bead — close the driver half, keep the ml-services-stability half open at P2
with the acceptance criteria narrowed to it.

## 4. nmemo-gnt — STILL-BROKEN (both sides)

Note the file moved: `llm.py` to `ml-services/app/core/llm.py`, and the cited line 1001 is now 1041 (V).

Python (V) — no validation, silent fallback:
```python
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "claude")        # :1041

def create_llm_client() -> LLMProvider:                    # :1044
    if LLM_PROVIDER == "zai":  ... return ZAIProvider()
    if LLM_PROVIDER == "pi":   ... return PiBridgeProvider()
    logger.info("Using Claude Code CLI LLM provider")
    return ClaudeCodeProvider()
```
Any unknown value (`LLM_PROVIDER=clade`) yields Claude with an `info` log. No allowed set, no raise.

TS (V) — the opposite default, but it *does* reject unknowns:
`startup-validation.ts:108` `const provider = process.env.LLM_PROVIDER ?? 'pi';` and `:137`
returns `unknown LLM_PROVIDER='<provider>' (expected pi|claude|zai)`.

So: the "silently falls back" defect is **Python-only**; the "defaults drift (pi vs claude)" defect is
**still exactly as filed** — unset var means the Node host probes the Pi bridge on :3099 while Python builds
a Claude client. All three acceptance criteria are unmet.

**Severity:** real-but-quiet config trap; the failure is a confusing startup verdict or a silently wrong
provider, not a crash. **Fix size: one-function** on the Python side (an allowed set plus `raise`) plus a
one-line default alignment; the only judgement call is *which* default wins.

## 5. nmemo-3aq — STILL-BROKEN

Every element of the mechanism is intact (V).

The fast path lives in Python, `ml-services/app/resolve_predicate.py:117-130`:
```python
# Fast path: the raw predicate resolved straight to a canonical (exact or
# via the alias/tense table) — reuse it without embedding.
if base in canonical_set:
    return ResolveResponse(decision="merge", canonical=base, base=base, ..., score=1.0,
                           signals={"combined": 1.0, "exact_match": True}, top=[])
```
`canonical_set` is `{c.predicate for c in request.candidates}` (`:99`) — **keyed on the string alone**,
type-blind. So a predicate already canonical resolves onto **itself** and returns `decision="merge"`.

The TS caller books that as reuse without comparing input to output
(`platform/src/services/predicate-resolve.ts:139-150`):
```ts
const key = `${f.predicate} ${subjectType ?? ''} ${objectType ?? ''}`;   // :139 — keyed on the TYPE PAIR
...
if (res.decision === 'merge' && res.canonical) { cache.set(key, res.canonical); stats.reused++; }  // :147-150
```
The cache key includes the type pair while the fast path keys on the string — exactly the mismatch the bead
describes: the same string under a second type pair is a new key whose string is already canonical, so the
fast path fires and books a `reused` while nothing collapses.

The log line is unchanged (`promotion.ts:715-717`):
```ts
`[promotion] epoch=${epochId.slice(0,8)} predicates: reused=${predStats.reused} ` +
  `minted=${predStats.minted} deferred=${predStats.deferred}`
```
`CanonicalizeStats` is still `{ reused, minted, deferred }` (`predicate-resolve.ts:106-110`) — no
`self_resolved` / `redirected` split, and no warning when `redirected == 0 && candidates > 0`.

The 1715/1722 split itself is (B) from doc 41 section 2 and could not be re-measured — `/resolve-predicate`
needs ml-services. The *defect that produces it* is verified structurally.

**Severity:** real — it is a false success signal on the canonicalisation layer, the same silent-no-op class
as doc 39 section 8, and it is what let the fold sit inert for months. **Fix size: one-function** (compare
`res.canonical` against the raw predicate, split the counter, extend the log line, add the
`redirected == 0` warn) touching `predicate-resolve.ts` plus `promotion.ts`.

## 6. nmemo-m8d — STILL-BROKEN (structural claim verified; F1 numbers not re-measured)

There is **no precision gate of any kind** on the proposer-to-promote path (V):

- `promotion-plan.ts` contains zero confidence comparisons against a threshold. `confidence` appears only as
  `Math.max(...)` folding (`:724`), a supersession tiebreak (`:752`, `:840`), and a carried field. No
  `minConfidence` / `confidenceThreshold` / grounding gate exists anywhere in `platform/src/services`.
- `promotion.ts:506-536` inserts every planned fact; the only filtering is triple-dedup and exclusive-group
  supersession, both correctness concerns, not precision.
- A confidence gate would be useless as built anyway (V): over the 5,714 arXiv facts, confidence averages
  **0.949** with only **8 rows below 0.8**. The proposer self-reports near-certainty on everything, so
  `confidence` carries no precision signal to gate on. This is new evidence and it changes the fix
  direction — "add a confidence gate at promote-time" cannot work without first making the proposer's
  confidence mean something.
- The proposer prompt still pushes recall, not precision. `ml-services/app/graph_agent.py:740-741`:
  *"You have 100 tool calls. Aim for 30-50. **Spend the budget on RELATE (propose_fact): every proposed fact
  is real output.**"* There is no "extract only well-grounded relations" instruction. The only
  precision-adjacent addition since the bead was filed is `search_predicates` plus predicate-reuse
  discipline (commit `47a0d85`), which targets *vocabulary* sprawl, not fact precision.

**Not re-measured:** the corpus10/20 fact-F1 numbers (0.09-0.13 / 0.16-0.22) are (B). Re-running the litmus
benchmarks needs ml-services plus Ollama plus Claude spawns, all unavailable.

**Severity:** real and it is upstream of the retrieval work — 70.9% hapax predicates and 49.9% hapax entity
types (see nmemo-ecn) are partly this bead's output, and CLAUDE.md's own retrieval findings name
"extraction sparsity/quality" as the root cause of the concept-layer failure. **Fix size: needs-design** —
prompt tightening is cheap but unmeasurable without a working benchmark loop, and the gate design needs a
grounding signal that does not exist yet.

## 7. nmemo-p0t — PARTIAL (the bead's work landed; the guard has re-drifted by one tool)

Commit `2df6416` *"test(pi-bridge): resync stale guard tests to current actor/write-tool surface"* did the
work. Of the bead's three items (V):

1. **FIXED.** `pi-agent-bridge.test.ts:233` is now titled *"...covers all 9 Actor values"* and `:245` asserts
   `expect(VALID_ACTORS.size).toBe(9)`.
2. **STALE AGAIN.** `EXPECTED_WRITE_TOOLS` (`:84-99`) lists **22** names. `GRAPH_TOOLS.filter(t => t.mutates)`
   now yields **23** (`grep -c "mutates: true"` = 23). The missing one is **`propose_bridge_edge`**
   (`causal-agent.ts:1377-1380`, `mutates: true`), added for the cross-corpus audit (`nmemo-uhp.12.2`).
   So `:105` `expect(actualWriteTools).toEqual(EXPECTED_WRITE_TOOLS)` fails. This is a *new* drift, not the
   one the bead described — the bead's named tools (`create_causal_edge` removed, the five `propose_*` and
   `create_contradiction` added) were all resynced correctly.
3. **FIXED.** No hardcoded tool count remains; `:312` and `:320` compare against `GRAPH_TOOLS.length`, and
   `:32` is a `toBeGreaterThan(0)` smoke.

The bead's own recommendation is now vindicated (V): it warned that keeping two overlapping guards would let
them "drift independently", and that is precisely what happened. The authoritative partition in
`actor-tool-allowlist.test.ts:47-61` is `CANONICAL_WRITES` (17) plus `PROPOSE_VERDICT_WRITES` (6, including
`propose_bridge_edge`) = 23, and `:103-119` already pins the whole mutating surface against it. The
`EXPECTED_WRITE_TOOLS` block in `pi-agent-bridge.test.ts` is now pure redundancy.

**Severity:** theoretical (one failing test guard, no production impact), but it is a *recurring* failure
mode. **Fix size: one-line** to add `propose_bridge_edge`, or better, delete the duplicate block and keep
the allowlist partition as the single guard. I did not run the suite (it writes to the DB, and this pass was
SELECT-only), so the failure is established by reading `mutates` flags against the literal, not by a run.

## 8. nmemo-xt1 — FIXED

The leak is closed (V). `platform/src/test/services/epoch-propose-tools.test.ts:63-93` adds
`cleanFixtureEntities()` with a comment that describes the bead's exact failure:

> *"createTestEntity uses real-world canonical names (not a TAG). The original beforeEach only cleared
> STAGING, so these canonical fixtures accumulated in the shared cognitive_test DB across runs — and a later
> run's resolve_anchor('Globex') then matched a STALE duplicate, not the freshly-minted one."*

`FIXTURE_ENTITY_NAMES = ['Dr. Elena Vasquez', 'Helix Corp', 'Acme Inc', 'Globex']` (`:70`) and the cleanup
deletes `causal_events`, then `fact_history`, then `facts` (both subject **and** object side), then
`entity_merges`, then `entities`, in FK order. `cleanAll()` runs in `beforeEach` (`:108`) and `afterAll`
(`:109`). Landed in `c6e916d`, with the object-side and `entity_merges` hardening added later.

Live confirmation (V): querying `entities` for all five names the bead reported as accumulating returns
**zero** `Globex`, `Acme Inc`, `Helix Corp`, `Dr. Elena Vasquez` rows. The only fixture debris left in
`cognitive_test` is from *other* suites — `Target` (8 `person`, 6 `company`) and `Acme` (8 `company`), all in
`corpus_id='default'`, none in `FIXTURE_ENTITY_NAMES`.

I did **not** run the test repeatedly to demonstrate the acceptance criterion, because that writes to the
DB and this pass was read-only. Verdict rests on the code path plus the clean DB state.

## 9. nmemo-zro — STALE-PREMISE

The bead's premise ("the LongMemEval harness depends on `claude -p` for every graph-extraction window") no
longer describes anything live (V).

- The two current harnesses are `platform/src/test/tools/longmemeval-i1-baseline.ts` and
  `longmemeval-i2-baseline.ts`. `i1`'s header states: *"Deterministic + Claude-free (nomic-embed-text via
  Ollama through ml :8000). No Claude, no DB writes — cognitive_test and _cronqa are untouched."* Grepping
  both files for `claude -p`, `graph-agent`, `graphAgent`, `runGraphAgent`, `session-limit`, `sessionLimit`
  returns **nothing**. They are retrieval-only (dense chunks plus BM25 plus RRF-60) against a pre-cut JSON
  haystack with an append-only local vector cache.
- The old Python harness `benchmarks/longmemeval/run.py` still exists and still carries `resume_from`
  (`:74`, `:302`) and the session-window chunking, i.e. the manual `--resume-from` recovery the bead
  complains about. But the graph-agent LongMemEval path it drives is superseded by Path B (docs 42/43) and
  CLAUDE.md records LongMemEval as parked. Its last touch is the base commit `4d3c0b8`.
- The bead's generic acceptance criteria 1-3 were separately satisfied for the *ingest* path, not the
  benchmark: `platform/src/services/session-limit.ts` provides `isSessionLimitError` (nine narrow
  signatures, deliberately excluding 429/503) and `parseResetAt`; `concurrency.ts:98` makes
  `isRetryableAgentError` **fail fast** on a session limit so the attempt budget is not burned; and
  `platform/scripts/ingest-resumable.ts` detects it (`:198`), parses the reset (`:200`), sleeps with a
  heartbeat (`:93`, `:219`), honours `--no-wait` (`:207`), and resumes from a ledger checkpoint (`:6`,
  `:14`). Criterion 4 (ml-services supervision) remains unmet and belongs to nmemo-1tc, not here.

**Recommendation:** close as stale, or rewrite as "ml-services supervision" and merge into nmemo-1tc. Do not
build session-limit resilience into the current LongMemEval harnesses — they have no Claude dependency to
protect.

---

## Surprises worth flagging

1. **The P0's headline number is genuinely correct and generalises** — bit-exact on the original slice, and
   67-75% hapax on all five `llm`-extracted corpora. It is the *diagnosis*, not the measurement, that is
   wrong, and the bead already says so twice in its own notes. The `_cronqa` corpus (8.9% hapax via
   `kg_load`) is a clean control that localises the defect to the LLM extraction path.
2. **The ontology's coverage on scientific corpora is 0.91%**, and its exclusive-group machinery touches
   0.18% of facts. The bead's comments call the domain-mismatch concern "SECONDARY AND UNTESTED" — the
   coverage half is now tested and it is near-total. This does not revive the causal claim (there is no
   write-path gate for a domain ontology to act through), but it does mean the entity/predicate ontology is
   doing essentially nothing on four fifths of the live graph.
3. **A confidence gate for nmemo-m8d cannot work as specified.** Proposer confidence averages 0.949 with 8
   of 5,714 rows below 0.8 — there is no signal to threshold. The fix direction in the bead needs revising.
4. **nmemo-p0t is a fixed-then-regressed bead, and it regressed in exactly the way the bead predicted.**
   Two overlapping guards on the mutating tool surface drifted apart again; `propose_bridge_edge` is missing
   from the duplicate. The bead's own advice (delete the duplicate, keep the allowlist partition) is the
   right fix and should be applied this time rather than patching the literal.
5. **The predicate-ontology growth path is architecturally unreachable, not just unused.**
   `recordPredicateUsage` has exactly one caller, inside `createFact`, and the epoch path inserts facts
   directly via `tx.insert(facts)`. So `usage_count` is 0 across all 48 rows and `last_used_at` is now NULL
   everywhere (the bead comment's "max 2026-06-30" is stale). Any seeded-ontology plan has to fix this first
   or the candidate-promotion columns stay dead.
6. **Two beads' cited file paths have moved:** `llm.py` is now `ml-services/app/core/llm.py` (line 1001 is
   now 1041), and nmemo-3aq's "fast path" is in Python (`resolve_predicate.py:119`), not in the TS
   `canonicalizeStagedPredicates` the bead names.
7. **`default` corpus holds 246 rows of pure test-fixture debris** (`person-1784553627691-rmddjm`,
   `EMC10-Target-...`, `dup-pred-...`, `bridges_1..5`) in the live `cognitive_test` DB. Unrelated to any bead
   here, but it is the same shared-DB hygiene class as nmemo-xt1 and it will keep biting name-matching tests.

## Coverage limits of this pass

- No live ingest, extraction, embedding, `/chat`, or `/resolve-predicate` call was made — ml-services :8000
  and Ollama :11434 were down by instruction. Every claim about runtime behaviour is from code reading plus
  SQL over the resting substrate.
- No test suite was executed, since the relevant suites write to `cognitive_test` and this pass was
  SELECT-only. nmemo-p0t item 2 and nmemo-xt1 are established by reading code against the live DB state, not
  by a run.
- The doc-41-derived counts in nmemo-3aq (1715/1722) and the corpus10/20 F1 figures in nmemo-m8d are carried
  forward unverified; both need working services to re-measure.
