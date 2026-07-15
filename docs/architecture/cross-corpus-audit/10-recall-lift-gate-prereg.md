# Doc 10 — EMBED_DESCRIPTIONS recall-lift gate: pre-registration

**Status:** PRE-REGISTERED (frozen before any number was computed). Bead nmemo-uhp.12.4,
the "HARD GATE" inherited from nmemo-uhp.14 criterion 3. This is the real, on-substrate
version of the E1 recall question (nmemo-uhp.6) — run on ingested comparative corpora
through the production embedding + recall path, NOT the schema-less strawman of doc 09.

This document is written and committed **before** the corpus is embedded or any recall@k
is computed, so the pass bar cannot be moved to fit the result (the HARKing failure mode
that recurred five times across the doc-09 E1 legs). Author self-certification is
explicitly distrusted: a blind adversary audits the corpus, the labels, and the result
before any capability claim.

---

## 1. The question

Does authoring rule-aligned **descriptions** on graph entities (running with
`EMBED_DESCRIPTIONS=on`) **materially lift** the cross-corpus recall@k of the true
(code → rule) match, versus name-only embeddings (`EMBED_DESCRIPTIONS=off`)?

"Recall" here is `recallCrossCorpusCandidates(sourceCorpus, targetCorpus, {k, threshold})`
(`platform/src/services/audit-pass.ts:82`) — the exact function the running audit pass
uses to seed candidate cells. It is a single cross-corpus vector query over
`entities.embedding`, scoped by `entities.corpus_id`. This gate measures that function
directly.

## 2. The lever (grounded)

`config.EMBED_DESCRIPTIONS` selects the text sent to the embedder, via
`entityEmbedTextFor(name, description, mode)` (`platform/src/services/embed-text.ts:39`):

- **off** → `mode='name'` → the embedded text is `name` only.
- **on**  → `mode='name_description'` → the embedded text is `` `${name}\n${description}` ``
  (name-only fallback if the description is blank).

The embedding model is `nomic-embed-text` (768-dim) via Ollama, the production embed path.

## 3. Corpus (real artifacts; names verbatim; oracle labels)

Chosen construction (user decision, 2026-07-15): **real artifacts, names verbatim; only
the labels are curated, and they are reused from a static-analysis oracle rather than
hand-authored.** Source: the committed E1 artifacts in `./e1-artifacts/` (real C++ Core
Guidelines + real C++ from the Alpha/Maverick codebase, with a real clang-tidy oracle).

- **`std` (target) corpus** — the union of `leg2_rule_set.json` (11) and
  `leg4_rule_set.json` (25), deduped by rule id, **leg2 text preferred** on overlap
  (leg2 is the leg the labels come from). Each rule → an entity: `name = rule id`
  (e.g. `ES.42`), `description = rule text` (verbatim from the artifact; a faithful
  one-line paraphrase of the real guideline). Covers all 9 true guidelines + distractors.

- **`code` (source) corpus** — the **29 positive elements** of `leg2_key.json` (elements
  the clang-tidy oracle flagged as a genuine `violation` of a specific guideline). Each
  element → an entity: `name = the function's identifier` (as it appears in the code),
  `description = a neutral behaviour summary`. The 34 `none` (near-miss control) elements
  are excluded because recall is only defined for items that HAVE a true match; this is
  stated, not silent.

- **Ground truth (labels)** — the `guideline` field of each positive `leg2_key.json`
  entry: element `E00x` truly matches rule `<guideline>`. This is the real clang-tidy
  oracle's verdict on a pinned clean checkout (doc 09 §14-15), reused verbatim — I author
  no new labels. The adversary verifies the mapping is transcribed faithfully.

### 3a. Anti-gerrymander controls (the load-bearing discipline)

The descriptions ARE the lever, so whoever authors them can tilt the result. Controls:

1. **Blind description authoring.** Function names + behaviour summaries are produced by
   a subagent shown **only the cleaned C++ code** — blind to the rule set, blind to the
   labels, and not told the task is rule-matching. It is asked to document what each
   function does. This makes descriptions independent of the rules *by construction*, so
   any recall lift comes from genuine code↔rule semantic alignment, not from echoing rule
   text. (Precedent: `legA_embedding.mjs` authored summaries that "deliberately do not
   name the rule.")
2. **Names and rule text are verbatim from artifacts** — not authored here.
3. **Labels are an external oracle's** — not authored here.
4. **The blind adversary** (§6) audits: descriptions for rule leakage, labels for faithful
   transcription, rule text for tampering, and the metric code for bugs — before any claim.

## 4. Method (one deterministic, reproducible run)

The mode is driven directly through the production helper `entityEmbedTextFor(name, desc,
mode)` — exactly what `entityEmbedModeFromFlag(config.EMBED_DESCRIPTIONS)` selects — so
both settings run in one process without fighting the config singleton; this is
equivalent to toggling the flag and is noted for the adversary. Embedding uses the
production `generateEmbedding`; recall uses the production `recallCrossCorpusCandidates`.

For `mode ∈ {name, name_description}`:
1. Clean + embed every rule into corpus `gate_std__<mode>` and every code function into
   `gate_code__<mode>` (vector written to `entities.embedding`).
2. `recallCrossCorpusCandidates('gate_code__<mode>', 'gate_std__<mode>', {k: 8, threshold: 0})`
   → for each code function, its top-8 nearest rules by cosine, ranked.
3. **recall@k** for `k ∈ {1,3,5,8}` = fraction of the 29 code functions whose **true**
   rule appears within its top-k ranked candidates.

Every input (corpus, descriptions, labels) and the harness are committed to
`./recall-gate-artifacts/` so every number is reproducible and auditable.

## 5. FROZEN pass bar (user-set, 2026-07-15)

The gate **PASSES iff both hold**:

- `recall@5(on) − recall@5(off) ≥ 0.15`, **and**
- `recall@k(on) ≥ recall@k(off)` for **every** `k ∈ {1,3,5,8}` (monotone — a regression
  at any k fails the gate).

The report states all four k for both settings, the delta at each k, the pass/fail, and
the full list of labelled (function → true rule) pairs with each function's realized rank
under both settings.

## 6. Adversary (pre-committed, before any claim)

A blind adversarial subagent — given the corpus, descriptions, labels, harness, and raw
results, and instructed to REFUTE — must rule on:
1. **Description leakage**: do any code descriptions name or paraphrase their true rule
   (would make the lift circular)?
2. **Label fidelity**: does the ground truth match `leg2_key.json` exactly?
3. **Metric correctness**: is recall@k computed correctly; is threshold=0 fair; are ties
   handled without favouring `on`?
4. **Effect attribution**: can the measured lift be explained by construction bias rather
   than the lever?

If the adversary finds a laundering or a construction flaw, the result is VOID and the bar
is not claimed met, regardless of the numbers.

## 7. Pre-committed caveats (to report even on a PASS)

- **Opaque-name inflation.** Rule names are opaque dotted codes (`ES.42`), so name-only
  recall is near-doomed by construction. A large lift is *expected and real*, but its
  **magnitude is inflated** by how little signal the rule identifiers carry; in a corpus
  with descriptive rule names the lift would shrink. This gate establishes a
  **constructed-corpus FLOOR**, not a field effect size.
- **Checker-decidable slice.** The 9 leg2 guidelines are clang-tidy-decidable rules
  (doc 09's "checkable slice"), not the no-shadow semantic-judgment rules that remain the
  open E1 question. A PASS here says description-aligned vectors improve recall of the
  *candidate set*; it says nothing about the adjudication/judgment question of doc 09 §27.
- **Small n.** 29 positive items; recall@k granularity ≈ 0.034/item.

## 8. What a PASS licenses / does not license

- **Licenses:** shipping `EMBED_DESCRIPTIONS=on` as the default for cross-corpus audit
  ingestion; the claim that authored descriptions materially improve cross-corpus
  candidate recall on this constructed corpus.
- **Does NOT license:** any field-prevalence recall claim, any adjudication/precision
  claim, or any autonomous-auditor claim. Those remain governed by doc 09's terminal state.

---

# RESULTS (post-run, 2026-07-15)

Everything below was produced AFTER §1-8 were frozen and committed (commit `5e60aca`).
Harness: `platform/src/test/tools/recall-gate.ts`; corpus builder:
`./recall-gate-artifacts/build_corpus.mjs`; inputs + full results:
`./recall-gate-artifacts/{gate_rules,gate_code_raw,gate_code_desc,gate_results}.json`.
Deterministic: ranking counts ties AGAINST the true rule (worst-case rank), so repeated
runs are byte-identical and tie-breaks never favour `on`.

## Outcome: the gate PASSES its frozen bar

| k | recall@k off (name,name) | recall@k on (nd,nd) | Δ |
|---|---|---|---|
| 1 | 0.000 | 0.069 | +0.069 |
| 3 | 0.207 | 0.414 | +0.207 |
| 5 | **0.207** | **0.586** | **+0.379** |
| 8 | 0.310 | 0.724 | +0.414 |

Δrecall@5 = 0.379 ≥ 0.15 and `on ≥ off` at every k → **PASS**. It also passes on the
**macro** (per-guideline mean, 9 guidelines) lens that neutralises near-duplicate
inflation: off@5 = 0.111 → on@5 = 0.422, **Δ@5 = 0.311**, monotone.

## Verification (blind adversary, two passes — agent a386599)

The adversary could not void the PASS. It confirmed: descriptions are **genuinely blind**
(mean Jaccard with the true rule = 0.008, *lower* than with other rules; the one
rule-echoing cluster, Type.1, *regressed*), labels are **29/29** faithful to
`leg2_key.json`, rule text is **27/27** verbatim, the metric recomputes exactly and the
full-ranking/threshold choice is conservative (does not favour `on`). Verdict: **PASS
legitimate but narrow.**

## Laundering caught + corrected (honest record)

I initially reported the decomposition with a **+0.517 "two-sided interaction"** headline
that "vindicates the code-side lever." That used the **micro** lens for the decomposition
while using the **macro** lens to defend the primary against near-duplicate inflation — an
inconsistent lens that inflated the code-side marginal ~2.6× via the very clusters I had
agreed to control for. The adversary cut it. The corrected, consistent (macro) reading:

| contrast | micro Δ@5 | **macro Δ@5 (honest)** |
|---|---|---|
| pure code-side (codeOnly − neither) | −0.034 | **−0.011** |
| pure rule-side (ruleOnly − neither) | −0.138 | **+0.111** |
| code-side GIVEN rule text (both − ruleOnly) | +0.517 | **+0.200** |
| rule-side GIVEN code text (both − codeOnly) | +0.379 | **+0.322** |

So: "neither side helps alone" is **false** (rule-side alone helps, +0.111 macro); the
interaction is **asymmetric**; **rule-side text is the primary driver**; code-side
descriptions are the **smaller, secondary** marginal (~+0.20 macro), and they *regress*
2 of 9 guidelines given rule text.

## Per-guideline hit@5 (off → on) — the decisive fine structure

| guideline | n | off | on | |
|---|---|---|---|---|
| ES.45 | 6 | 0 | 6 | improves |
| ES.42 | 5 | 0 | 4 | improves |
| ES.30 | 6 | 0 | 4 | improves |
| C.12  | 1 | 0 | 1 | improves (singleton) |
| Type.1| 6 | 6 | 2 | **regresses** |
| F.16  | 2 | 0 | 0 | floored |
| C.48  | 1 | 0 | 0 | floored |
| ES.20 | 1 | 0 | 0 | floored |
| ES.75 | 1 | 0 | 0 | floored |

Every improver starts at **0.0** off (opaque-ID baseline). 4 of 9 guidelines (5 of 29
items) are **never recalled@5 under any setting** — the embedder cannot surface them
regardless of descriptions. The aggregate rests partly on 4 singleton (n=1) guidelines.

## Licensed claim (stated stingily)

On this constructed, checker-decidable, opaque-ID C++-Core-Guidelines corpus (29 items /
9 guidelines / ~9 distinct situations), describing entities **materially lifts
cross-corpus recall@5 of the true code→rule match** (micro +0.38 / macro +0.31, monotone,
no leakage, faithful labels/text, conservative metric) — a genuine existence **floor**.
The decomposition shows **rule-side text is the primary driver**; authored **code-side**
descriptions add a **modest, fragile, conditional** marginal (~+0.20 macro @5), worthless
without rule text and negative on 2/9 guidelines.

**Does NOT license:** any field effect size (magnitude inflated by opaque IDs), a +0.52
code-side effect, a symmetric "need both" interaction, recall of the 4/9 guidelines the
embedder never surfaces, or anything about adjudication/precision/autonomous auditing.

## Disposition for nmemo-uhp.12.4

Gate PASSED per the pre-registered bar → the "HARD GATE" criterion is met, honestly and
adversarially verified. `EMBED_DESCRIPTIONS=on` is justified as the default for
cross-corpus audit ingestion (rules + code both described). The narrowness is recorded,
not laundered; the field-magnitude and code-side-primacy questions remain open and are
out of this gate's scope.
