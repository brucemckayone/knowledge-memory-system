# Doc 29 — Does an AGENT reasoning over the concept graph retrieve better, and does the graph earn it? (pre-registration)

**Bead:** new (nmemo, agent-loop-retrieval) · **Status:** PRE-REGISTRATION — frozen before any number
**Date:** 2026-07-24 · **Discipline:** [[verify-empirical-gates]] (25th run). Committed to git BEFORE the run.
Autonomous `/goal`. User-directed follow-up to doc-28.

---

## 0. Why (correcting a framing error from doc-28)

doc-28 measured MECHANICAL single-hop concept-JOIN (rank by direct shared-node overlap, no agent) — it lost to
embedding (recall@10 0.061 vs 0.162), capped at a ~13% ceiling because only ~13% of oracle-related cross-pairs
share ANY directly-extracted node. In discussion I wrongly carried that single-hop-mechanical ceiling into a
claim about an AGENT loop. Two things break that ceiling: (1) **multi-hop** traversal (A → conceptX → intermediate
doc → conceptY → B connects pairs sharing no direct node); (2) an **agent** that reasons over the named structure
— rejecting false friends (doc-28's contrastive finding: `zero-shot-learning`/`foundation-models` are
same-word-different-meaning bridges that inflate mechanical JOIN) and judging relatedness rather than counting
overlaps. This gate tests whether an agent loop over the graph retrieves better — AND, critically, whether the
GRAPH earns it or the agent's raw reading does.

## 1. Claims under test
- **(A) structural:** multi-hop concept reachability recovers oracle-related cross-pairs beyond the 13% single-hop
  ceiling (at some precision cost).
- **(B) the confound-controlled core:** an agent reasoning over the **named graph structure** ranks related
  cross-corpus docs better than the SAME agent reading **raw abstracts** of a matched candidate pool — i.e. the
  concept-graph representation earns retrieval value OVER the agent's reading ability. If they tie, the value was
  the reading, not the graph (the launder we must not commit — [[verify-empirical-gates]] iters 13/15/17).
- **(C) agent vs mechanical:** the agent (either representation) beats mechanical JOIN on the same pool — i.e.
  reasoning/false-friend-rejection improves on overlap-counting.

## 2. Corpora + oracle (reuse doc-28 exactly — comparable)
`corpus-A.json` (NLP, 147) / `corpus-B.json` (CV, 147); external OpenAlex concept oracle, unseen by any arm.
RELATED(a,b) = share an OpenAlex concept at level ≥ L, score ≥ 0.3, excluding the split concepts + level ≤1.
**L = 2 primary** (frozen in doc-28 §5), L = 3 sensitivity. Our concept nodes per doc = `cc-seeded.json` (the
validated Arm R extraction). Doc embeddings = `cc-docemb.json`.

## 3. Part 1 — structural reachability ceiling (deterministic, no LLM; computed FIRST)
For each A-query compute the B-docs reachable at 1-hop (share a direct concept node), 2-hop (share a concept with
an intermediate doc that shares a concept with the target — via the doc×concept bipartite graph), 3-hop. Report,
vs the oracle: **reachability-recall** (fraction of oracle-related B-docs reached) and **reachable-set size**
(precision cost — how much of B is swept in) at each hop. This is oracle-structural (uses only the graph +
oracle, no arm performance), so computing it before Part 2 is NOT peeking — it characterizes the substrate and
sets the Part-2 candidate pool. Predicted: 1-hop ≈ 13% (doc-28), 2-hop substantially higher recall but larger
sweep; establishes whether "uncapped" is real and at what precision cost.

## 4. Part 2 — matched-pool agent ranking (the confound control)
**Candidate pool per query** = union( embedding top-15 B-docs, graph 1-hop + 2-hop reachable B-docs ), deduped,
capped at 30 by a fixed priority (embedding rank interleaved with graph-path strength). The pool is built to
CONTAIN the oracle-related items either route reaches — so recall is not substrate-limited and Part 2 tests
RANKING/DISCRIMINATION over a recall-matched pool. **Report pool-recall** (oracle-related items NOT in the pool —
what no arm here can recover; the honest ceiling).

**Arms** (all rank the SAME pool per query; scored on the oracle):
- **STRUCT (graph-agent):** Haiku sees, per pool item, `{title, the named concept path(s) linking it to the
  query}` (1-hop shared node, or 2-hop chain via the intermediate concept) — NOT the abstract. It judges/ranks
  which are truly related, and may reject a shared concept as a false friend.
- **TEXT (read-agent):** Haiku sees, per pool item, `{title, abstract}` — NO concept structure. Same task, same
  pool. The ONLY difference vs STRUCT is representation (named graph structure vs raw text).
- **JOIN-pool (mechanical ref):** rank the pool by IDF-weighted shared-node overlap (doc-28 scorer).
- **EMB-pool (mechanical ref):** rank the pool by doc-embedding cosine.

Agent = **Haiku** (Haiku-first discipline). If STRUCT fails to beat baselines, that is scoped as "Haiku-agent
can't," not "agent-loop can't"; a capable-model ceiling run is the named follow-up (not run here).

**Metrics** (macro over the query sample, A→B; B→A owed): **recall@10-within-pool**, **precision@5**, **MRR**.
Paired-bootstrap 95% CIs (seed fixed) for STRUCT−TEXT and STRUCT−JOIN-pool.

## 4B. Part 3 — free-navigation arm (SECONDARY; user-requested — tests "full exploratory reasoning")

A real subagent per query autonomously explores the concept graph — no pre-navigated pool. Substrate = the
concept graph ONLY (it may look up `concept → B-docs`, a B-doc's concepts, and pull a B-doc's abstract once
reached; it may NOT use embedding cosine — that would make it an embedding-nav arm). Starting from the query's
concepts it traverses (1-hop, then expand via intermediate concepts/docs = multi-hop), reads what it reaches,
and returns a ranked list of B-docs it judges related. Agent = Haiku (Haiku-first; capability-floor caveat as §4).

Run on the **first 20** of the frozen query sample (bounded cost; a subset, disclosed). Compared to STRUCT,
JOIN-pool, EMB-pool on the SAME 20 (recall@10 over full B / precision@5 / MRR — note free-nav retrieves over all
147, so its recall is over the full corpus, reported separately from the pool-restricted arms and matched by
recomputing the pool arms over full-B for those 20).

**Honest scoping (frozen):** free-nav's confound is NOT controlled — a win cannot be split into graph-value vs the
agent's reading, and it may degenerate to reading many abstracts. So it is **reported, not a pass/fail gate**: it
shows what autonomous graph exploration *achieves* (does it beat mechanical JOIN? approach embedding? break the
13% ceiling in practice?), and its behavior (how many hops/docs it actually visited) is logged for the adversary.
The clean "does the graph earn it" verdict rests on H-B (matched-pool STRUCT vs TEXT), not on this arm.

## 5. Query sample (frozen)
A-queries with ≥3 oracle-related B-docs at L=2 (recall measurable). Take the **first 40** by corpus order (fixed,
reproducible; if <40 qualify, take all and report N). B→A symmetric run is owed, not primary.

## 6. Bars (FROZEN before any number)
- **H-A (multi-hop breaks the ceiling):** 2-hop reachability-recall ≥ 2× the 1-hop recall (≥ ~26%), reported with
  its sweep-size cost. Structural, deterministic.
- **H-B (graph representation earns it — THE core):** STRUCT − TEXT ≥ **+0.05** on precision@5 (primary) with
  paired-bootstrap CI excluding 0. **A tie (CI straddles 0) = the graph does NOT earn value over the agent's
  reading — reported as such, not spun.** Stronger still if STRUCT also wins recall@10 and MRR.
- **H-C (reasoning beats counting):** STRUCT > JOIN-pool on precision@5, CI excluding 0.
- **Mechanism check (false-friend rejection):** among pool pairs linked ONLY by a known false-friend bridge
  (`zero-shot-learning`, `foundation-models`), does STRUCT reject them at a higher rate than JOIN-pool accepts
  them? (Directly tests doc-28's contrastive finding as a capability.)

**"The agent loop determines retrieval accuracy better, and the graph earns it" = H-B holds (STRUCT > TEXT) AND
H-C holds.** H-A alone (multi-hop recall) without H-B is just "reachability is broad," not "the graph helps."

## 7. Anti-launder controls
- **The 2×2 is the point:** {graph, embedding} × {mechanical, agent}. STRUCT-vs-TEXT isolates graph-scaffold value
  from agent-reading value on a MATCHED pool — the exact confound that produced false positives in the E1 legs
  (crediting the LLM's reading for the graph). A STRUCT≈TEXT tie is a real, reportable null.
- Oracle external + unseen; L frozen (doc-28); pool built to be recall-matched (neither substrate ceiling-limits
  it); pool-recall reported (the un-recoverable remainder).
- Ties are not wins (rule 30/50/58); Haiku-floor scoping disclosed (a fail is "Haiku can't", not "agent can't").
- Mechanical JOIN/EMB computed ON THE POOL for apples-to-apples with the agent arms (doc-28's full-corpus numbers
  are a different denominator — not conflated).
- All arms/pools/rankings + agent prompts persisted for the adversary; paired-bootstrap CIs; both directions of
  interpretation; blind adversary before any claim; no capability banked on one pairing/one direction/Haiku-only.
- Cost noted: agent arms = 2 Haiku calls per query (STRUCT, TEXT); mechanical arms free.

## 8. Blind-adversary protocol
Fresh subagent, raw artifacts only: (1) recompute Part-1 reachability + all Part-2 metrics + CIs independently;
confirm match. (2) Verify STRUCT and TEXT see the SAME pool and differ ONLY in representation (diff the two
prompts per query — no abstract leaks into STRUCT, no concept labels leak into TEXT). (3) Verify the pool is not
gerrymandered (built by the frozen union rule, contains the true positives it claims). (4) Attack H-B: is a STRUCT
win real, or does the named concept path smuggle in the answer (e.g. the shared concept label IS the oracle
concept's name → leakage)? Check overlap between our node labels and OpenAlex concept names on the winning pairs.
(5) Attack the false-friend mechanism check. (6) For the free-nav arm: verify it actually traversed the graph
(not degenerate full-abstract-scan), that it used NO embedding, and log how many hops/docs it visited; rule
whether its result reflects graph exploration or just reading. (7) Rule whether any STRUCT win is the graph or
the reading, and whether a tie was honestly reported. Verdict even if it retracts.

## 9. Disposition
Names the outcome per §6. Answers whether an agent loop over the graph beats mechanical JOIN (H-C) and — the load-
bearing question — whether the graph representation earns retrieval value over the agent simply reading the text
(H-B). Does NOT settle: capable-model ceiling (Haiku-floor only), B→A direction, multi-pairing generality, or
production cost/latency. Each its own follow-up.

---

## 10. RESULT (2026-07-27) — H-B robust (graph adds nothing over reading); "agent < mechanical" RETRACTED as an oracle artifact

Ran Part 1 (structural), Part 2 (matched-pool STRUCT/TEXT/JOIN/EMB, Haiku), Part 3 (free-nav autonomous
exploration, Haiku). **Operational note:** the ML service died between sessions and the first Part-2 run cached
80 empty agent responses (silently — retries exhausted → `{}`); caught, ML restarted, cache cleared, re-run.
(Harden: fail loud on all-empty, not silent-cache.) Blind adversary (Opus, fresh) reproduced **every number to
the digit** (incl. both bootstrap CIs), verified the harnesses are honest (free-nav uses NO embedding in
navigation — `cosine` only in the `embFull` baseline; real traversal logged; STRUCT/TEXT isolation clean), and
then **overturned my headline**.

| L=2 primary | STRUCT | TEXT | JOIN | EMB | free-nav |
|---|---|---|---|---|---|
| MRR | 0.40 | 0.40 | 0.52 | 0.50 | 0.47 |
| precision@5 | 0.21 | 0.21 | 0.34 | 0.38 | 0.30 |
| recall@10 | 0.05 | 0.05 | 0.12 | 0.16 | 0.08 |

Part 1: 1-hop reachability-recall 13% → 2-hop 62% (sweeps 91/147) → 3-hop 65%. Multi-hop breaks the single-hop
ceiling but near-indiscriminately (H-A holds, structural).

### The ONE robust finding — H-B: the graph representation adds NO retrieval value over reading
STRUCT vs TEXT differ only in representation (named concept structure vs raw abstract), same agent, same pool.
**Tie at L=2 on every metric** (MRR 0.404 vs 0.399, CI straddles 0), and STRUCT **loses** at L=3. Both arms eat
the same oracle noise, so it cancels in this same-oracle same-pool contrast → **oracle-independent and robust.**
For the Haiku agent, reasoning over the named concept graph does not beat the same agent reading the text. This
is the clean confound-controlled null the pre-reg set out to test, and it holds.

### RETRACTED (adversary's decisive correction): "agent < mechanical" is NOT a capability verdict — it is an ORACLE ARTIFACT
I framed doc-29 as a "consistent negative — neither pooled agent nor free-nav beats mechanical embedding." The
adversary showed that cross-arm comparison is not trustworthy, because **the OpenAlex oracle is not a credible
relatedness ground truth here:**
- **Coarse:** base rate 0.196 (28.9 "related" B-docs per query); **85% of related pairs share exactly ONE L2
  concept.**
- **Junk-laden:** the top pair-generating "concepts" are OpenAlex disambiguation noise — `Task (project
  management)` (160 pairs), `Code (set theory)` (94), `Pattern recognition (psychology)` (89), `Image
  (mathematics)`, `Process (computing)`. A conservative 13-term junk filter dissolves **25% of all "related"
  pairs.** (Q0 "LLMs for systematic review" is scored related to diffusion/video-gen papers solely via `Process
  (computing)`.)
- **EMB is graded against its own bias:** doc-embedding cosine and a coarse topical-concept oracle are BOTH
  surface-topical-similarity functions → "EMB wins" is partly circular. (This confound is **inherited by doc-28**
  too — its "concept-JOIN loses to embedding" is likewise oracle-shaped, noted retroactively.)
- **Where the data actually adjudicates — agent/oracle disagreements — the agent is FREQUENTLY RIGHT:** STRUCT
  returned `CodeGen2` (an LLM paper) for 4 LLM queries (genuinely related) though the oracle marks it related to
  0/40 (its L2 tags are junk: `Infill`, `Sampling (signal processing)`, `Representation (politics)`); InstructBLIP
  → `ImageBind-LLM instruction tuning`; BLIP-2 → `object hallucination in vision-language models` — all
  agent-right / oracle-blind. The agent applies orthogonal **categorical** judgment ("both are LLM papers") that
  the topical oracle penalizes as false positives.

So the agent was doing a **different, arguably better KIND of discrimination** (categorical/semantic) than
embedding's surface-topical match — exactly what the concept layer is *for* — but this oracle cannot reward it
and mechanical EMB is scored against its own yardstick. **The "agent retrieves worse" claim is withdrawn.**

### But NOT laundered toward the agent either (adversary's counter-evidence)
The agent is not a proven good retriever: it returns the same hubs across unrelated queries (`B130` in 22/40
STRUCT lists, `B75` in 10/40 despite 0/40 oracle support), collapses at L=3, one free-nav query degenerated to
reached=0, and its whole-list precision is ~0.37 even against the generous oracle. Free-nav's low recall (0.079)
is largely a harness cap (REACH_CAP=60, ~7-item returns, greedy Haiku picks) — the substrate reaches 62% at 2
hops — so it understates reach, but doesn't prove strength. **Honest state: this oracle cannot adjudicate
agent-vs-mechanical either way. The retrieval question is OPEN, not negative.**

### OVERALL
- **Can claim:** (H-A) multi-hop breaks the 13% ceiling, near-indiscriminately; **(H-B) the graph REPRESENTATION
  earns nothing over the agent reading the text** — robust, oracle-independent, the load-bearing result; all
  numbers sound, harnesses honest; and the agent demonstrably makes categorical cross-corpus judgments the coarse
  topical oracle + embedding both miss.
- **Cannot claim:** "agent retrieves worse than embedding" (oracle-artifact; retracted); anything about capable
  models (Haiku-floor); that free-nav's low recall is a graph limit (harness cap). doc-28's embedding-beats-JOIN
  is retroactively caveated by the same oracle confound.
- **Owed to actually settle the retrieval question:** a relatedness oracle NOT self-aligned with embedding —
  citation links, human judgment, or a de-junked fine concept oracle; capable-model agent; B→A; second pairing.

### Discipline note
This is a **pessimistic-direction over-extension** I made and the adversary caught (rule 29 / the pessimistic
mirror): I built a comparison whose oracle is self-aligned with the winning baseline and reported the resulting
"negative" as a capability fact. The user's live surprise ("the agent didn't discriminate better?!") flagged it
before the adversary confirmed it. See [[verify-empirical-gates]] iter-25 (rule 59).
