# 40 — CronQA time-blind flat-vector baseline — PRE-REGISTRATION (nmemo-asf.7, Phase 3)

**Status: PRE-REGISTERED 2026-09-08. Frozen before computing. Append results below; do not edit the spec.**

## Purpose
Establish the **time-blind dense-retrieval floor** for I3 (temporal / as-of-state) on CronQuestions — the
number the time-AWARE arm (bead nmemo-asf.8, over the doc-39 temporal substrate) must beat. This baseline
uses NO temporal information: it embeds the natural-language question and ranks candidate answer entities
by cosine similarity. It is a BASELINE (a reference floor), not a lever claim.

Deterministic + free (nomic-embed-text via Ollama :11434 through ml :8000; direct DB not required — the
baseline reads CronQuestions files, not the graph). No Claude.

## Data + cut (frozen)
- Dataset: CronQuestions `benchmarks/cronqa/upstream/data/wikidata_big/`, **test split**
  (`questions/test.pickle`, 30,000 questions). Labels from `kg/wd_id2entity_text.txt` /
  `kg/wd_id2relation_text.txt`.
- **Subset: `answer_type == 'entity'` questions only** (19,524 of 30,000). Rationale: a time-answer
  question ("in which year …") is not an entity-retrieval task; those are out of scope for a flat
  entity-retrieval baseline. Report broken out by `type` bucket
  (simple_entity / time_join / before_after / first_last; simple_time is answer_type=time so excluded).
- **Sample: N = 2,000** entity-answer questions, drawn by a **fixed seeded shuffle (mulberry32 seed
  20260908)** of the filtered list in file order, then take the first 2,000. (If fewer than 2,000 exist in
  a bucket it is reported at its full size.) The seed + order are frozen here.
- **Query text:** reconstruct the natural-language question by substituting entity/relation **labels** into
  the record's `template` (the raw `question` carries QIDs; `paraphrases` has label text but is
  encoding-corrupted for accented characters). If a template slot cannot be resolved to a label, fall back
  to `paraphrases[0]`; if that is also unusable, drop the question and report the drop count.

## Candidate universe (frozen)
Closed-world over the cut: the candidate set = the **union of all gold answer entity QIDs across the
sampled questions** (deduped), each embedded by its **name** (nomic-embed-text, raw — the entity-name
convention, not the SEARCH_DOCUMENT prefix). Report `|candidates|`. A question's gold set = its `answers`
QIDs intersected with the candidate universe (always a subset by construction).

## Arm (frozen)
- **NAME** (the flat-vector baseline): score(entity) = cosine( embed(question_NL), embed(entity_name) ).
  Rank descending, tie-break by candidate index ascending (the frozen `rankByScore` convention in
  `retrieval-eval/core.ts`). This is the only arm; FACT/FUSION are out of scope (KG facts are not embedded
  for the time-blind baseline — that is nmemo-asf.8 territory).

## Metrics (frozen)
- **Hits@1**: 1 if the top-ranked candidate is in the question's gold set, else 0.
- **Recall@10**: 1 if any gold answer is in the top-10, else 0. (Answers are set-valued; "any-hit" is the
  honest recall form.)
- Report mean Hits@1 and Recall@10 overall and per `type` bucket, with N per bucket.
- Uncertainty: paired cluster bootstrap over questions (the `clusteredBootstrap` in core.ts, each question
  its own cluster) for a 95% CI on each mean — reported for context (a baseline has no delta to test).

## Validity controls / kill conditions (frozen, checked BEFORE reporting)
1. **Leakage check (report, do not auto-kill):** fraction of questions whose reconstructed NL text contains
   a gold answer's label as a verbatim substring (case-insensitive). A high rate means the "retrieval" is
   partly string-copying, not semantics — reported alongside the score so the number is read honestly.
2. **Underpowered guard:** if the usable sample < 500 questions, VOID (report why) rather than quote a
   number.
3. **Embedding integrity:** every question and candidate name must embed to a finite 768-vector; a single
   empty/failed embedding VOIDs the run (no silent zero-vector).
4. **Tie-break sensitivity:** re-run the ranking with index-DESCENDING tie-break; if Hits@1 moves by more
   than 0.02, the absolute level is tie-break-fragile — flag it (the doc-05 caveat).
5. Deterministic: fixed seed; the embed cache is content-keyed so a re-run reproduces the number.

## Output (frozen)
- Machine JSON conforming to the `benchmarks/` envelope shape (benchmark="cronqa-flat-baseline", the cut,
  scores {hits_at_1, recall_at_10, per-bucket}, N, |candidates|, leakage rate, tie-break delta), written
  under `benchmarks/results/cronqa/runs/` and/or the prereg-artifacts dir; a short trend note.
- The result is the FLOOR for nmemo-asf.8; it is not a capability claim on its own.

---

## RESULTS (append below; do not edit the spec above)

### Run 2026-09-08 (`benchmarks/results/cronqa/runs/2026-09-08-flat-baseline.json`)
Sample n=2,000 (seed 20260908), |candidates|=12,162, nomic-embed-text via Ollama.

| metric | overall | simple_entity | first_last | time_join | before_after |
|---|---|---|---|---|---|
| n | 2,000 | 808 | 593 | 391 | 208 |
| **Hits@1** | **0.0245** [0.018,0.032] | 0.0062 | 0.0725 | 0.0026 | 0.000 |
| **Recall@10** | **0.076** [0.065,0.088] | 0.058 | 0.152 | 0.005 | 0.063 |

**Validity (all pass):** leakage 9.6% (NL contains a gold answer name — flagged, concentrated in the
paraphrase-fallback + first_last rows); tie-break sensitivity |asc−desc| Hits@1 = 0.0020 (< 0.02, so the
absolute level is NOT tie-break-fragile); n=2,000 > 500 (powered); embeddings all finite. Not VOID.

**Reading (honest):** pure dense retrieval is **near-useless on temporal QA** — 0.0245 Hits@1 is ~75× the
1/12,162 chance rate, so the embedding adds only weak signal. This is expected: the question text almost
never contains the answer, and dense similarity has no way to pick the temporally-correct object. The
floor confirms **I3 is not a dense-retrieval task** — it needs graph structure + time.

**IMPORTANT distinction for nmemo-asf.8 (corrects doc 40's "the number the time-aware arm must beat"):**
there are two different time-blind baselines and they measure different things.
- **This `.7` dense floor (~0.02):** how far *pure semantic retrieval* gets. It motivates the substrate
  (dense alone fails) but is NOT the fair control for the value of TIME.
- **The STRUCTURAL time-blind control (`.8` will build it, projected ~0.54 fwd / ~0.14 rev by the
  scratch-asf8 investigation):** use the graph — subject + relation → objects, ignore the year, pick
  most-recent. `.8`'s as-of arm also uses subject+relation; the *only* added variable is TIME, so **as-of
  vs structural-time-blind** is the comparison that isolates the temporal lift. Beating this `.7` dense
  floor is trivial and not the interesting claim; beating the structural control is.

So `.7` is banked as the dense floor (the I1-style retrieval reference); `.8` must include the structural
time-blind control as its primary comparator, not this number.
