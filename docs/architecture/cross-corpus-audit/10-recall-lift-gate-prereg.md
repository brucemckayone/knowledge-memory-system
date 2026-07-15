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
