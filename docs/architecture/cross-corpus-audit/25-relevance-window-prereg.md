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
