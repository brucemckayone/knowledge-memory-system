# 42 — Living Predicate Ontology: Deterministic Multi-Signal Canonicalization

**Status:** Design — for review before code (epic `nmemo-213`, child PC1)
**Branch:** `feat/parallel-ingestion`
**Decision:** Complete the adaptive, self-limiting predicate vocabulary already designed into `fact_predicates` but never wired into the epoch-v2 propose/promote path. Canonicalization is **deterministic and model-free**: enriched embeddings retrieve candidates, a multi-signal score plus the `inverse_predicate` hard guard decides the merge, and two calibrated thresholds gate the decision. The LLM gate is demoted to an optional, off-hot-path adjudicator for the thin ambiguous band only.

> This doc is the contract; the epic's child beads (PC2–PC8) point at it. Read each section as: **the problem and its evidence → what already exists → the design → where it binds → how it's verified.**

**Lineage.** This is the third pass over predicate canonicalization, and it narrows rather than restarts:

- [`docs/design/living-ontology.md`](../../design/living-ontology.md) (2026-03-24/25) is the research-validated design — three intelligence layers (structural → embedding → LLM), tense-into-timestamps, the explicit inverse registry, two-threshold scoring, and the staging lifecycle. Its conclusion was "embeddings rank, **the LLM verifies every merge** (~40% of candidates)."
- [`issues/04-predicate-explosion.md`](issues/04-predicate-explosion.md) (2026-04-16) is the problem statement: `normalizePredicate()` returns unknown predicates as-is, so invented predicates flow through to facts unchecked.
- [`41-epoch-v2-design.md`](41-epoch-v2-design.md) is the propose/promote ingestion model this work binds into. It did not exist when the living-ontology design was written.

**What changed since living-ontology.md.** The 2026-06-01 ontology benchmark added a multi-signal score and an inverse-pair guard and measured them. The result: the deterministic multi-signal fold drives adversarial false-merges to **0** and lifts NL mapping past the 85% bar **without** putting the LLM on every merge. So we replace "LLM-verifies every merge" with "deterministic multi-signal decides; LLM adjudicates only the narrow ambiguous zone, off the hot path, optional and async." The structural insight stands unchanged: embeddings cannot see direction, so no model size fixes inverses — the `inverse_predicate` registry and the type-pair signal do.

---

## 1. The problem (and its evidence)

The epoch-v2 proposer stores fact predicates as **free text, verbatim**. The `propose_fact` tool handler reads `toolInput.predicate` raw (`causal-agent.ts:3099`), uses it only to look up its exclusive group (`resolveExclusiveGroup(predicate)` at `:3114`, no normalization), and writes the raw string into the staging buffer (`:3148`). Only the **dead** `create_fact` path normalizes (`causal-agent.ts:1815` calls `normalizePredicate`), and that path is not on the epoch-v2 ingestion route.

The consequence: the same logical relation lands under many predicate strings — `works_at`, `employed_by`, `has_role_at` — and the fact matcher is exact (`graph-canonical-semantic.ts` `factEq` requires `a.pred === b.pred`). Predicate sprawl fragments the graph and tanks fact quality.

**Evidence — the validity-harness run at `cbf34d2` (2026-06-17), recorded in `benchmark-results/history.jsonl`:**

| Metric | Value | Reading |
|---|---|---|
| Fact litmus F1 | 0.27 | Forward-vs-reverse ingestion barely agree on facts |
| Determinism fact F1 | 0.33 | Same corpus, repeated, barely agrees with itself |
| `predicateSprawlMax` | 2 | Distinct predicate strings collapsing to one logical relation |
| Entity F1 | 0.65–0.80 | Entity resolution is comparatively healthy |

The gap is almost entirely the exact-predicate matcher: entities resolve, facts do not, because their predicates never canonicalize. The validity-harness measurement dimensions (predicate-sprawl count, current-state correctness, litmus order-independence) are defined in [`39-graph-validity-harness.md`](39-graph-validity-harness.md) §2.

---

## 2. What already exists (the unwired infrastructure)

Most of the machinery is built. The epic wires it together; it does not invent it.

**Canonical ontology — `predicate-ontology.ts:30–262` (re-exported via `predicates.ts:21–26`).** 27 canonical predicates across 7 categories. Each entry carries `description`, optional `inverse`, optional `type`, `exclusive`, `category`, and `aliases`. `normalizePredicate()` (`predicate-ontology.ts:275–291`) lowercases, checks canonical, checks the alias map, and — the leak — **returns the input as-is** when it finds nothing (`:290`, comment "will be flagged for review").

**The `fact_predicates` registry — `schema.ts:188–207`, seeded in `001_consolidated.sql`, extended by `039_canonical_role_hq_predicates.sql`.** It already has the columns the lifecycle needs:

- `inverse_predicate` — present, but not consistently populated.
- `predicate_type`, `category`, `aliases`, `is_exclusive`, `is_canonical`.
- `status` (`staging | candidate | provisional | canonical | rejected`), `usage_count`, `distinct_memory_count`, `first_seen_at`, `promoted_at`, `rejected_at`, `rejection_reason`.

It is **missing** exactly two things this design needs: an **embedding vector** for similarity retrieval, and a **per-predicate type-pair** (`subject_type`, `object_type`) for the type-pair signal.

**Exclusive groups — `exclusive-groups.ts` `resolveExclusiveGroup()`.** The shared map that folds `job_title`/`title`/`role_at`/… into one role group. Already used by detection (`graph-invariants.ts`), by `createFact` supersession, and by the promotion planner. This is the cross-predicate grouping for *supersession*; it is coarser than the *identity* canonicalization this doc adds, and the two compose (a predicate canonicalizes to one string; that string still belongs to an exclusive group).

**The lifecycle helpers — `predicates.ts`.** `transitionPredicateStatus()`, `syncOntologyToDb()`, `findNonCanonicalPredicates()` exist but were deprecated as never-built orchestrator pieces (`nmemo-2yv.23`). `recordPredicateUsage()` (`predicates.ts:132–141`) is live and bumps `usage_count`/`last_used_at` from `createFact`.

**Proven-in-tests, not yet in live modules — `ml-services/tests/`:**

- `multi_signal_score(...)` — `benchmark_ontology_embeddings.py:726–741`. The weighted score (see §4).
- `embed_enriched(label, description)` — `:84–87`. Prompt: `"clustering: The relationship '{label}' describes {description}"`.
- `mean_center(embeddings)` — `:94–95`. Anisotropy fix.
- `lemmatize_predicate(verb)` — `test_lemmatization.py:344–359` (spaCy with rule-based fallback).
- `normalize_tense(predicate)` — `test_tense_normalization.py:74–110`. Returns `(base_predicate, temporal_hint)`.
- `_type_pair_overlap`, `_conceptnet_relatedness`, `_jw_sim` and the `PREDICATE_TYPE_PAIRS` / `CONCEPTNET_SYNONYMS` tables — in the benchmark + `ontology_test_data.py`.

**Live ML services.** `/embed` (`embed.py`) returns plain nomic embeddings — no enrichment, no mean-centering. `/compare-predicates` (`compare_predicates.py`) is the LLM gate (merge / keep_separate / defer). There is **no** `/resolve-predicate` endpoint.

**No `search_predicates` tool** exists in `GRAPH_TOOLS` (`causal-agent.ts:86–1274`).

---

## 3. Design overview

Two principles, taken from the prior research design and the new evidence:

1. **Deterministic and model-free on the hot path.** Retrieval is embeddings; the decision is a weighted multi-signal score plus a hard inverse guard, gated by two calibrated thresholds. No LLM call is required to canonicalize a predicate during ingestion.
2. **Adaptive and self-limiting.** The `fact_predicates` vocabulary grows only when a predicate is genuinely novel (above the distinct threshold against every known canonical) and reuses otherwise. Aliases, `usage_count`, and the `status` lifecycle keep the set bounded.

The fold binds in **two isolation-safe places** (per `41-epoch-v2-design.md` §8a):

- **Propose-time** — a read-only `search_predicates` tool gives the proposer a reuse *hint* at the source. Advisory; respects proposer isolation (proposers never read the in-flight graph, only the stable registry).
- **Promote-time** — the deterministic fold is **authoritative**. It reuses-or-mints the canonical predicate and dedupes across isolated proposers, because promotion is the one place that sees all proposals at once.

```d2
direction: right

propose: "Propose-time (per proposer, isolated)" {
  style.fill: "#e3f2fd"
  tool: "search_predicates tool\n(read-only hint)"
  raw: "propose_fact stores\nproposer's predicate"
}

promote: "Promote-time (sees all proposals)" {
  style.fill: "#e8f5e9"
  resolve: "resolve-predicate\n(deterministic fold)"
  key: "tripleKey + prior-canonical index\nkey on CANONICAL predicate"
}

zone: "Off hot path (optional)" {
  style.fill: "#fff3e0"
  llm: "LLM zone adjudicator\n(thin ambiguous band only,\nasync)"
}

propose -> promote: "staged proposals"
promote -> zone: "narrow zone\ncases only" {style.stroke-dash: 4}
```

---

## 4. The deterministic multi-signal fold

**Candidate retrieval — enriched embeddings.** Embed each predicate as `"clustering: The relationship '{label}' describes {description}"`, mean-centered across the vocabulary (anisotropy fix). Store the vector on `fact_predicates`; retrieve nearest neighbours with pgvector. Enrichment + mean-centering is what produces the separation the benchmark measures (B1 gap **0.8125**); raw-label embeddings do not (B5 gap **0.0752**).

**Merge decision — weighted multi-signal score** (`benchmark_ontology_embeddings.py:726–741`):

```
combined = 0.50 * cosine
         + 0.30 * type_pair_overlap
         + 0.10 * jaro_winkler
         + 0.10 * conceptnet
```

- `cosine` — enriched-embedding cosine similarity (the ranking signal).
- `type_pair_overlap` — 1.0 if both predicates share `(subject_type, object_type)`, 0.5 if one type matches, 0.0 otherwise. Keeps relations between different entity-type pairs apart even when labels look alike.
- `jaro_winkler` — surface string similarity. Low weight; catches morphological near-duplicates, contributes little alone (B5).
- `conceptnet` — 1.0 if linked in the ConceptNet synonym table, else 0.0. A cheap external lexical prior.

**Hard guard — the inverse registry.** Embeddings cannot see direction: `works_at` and `employs` are near-identical in embedding space (B7), as are `parent_of`/`child_of`. The `fact_predicates.inverse_predicate` registry is a **hard veto**: if predicate A's registered inverse is B (or vice versa), they never merge regardless of score. The benchmark shows 6 of 9 inverse pairs would false-merge without this guard (B12) — direction is structural, not a similarity problem.

**Two-threshold calibration** (B3): auto-merge at `combined ≥ ~0.905`, auto-distinct at `combined < ~0.848`, with a narrow ambiguous zone between. Above the merge line → reuse the existing canonical (record an alias, bump `usage_count`). Below the distinct line → mint a new staging predicate (the vocabulary grows). Inside the zone → see §6. Exact thresholds are config, not hardcoded, and are tuned by the PC6 sweep; they must be recalibrated if the embedding model changes (B11 confirms drift is small, **0.0104**, but nonzero).

**Tense and lemma, first.** Before scoring, `normalize_tense` folds `worked_at → works_at` (tense becomes a `valid_at`/`invalid_at` timestamp, per the bi-temporal model) and `lemmatize_predicate` reduces inflected verbs to base form. This removes the false-merge cases that are really tense variants (B7's `works_at`/`worked_at`) before they reach the score.

---

## 5. Schema deltas (PC2)

A single additive migration — **`045_predicate_enrichment.sql`** (next free number; `044_causal_pass.sql` is current highest). Use explicit `public.` schema qualifiers (AGE session `search_path` gotcha, per `001_consolidated.sql` and `039`).

- `ALTER TABLE public.fact_predicates ADD COLUMN embedding vector(768)` + an HNSW index for nearest-neighbour retrieval.
- `ADD COLUMN subject_type varchar(50)`, `ADD COLUMN object_type varchar(50)` — the per-predicate type pair for the type-pair signal.
- Backfill `inverse_predicate` for the seeded canonicals from the inverse registry (the column exists; populate it consistently).
- Backfill enriched, mean-centered embeddings for the seeded canonicals (call the enriched `/embed` once per canonical).

No column is dropped or repurposed; existing lifecycle columns are reused as-is.

---

## 6. The `/resolve-predicate` service (PC3)

A new deterministic ML endpoint, model-free on the hot path. Port the proven test functions into live modules (`multi_signal_score`, `embed_enriched` + `mean_center`, `lemmatize_predicate`, `normalize_tense`, the type-pair and conceptnet helpers).

Pipeline, given a raw predicate (+ optional subject/object types and description):

1. **Lemmatize** → base form.
2. **Tense-normalize** → `(base, temporal_hint)`; the hint flows to the fact's `valid_at`/`invalid_at`.
3. **Enriched-embed** → mean-centered vector.
4. **pgvector NN** over `fact_predicates` canonicals → top candidates.
5. **Multi-signal score** each candidate (§4).
6. **Two-threshold decision** with the **inverse guard** applied first:
   - inverse of a candidate → forced distinct;
   - `≥ merge` → return that canonical (reuse);
   - `< distinct` → return "mint new" (novel);
   - in-zone → return "ambiguous" with the top candidate and score (caller decides; default conservative = keep distinct, optionally defer to the async LLM adjudicator of PC7).

The endpoint is pure given the registry snapshot, so promotion replay is stable.

---

## 7. Where it binds in the live code (PC4 spine, PC5 hint)

**Promote-time — the authoritative fold (PC4).** Today `tripleKey` is `` `${subjKey}|${predicate}|${objKey}` `` with the **raw** predicate (`promotion-plan.ts:584`), and the prior-canonical index keys the same way (`:615–619`). So a staged `works for` never matches a prior-canonical `works_at`, and two proposers' variants never dedup against each other. The fix: resolve each staged predicate to its canonical **before** keying — either post-load in `loadPromotionInputs()` (`promotion.ts`) so the planner only ever sees canonical predicates, or in the ref-rewrite loop before `tripleKey` is built. Then `tripleKey` and `priorTripleIndex` key on the canonical predicate, and whole-epoch dedup (`41-epoch-v2-design.md` §5(d)) collapses the variants. This preserves the litmus property (§10 of doc 41): the fold is order-independent, so `promote(forward) == promote(reverse)` still holds.

**Propose-time — the reuse hint (PC5).** Add a `search_predicates` tool to `GRAPH_TOOLS` (`mutates: false`), letting a proposer look up likely-canonical predicates for a relation it is about to propose. Restore predicate discipline to the proposer prompt (prefer canonical predicates; the registry is the menu). This is advisory only — it reduces sprawl at the source but never substitutes for the promote-time fold, because proposers are isolated and cannot see each other or the in-flight graph (`41-epoch-v2-design.md` §8a.4).

**Optional LLM zone adjudicator (PC7).** For the narrow ambiguous band only, off the hot path and async: a `compare-predicates` call (Sonnet) that decides merge / keep_separate. Build only if the zone proves to matter in practice; the deterministic fold is designed to make the zone small.

---

## 8. Evidence — the ontology benchmark (2026-06-01)

Recorded in `ml-services/tests/ontology_benchmark_results.json`; method in `benchmark_ontology_embeddings.py` over the curated corpus in `ontology_test_data.py` (27 canonical predicates + their aliases, 9 inverse pairs, 5 novel predicates, 20 adversarial pairs, 17 noise predicates, 41 natural-language phrases).

| Benchmark | Measures | Target | Result |
|---|---|---|---|
| B1 | Enriched vs cross-category gap | > 0.50 | **0.8125** pass |
| B2 | HAC clustering F1 | ≥ 0.80 | **0.95** pass |
| B3 | Two-threshold separation | merge > distinct | **0.905 / 0.848**, clean |
| B4 | Novel-predicate detection | ≥ 0.80 | **1.0** pass |
| B5 | String-similarity baseline | (low utility) | gap **0.075** |
| B7 | Adversarial false merges (embeddings alone) | 0 | **3** fail |
| B8 | Noise auto-reject rate (embeddings alone) | ≥ 0.80 | **0.556** fail |
| B9 | NL mapping accuracy (embeddings alone) | ≥ 0.85 | **0.778** fail |
| B10 | Cross-validation mean F1 | ≥ 0.75 | **0.9615** pass |
| B11 | Threshold drift across vocab growth | < 0.05 | **0.0104** pass |
| B12 | Inverse-registry necessity | validates design | **6 of 9** pairs need the guard |
| **B18** | **Multi-signal adversarial** | **0 false merges** | **0** (embeddings alone: 3) pass |
| **B19** | **Multi-signal NL mapping** | **≥ 0.85** | **0.8519** (embeddings alone: 0.778) pass |

The story the numbers tell: enriched embeddings are excellent at ranking and at scale (B1, B2, B10, B11), but **alone** they false-merge adversarial and inverse pairs and leak noise (B7, B8, B9). The multi-signal score plus the inverse guard close exactly those gaps — adversarial false-merges to 0 (B18) and NL mapping over the 85% bar (B19) — which is why the design is multi-signal-and-guard, not embeddings-and-LLM-on-everything.

---

## 9. Acceptance — the close gate (PC8)

"Tested and verified against real runs." Re-run **both** the live validity harness and the ontology benchmark, and require, versus the `cbf34d2` baseline:

- **Up:** fact litmus F1 and determinism fact F1.
- **Down:** `predicateSprawlMax`.
- **Unchanged-good:** duplicate entities and duplicate facts still 0/0; `errorViolations` still 0.
- **No regression:** no new false-merges introduced.
- **Benchmark:** B7/B8/B9 recover under multi-signal (the B18/B19 path); B12 still validates the inverse guard.
- **Bounded growth:** predicate vocabulary does not explode on corpus10/corpus20 — it grows only for genuinely novel relations.

Run procedure (from the worktree `platform/`): `compare-ingestion.ts --chunks corpus10.json --modes epoch` then `corpus20.json`, plus `--determinism` for the noise floor; metrics defined in [`39-graph-validity-harness.md`](39-graph-validity-harness.md). Append results to `benchmark-results/history.jsonl`.

---

## 10. Implementation roadmap (the child beads)

| Bead | Scope | Depends on |
|---|---|---|
| PC1 (`.1`) | This design doc | — |
| PC2 (`.2`) | `fact_predicates` enrichment — embedding + HNSW + type-pair columns; backfill inverse + enriched embeddings (migration 045) | PC1 |
| PC3 (`.3`) | `/resolve-predicate` service — port lemmatize / tense / enrichment / multi-signal into live modules; two-threshold + inverse guard | PC2 |
| PC4 (`.4`) | Promote-time deterministic fold — wire resolve into `promote()`; key `tripleKey` + prior-canonical index on the canonical predicate | PC3 |
| PC5 (`.5`) | `search_predicates` MCP tool (`mutates:false`) + proposer prompt predicate discipline | PC3 |
| PC6 (`.6`) | Threshold + weight optimization sweep (tunable config, not hardcoded) | PC4 |
| PC7 (`.7`, optional) | Off-hot-path async LLM zone adjudicator (narrow band only) | PC3 |
| PC8 (`.8`) | Verification gate — validity harness + ontology benchmark vs real runs | PC4, PC5, PC6 |

---

## 11. Decision ledger

**Locked.**

- Hot-path canonicalization is **deterministic and model-free** (multi-signal score + inverse guard + two thresholds). This supersedes living-ontology.md's "LLM verifies every merge."
- The decision binds in **two** places: an advisory propose-time tool and an authoritative promote-time fold. Promote-time is where cross-proposer dedup happens, because only promotion sees all proposals.
- The **inverse registry is a hard guard**, not a signal — direction is structural and no embedding or model size resolves it.
- Tense is **timestamps, not predicates** (consistent with the bi-temporal model and every major KG; per living-ontology.md Finding 1).
- The vocabulary is **self-limiting**: mint only above the distinct threshold against all canonicals; otherwise reuse + alias.
- Thresholds and weights are **config**, recalibrated if the embedding model changes.

**Open (resolve during implementation, not before).**

- The exact merge/distinct threshold values land from the PC6 sweep against corpus10/corpus20, not from the benchmark corpus alone.
- Whether the ambiguous zone is wide enough to justify building the PC7 LLM adjudicator — decide from PC8 data.
- Whether `search_predicates` should also surface staging (non-canonical) predicates as reuse hints, or canonicals only.
- Migration of **existing** non-canonical facts (a backfill fold over the live `facts` table) is out of scope for this epic; the epic fixes the ingestion path forward. Track separately if the live graph needs a sweep.
