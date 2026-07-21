# Doc 21 — Cross-corpus concept reconciliation: pre-registration

**Bead:** nmemo-uhp.25 · **Status:** PRE-REGISTRATION (committed before any number) · **Date:** 2026-07-21
**Discipline:** [[verify-empirical-gates]] — 17th empirical run on this feature family; the prior 16 produced
11 launder-catches in *both* directions. Every rule cited (R#) is from that memory. Nothing in §6–§10 may
change after the first number is computed (R1: no HARKing).

**Reads on top of:** doc-20 (the concept-JOIN gate that FAILED) and its frozen artifacts
(`concept-join-artifacts/cj-extracted.json`). This experiment does **not** re-extract; it runs one new
reconciliation step on the frozen extraction and re-scores against the same external oracle.

---

## 0. Why this experiment exists (the doc-20 failure, one level down)

doc-20's JOIN failed because the two corpora were extracted **in isolation and never reconciled**. The
frozen artifacts make the disease exact: of **61** distinct code-side concept labels and **50** rule-side,
**only 2 overlap by exact string** (`pointer-arithmetic`, `preprocessor-macro`). Everything else the two
Haiku passes named differently for the same mechanism. Sorting doc-20's 21 disconnected true pairs by *why*
(from `cj-analysis.md`, frozen):

| bucket | pattern | pairs | reachable by reconciliation? |
|---|---|---|---|
| **1 — vocabulary mismatch** | same mechanism, different word: `reinterpret-cast`≡`unsafe-cast` (all 6 Type.1), `macro-definition`≡`preprocessor-macro` (3× ES.30), `raw-pointer-arithmetic`≡`pointer-arithmetic` | **10** | **yes** — a true equivalence/is-a link connects them |
| **2 — related, not equal** | `constexpr-constant` is the *fix for* `magic-constant` (all 6 ES.45) | 6 | partly — needs a typed `addresses` link, more judgment |
| **3 — extraction miss** | code side never minted a relatable concept at all (F.16 param-passing, C.48/ES.20 init, ES.75 do-while) | 5 | **no** — no node to link to (upstream extraction problem) |

Bucket 3 is the pre-declared ceiling: reconciliation **cannot** reach those 5 pairs, because the concept
was never extracted. It caps recall independent of reconciliation quality, and §9 restates it before any
number.

## 1. The exact question

> Given the frozen doc-20 extraction, if a **single blind agent aligns the two concept vocabularies** —
> proposing typed cross-corpus relations (equivalent / is-a / addresses) between concept labels, seeing
> **both full vocabularies but never the code↔rule oracle** — does the **reconciled** concept-JOIN
> (traversing 1 hop over those relations) **recover toward cosine-level recall** as graded by the
> **external clang-tidy oracle**, *without* buying that recall through promiscuous over-alignment?

**Design choice that removes the need for any human labelling (R2/R31, and the user has declined to
label):** the agent proposes the alignments **itself** — candidates are **not** seeded by cosine. A
cosine-seeded design would make recall recovery near-tautological (an agent handed cosine's neighbours
merely re-accepts them) and would force a per-relation truth oracle to salvage a prize. By letting the
agent align blind and grading the *result* with the **external, concept-independent clang-tidy oracle**
(`trueGuideline`, fixed months before the concept layer existed), recall recovery becomes a **genuine**
measurement: a wrong alignment does not produce true hits against ground truth, so the external key — not
any person's or model's opinion — is the grade. No user labels, no me-as-judge, no LLM-opinion oracle in
the gating path.

**What is and isn't claimed:** a recovery is **not** a recall-win over cosine (cosine reaches bucket-3 via
raw-text embedding the concept layer discarded; §9 ceiling). The claim on PASS is narrow: *a blind
map-building agent run recovers most of the recall the isolation-extraction threw away, via alignments that
are committed and inspectable.* Auditability is delivered as **committed, human-inspectable bridges** —
not as a certified "N% true" count, because certifying that needs a truth oracle we chose not to staff.

## 2. What this does NOT test (scope fences, R8/R11)

- **NOT** "concept-JOIN beats cosine." doc-20 settled that (it doesn't); recall here targets *recovery
  toward* cosine, externally graded, with a pre-declared ceiling below cosine's full reach.
- **NOT** field prevalence. Constructed-floor recall, n=29 elements / 9 guidelines. The real-code field
  run stays owed.
- **NOT** ingest-time generation or usage-driven self-conformance — the user scoped both out of this first
  test. This measures **one reconciliation agent run** on frozen extraction, nothing continuous.
- **NOT** a fix for bucket-3 extraction misses (pre-declared unreachable, §0/§9).
- **NOT** a certified per-relation truth rate — the bridges are committed for inspection, not oracle-graded.

## 3. Frozen inputs (immutable — extraction does NOT re-run)

From `concept-join-artifacts/cj-extracted.json`, verbatim:

- `codeConcepts[E###].labels` → each code element's extracted concept labels (blind: raw code only).
- `ruleConcepts[R].labels` → each rule's extracted concept labels (blind: guideline text only).
- 29 code elements, 27 rules, 9 true guidelines. External oracle = `trueGuideline` (clang-tidy; R6/R31/R44),
  read from `cj-results.json` `oracleKey` (element → true guideline).
- doc-20's fixed comparison points: cosine macro@5 = **0.467**, BM25 = 0.433, un-reconciled JOIN = **0.256**.

Re-running extraction is **prohibited** (R26): a fresh extraction would confound "did reconciliation help"
with "did extraction drift." Reconciliation is a pure function of the frozen concept label sets.
**Scoring is DB-free** — computed directly from the frozen artifacts + the sealed oracle — so no live-DB
drift (a known hazard) can touch the numbers.

## 4. The pipeline under test

**Step A — blind agent alignment (Haiku, one deterministic-tempered run).**
The agent is given the **two full concept-label vocabularies** (61 code labels, 50 rule labels) plus the
injected decoys (§5), shuffled, with **no** element text, **no** guideline text, **no** candidate
provenance, and **no** oracle. Task: for each rule concept, list the code concepts (if any) that name the
same or a directly related mechanism, with a typed relation and a one-line rationale:

- `equivalent` — same concept, different word (`unsafe-cast` ≡ `unsafe-casting`).
- `specializes` (is-a) — `reinterpret-cast` is-a `unsafe-cast`.
- `addresses` — `constexpr-constant` is the fix/counterpart for `magic-constant`.
- (omit / no row) — unrelated.

Output frozen to `cr-relations.json`: every asserted relation `(code_label, rule_label, type, rationale)`.
Batched to fit context; the batching is content-blind (alphabetical) and pre-registered, never re-ordered
after seeing results.

**Step B — reconciled JOIN scoring (deterministic, no LLM, DB-free).**
`Score(E, R)` = count of `(c_i ∈ codeConcepts[E], r_j ∈ ruleConcepts[R])` pairs that are **either** the same
label **or** joined by an agent relation ∈ {equivalent, specializes, addresses} (1 hop). Rank the 27 rules
by score; recall@k vs `trueGuideline`. Ties broken **against** the true rule (doc-20 §7). Report
exact-label-only vs +1-hop separately so the relations' contribution is isolated.

**Step C — metrics** (§6), bootstrap CIs (§8), decoy + density guards (§5), all persisted.

## 5. Anti-leak + discrimination controls (each maps to a prior catch)

- **Agent blind to the recall oracle (R41/R48).** It aligns concept↔concept only; it never sees which code
  element maps to which rule. The recall ground truth (element→guideline) is a *different relation* than
  what it operates on (concept→concept). The adversary must confirm from the actual `cr-relations.json`
  inputs that no element/rule/oracle text was passed.
- **No cosine seeding (R36).** Candidates are agent-proposed, not embedding-nearest, so recall recovery is
  not a cosine tautology. The adversary must confirm no embedding/oracle signal entered Step A.
- **Decoy discrimination (R43, the Leg-5 hollow-control test).** Inject **10** decoy code concepts —
  real C++ terms orthogonal to all 9 guidelines (`thread-mutex-lock`, `virtual-destructor`,
  `lambda-capture`, `signal-handler-registration`, `network-socket-timeout`, `template-metaprogramming-recursion`,
  `atomic-compare-exchange`, `coroutine-suspension`, `rvalue-reference-forwarding`, `stack-unwinding`) —
  into the code vocabulary, shuffled in. The agent must align **≤ 1 of 10** to any rule concept. A
  reconciler that relates orthogonal concepts is promiscuous and its real alignments are suspect.
- **Density cap (R43).** The agent may assert relations on **≤ 15%** of the 61×50 = 3050 cross pairs
  (≤ 457). Exceeding the cap is a promiscuity FAIL: recall bought by connecting everything, not by judgment.
- **Plumbing invariant (R40).** Reconciliation adds edges over existing labels; the 29 code / 27 rule
  elements and their concept sets are unchanged. Asserted and printed before any recall number.
- **Persist everything (R15).** `cr-alignment-input.json` (exact vocab + decoys as the agent saw them),
  `cr-relations.json` (agent output + rationales), reconciled per-element ranks, the scorer, the sealed
  oracle → committed under `concept-join-artifacts/`, independently re-scorable.

## 6. Primary metrics and the bar (frozen — R1)

Primary metric = **macro** recall@5 (per-guideline mean, doc-20 §6 lens), externally graded. **PASS
requires BOTH:**

1. **Recall recovery (externally graded).** Reconciled JOIN macro@5 **≥ 0.40** AND **≥ un-reconciled JOIN
   (0.256) + 0.10 = 0.356** (reconciliation demonstrably lifted recall toward the doc-20 perfect-resolver
   ceiling of 0.444 and cosine's 0.467). Reported beside cosine; recovery, not a win over cosine (§1).
2. **Discrimination guard (construction-based, no labelling).** Agent aligns **≤ 1/10** decoys to any rule
   concept **AND** asserts relations on **≤ 15%** of cross pairs. Recall must not be bought by promiscuity.

**Secondary (reported, not gating):** exact-label-only vs +1-hop recall (the relations' marginal
contribution); micro recall@k; per-guideline table with the bucket-1/2/3 reconnection breakdown;
recall@{1,3,8}; count of asserted relations by type; the committed bridges for qualitative inspection.

## 7. Frozen operational definitions (R26)

- **Relation set:** {equivalent, specializes, addresses}; all three count as a 1-hop bridge. No 4th type
  added post-hoc.
- **Traversal depth:** 1 hop only. Transitive closure is a *later* variant, not this gate.
- **Decoys:** the 10 listed in §5, seeded shuffle (mulberry32, seed frozen in harness). Threshold ≤ 1/10.
- **Density cap:** ≤ 15% of 3050 = ≤ 457 asserted relations.
- **k set:** {1,3,5,8}; primary k = 5. **Ties:** against the true rule (doc-20 §7).
- **Bar thresholds (0.40 / 0.356 / ≤1-of-10 / ≤15%):** frozen here, before Step A runs.
- **Agent model:** Haiku (Haiku-first, [[feedback_haiku_first]]); default prompt; temperature low/fixed.
- **Bug policy:** a bug found mid-run is fixed in code and the **whole run re-executed**; thresholds never
  move (R26).

## 8. Statistics (R25/R30/R33/R39)

- **Paired bootstrap** (resample the 9 guidelines, 10k, seeded) for reconciled-JOIN − cosine and
  reconciled − un-reconciled macro@5; report point + 95% CI. At n=9 the CI is wide (doc-20: ±0.3); **an
  underpowered CI is reported as "underpowered," never spun** (R39/R50 — compute the CI the pre-reg
  specifies, not a harsher/looser convenient variant).
- **Report the quantum** (1/9 = 0.111) beside every macro delta; flag deltas < 2 quanta as singleton-fragile.
- **Shared-prior note (R33):** extraction AND alignment are both Haiku. If the same model that emitted
  `reinterpret-cast` on one side and `unsafe-cast` on the other now "recognizes" they match, that is a
  shared-prior consistency effect, not independent corroboration. Stated in the verdict; the external
  recall grade is what keeps the result meaningful despite this.
- **Both directions (R29):** the adversary is tasked as hard on a PASS as on a FAIL.

## 9. Pre-committed honest priors (so neither outcome is rationalised after the fact)

- **Pre-declared ceiling (bucket 3).** 5 true pairs are extraction-unreachable (§0). Even a perfect
  aligner leaves them missed; they cap reconciled JOIN below cosine's full reach. A residual gap to cosine
  **entirely explained by these pre-listed pairs** is a reconciliation success with an extraction TODO —
  **not** a reconciliation failure. A gap *larger* than bucket 3 explains is a real reconciliation miss.
- **Plausible PASS:** the agent accepts the 10 bucket-1 equivalences + several bucket-2 `addresses`
  relations, rejects decoys, stays under the density cap; recall climbs from 0.256 toward ~0.44. → auditable
  recovery, bridges committed.
- **Plausible FAIL (recall):** the agent is too conservative or names mechanisms differently again; recall
  barely moves. Reported as a fail.
- **Plausible FAIL (promiscuity / the cheat):** the agent aligns liberally, recall shoots up, but it aligns
  decoys and/or blows the density cap. Recall bought by over-alignment. §6.2 catches this → FAIL. **This is
  the most dangerous outcome to launder** (a recall number that flatters) and is exactly why the density +
  decoy guards gate alongside recall.
- **Plausible "cosine already does it":** if the +1-hop lift over exact-label-only is small and the agent's
  alignments merely mirror embedding similarity, the auditability is decorative. Reported honestly via the
  exact-vs-1-hop decomposition.

## 10. No-labelling grading (the resolved oracle question)

The user has declined to hand-label, which removes the per-relation truth oracle. The gate is therefore
built to need **none**:

- **Recall is graded by the external clang-tidy oracle** — the same concept-independent key doc-20 used,
  fixed before the concept layer existed. This is the load-bearing grade and requires no judgement.
- **Discrimination is construction-based** — decoy rejection + density cap are mechanical.
- **Auditability is delivered as committed artifacts, not a certified count** — `cr-relations.json` (every
  bridge + rationale) is committed for anyone to inspect; the doc claims no truth rate over it.

Consequence, stated plainly (R7): this gate can show the reconciliation agent **recovers recall without
promiscuity**, but it **cannot certify each bridge is semantically true**. If a future question needs that
certification, it requires ≥2 independent expert labellers (the doc 09 §27 standard), not this run.

## 11. Blind-adversary protocol (R2, mandatory before any claim)

After the run, a fresh subagent **not seeded with the verdict**, given this pre-reg + all artifacts + the
raw numbers, tasked to break the claim:

1. **Oracle leak** — did Step A see any element/rule/oracle text, or only concept labels + decoys? Inspect
   the actual `cr-alignment-input.json`.
2. **Promiscuity check** — is the recall lift explained by sound alignments, or by density near the cap /
   decoy contamination? Recompute density and decoy rate independently.
3. **Ceiling honesty** — is the residual gap to cosine within the pre-declared bucket-3 pairs, or larger?
4. **Marginal-contribution check** — does +1-hop beat exact-label-only, or are the relations decorative?
5. **Plumbing** — concept sets unchanged, 29/27 intact (R40); scorer is DB-free and re-derivable.
6. **Stats** — is the recall delta a singleton swing (R39)? Are the bootstrap CIs the pre-registered
   arm-vs-arm ones (R50), not a harsher/looser variant?
7. **Direction (R4)** — the aligner answers concept→concept; recall answers element→guideline. Confirm the
   win isn't smuggling one for the other.
8. **Over-claim scan** — does the write-up claim a recall *win* over cosine, or a certified bridge-truth
   rate? Either is a FAIL of §1/§10 scope and must be cut.

The adversary's verdict is reported **even if it retracts the result** (R3); docs/bead/memory corrected
immediately. Per R49, if the adversary's cut rests on an un-run measurement, that measurement is run before
concluding.

## 12. Disposition rule (decided now, before numbers — R32)

- **PASS** (both §6 bars + adversary clears): a blind cross-corpus reconciliation agent **recovers recall
  the isolation-extraction discarded, without promiscuity, via committed inspectable bridges** — licensing
  "a map-building agent run after both corpora ingest" as the mechanism the user proposed, and licensing
  the concept-JOIN as an *explainable* recall path (recovery toward cosine, plus a named 1-hop reason
  cosine lacks). Field prevalence, per-bridge truth certification, and the continuous/self-conforming
  pieces remain owed and unclaimed.
- **FAIL (recall floor):** the vocabulary gap exceeds what a single blind alignment run can close; the
  map-building agent is not yet a recall mechanism. Concept layer stays shipped as-is (doc-20 §12 FAIL
  branch stands).
- **FAIL (promiscuity):** reconciliation *can* inflate recall but only by over-aligning; its alignments are
  not trustworthy and autonomous reconciliation is disqualified pending a precision fix. A MORE informative
  failure than the recall floor — must not be softened into it.

All outcomes leave the code shipped; only the *claim* and the *licensed mechanism* differ — the thing under
test (R32).

---

## 13. RESULT (2026-07-21) — GATE PASS on the frozen bar; blind adversary = QUALIFIED-HOLD

Run: `platform/src/test/tools/concept-reconcile-recall.ts` (blind Haiku alignment, provider=claude, DB-free).
Artifacts frozen in `concept-join-artifacts/`: `cr-alignment-input.json` (exactly what the agent saw),
`cr-relations.json` (27 typed relations), `cr-results.json`. Plumbing clean; baseline reproduces doc-20.

**Macro recall@k:**

| arm | @1 | @3 | @5 | @8 |
|-----|----|----|----|----|
| JOIN baseline (un-reconciled) | 0.237 | 0.256 | **0.256** | 0.256 |
| JOIN **reconciled** | 0.159 | 0.311 | **0.444** | 0.444 |
| cosine (doc-20) | 0.259 | 0.337 | **0.467** | 0.626 |

- **cond1 recall recovery — PASS:** reconciled macro@5 = **0.444** ≥ 0.40 and ≥ 0.356. Connectivity
  8/29 → **18/29**. Lift over baseline +0.190 (95% CI **[0.000, +0.444]** — touches 0, underpowered at n=9;
  the absolute 0.40 floor carries the PASS, **not** the lift's significance).
- **cond2 discrimination — PASS:** **0/10** decoys aligned; density **0.89%** (27 relations / 3050 ≤ 15%).
- **vs cosine:** −0.021, 95% CI **[−0.389, +0.319]** → a **statistical TIE**, not a win. Reconciliation and
  cosine are **complementary**: JOIN wins ES.42 (1.0 vs 0.2) and ES.30 (1.0 vs 0.5); cosine wins ES.45
  (0.83 vs 0) and F.16 (1.0 vs 0).

**Per-guideline @5 (baseline → reconciled [cosine]):** C.12 1→1 [1] · ES.30 0.5→**1** [0.5] · ES.42 0.8→**1**
[0.2] · Type.1 0→**1** [0.67] · ES.45 0→**0** [0.83] · C.48/ES.20/ES.75/F.16 0→0 (bucket-3, pre-declared).

**Blind adversary verdict: QUALIFIED-HOLD** (agent afb0ae23). It re-derived every gating number from the
raw artifacts (baseline 0.2556/8-29, reconciled 0.4444/18-29, both CIs, guards) — all reproduced. It
confirmed:

- **No leak.** `vocabA` = the 61 code labels + 10 decoys exactly; `vocabB` = 50 rule labels exactly. Zero
  element/rule/oracle/cosine text reached the agent (§5 verified on the actual input, not the prompt).
- **Recall bought honestly (the opposite of hollow).** Stripping **all 11** questionable relations → still
  0.444. Stripping **all 6 `addresses`** relations → still 0.444. Keeping **only the 10 sound bucket-1**
  synonym relations → still 0.444. Every questionable relation points at a **distractor** rule (no
  element's true guideline), so it can only add tie-competition, never buy a hit. The three gains are
  exactly the pre-registered bucket-1 pairs: `reinterpret-cast→unsafe-cast/type-punning` (Type.1),
  `macro-definition→preprocessor-macro/macro-constant` (ES.30), `raw-pointer-arithmetic→pointer-arithmetic`
  (ES.42).
- **Conservative tie-break confirmed:** the favorable tie-break would give macro@5 = 1.0; the pre-registered
  "against true rule" break gives 0.444. The reported number is the pessimistic floor.

**The adversary's binding qualifications (all folded into the disposition below):**

1. **Synonym-only recovery.** *All* recovery is `equivalent`/`specializes` synonym bridges on 3 guidelines;
   the `addresses` (fix-counterpart) relation type contributed **zero**. The gate does **not** validate
   typed-relation richness — only synonym-level vocabulary re-joining.
2. **Bucket-2 recovered nothing.** ES.45 (magic-constant) stayed **0/6** vs cosine 0.83 — §9 "plausible
   PASS" hoped for bucket-2 `addresses` recovery and got none. Reconciliation reached exactly the
   **bucket-1-only** perfect-resolver ceiling (0.444), no further.
3. **recall@1 REGRESSED** 0.237 → **0.159**: the added bridges create score ties and the conservative
   tie-break pushes the true rule behind them. The headline @5 hides a precision-at-1 cost.
4. **Guards are weak by design** — decoys wholly off-topic (0/10 is a trivial test), the 15% cap is ~17× the
   observed 0.89%. The real discrimination evidence is the *observed restraint* (27 relations, questionable
   ones non-load-bearing), not the guard thresholds being hard.
5. **Same-model circularity.** The same Haiku extracted *and* aligned — this is intra-model consistency
   recovery (a model re-joining a vocabulary it earlier split). The external clang-tidy oracle neutralizes
   the *correctness* worry (a wrong re-join scores nothing against ground truth) but does **not** establish
   cross-model or genuine two-source generality — **untested**.
6. **Haiku non-determinism:** an earlier run gave macro@5 0.481, this frozen run 0.444; both clear 0.40, so
   the PASS is stable to the variance, but the frozen artifact is one sample.

**Mid-run fixture fix (disclosed, R26):** one original §5 decoy, `virtual-destructor`, collided with a real
rule concept (C.35 distractor) and so could not test promiscuity; replaced with `regex-backtracking`
(verified absent from both vocabularies) and the run redone. Recall is provably independent of the decoy
set (no code element exhibits any decoy label), so this cleaned the guard without touching the recall
number. A `badDecoys` assertion now fails the harness fast if any future decoy collides.

**What this licenses (§12 PASS branch, narrowed to the adversary's scope):** a blind cross-corpus
**map-building agent run** — the mechanism the user proposed — **recovers the bucket-1 synonym-vocabulary
recall that isolated extraction discarded**, externally graded by clang-tidy, without promiscuity, via
committed inspectable bridges (`cr-relations.json`). It closes doc-20's core wound (only 2 exact-string
overlaps → 18/29 connectivity) for the synonym case.

**What it does NOT license:** (a) NOT a recall *win* over cosine — it's a tie; cosine still strictly wins
where raw-text embedding beats concept vocabulary (ES.45, F.16). (b) NOT typed-relation value — `addresses`
and bucket-2 conceptual-relatedness delivered nothing here. (c) NOT recall@1 (it regressed). (d) NOT
cross-model / real-two-source generality (same-model circularity, untested). (e) NOT field prevalence
(n=29/9 guidelines, constructed floor). (f) NOT any per-bridge truth certification (no truth oracle was
staffed — §10); the bridges are committed for inspection, not certified.

**Net:** the user's diagnosis was right and the fix works *for the failure mode it targets* — synonym-level
vocabulary drift between independently-extracted corpora. That is a real, externally-graded recovery from
0.256 to 0.444. It is not yet a general cross-corpus recall engine, and the next honest steps (cross-model
alignment, bucket-2/conceptual relatedness, field prevalence, recall@1) each need their own pre-registration.
