# Doc 14 — Service recall-lift acceptance: pre-registration

**Status:** PRE-REGISTERED (frozen before any number is produced). Bead nmemo-uhp.17.4.
The acceptance gate for the element-description authoring convention (doc 13). This
is committed BEFORE the harness runs — same distrust-the-author discipline as docs
10–12 (blind authoring, one consistent macro lens, hostile adversary before any claim).

## 1. What is new here (vs docs 10–12)

Doc 11 showed hand/subagent-authored *faceted* code descriptions beat one-line prose
by ~+0.35 macro recall@5 — but that text was authored ad hoc and loaded from JSON.
Docs 10–12's recall behaviour on this corpus is therefore ALREADY KNOWN; this gate
does not re-discover it. The narrower, still-open question is:

> Does the **built .17 authoring path** — `authorElementDescription` (a Haiku call,
> blind to the rule set) → `composeFacetedDescription` — reproduce the
> faceted-beats-plain recall lift, and does it hold on a **held-out** guideline split?

i.e. does the code we shipped, not just some hand-written dense text, produce
recall-lifting descriptions.

## 2. Method (frozen)

- **Code faceted (the thing under test):** author a description for each of the 29
  gate code items via the production `authorElementDescription` service (Haiku via
  ml.generateJson, blind — the prompt sees only the code + the generic domain, never
  a rule). Authored ONCE and FROZEN to
  `recall-gate-artifacts/gate_code_service_facets.json` (disclosed limitation: a
  one-shot LLM sample; the recall measurement over the frozen artifact is
  deterministic).
- **Code plain (baseline):** the existing doc-10/11 plain one-liners
  (`gate_code_desc.json`), unchanged.
- **Rule side held FIXED** = the one-liner (`gate_rules.json`), isolating the
  code-side description as the single variable (doc 11 showed the rule `richer` axis
  is within noise).
- **Rig:** reuse the doc-11/12 machinery verbatim — production `entityEmbedTextFor`
  (`name\n<description>`) + `ml.embed` (nomic-embed-text) + the deterministic
  conservative rank (a candidate's rank = count of candidates with score ≥ its score;
  ties count AGAINST the true rule). Score recall@k for k∈{1,3,5,8}, MICRO (per-item,
  n=29) and MACRO (per-guideline mean, 9 guidelines).
- **Held-out split:** the 9 guidelines are partitioned by a fixed seed (17) into
  HELD-OUT (the subset the pass/fail decision reads) and TRAIN (inspected freely). The
  split is committed in the results artifact.

## 3. What "pass" means (frozen)

- **Primary metric: MACRO recall@5** (the honest lens; micro is near-duplicate
  inflated — doc 10 rule 35).
- **PASS iff BOTH:**
  1. **HELD-OUT:** `faceted macro@5 − plain macro@5 ≥ +0.10` (point estimate). Held-out
     n is small (≈4–5 guidelines, some singletons), so the held-out decision is a
     margin on the point estimate, not a powered CI.
  2. **FULL CORPUS (n=9, the powered test):** the paired bootstrap (5000 iters, seed
     12345, resampling guidelines) 95% CI of the `(faceted − plain)` macro@5 delta has
     **lower bound > 0**.
- **Report ALL cells** — no cherry-picking: macro + micro at every k, for full /
  held-out / train, both formulas.

## 4. Mandatory disclosures (not pass conditions — context)

- **Lexical baseline (rule 36):** report the no-embedding lexical recall (token-Jaccard
  AND textbook BM25, same frozen tokenizer as doc 12) for both formulas. Doc 11 found
  the faceted lift is **largely lexical** (dense MISRA vocabulary matching keyword-dense
  rule text). This gate confirms the *convention produces recall-lifting text*; it does
  NOT claim a semantic-embedding win. The lexical baseline quantifies how much is
  lexical vs embedding, exactly as doc 11 did.
- **Floored-rescue:** report how many of the 4 singleton guidelines
  (`F.16, C.48, ES.20, ES.75`) the faceted formula hits @5, flagged as singletons (a
  single item swinging the macro mean — doc rule 39).
- **This measures the EMBEDDING leg**, i.e. the pure-vector `recallCrossCorpusCandidates`
  cosine — the specific leg element descriptions move. It is NOT the full
  graph-mediated recall (relationship traversal), and the embedding is the weakest leg
  (doc 09 §1). No claim beyond the embedding leg.

## 5. Adversary (pre-committed, before any claim)

A blind hostile subagent, given the frozen faceted descriptions + the harness + the
results:
1. **Leakage battery** on the SERVICE-authored faceted text: did Haiku leak a rule id /
   standard name / rule paraphrase despite the blind prompt (making a match circular)?
   Per-item token overlap with the true rule vs other rules; `detectRuleReferences` scan.
2. **Artifact check:** is any "pass" driven by opaque dotted-ID matching, a near-dup
   cluster, or a singleton guideline swinging the macro mean?
3. **Lexical vs embedding:** re-derive whether the lift survives with the embedding
   removed, and state plainly which leg the effect lives on.
4. **Held-out honesty:** was the held-out subset genuinely untouched, or does the split
   or bar look reverse-engineered to pass?

## 6. Pre-committed caveats — what a pass does and does NOT license

- Still a **constructed-corpus FLOOR:** opaque dotted-ID rule names, checker-decidable
  slice, n=29 / 9 guidelines / 4 singletons. Absolute magnitudes do NOT transfer; the
  ranking (faceted ≫ plain) does. Docs 10–12 §caveats carry.
- **Licenses (on pass):** adopting the .17 authoring convention as the cross-corpus
  ingest default, and the claim "the built authoring service produces descriptions that
  lift embedding-leg recall over plain prose on this corpus."
- **Does NOT license:** a field-magnitude recall number, a semantic-embedding claim
  (the lift is largely lexical), a full graph-mediated-recall claim, or any
  adjudication / precision / coverage / autonomous-auditor claim. Hybrid retrieval
  (bead .18) is a separate, complementary gate.
- **A FAIL is a legitimate, reportable outcome** (e.g. Haiku facets too thin to reach
  the bar). No tuning to pass; report the failure and its cause.
