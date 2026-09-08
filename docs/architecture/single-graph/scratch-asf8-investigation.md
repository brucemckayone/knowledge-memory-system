# scratch — nmemo-asf.8 investigation (I3 temporal retrieval experiment)

**READ-ONLY prep, 2026-09-08. Not a design of record — a build brief for `.8`.** Substrate = doc 39
(S2+R1+MCP, landed as `.12`). All numbers below computed directly against the on-disk CronQuestions
`test` split (30,000 Qs) and the KG `full.txt` (328,635 rows). Scripts were throwaway; findings are what
matter.

---

## A. Question structure per bucket (test split, n=30,000)

Every record is a dict with: `question` (QID-bearing NL), `paraphrases` (name-resolved NL — **corrupted
encoding, do not use**), `answers` (a **set**), `answer_type` (`entity|time`), `type` (bucket),
`entities`/`relations`/`times` (sets of QIDs/PIDs/years), `template`, `annotation` (the **gold slot dict —
use this**), `uniq_id`.

The **year constraint lives in `annotation`**, not consistently in `times`: `times` is non-empty **only**
for `simple_entity` (all 7,812) and empty for every other bucket. So the queryable year is
`annotation['time']` (a string like `'1971'`) and exists **only for simple_entity**. All other buckets
carry no explicit year — their time constraint is *relational* (derived by a join/ordering), which is why
they are not single as-of lookups.

| bucket | n (test) | answer_type | annotation shape(s) | time given? | clean as-of? |
|---|---|---|---|---|---|
| **simple_entity** | 7,812 | entity | `{head,time}` ×6282 · `{tail,time}` ×1530 | **YES (`time`)** | **YES — the target** |
| simple_time | 5,046 | time | `{head,tail}` | no (answer *is* the year) | no (window read-out, not as-of) |
| time_join | 3,832 | entity | `{head,tail}` · `{event_head,tail}` | no | no (temporal self-join) |
| before_after | 2,151 | entity | `{head,tail,type}` · `{event_head,tail,type}` | no | no (ordering/next-in-sequence) |
| first_last | 11,159 | entity 5,729 / time 5,430 | `{adj,head}` · `{adj,head,tail}` · `{adj,tail}` | no | no (min/max over windows) |

**The clean target = `simple_entity` (entity-answer + single given year). Nothing else is a single as-of
lookup.** Only 5 relations appear in it: P166 award received (3,074), P54 member of sports team (2,886),
P39 position held (1,530), P26 spouse (202), P108 employer (120). Exactly 1 entity + 1 relation per Q.

### Concrete decoded examples (QIDs → names via `kg/wd_id2entity_text.txt` / `wd_id2relation_text.txt`)

**simple_entity — forward `{head,time}`** (subject given, answer = object):
- uniq_id 24701: `"What award was awarded to Q24256741 in 1971"` head=Richard Aaker Trythall, rel=P166,
  time=1971 → answer **Q3405483 Rome Prize**.
- uniq_id 7924: `"Q4138308 played for which team in 1890"` head=James Gillespie, rel=P54, time=1890 →
  answer **Q18739 Sunderland A.F.C.**
- uniq_id ~ (P39 multi-answer): `"Q653368 in 1931 was who"` — this is actually a `{tail,time}` reverse
  (see below); shown to flag that "was who" = answer is the *subjects*.

**simple_entity — reverse `{tail,time}`** (object given, answer = subject(s)):
- `"Q653368 in 1931 was who"` tail=a P39 position, time=1931 → **11 answer QIDs** (all people holding it
  that year). Reverse questions are position-heavy and often multi-answer.

**simple_time** (answer = year): uniq_id 4547 `"What year was Q2400411 playing in Q2641?"` head=Andrea
Russotto, tail=S.S.C. Napoli, rel=P54 → answer **{2008, 2009}**. Substrate-answerable (read the window's
start-year for the (head,rel,tail) fact) but it is a **fact-attribute read-out, not an as-of read**.

**time_join** (answer = entity set): uniq_id 7115 `"Who were the players who played in Q2768 with
Q3904049"` tail=Torino FC, head=Pietro Mariani, rel=P54 → **86 teammates**. Requires: find the years head
was on team tail, then all *other* subjects on tail during those years = a temporal self-join. Not one
lookup.

**before_after** (answer = entity): uniq_id 17662 `"Who held Q1071117 position after Q139785"`
tail=Prime Minister of NZ, head=Jim Bolger, `type=after` → **Q180383 Helen Clark**. Requires ordering
windows and taking the *next* one. `event_head` variants anchor on an event's year instead of a person.

**first_last** (answer = entity or year): uniq_id 750 `"The last team that Q978570 played in was"`
head=Ernesto Castano, `adj=last` → the team with the **max** start/end window (this example's gold set is
large = a labelling-noise case, see §D). uniq_id 1013 `"When was the first time Q6114110 was playing in
Q48951"` `adj=first`, answer_type=time → **2010** (min start-year). Requires argmin/argmax over windows.

---

## B. The time-aware arm design (simple_entity only)

**Do not NL-parse. Read the gold slots from `annotation` + `relations`.** For each simple_entity Q:
`rel = the single PID in d['relations']`; `year = int(d['annotation']['time'])`; the anchor QID is
`annotation['head']` (forward) or `annotation['tail']` (reverse).

Map slot → substrate (deterministic, no lookup table if you key entity UUIDs as `uuidv5(ns, qid)` — see
§C): anchor QID → entity UUID; PID → the `predicate` string used at load; year → the mid-year instant
**July-1-of-Y** (doc 39 §7 boundary convention, matches the probe's `midYear`).

- **Forward `{head,time}` (6,282):**
  `getEntityFactsAsOf(headUUID, midYear(year), {predicate: PID, asSubject:true, asObject:false, corpusId})`
  → read `objectEntityId` of the returned fact(s) → map back to QID = predicted answer.
- **Reverse `{tail,time}` (1,530):**
  `getEntityFactsAsOf(tailUUID, midYear(year), {predicate: PID, asSubject:false, asObject:true, corpusId})`
  → read `subjectEntityId`(s) = predicted answer(s).

`getEntityFactsAsOf` (`platform/src/services/facts.ts:959`) already supports both directions via
`asSubject`/`asObject` (default both true) and filters `valid_at <= asOf AND (invalid_at IS NULL OR
invalid_at > asOf) AND expired_at IS NULL` corpus-scoped — exactly R1. **Call the service function
directly in the harness** with explicit direction (cleaner than the MCP tool for a benchmark). The MCP
tool `query_entity_facts_as_of` (`causal-agent.ts:114`, dispatch `:1812`) is the product-surface
equivalent: it calls the same function with **both directions on** and **no result cap**, corpus-scoped by
`context.corpusId` (env carrier `MNEMO_CORPUS_ID`), and returns both `subjectEntityId` and
`objectEntityId` per fact — so it also answers reverse Qs (pass the tail as `entity_id`, read
`subjectEntityId`). Only takes `entity_id`, `as_of`, optional `predicate`; no `asSubject/asObject` arg, so
if you want strict single-direction, use the service fn, not the tool.

**Where a single as-of lookup will NOT work (all other buckets):**
- `simple_time` — answer is the year; read the fact's `valid_at`, not an as-of filter.
- `time_join` — temporal self-join (co-membership during overlapping windows).
- `before_after` — window ordering + next/prev.
- `first_last` — argmin/argmax over an entity's windows.
These are the **composite-reasoning class** doc 34 flagged (agent composes primitives). Out of scope for
`.8`'s single-primitive as-of arm; note them, don't build them here.

### Faithfulness check — the as-of arm reproduces gold EXACTLY (100%)

I replayed the as-of lookup over `full.txt` for **all 7,812 simple_entity** Qs: predicted set == gold set
for **6,282/6,282 forward and 1,530/1,530 reverse = 100.0%**, 0 anchors missing from the KG, 0 empty
predictions. The questions were **generated from this KG**, so gold is a deterministic function of it. This
is the headline validity caveat (§D) and it fixes the arm's ceiling at 100%.

---

## C. KG load plan (fastest faithful bulk load)

Source file: **`kg/full.txt`** (tab-sep `subj_qid  rel_pid  obj_qid  start_year  end_year`, 328,635 rows).
(`kg/train|valid|test` are tkbc KG splits — ignore; questions were validated against `full.txt`.)

Counts: **125,726 distinct entities** (111,641 ever-subject, 32,067 ever-object; s∪o = 125,726) — **every
one has a label** in `wd_id2entity_text.txt` (0 missing). 203 distinct relations (label file
`wd_id2relation_text.txt` covers the 5 simple_entity PIDs). 284,892 distinct `(s,p,o)` triples; **22,343
carry >1 validity window** (max 70), i.e. 43,743 extra rows = the recurrence doc 39 is built for.

**`fact_embedding` CAN be NULL** — confirmed: `facts.fact_embedding VECTOR(768)` is nullable (001), and
the probe `temporal-recurrence-probe.ts` inserts facts directly with no embedding. The as-of arm is a
structured index lookup, never a vector read, so **skip `createFact` entirely** and bulk-INSERT. This
avoids 328k per-fact ML embedding calls.

**Load order (single scratch corpus, e.g. `_cronqa`):**
1. `INSERT INTO public.corpus_policies (corpus_id, recurring_facts) VALUES ('_cronqa', true);` **first** —
   the flag must exist before facts so `temporal_corpus=true` is meaningful. (No separate `corpora`
   registry table exists; corpus_id is just a TEXT tag. `corpus_policies` is the only registration point.)
2. **Entities (125,726):** one row per QID. `id = uuidv5(NS, qid)` (deterministic → QID↔UUID is a pure
   function, no join table, and it dodges the **name-collision** trap — canonical_name is NOT unique, e.g.
   two "Jorginho" QIDs Q163750/Q6278277). `canonical_name = label` (VARCHAR(500), labels fit),
   `entity_type = 'thing'` (NOT NULL, any constant), `corpus_id = '_cronqa'`, `embedding = NULL`. Batch
   ~5–10k rows/INSERT (multi-row VALUES or COPY). **Composite-FK requirement:** mig 052 adds
   `facts(subject/object_entity_id, corpus_id) → entities(id, corpus_id)` — so entities MUST all carry the
   same `corpus_id` as the facts, and must be inserted **before** facts.
3. **Facts (≤328,635):** `subject_entity_id/object_entity_id = uuidv5(NS, qid)`, `predicate = PID`
   (use the raw PID string — collision-free and deterministic; store the label elsewhere only if desired),
   `valid_at = Jan-1 of start`, `invalid_at = Jan-1 of (end+1)` (exclusive upper bound; open-ended windows
   → NULL — see year-outlier note §E), `corpus_id = '_cronqa'`, **`temporal_corpus = true`** (MANDATORY —
   without it the recurring triples collide on the unique index), `created_at = NOW()`, `expired_at = NULL`,
   `fact_embedding = NULL`, `confidence = 1.0`, `extraction_method = 'kg_load'`.
   **De-dup before insert (load-blocker, see §E):** the temporal unique index keys on `(s,p,o,valid_at)`;
   **3,059 rows collide** on it (1,776 same-start/different-end groups + 1,282 exact-dup rows). Collapse
   deterministically **keep-max-end per `(s,p,o,start)`** (widest window, loses no answerable year), OR
   `INSERT ... ON CONFLICT DO NOTHING`. Either way re-run the §B 100% validation *after* dedup to confirm
   no simple_entity gold answer moved (the collisions are not hit by simple_entity, so it should stay 100%).
   Batch inserts inside a transaction; ~328k rows is seconds-to-minutes via COPY / multi-row VALUES.

**Cleanup order (reverse of FK deps, mirrors the probe's `cleanup()`):** causal_edges/events for the
corpus (none created here) → fact_history (none) → facts → entities → corpus_policies, all
`WHERE corpus_id = '_cronqa'`. Then `clearCorpusTemporalCache()` if the same process wrote via createFact
(the harness won't). Assert 0 leftovers.

---

## D. Pre-registration shape

- **Population / cut:** the **full `simple_entity` test split, n = 7,812** (report forward 6,282 / reverse
  1,530 separately — they have very different headroom). 7,812 indexed lookups is trivial, no sampling
  needed. Use the **test** pickle only (train.pickle is 229 MB and unused).
- **Metric:** **Hits@1** (dataset standard). Answers are sets and the as-of read returns a set, so fix a
  **single shared deterministic pick rule** applied to *both* arms — pick the answer from the
  most-recently-valid window (a time-blind system's most defensible guess) — and score Hits@1 = pick ∈ gold.
  Report **overall** and **on the "ambiguous" subset** (anchor+relation resolves to >1 distinct all-time
  answer, i.e. where time genuinely disambiguates: **73.3% of forward, 99.9% of reverse**). Secondary
  metric: exact-set-match (returned set == gold).
- **Comparison:** time-BLIND flat baseline (bead `.7` — retrieves the answer entity ignoring the year;
  its most-recent-value pick is the natural time-blind guess) **vs** time-AWARE as-of arm (this bead).
  **Hold the slots constant** — both arms get the same oracle `(anchor QID, PID, year)` from `annotation`,
  so the *only* variable is time-aware vs time-blind. State this explicitly.
- **Pre-registered expectation (computed here — the honest "what I expect this run to show"):**

  | arm | forward Hits@1 | reverse Hits@1 |
  |---|---|---|
  | as-of (time-aware) | **1.000** (ceiling; deterministic) | **1.000** |
  | time-blind pick-most-recent | 0.542 | 0.137 |
  | time-blind pick-random | 0.555 | 0.163 |

  Expected **lift ≈ +0.46 forward, +0.86 reverse**; larger still on the ambiguous subset. This is doc 34's
  predicted "cheapest high-information win."
- **Bar (DEMONSTRATED):** as-of Hits@1 ≥ **0.98** overall **AND** lift over time-blind-most-recent ≥
  **+0.30** on the full simple_entity split. (Both are easily cleared if the load+read are correct.)
- **Kill / invalid-run conditions** (note the inverted logic — a *low* as-of number here means a **bug**,
  not a refutation):
  - as-of Hits@1 materially < ~0.98 ⇒ load or read defect (wrong boundary convention, dropped windows in
    dedup, direction bug, PID mismatch between load and query). Fix the harness; do not report as a
    capability finding.
  - **Leakage caveat (load-bearing, put it in `notes`):** gold IS a deterministic function of the loaded
    KG, so the as-of arm's ceiling is 100% by construction. The experiment measures **(a) load+read
    faithfulness and (b) the lift over a time-blind read** — NOT open-domain reasoning or entity-linking.
    Do not present 100% as a reasoning result.
  - **Never use `paraphrases`** — latin-1/utf-8 mojibake throughout (e.g. `Mateo Valero Cort�s`,
    `Sele��o`). Build any displayed query text from QIDs + the label files, or just from `annotation`.
  - Dedup must be re-validated (§C) or dropped windows silently lower faithfulness.

---

## E. Gotchas

1. **Only simple_entity is a single as-of lookup.** The other 22,188 test Qs (74%) need composition
   (join / ordering / argmin-max) — scope `.8` to simple_entity; the rest is the doc-34 composite class.
2. **`times` is empty except for simple_entity.** The queryable year is `annotation['time']` and exists
   nowhere else — don't look for a year field on the other buckets.
3. **Temporal-index collisions block a naive load:** 3,059 rows share `(s,p,o,valid_at=start)` (mig 060's
   functional unique index key). Dedup keep-max-end per `(s,p,o,start)` before insert (§C). The 22,343
   multi-window triples themselves are fine (distinct start-years coexist) — only same-start windows and
   1,282 exact-dup rows collide.
4. **`temporal_corpus=true` is mandatory on every fact** — it is what flips the unique index from `(s,p,o)`
   to `(s,p,o,valid_at)`. Forget it and the recurring triples throw 23505 on insert.
5. **canonical_name is NOT unique** (name collisions, e.g. two "Jorginho"). Key entities on QID; use
   `uuidv5(qid)` for the UUID so QID→UUID needs no lookup table.
6. **Composite FK (mig 052):** every fact's subject and object entity must exist in the *same* corpus_id.
   Load all entities into `_cronqa` first; a fact referencing an entity in another corpus fails the FK.
7. **Year outliers / bad windows in the KG** (do not affect simple_entity — its asked-year range is
   367..2019 and it validated 100% — but affect load faithfulness): 652 rows have `end < start` (empty
   window; drop or clamp), 113 start-years > 2021, 141 end-years > 2021 (sentinels like 2265/3000/9500 =
   "ongoing/unknown" — consider mapping end > 2021 → `invalid_at = NULL` open-ended), 890 start-years
   < 1000. Decide a policy and record it; none of these are hit by simple_entity gold.
8. **Reverse (`{tail,time}`) questions are position-heavy and multi-answer** (99.9% ambiguous). The as-of
   read returns all subjects for the year (tool has no result cap — good). Read `subjectEntityId`, not
   `objectEntityId`.
9. **Answer cardinality is wildly skewed** in simple_entity: 5,440 single-answer, but a long tail up to
   585 answers (mostly P39 positions / national-team rosters and a few clearly noisy labels — e.g. uniq_id
   750 "last team" with ~100 teams looks like an aggregation artifact). The shared-pick Hits@1 (§D) is
   robust to this; exact-set-match is not — report both but lead with Hits@1.
10. **Use the service fn, not the MCP tool, for strict single-direction reads.** The tool runs both
    directions; harmless here (positions never act as subjects) but the service call with explicit
    `asSubject/asObject` is unambiguous.
11. **`rawQuery` snake→camel rewrite and NUL-byte `index.ts`** (CLAUDE.md traps) — the harness reads via
    the drizzle service layer (`getEntityFactsAsOf` returns camelCase `Fact` objects), so this is avoided
    as long as you don't hand-roll raw SQL result-key access.
