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
- `type_pair_overlap` — 1.0 if both predicates share `(subject_type, object_type)`, 0.5 if one type matches, 0.0 otherwise. Keeps relations between different entity-type pairs apart even when labels look alike. **Source of the type pair at promote-time (critical):** a never-before-seen staging predicate has no registry type pair, so the fold derives it from the **staged fact's own resolved subject/object entity types** (available after promotion's entity-resolution step), not from a registry lookup keyed on the unknown predicate. Without this the signal collapses to a hard 0.0 for exactly the novel predicates the fold exists to judge — and the benchmark's B19 number borrows the gold answer's type pair, so it is *not* the live promote-path number (see §12-R1). For **attribute facts** (`object_value`, no object entity → no `object_type`), treat a NULL object type as a wildcard contributing 0.5 (subject-type match only); the role/HQ/title sprawl that motivates this epic is largely attribute-valued, so the exclusive-group fold (`resolveExclusiveGroup`) does the heavy lifting there and the type-pair signal is deliberately permissive.
- `jaro_winkler` — surface string similarity. Low weight; catches morphological near-duplicates, contributes little alone (B5). **Requires the `jellyfish` dependency** — absent it the term is silently 0.0 (the benchmark's `_jw_sim` fallback), quietly dropping 0.10 of the score. PC3 adds it to `requirements.txt`.
- `conceptnet` — 1.0 if linked in the shipped synonym table, else 0.0. A cheap lexical prior (the table is a curated stub, not live ConceptNet). **It must be audited against the inverse registry before porting:** the benchmark table maps `employs → works_at`, which is an *inverse*, not a synonym (flagged in-source) — porting it verbatim would push an inverse pair toward merge. PC3 scrubs inverse-direction entries and asserts at load that no conceptnet entry asserts synonymy for a registered inverse pair.

**Hard guard — the inverse registry.** Embeddings cannot see direction: `works_at` and `employs` are near-identical in embedding space (B7), as are `parent_of`/`child_of`. The `fact_predicates.inverse_predicate` registry is a **hard veto**: if predicate A's registered inverse is B (or vice versa), they never merge regardless of score. The benchmark shows 6 of 9 inverse pairs would false-merge without this guard (B12) — direction is structural, not a similarity problem.

**Two-threshold calibration** (B3): auto-merge at `combined ≥ ~0.905`, auto-distinct at `combined < ~0.848`, with a narrow ambiguous zone between. (living-ontology.md calibrated 0.906/0.852 from an earlier run; the values moved slightly and are not final — see §12-R3-C4.) Above the merge line → reuse the existing canonical (record an alias, bump `usage_count`). Below the distinct line → mint a new staging predicate (the vocabulary grows). Inside the zone → see §6. Exact thresholds are config, not hardcoded. They are calibrated on the curated benchmark corpus, whose distribution differs from the LLM-extracted predicates in corpus10/corpus20; **PC6 must re-derive them on live staging predicates** and PC8 runs at that operating point (the transfer is an assumption until measured — see §12-R1-B4). B11 confirms drift across *in-distribution* vocab growth is small (**0.0104**), but that is not the same as corpus-distribution transfer.

**Tense and lemma, first.** Before scoring, `normalize_tense` folds `worked_at → works_at` (tense becomes a `valid_at`/`invalid_at` timestamp, per the bi-temporal model) and `lemmatize_predicate` reduces inflected verbs to base form. This removes the false-merge cases that are really tense variants (B7's `works_at`/`worked_at`) before they reach the score. Both normalizations run **identically on the candidate and on the registry sides**, and the inverse guard checks the **post-lemma** forms, so lemmatization cannot smuggle a predicate onto a registered inverse's surface form and slip past the veto. A temporal hint derived here **never overrides an explicit proposer-supplied `validAt`** (`valid_at` is the validity source of truth, per `41-epoch-v2-design.md` §12 #7); the hint only fills the gap when the proposer left the fact undated. (`normalize_tense` as it stands is table-driven, not grammatical — see §6 and §12-R2 for what porting it actually requires.)

---

## 5. Schema deltas (PC2)

A single additive migration — **`045_predicate_enrichment.sql`** (next free number; `044_causal_pass.sql` is current highest). Use explicit `public.` schema qualifiers (AGE session `search_path` gotcha, per `001_consolidated.sql` and `039`).

- `ALTER TABLE public.fact_predicates ADD COLUMN embedding vector(768)` + an HNSW index (`vector_cosine_ops`) for nearest-neighbour retrieval. pgvector + HNSW precedent already exists in `001_consolidated.sql` (the `vector` extension and entity/memory HNSW indexes) — copy that pattern.
- `ADD COLUMN subject_type varchar(50)`, `ADD COLUMN object_type varchar(50)` — the per-predicate type pair (a default/representative pair for the seeded canonicals; the live promote-path also derives the pair from the staged fact's entity types, per §4).
- Backfill `inverse_predicate` for the seeded canonicals from the inverse registry (the column exists but is inconsistently populated — `039` left it NULL; populate it consistently).
- Backfill **raw enriched** embeddings (uncentered) for the seeded canonicals — store the uncentered enriched vector and apply mean-centering at query time over a fixed registry snapshot. **Do not store mean-centered vectors**: mean-centering is vocabulary-relative, so a vector centered at backfill time is incomparable with a newly-minted predicate centered against a later, larger vocabulary (see §12-R1-N3). Centering against a fixed snapshot keeps both sides consistent.

Use the idempotency + explicit-`public.` pattern from `039` (`ADD COLUMN IF NOT EXISTS`, `ON CONFLICT DO NOTHING`). No column is dropped or repurposed; existing lifecycle columns are reused as-is.

---

## 6. The `/resolve-predicate` service (PC3)

A new deterministic ML endpoint, **model-free** (no LLM) on the hot path — though not network-free; it calls the enriched `/embed`. Port the proven test functions into live modules, but note the port is **not a verbatim copy** in three places (see §12-R2):

- `multi_signal_score`, `embed_enriched`, `mean_center` — port directly; add `jellyfish` (jaro-winkler) to `requirements.txt` or the 0.10 jaro term is silently dead.
- `normalize_tense` is **table-driven, not grammatical** — it only folds predicates present in the benchmark's hardcoded `TENSE_ALIASES`/corpus, returning `(input, "current")` for everything else. Porting it as-is gives near-zero tense folding on real extracted predicates. Carry the tense-alias data into the live ontology/registry (so it grows with the vocabulary) rather than copying the static table.
- `_type_pair_overlap` and `_conceptnet_relatedness` read **hardcoded benchmark dicts**, not the DB. Porting them is a *rewire*: the type pair reads from the staged fact's entity types + the `fact_predicates` columns (§4); the conceptnet signal reads a shipped, inverse-scrubbed synonym constant. `lemmatize_predicate` uses spaCy with a rule-based fallback — the fallback is acceptable for dev (Haiku-first discipline applies to the LLM path, not this); add spaCy only if the rule-based lemmatizer proves too weak at PC8.

Pipeline, given a raw predicate (+ the staged fact's subject/object entity types and description):

1. **Lemmatize** → base form.
2. **Tense-normalize** → `(base, temporal_hint)`; the hint fills `valid_at`/`invalid_at` only if the proposer left the fact undated (§4).
3. **Enriched-embed** → vector (centered at query time over the fixed registry snapshot, §5).
4. **pgvector NN** over `fact_predicates` canonicals → top candidates.
5. **Multi-signal score** each candidate (§4).
6. **Two-threshold decision** with the **inverse guard** applied first:
   - inverse of a candidate → forced distinct;
   - `≥ merge` → return that canonical (reuse);
   - `< distinct` → return "mint new" (novel);
   - in-zone → return "ambiguous" with the top candidate and score (caller decides; default conservative = keep distinct, optionally defer to the async LLM adjudicator of PC7).

**Hot-path cost and failure model (PC4 consumes this).** Promotion is single-writer and synchronous, so a per-predicate embed call serializes the transaction. Mitigations, all required: (a) cache the enriched embedding on `fact_predicates` so each canonical is embedded once, at mint; (b) batch-embed the distinct *new* staging predicates of an epoch in one `/embed/batch` call, outside the promotion transaction (alongside the existing entity-embed step); (c) **down-mode** — if ml-services is unreachable, promotion must not hard-fail: defer canonicalization, keep the raw predicate, and flag the fact for the gardener to canonicalize later. Given a frozen registry snapshot and cached/batched embeddings, the canonicalization map is deterministic, so promotion replay stays stable — but the endpoint is *not* "pure" in the network sense, and the down-mode path is the explicit escape hatch.

---

## 7. Where it binds in the live code (PC4 spine, PC5 hint)

**Promote-time — the authoritative fold (PC4).** Today `tripleKey` is `` `${subjKey}|${predicate}|${objKey}` `` with the **raw** staged predicate (`promotion-plan.ts:584`), and the prior-canonical index keys on the **prior fact's stored** predicate (`promotion-plan.ts:618`, reading `pf.predicate`). So a staged `works for` never matches a prior-canonical `works_at`, and two proposers' variants never dedup against each other.

The fix binds at one place — `loadPromotionInputs()` (`promotion.ts:90`), which maps both `StagedFact.predicate` and `PriorFact.predicate` (`:110`). Canonicalize **both sides** there, so the planner downstream sees only canonical predicates and stays pure string-equality:

- **Both sides, not just staged.** Resolving only the staged predicate is insufficient — a staged `works for → works_at` still misses a prior fact stored as `employed_by` unless the prior side is folded too. (Verified: load-time substitution is *not* blocked by exclusive-group ordering, because `resolveExclusiveGroup` resolves the group independently of the exact string and the staged group is precomputed at propose-time.)
- **Write the canonical string into `facts.predicate`, not just the key.** The litmus harness re-folds with its own token-only normalizer (`graph-canonical-semantic.ts`), which does *not* map aliases to canonicals — so litmus fact-F1 only moves if the canonical predicate is *physically stored* on the fact, not merely used for keying. This is the difference between `predicateSprawlMax` dropping (key-level) and litmus F1 rising (string-level); the gate (§9) requires both, so PC4 must do both. (See §12-R1-N4.)
- **Preserve supersession audit semantics.** Canonicalizing can make two facts with the *same object* but *different predicates* collapse to one `tripleKey`, turning what would have been a group-supersession (an expiry row in `fact_history`) into a silent corroboration that discards the older fact's `valid_at`. PC4 must canonicalize for the exclusive-group key as it does today, but guard the triple-dedup path so a real supersession still emits its expiry/audit row. The litmus harness must assert the count of `fact_history` expiry rows is unchanged when canonicalization is enabled on a corpus with known supersessions. (See §12-R1-B3.)

With both sides canonicalized, whole-epoch dedup (`41-epoch-v2-design.md` §5(d)) collapses the variants. The fold is a pure per-fact map applied to a frozen snapshot, and the downstream supersession total order is order-independent by construction, so the litmus property (§10 of doc 41) `promote(forward) == promote(reverse)` still holds — the swarm could not construct an order-dependent counterexample (§12).

**Propose-time — the reuse hint (PC5).** Add a `search_predicates` tool to `GRAPH_TOOLS` (`mutates: false`). The wiring is nearly free: a `mutates:false` entry auto-propagates through `READ_ONLY_TOOL_NAMES` into `PROPOSER_SURFACE` and the `graph-mcp.ts` ListTools filter, so the proposer gets the tool without a separate allow-list edit; the only manual piece is a single dispatch `case` in the tool-call switch (and the `mutates` field is mandatory — omitting it is a startup-assertion error, not a silent bug). The tool is a **dynamic registry lookup**, which is what replaces the static-predicate-menu idea from living-ontology.md / issue 04 (a static menu in the prompt would drift from the growing registry; the tool reads it live). Restore predicate discipline to the proposer prompt (prefer canonical predicates; use the tool). This is advisory only — it reduces sprawl at the source but never substitutes for the promote-time fold, because proposers are isolated and cannot see each other or the in-flight graph (`41-epoch-v2-design.md` §8a.4); its run-to-run variance is bounded and irrelevant to canonical correctness, since promotion re-canonicalizes regardless.

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
| **B18** | **Multi-signal adversarial** (recovers B7) | **0 false merges** | **0** (embeddings alone: 3) pass |
| **B19** | **Multi-signal NL mapping** (recovers B9) | **≥ 0.85** | **0.8519** (embeddings alone: 0.778) pass |

The story the numbers tell: enriched embeddings are excellent at ranking and at scale (B1, B2, B10, B11), but **alone** they false-merge adversarial and inverse pairs (B7) and miss NL phrasings (B9). The multi-signal score plus the inverse guard close exactly those two gaps — adversarial false-merges to 0 (B18) and NL mapping over the 85% bar (B19) — which is why the design is multi-signal-and-guard, not embeddings-and-LLM-on-everything.

**B8 (noise auto-reject, 0.556) has no multi-signal result** — there is no B18/B19-style measurement for it. Noise predicates like `sort_of_works_at` / `basically_knows` are near-duplicates with hedging prefixes; the lever for them is **morphological prefix-stripping in the lemma/tense stage** (§4, §6), a *different* mechanism than the score, which was never benchmarked. So B8 is **not** claimed recovered here. PC3 ships a noise-prefix unit test, and PC8 *measures* B8 under the full pipeline (lemma + multi-signal) rather than asserting a recovery the evidence base does not contain (see §12-R3-C1).

---

## 9. Acceptance — the close gate (PC8)

"Tested and verified against real runs." The gate is **falsifiable**, not directional — concrete thresholds, not "up/down". It is run with **PC7 disabled** (deterministic-only configuration, so the determinism claims aren't contaminated by an async LLM) and at the **PC6-locked operating point** (the thresholds/weights re-derived on corpus10/corpus20, not the benchmark-corpus defaults). Because the harness wipes and re-ingests fresh corpora per arm, the un-migrated live graph (§11) does not affect these numbers.

Re-run **both** the live validity harness and the ontology benchmark, versus the `cbf34d2` baseline (litmus fact-F1 0.27, determinism fact-F1 0.33, `predicateSprawlMax` 2):

- **Fact litmus F1 ≥ 0.70** and **determinism fact-F1 ≥ 0.80**, with **litmus_F1 ≥ determinism_F1 − 0.05** (order-dependence within the determinism noise floor, per doc 41 §10). If repeats are run (doc 39 §F), the litmus gain must exceed 2σ of the repeat-run band.
- **`predicateSprawlMax` ≤ 1** on *both* corpus10 and corpus20, and report the full per-relation sprawl *distribution* (a max of 1 with a tail of 2s elsewhere is a fail).
- **Bounded vocabulary growth (explicit ceiling):** distinct active predicate count on corpus20 ≤ count(corpus10) + (genuinely-novel relations in chunks 11–20, enumerable from the gold graph), AND ≤ 1.5× the 27 seeded canonicals. "Bounded" without a number is unfalsifiable.
- **No false-merge regression (measured):** ontology-benchmark B7/B18 adversarial false-merge count = 0; on the live run, a false-merge = a gold-distinct predicate pair collapsed to one canonical, measured against `gold/<corpus>.gold.json` (doc 39 §A) — baseline is 0 (nothing merges today) and must stay 0.
- **B8 measured, not assumed:** report B8 (noise auto-reject) under the full lemma+multi-signal pipeline; target ≥ 0.80, but report the number regardless (it is a new measurement, not a regression check).
- **Hard-fail invariants (deterministic, ungameable):** duplicate entities = 0, duplicate facts = 0, `errorViolations` = 0, and **single-active-per-exclusive-group invariant pass-rate = 100%** (doc 39 §C) — the last directly proves canonicalization let group-supersession fire.

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
- Migration of **existing** non-canonical facts (a backfill fold over the live `facts` table) is out of scope for this epic; the epic fixes the ingestion path forward. Track separately if the live graph needs a sweep. (The close gate is unaffected — it ingests fresh corpora.)

---

## 12. Review resolutions (adversarial swarm, 2026-06-18)

Three adversarial reviewers (design-soundness, code-seam feasibility, scope/coherence) reviewed this doc before any code. All returned APPROVE_WITH_CHANGES; the architecture and the inverse-guard insight held under attack, and no reviewer could construct an order-dependent counterexample to the fold. The substantive findings are resolved inline above and indexed here.

**R1 — design soundness.**
- **B1 (type-pair unavailable for novel predicates; B19's 0.852 is answer-aware):** resolved in §4 — the promote-path type pair comes from the staged fact's resolved entity types, not a registry lookup on the unknown predicate; B19 is flagged as not the live number, and PC8 reports the real one.
- **B2 (attribute facts have no object type):** resolved in §4 — NULL object_type is a 0.5 wildcard; the exclusive-group fold carries the role/HQ sprawl.
- **B3 (canonicalize-then-key can eat a supersession):** resolved in §7 — preserve `fact_history` expiry rows; litmus asserts the expiry-row count is unchanged.
- **B4 (thresholds not shown transferable):** resolved in §4/§9 — PC6 re-derives on corpus10/20; PC8 runs at that operating point.
- **N3 (synchronous embed / centering):** resolved in §5/§6 — store uncentered vectors, center per fixed snapshot; cache + batch; explicit ml-down deferral mode.

**R2 — code-seam feasibility (doc verified unusually accurate against HEAD).**
- **Seam 1 (prior index keys on the prior predicate):** resolved in §7 — canonicalize BOTH staged and prior sides in `loadPromotionInputs()` (`promotion.ts:90/110`).
- **Seam 2 (`normalize_tense` is table-driven):** resolved in §6 — carry tense data into the registry, don't copy the static table.
- **Seam 3 (type-pair/conceptnet read hardcoded dicts):** resolved in §6 — rewire to DB columns + a shipped constant.
- **Seam 4 (`jellyfish`/`spacy` not in requirements):** resolved in §4/§6 — PC3 adds `jellyfish`; spaCy optional with rule-based fallback.
- **Risk 1 (`employs→works_at` mislabeled synonym):** resolved in §4 — scrub inverse entries; assert at load.

**R3 — scope / coherence / numbering.**
- **Numbering:** keep **42** (slots 40/41 are occupied by live, unrelated epoch-v2 docs). The epic `nmemo-213` design field and bead `nmemo-213.1` title/description must change "40"→"42" (executed alongside this revision).
- **C1 (B8 over-claim):** resolved in §8/§9 — B8 recovery claim struck; B8 measured at PC8, noise handled by prefix-stripping.
- **C3 (PC8 must run PC7-off):** resolved in §9.
- **C4 (threshold provenance drift 0.906/0.852 → 0.905/0.848):** noted in §4.
- **Close-gate strengthening / S1 (run at PC6 operating point):** resolved in §9 (falsifiable thresholds + operating point).
- **S4 (dynamic vs static prompt menu):** resolved in §7 — `search_predicates` is the dynamic lookup that replaces a static menu.
- **Object-value sprawl (orthogonal):** noted — canonicalizing predicates may surface latent `object_value` sprawl (`"CTO"` vs `"Chief Technology Officer"`); out of scope, but PC8's sprawl number may be capped by it. Tracked for a future bead.
