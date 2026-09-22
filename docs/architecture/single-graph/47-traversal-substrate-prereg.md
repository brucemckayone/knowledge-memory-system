# 47 — Does a STRUCTURAL (traversal) substrate add to the fusion? — PRE-REGISTRATION

**Status: PRE-REGISTERED, NOT YET RUN.** Frozen 2026-09-17. **Cost ZERO** (frozen caches + SQL adjacency;
no Ollama, no LLM). Append results below the RESULTS line.

## 1. Why
CLAUDE.md's meta names the remaining gap explicitly: *"Untested substrates remain: **traversal-augmented**,
Graph C."* Graph C is now tested and null in both directions tried (docs 44, 45). **Traversal is the last
untested substrate**, and the one consistent lesson of this whole programme is that **separation comes from
FUSING substrates**, not from any single retriever:

- R4: dense-names ⊕ dense-facts = +0.0724 over name-only (banked; reproduced on arxiv this session).
- Doc 46: + a lexical fact substrate = **+0.0763 / +0.0801 over R4** on two corpus pairs (pending adversary).
- Every *single*-substrate arm ever tried ties at R@10 ≈ 0.20-0.23.

A traversal signal is **structural, not textual**, so it is a genuinely different substrate from all three
signals now in play (dense-names, dense-facts, lexical-facts) — which is the property that made R4 and doc
46 work (their component top-10 Jaccards are 0.085 and lower).

**The mechanism being tested:** the held-out target entity co-occurs in papers with other entities that the
query paper also mentions, and `public.facts` connects co-occurring entities. So the target should often be
a **graph neighbour** of entities that text retrieval already ranks highly, even when its own name/facts
match the query poorly. This is `traverseFromEntities`' regime (the sanctioned traversal primitive after
AGE was retired from the read path).

**Independence note:** this experiment does not depend on doc 46 being upheld. It is measured against
**both** FACTNAME (R4, banked) and L3 (doc 46), so it remains interpretable if doc 46 is retracted.

## 2. Task, data, conventions (inherited FROZEN)
Identical to doc 46 §2: the entity target-finding task via `retrieval-eval/harness.ts`, corpus pairs
**dal** (`dal-nlp` + `dal-cv`, with the frozen ARM-NAME regression guard = 0.20056497175141244 at n=354)
and **arxiv** (`arxiv-nlp` + `arxiv-cv`, the independent extraction). Query = paper `title + abstract`.
Retrieved-set RRF at k=60, index-ascending tie-break, strict metric primary.

**Standing caveats (stated, not to be discovered later):** papers-as-queries is a **proxy** task with a
known validity gap; **absolute levels ride on the index-asc tie-break, so deltas are the claim and levels
are not**; the condensed oracle is **not arm-neutral** and is excluded from the claim.

## 3. The new signal — TRAV

- **Adjacency:** entity↔entity edges from `public.facts` (`subject_entity_id` ↔ `object_entity_id`), same
  corpus, `expired_at IS NULL AND invalid_at IS NULL`. Undirected.
- **Seeds:** the top **S = 10** entities of a base ranking. The base is **NAME** for the primary arm, so
  TRAV is *not* seeded by the arm it is being fused into (that would be circular).
- **Score:** for each entity e, `TRAV(e) = Σ over seeds s adjacent to e of 1/(rank(s)+1)`, i.e. a
  rank-discounted count of high-ranked neighbours. 2-hop is reported as a variant (`TRAV2`, half weight on
  the second hop) but the primary is 1-hop.
- **Seeds are excluded from their own TRAV score** (an entity does not boost itself).
- **HELD-OUT GUARD (load-bearing):** an adjacency edge is **DROPPED if its underlying fact's source paper
  is the query document**, using `factToPaper` from the attribution artifacts — the identical guard
  `factSignals` (`harness.ts:86`) applies to the dense fact signal, and the guard doc 46 applies to BM25f.
  **Without it, the target's own edges from the query paper leak the answer directly** — this is the single
  most likely way for this experiment to produce a fake win, so it is asserted in §6 and a
  **guard-disabled run is reported alongside** to show the size of what the guard removes.
- **Conservative variant `TRAVc`:** additionally drops facts with **no** paper mapping (3.5% of facts,
  where the guard cannot fire — doc 46's finding). Reported.

## 4. Arms

| arm | definition |
|---|---|
| NAME / FACTMAX / FACTNAME | frozen baselines + regression guard (FACTNAME = R4 = a bar) |
| L3 | RRF-60(NAME, FACTMAX, BM25f) — doc 46's arm, the other bar |
| TRAV | the structural signal alone |
| **T-R4** | RRF-60(NAME, FACTMAX, TRAV) — does traversal add to R4? |
| **T4** | RRF-60(NAME, FACTMAX, BM25f, TRAV) — the four-way |
| TRAV2 / TRAVc | 2-hop and leak-hardened variants |
| **TRAV-RAND** | **the artifact control**: TRAV recomputed on a DEGREE-PRESERVING SHUFFLED graph |

## 5. Metric + bars (frozen)

- **Primary: strict R@10.**
- **BAR A (does traversal add to the banked lever):** `T-R4 − FACTNAME` > 0 on **all three bootstraps**
  (byPair/byEntity/byDocument) in **both** corpus pairs.
- **BAR B (does it add on top of doc 46):** `T4 − L3` > 0 on all three bootstraps in both pairs.
  Reported regardless of BAR A. If BAR A clears and BAR B does not, traversal and lexical are
  **substitutes**, which is itself a finding.
- **MANDATORY ARTIFACT CONTROL:** `T-R4 − FACTNAME` must **exceed** the same delta computed with
  **TRAV-RAND** (a degree-preserving shuffled graph). A real structural signal must beat a graph with the
  same degree distribution but scrambled edges. **If TRAV-RAND reproduces most of the gain, the result is
  a degree prior and/or an RRF artifact and must be reported as such, not as a traversal win.** This is
  the control doc 46 omitted and its adversary was asked to supply.
- **Degeneracy check:** component top-10 Jaccard of TRAV against each of NAME / FACTMAX / BM25f. If any
  exceeds 0.9, TRAV is not a distinct substrate and the fusion result is uninformative.
- Secondary, reported always: R@{1,5,20,30}; per-corpus breakdown for all four corpora; the
  guard-disabled delta (to size the leak the guard removes); and **the correlation between entity degree
  and TRAV-induced rank improvement** (to quantify how much of TRAV is simply a high-degree prior — the
  hazard doc 44's adversary flagged and CLAUDE.md records as "gain is degree-concentrated").

## 6. Kill / invalid conditions (fix; do NOT report as a finding)
1. ARM-NAME strict R@10 ≠ 0.20056497175141244 at n=354 (dal) → substrate drift; void.
2. The query-document adjacency guard not firing → leak; void. Assert a non-zero exclusion count.
3. TRAV top-10 Jaccard > 0.9 against any existing signal → degenerate; uninformative.
4. Seeds included in their own TRAV score → self-boost; void.
5. Adjacency built from expired/invalidated facts → void.
6. Any database write.

## 7. Pre-registered expectation
I expect **TRAV alone to be weak** (it has no text signal at all) and I am **genuinely uncertain about
BAR A**. I lean slightly toward BAR B failing even if BAR A clears, because doc 46's lexical signal and a
co-occurrence traversal signal may both be proxies for "entities that appear alongside what the query
mentions." I expect a **material degree effect** and have pre-committed to quantifying it rather than
discovering it later.

Risk carried this session: doc 44 drew eight adversary corrections (three overclaims toward my own
conclusion, one a code bug in the headline number); doc 45 contained a circular feature and a vacuous
check that I caught myself; doc 46's own control narrowed its claim. Guards here: the frozen regression
gate, the mandatory degree-preserving shuffle control, the degeneracy check, the guard-disabled
comparison, strict-only primary, and a four-corpus breakdown.

## 8. Discipline
Deterministic; no Claude in the measurement path. Pre-register → measure → blind adversary → bank.
NULL/negative pre-committed as valid. Frozen above the RESULTS line.

---

## RESULTS (append below; do not edit above this line)

**Run 2026-09-17 on BOTH corpus pairs. Cost ZERO.** Artifacts
`prereg-artifacts/traversal-substrate-results-{dal,arxiv}.json`; harness
`platform/src/test/tools/traversal-substrate.ts`. ARM-NAME regression gate passed exactly on dal
(0.20056497175141244, n=354). Held-out adjacency exclusions fired 3545 (dal) — guard confirmed live.

### HEADLINE — BAR A FAILED and BAR B FAILED, on both pairs. Traversal does NOT add.

Strict R@10:

| arm | dal (n=354) | arxiv (n=387) |
|---|---|---|
| NAME | 0.2006 | 0.1912 |
| FACTNAME (R4) | 0.2429 | 0.2636 |
| L3 (doc 46) | 0.3192 | 0.3437 |
| **TRAV alone** | **0.0904** | **0.0724** |
| TRAV-RAND (shuffled graph) | 0.0339 | 0.0155 |
| T-R4 = RRF(NAME, FACTMAX, TRAV) | 0.2260 | 0.2300 |
| T4 = RRF(NAME, FACTMAX, BM25f, TRAV) | 0.2938 | 0.2946 |

| bar | dal | arxiv |
|---|---|---|
| **BAR A** `T-R4 − FACTNAME` | **−0.0169**, spans 0 | **−0.0336**, spans 0 |
| **BAR B** `T4 − L3` | **−0.0254**, spans 0 | **−0.0491, BELOW 0** |

Both bars fail in both pairs, with **negative point estimates throughout**. On arxiv, adding traversal to
doc 46's arm is **significantly harmful** (below 0 on all three bootstraps). Per-corpus, all four corpora
agree. **Traversal is not a usable retrieval substrate here in any configuration tested.**

### The artifact control: the real graph adds nothing over a degree-preserving shuffle
`T-R4 − T-R4-RAND` = **−0.0028 (dal)** and **−0.0362 (arxiv)**, both spanning 0 — and on arxiv the
**shuffled** graph is nominally *better* (T-R4-RAND 0.2661 vs T-R4 0.2300). A degree-preserving edge
shuffle destroys all real structure while preserving every node's degree, so this says whatever small
effect TRAV has in fusion is a **degree prior, not graph structure.**

Confirmed directly: targets rescued by T-R4 (miss→hit at k=10) have **mean degree 17.9 vs 9.7 overall**
(dal) and **20.2 vs 12.2** (arxiv). This is the degree-concentration hazard CLAUDE.md already records for
the R4 lever, now measured for traversal.

### THE MOST IMPORTANT RESULT HERE IS THE LEAK CONTROL — and it is a warning, not a finding about traversal
With the held-out guard **disabled**, traversal looks like a substantial win:

| | `T-R4-NOGUARD − T-R4` | verdict |
|---|---|---|
| dal | **+0.0904** [0.0593, 0.1215] | above 0, all three bootstraps |
| arxiv | **+0.0801** [0.0543, 0.1085] | above 0, all three bootstraps |

TRAV alone goes from 0.0904 → **0.2175** (dal) and 0.0724 → **0.2274** (arxiv) when the guard is removed.

**That fake gain is the same magnitude as doc 46's real one (+0.0763 / +0.0801).** Had the guard not been
pre-registered as load-bearing in §3, this experiment would have produced a confident, CI-clean,
both-corpora "traversal substrate demonstrated" result that was **pure leakage** — the target's own edges
from the query document. Recorded as a calibration point: **on this task, a missing held-out guard buys
roughly +0.08 of counterfeit R@10**, which is exactly the size of a real effect. Any future arm on this
task must state its guard explicitly and report the guard-disabled delta alongside.

(`TRAVc − TRAV` is exactly 0.0000 in both pairs — the 3.5% unmapped-paper facts make no difference to
traversal, unlike their small effect in doc 46.)

### The finding that refines the programme's core heuristic
**TRAV top-10 Jaccard vs NAME = 0.000** (completely disjoint) and **vs FACTMAX = 0.104.** So TRAV is the
*most* distinct substrate yet tested — more distinct than the name/fact pair that made R4 work (0.085) —
and it still fails to add, and actively hurts on top of L3.

**Therefore: substrate DISTINCTNESS is necessary but NOT sufficient for fusion to help.** The project's
working heuristic ("separation comes from fusing substrates") needs the qualifier that the added substrate
must also be **individually competitive**. TRAV at 0.0904/0.0724 is ~4x worse than the weakest arm in the
working fusion, and RRF cannot recover from that — consistent with doc 45, where RRF was worse than its
better component, and doc 46, where fusing a weaker arm into a strong one cost more than it gained.

### Banked disposition
**Traversal-augmented retrieval: NULL, both bars, both corpus pairs, with the real graph indistinguishable
from a degree-preserving shuffle.** This closes the last of the untested substrates CLAUDE.md listed
(*"traversal-augmented, Graph C"*) — **both are now tested and both are null.** The working read path
remains dense-names ⊕ dense-facts ⊕ lexical (doc 46, pending adversary).

**Caveats:** papers-as-queries proxy; strict metric only; one traversal formulation tested (1-hop
rank-discounted neighbour count, NAME-seeded, S=10) — a different seeding or weighting is untested, but the
degree-shuffle control argues the substrate carries little structural signal on this task regardless.
**Blind adversary: NOT RUN** (the pre-registered artifact control and leak sizing were run in-harness).
