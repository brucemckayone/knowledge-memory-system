# Doc 25 — Controlled-vocab extraction with a relevance-preserving window: pre-registration

**Bead:** nmemo-r0o follow-up (new bead to file) · **Status:** PRE-REGISTRATION — frozen before any number
**Date:** 2026-07-22 · **Discipline:** [[verify-empirical-gates]] (21st run). Committed to git BEFORE the run.
Bars inherited verbatim from doc-23 §5.1 (unchanged). Autonomous `/goal` session (keep testing mechanisms).

---

## 0. Where doc-24 left it (the precise reason this experiment exists)

doc-24 ran three arms; all FAILed the gate. The blind adversary reproduced every number and delivered a
**load-bearing correction**: Arm B (controlled-vocabulary extraction) genuinely cut explosion **43%** (10× the
naive arms) with over-merge controlled (**96.5%**), but its verbatim-conform FAIL (0.36) was **substantially a
harness artifact** — the **MRU-500 vocab cap**. The cap triggered on all 15 verbatim probes; the probes'
base-twins are the *oldest* base docs, so recency-based eviction dropped 38 twin labels out of the window
before re-extraction. The extractor cannot reuse a label it is never shown. 9/20 verbatim new nodes are
token-variants of evicted twins. Adversary estimate: uncapped, cond3's verbRatio falls 0.36 → 0.05–0.20.

So the artifact-free FAIL reason for Arm B is **cond1 growth-saturation (0.72 > 0.5)**, not cond3. This gate
tests the fix the adversary named: **choose the shown vocabulary window by RELEVANCE, not recency.**

## 1. Claim under test
Replacing the MRU-500 recency window with a **relevance-preserving retrieval window** (show the extractor the
embedding-nearest existing concept labels for the current document) will:
- **(primary) recover cond3** — a verbatim duplicate's twin labels are maximally relevant to its identical
  text, so they are retrieved regardless of age → the extractor can reuse them. Confirms the cap-artifact
  diagnosis if verbRatio drops toward ≤0.10.
- **(secondary) possibly improve cond1 growth** — late documents shown their most-relevant existing labels
  (not a stale recency slice) may reuse more in the tail, pushing new-nodes-per-doc down over quartiles.
- **(risk) possibly worsen cond2** — a tighter, relevance-biased window could surface a base label that a
  distinct-field concept then latches onto. Watched.

## 2. Mechanism (Arm R — frozen; the ONLY change vs doc-24 Arm B is window selection)
Sequential controlled-vocabulary extraction, identical to Arm B **except** how the shown window is chosen:
1. Maintain vocab V of canonical labels, each with a stored nomic-embed embedding (embed a label once, when
   first coined).
2. For each document (stream order base→verbatim→paraphrase→distinct, same corpus): **embed the document
   text**; retrieve the **top-K = 100** existing labels by cosine(docEmb, labelEmb); show exactly those as the
   candidate vocabulary. (When |V| ≤ 100, show all — no retrieval needed.)
3. Haiku extracts 4–10 concepts; for each, reuse an EXACT shown label if the concept already exists, else coin
   a new kebab label. Conform = returned label ∈ V (exact match); grow = new label → coin, embed, append to V.
4. No thresholds, no separate judge (identical to Arm B). Node identity = the canonical label.

**Frozen knobs:** K = 100 (relevance window). Note this is *smaller* than Arm B's 500 — so if relevance@100
beats recency@500 on cond3, the smaller-but-smarter window wins, which is the stronger result. Retrieval is
doc-embedding → label-embedding cosine (accepted granularity mismatch; if retrieval misses that is itself a
finding about doc-level retrieval). Extraction prompt = Arm B's `vocabPrompt`, unchanged, fed the retrieved 100.

## 3. Bars (inherited verbatim from doc-23 §5.1 — frozen, unchanged)
PASS iff all three: **cond1** reduction ≥40% AND growth Q4/Q1 ≤0.5; **cond2** distinct-field stay-separate
≥90%; **cond3** verbatim new/doc ÷ fresh new/doc ≤0.10. Free-form baseline denominator = 906 (same corpus).

## 4. What each outcome means (registered before the run)
- **cond3 recovers (verbRatio ≪ 0.36, ideally ≤0.10) while reduction/cond2 hold:** confirms the doc-24 cond3
  FAIL was the MRU-cap artifact; the mechanism conforms duplicates correctly with a relevance window. Whether
  the *gate* passes then rests on cond1 growth.
- **cond1 growth also drops ≤0.5:** all three pass → **exploratory WIN** (first mechanism to clear the gate) →
  triggers the pre-registered held-out confirmation (astro-ph.GA base / cs.CL distinct, fresh fetch) before any
  capability claim. NOT banked without held-out (doc-24 §4 rule).
- **cond3 recovers but cond1 growth stays >0.5:** the artifact is confirmed and the mechanism conforms
  duplicates, but same-field prose still doesn't saturate at 120 docs → the growth bar's appropriateness at
  this corpus size becomes the open question (a larger-corpus gate), NOT a mechanism verdict.
- **cond3 does NOT recover:** the doc-24 "residual non-determinism" reading was right after all and the cap was
  a red herring — the extractor coins variants even when shown the relevant twin labels. Report the retraction.

## 5. Anti-launder controls
- **Only ONE variable changes vs Arm B** (window selection: recency@500 → relevance@100); everything else
  (corpus, prompt, conform rule, bars, stream order) is byte-identical. Clean isolation.
- **Bars inherited verbatim** from doc-23 §5.1; pre-reg + harness committed to git **before** any number.
- **Prediction registered above** (cond3 recovers) so a null result is a real, reportable retraction.
- **No winner banked without held-out** (doc-24 §4). A gate PASS here is exploratory until the held-out run.
- **Persist per-doc decisions + retrieved windows** → the adversary can verify each verbatim doc's twin labels
  were actually in the retrieved window (the crux of the artifact claim).
- **Report both directions** (R3): if cond3 recovers, do not oversell — cond1 growth likely still fails; if it
  doesn't recover, state the doc-24 correction was wrong.

## 6. Blind-adversary protocol
Fresh subagent: independently recompute Arm R's four metrics from its per-doc log; confirm the corpus is the
same frozen file; confirm the ONLY code difference vs Arm B is window selection (diff the harness); **verify
the retrieval window genuinely contained the verbatim twins' labels** (open ≥3 verbatim docs, confirm the
top-100 retrieved for that doc included its base-twin's canonical labels — the mechanism the recovery is
attributed to); check no NEW artifact was introduced (e.g., K=100 accidentally excluding needed labels for
base docs, inflating growth); check reuse is still genuine not lumping; check no bar swapped, no winner banked
without held-out. Verdict even if it retracts.

## 7. Disposition
Names the outcome per §4. This remains one field, one modality; controlled-vocab extraction's viability as the
product's convergence mechanism rests on (a) cond3 recovery here, (b) a resolution of the growth-saturation
bar (this run or a larger-corpus gate), and (c) eventual held-out + multi-field generality — each its own gate.

---

## 8. RESULT (2026-07-23) — Arm R GATE FAIL; adversary QUALIFIED; cond3 residual is ANOTHER window artifact

Arm R (relevance-window, K=100) ran on the frozen corpus. Blind adversary independently replayed it from raw
data (**0/162 perDoc mismatches**) and audited the interpretation. Verdict: **numbers SOUND, interpretation
QUALIFIED** — my central "genuine non-determinism floor" claim was **retracted**. Artifacts:
`convergence-artifacts/cv2-results-armR.json`, `rel-window-log.json` (the exact window shown per doc).

| metric | Arm B (MRU-500) | Arm R (relevance-100) | bar |
|---|---|---|---|
| explosion reduction | 43.2% | **46.7%** (483/906) ✓ | ≥40% |
| growth ratio Q4/Q1 | 0.72 (154→111) | **0.72** (149→107) | ≤0.5 ✗ |
| distinct stay-separate | 96.5% | **95.0%** (6/119) ✓ | ≥90% |
| verbatim ratio | 0.36 | **0.19** (0.67/3.57) | ≤0.10 ✗ |
| **gate** | FAIL | **FAIL** (c1,c3) | |

Corpus byte-identical (sha256 `d1af6fc4…`, unchanged since doc-23), pre-reg `a4ec317` frozen before the result
`eb6573f`, and the only harness difference vs Arm B is window selection (conform/prompt/metric/corpus identical)
— **plus** window *size* (100 vs up-to-500), a confound noted below.

### What holds
- **The MRU-cap artifact was real (doc-24 claim a confirmed).** Switching recency→relevance nearly halved
  verbatim leakage (0.36 → 0.19) with no other change. The window genuinely mattered.
- **Growth-saturation is the robust, window-independent blocker.** Arm B 0.721 (154→111) vs Arm R 0.718
  (149→107) — near-identical, both ≈4× over the ≤0.5 bar. No window choice touches it. This is the binding
  reason controlled-vocab extraction FAILs the gate. (Scope: "window-independent," since only two window
  mechanisms were tested.)
- **cond2 PASS is sound, even conservative.** Of the 6 distinct-field "over-merges," ~4 are *legitimate*
  cross-domain concept shares (`epistemic-uncertainty`, `semiparametric-inference`, `prediction-calibration`,
  `uncertainty-coverage`); only 2 are genuine homonym errors exact-match can't catch (`fir-deconvolution` =
  far-infrared vs finite-impulse-response; `diachronic-morphology` = galaxies vs oracle-bone-script). True
  separation is if anything >95%.

### What was RETRACTED (adversary's load-bearing correction)
My write-up claimed a **"genuine residual non-determinism floor" — "even shown the relevant twin labels, the
extractor coins ~0.67 fresh labels per identical re-read."** The raw `rel-window-log.json` **contradicts** it:
- Top-100 window **coverage of a verbatim doc's own twin labels = only 72%** — for byte-identical text, 28% of
  the twin's labels were never shown.
- Of 31 twin labels the verbatim re-read failed to reproduce, **27 (87%) were NEVER in the window**
  (retrieval-miss); only **4 were shown-but-not-reused** (the sole clean non-determinism signal).
- Of the 10 verbatim fresh labels, **0** came from a doc with full twin coverage; **10/10** came from docs with
  ≥1 twin label hidden. On the 2 docs where the full twin set *was* shown, fresh = **0**. Smoking gun: doc
  `18199` coined `[perplexity-based-selection, task-aware-selection, budget-aware-selection]` while its twin's
  `[perplexity-scoring, task-aware-scoring, budget-allocation]` were **all hidden** — rewordings of concepts
  whose canonical label simply wasn't shown.

So the residual 0.19 is **dominated by a K=100 retrieval-miss — the same *class* of window artifact as the
MRU-cap, relocated from recency-eviction to relevance-ranking-eviction.** A genuine non-determinism component
exists but is a **minority (≤4 label-events), unquantified**, and this design **cannot isolate it** because
K=100 confounds it. **I have NOT run the test that could establish a floor** (uncapped / full-vocab, or larger-K,
verbatim re-read — the prior adversary's actual spec). Predicted: verbRatio drops further as the 27 hidden twins
re-enter the window. The "~half genuine" claim in the commit was an unquantified guess and is withdrawn.

### Both directions
- **Over-optimism:** this is the **5th consecutive GATE FAIL** (0/A/B/R). "Best reduction yet" (43→47%) moves a
  sub-metric that *already cleared* its ≥40% threshold in Arm B; cond1 fails on **growth**, which reduction
  cannot rescue. Real but strategically irrelevant.
- **Over-pessimism (the one I actually committed this time):** I over-claimed an *irreducible* limit ("genuine
  floor") that the shown-window log refutes — a pessimistic over-reach, banked before checking the log. Corrected.

### Net + next (NOT run this session — user paused after Arm R)
Across five arms the honest state is:
1. **Extraction front-end is the bottleneck** (graph/JOIN/judge are fine) — holds since doc-23.
2. **Embedding representation is not it** (Arm A, clean negative).
3. **Controlled-vocab extraction is the right lever** — ~43–47% explosion reduction, over-merge controlled.
4. **cond3 (verbatim conform) is a WINDOW-COVERAGE problem, not proven intrinsic** — improved 0.47→0.36→0.19 as
   the window improved (recency→relevance); the remaining leakage is mostly labels-not-shown. **Next test:
   uncapped / full-vocab (or K≥ vocab) verbatim re-read** to find the true non-determinism floor.
5. **cond1 growth-saturation (~0.72) is the deep, window-independent blocker** — the real open question: does
   same-field prose genuinely saturate at 120 docs (then the ≤0.5 bar needs a larger-corpus gate), or can no
   label-reuse mechanism force sublinearity while real new concepts keep arriving?

No capability claim; no held-out run (nothing passed; and Arm R FAILed). The two owed experiments — uncapped
verbatim re-read (cond3 floor) and a larger-corpus / bar-appropriateness gate (cond1 growth) — each need their
own pre-registration + adversary.
