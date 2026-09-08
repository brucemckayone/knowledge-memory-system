# 41 — CronQA I3 temporal experiment — PRE-REGISTRATION (nmemo-asf.8, Phase 4)

**Status: PRE-REGISTERED 2026-09-08. Frozen before the run. Append results below; do not edit the spec.**
Build brief + all counts: `docs/architecture/single-graph/scratch-asf8-investigation.md`. Substrate: doc 39
(per-corpus temporal mode + as-of read `getEntityFactsAsOf`, landed as `nmemo-asf.12`). Floor: doc 40
(the `.7` dense flat baseline).

## Question / claim
Does the bi-temporal substrate + the as-of-validity read (R1) answer temporal "who did X <relation> in
year Y" questions better than a time-blind read of the same graph? This is doc 34's projected "cheapest
high-information win" for I3.

## What this measures — and what it does NOT (load-bearing honesty)
CronQuestions gold is a **deterministic function of the KG we load** (questions were generated from it), so
the as-of arm's ceiling is **100% by construction**. This experiment measures **(a) load+read faithfulness
of the doc-39 substrate and (b) the LIFT of time-aware over time-blind reads on the same graph** — NOT
open-domain reasoning or entity linking. Do not present a high as-of number as a reasoning result. Because
of this, the **kill logic is inverted**: a *low* as-of number means a load/read **bug** (boundary
convention, dropped windows, direction, PID mismatch), not a refutation — fix the harness, don't report it.

## Data / cut (frozen)
- CronQuestions `test` split, **`simple_entity` bucket only, full n = 7,812** (the only single-as-of-lookup
  bucket; the other 22,188 test Qs are the doc-34 composite class — out of scope). No sampling.
- Report **forward `{head,time}` (6,282)** and **reverse `{tail,time}` (1,530)** separately.
- Oracle slots read from `annotation` + `relations` (NEVER NL-parsed; NEVER `paraphrases` — mojibake):
  `anchor = annotation.head|tail`, `pid = the single relation PID`, `year = int(annotation.time)`.
- Gold = the question's `answers` QIDs.

## Substrate load (frozen; `_cronqa` corpus, doc 39 temporal mode)
Full KG `kg/full.txt` (328,635 rows → 125,726 entities, 203 relations) bulk-loaded direct (bypass
`createFact`, `fact_embedding = NULL` — the arms are structured index reads, never vector reads). Entity
`id = uuidv5(qid)` (name is not unique); `canonical_name = label`; `entity_type='thing'`; corpus first with
`recurring_facts=true`; every fact `temporal_corpus=true`, `valid_at=Jan1(start)`,
`invalid_at=Jan1(end+1)` (end>2021 → NULL; end<start dropped). **Dedup the 3,059 rows that collide on the
`(s,p,o,valid_at)` unique index: keep-max-end per `(s,p,o,start)`.** Re-assert the §B 100% faithfulness
check AFTER dedup. Self-cleaning corpus.

## Arms (frozen) — slots held constant across both
Both arms receive the SAME oracle `(anchor, pid, year)`; the ONLY variable is time-aware vs time-blind.
- **AS-OF (time-aware):** `getEntityFactsAsOf(uuidv5(anchor), midYear(year), {predicate: pid, asSubject:
  <fwd>, asObject:<rev>, corpusId:'_cronqa'})` → forward reads `objectEntityId`, reverse reads
  `subjectEntityId`.
- **STRUCTURAL time-blind (the fair control):** all active facts for `(anchor, pid)` in `_cronqa` IGNORING
  the year, pick the most-recently-valid window (max `valid_at`), read the same-direction endpoint. This is
  the honest "graph-but-no-time" comparator (NOT the `.7` dense floor, which is a different, weaker task).
- Predictions and gold are compared as **entity UUIDs** (gold QID → uuidv5), so no reverse UUID→QID map.

## Metric (frozen)
- **Hits@1** with a single shared deterministic pick rule applied to BOTH arms: **pick from the
  most-recently-valid window**; Hits@1 = pick ∈ gold. Report overall, per direction, and on the
  **ambiguous subset** (anchor+pid resolves to >1 distinct all-time answer — where time actually
  disambiguates: ~73.3% fwd / ~99.9% rev).
- Secondary: exact-set match (as-of returned set == gold).
- **Lift = as-of Hits@1 − structural-time-blind Hits@1.**

## Pre-registered expectation (from the investigation, the honest "what I expect")
| arm | forward Hits@1 | reverse Hits@1 |
|---|---|---|
| as-of (time-aware) | ~1.000 | ~1.000 |
| structural time-blind (most-recent) | ~0.542 | ~0.137 |

Expected lift ≈ **+0.46 fwd / +0.86 rev**, larger on the ambiguous subset.

## Bar (DEMONSTRATED) + validity
- **Bar:** as-of Hits@1 ≥ **0.98** overall **AND** lift over structural-time-blind ≥ **+0.30**.
- **Validity:** load faithfulness re-checked after dedup (as-of == 100% on simple_entity); every anchor
  resolves to a loaded entity (report misses); deterministic (fixed uuidv5 namespace, no sampling); the
  leakage/ceiling caveat above stated in the result `notes`.
- **Kill (inverted):** as-of materially < 0.98 ⇒ load/read bug, fix and re-run, do not report as a finding.

---

## RESULTS (append below; do not edit the spec above)

### Run 2026-09-08 — BAR MET (`benchmarks/results/cronqa/runs/2026-09-08-temporal-experiment.json`)
Load: 125,523 entities + 324,926 facts into `_cronqa` (17.9s; dropped 652 empty + self-ref windows;
deduped keep-max-end; 0 missing anchors). Slots held constant; both arms use the most-recent-window pick.

| slice | n | as-of Hits@1 | structural time-blind | LIFT |
|---|---|---|---|---|
| overall | 7,812 | **1.000** | 0.4442 | **+0.5558** |
| forward `{head,time}` | 6,282 | 1.000 | 0.5252 | +0.4748 |
| reverse `{tail,time}` | 1,530 | 1.000 | 0.1118 | +0.8882 |
| ambiguous (time disambiguates) | 6,136 | 1.000 | 0.2924 | +0.7076 |

**Bar:** as-of ≥ 0.98 (=1.000) AND lift ≥ +0.30 (=+0.556) → **MET.** Structural matches the pre-registered
projection (~0.542 fwd / ~0.137 rev).

**Falsification control (the load-bearing validity check for a 1.000 result):** re-ran the as-of arm at the
WRONG year (`YEAR_OFFSET=50`, `…-offset50.json`). as-of Hits@1 **collapsed 1.000 → 0.001** (fwd 0.0005,
rev 0.0033). So the temporal `valid_at`/`invalid_at` filter is genuinely used — the 1.000 at the correct
year is a real as-of read, NOT an always-return-gold artifact. This is the decisive check under the
inverted kill logic.

**Honest reading (as pre-registered):** this DEMONSTRATES (a) the doc-39 temporal substrate loads + reads
faithfully end-to-end on a real temporal-QA benchmark (as-of == gold on all 7,812, and collapses when the
year is wrong), and (b) a large, expected LIFT of time-aware over time-blind reads of the same graph
(+0.56 overall, +0.89 on reverse). It does **NOT** demonstrate reasoning or entity-linking — gold is a
deterministic function of the loaded KG, so as-of's ceiling is 100% by construction. The finding is:
**time-awareness is the lever for I3, and the substrate delivers it.** This confirms doc 34's projected
"cheapest high-information win."

**Blind adversary (2026-09-08): VALID-AS-FRAMED — could not break it.** Independently re-derived both arms
from `full.txt` in Python (as-of 1.0000, structural 0.4438, matching within rounding), spot-checked the
loaded `_cronqa` rows against source, and ran boundary controls. Findings incorporated:
- **Stronger time-blind baselines computed (the baseline here was ~0.08 generous):** most-frequent-endpoint
  **0.5225**, random-window **0.4872**, most-recent-by-END-year 0.4731, vs this doc's most-recent-by-START
  0.4438. **The lift SURVIVES the strongest of them: +0.4775 (vs most-frequent), still ≫ the +0.30 bar.**
  Time-blind is capped ~0.52 because 78.5% of questions are genuinely ambiguous. Recorded so the comparator
  is not understated as a strawman.
- **Strict metric confirms faithfulness + makes the lift a lower bound:** as-of **exact-set-match = 1.000**
  across all 7,812 (incl. 585-answer reverse sets) — proves no asked window was dropped/shifted by the
  load's dedup/drops, and that Hits@1 set-membership leniency contributes nothing to the as-of number.
  Leniency can only inflate the *structural* baseline, so the reported +0.556 lift is a **lower bound**.
- **Year-granular filter confirmed:** boundary probes give graded drops (+3 → 0.233, −3 → 0.311, +50 →
  0.001), i.e. a correct year-level as-of filter, not all-or-nothing.
- **Framing footnote (adversary nit):** "reads faithfully end-to-end" is **oracle-slotted** — the anchor,
  PID and year are read from `annotation`/`relations`, never NL-parsed (the entity-linking disclaimer above
  covers this). This is a substrate load+read + lift result, not an NL-QA result.

**BANKED.** The doc-39 temporal substrate loads + reads faithfully and time-awareness is a large, real,
year-driven lever for I3 (lift ≥ +0.48 even vs the strongest time-blind control). Not reasoning.
