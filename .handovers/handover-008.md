---
session: 008
date: 2026-09-17
project: nmemo — intent-adaptive retrieval & ingestion redesign (epic nmemo-asf)
status: in-progress
supersedes: 007
---
# Handover 008 — I4 causal is a NULL in both directions tested; but the session found the FIRST demonstrated retrieval win: a third LEXICAL fusion signal beats R4 on both corpus pairs. Adversary on it still pending.

## Mission / goal
Program `nmemo-asf` (docs 30-46): redesign ingestion pulled by committed query capabilities,
benchmark-gated, on a SINGLE graph in Postgres `cognitive_test`. **Loop discipline: PROVE deterministically
(standalone tsx / direct SQL, no Claude) before spending Claude; pre-register metric+bar BEFORE computing;
run a BLIND ADVERSARY before banking; NULL/negative is a valid banked outcome; halt-and-surface on
surprise.** Branch `feat/single-graph-retrieval`. Nothing is git-committed — the user commits on request.

**Active user goal (session-scoped, still live):** *"just continue down this path keep going improve the
preformance its quite simple find the way to a better working more useful system."* The user also stated
plainly: **"im not buying anything"** — so NO org LLM/API/benchmark spend. Subagent adversaries are
accepted (they were the only model spend in sessions 006-008).

## What happened this session (all FREE — zero org spend)

### 1. I4 was opened, and the committed plan for it was KILLED
Two read-only investigations (`scratch-asf-i4-substrate.md`, `scratch-asf-i4-benchmarks.md`):
- **Corr2Cause / CLadder are INVALID as I4 benchmarks.** Both verified **100% self-contained in the
  prompt** — nothing to retrieve, so the graph cannot contribute; `docs/benchmarks/plan.md:157` would
  ingest the question's own preamble and read it back. Also: variables are literally `A`/`B`/`C` (node
  collision), CLadder reuses 10 graph structures across hundreds of items with **opposite gold answers**,
  and Corr2Cause's eval split is **1,162** items not `plan.md:151`'s "200K+" (that's train).
  **`nmemo-4fd` and `nmemo-9hp` are now CLOSED as invalid-as-specified** with full reasoning.
- **There is NO valid external oracle for cross-document causal retrieval.** MAVEN-ERE's own Limitations
  says so; EventStoryLine's gold is not causality (`PLOT_LINK` = "a loose causal and temporal relation";
  explicit causality on only 117/5,625 pairs); ESTER's HIT@1 is degenerate (whole passage scores 99.2%)
  and its retrieval leg is ~80% solved by bag-of-words; the area's critique paper *requires* benchmarks be
  "non-retrievable". **Do not go shopping for one again.**
- **Verified-negative external prior** (I checked these myself from primary sources): CauseNet —
  BERT/RoBERTa/E5 *"did not lead to improved results … compared to GloVe"*; Touché 2023 — CauseNet
  expansion scored 0.225 vs baseline 0.615, *"both expansion techniques significantly lowered the
  retrieval performance"*. Also from the CauseNet QA table: **provenance text HURT answers vs bare
  triples** on MS MARCO (GPT-4 0.768 → 0.669) but **ties/reverses on SemEval** — so that finding is
  single-dataset, weaker than first reported.

### 2. Doc 44 — I4 causal pass-through: **UNRESOLVED** (banked, adversary VALID-BUT-MISFRAMED)
`44-i4-causal-passthrough-prereg.md`. Can dense retrieval find Graph C's own asserted causes?
Best r@10 on the honest stratum D: **0.4245 (dal-cv) / 0.3936 (dal-nlp)** vs a 0.70 bar → **missed by
~0.28**, CI entirely below the bar in all 12 bar-bearing cells. Pre-registered as **one-directional**: a
low recall is NOT a positive for Graph C, because a miss is equally consistent with a spurious edge and
the edge-correctness adjudication was not purchased.
**Graph C substrate, verified by my own SQL:** 1043 edges / 17,847 events; reasoning 1043/1043 distinct
(avg 315 chars, real prose); 2353 refs of which **2349 resolve (99.83%)**; cited facts carry `source_text`
at ~100% vs **5.20% graph-wide**. BUT structurally thin: 1-hop 1043 / 2-hop 142 / 3-hop 12 / 4-hop 3;
**794 of 920 answerable effects (86.3%) bottom out at one hop**; largest connected component 7 nodes;
`event_embedding` NULL on 17,847/17,847, **written by nothing and read by nothing**; every causal entry
point (MCP or HTTP) is keyed by **id, never a query string**; `temporal_span` NULL on 1043/1043 and
1027/1043 share cause/effect timestamps (so **I4×I3 has no substrate**); `causal_patterns` 0 rows.
**Adversary's 8 corrections are IN the doc** — the load-bearing ones: my BM25 "median 10" was a
**survivorship bug** (73/461 golds dropped; unconditional 26; arithmetically self-refuting), I asserted a
CI for cells my bootstrap **never computed**, and the CLOSE branch was **near-unreachable by construction**
(all arms direction-blind: reversing cause/effect moves D 0.3688→0.3623). Its control is the real keeper:
causal pairs sit **~89x above matched chance**, which bounds the hallucinated-edge alternative.

### 3. Doc 45 — asymmetric re-rank: **NULL** (adversary NOT run)
`45-i4-asymmetric-rerank-prereg.md`. Chased the direction-blindness diagnosis with a held-out predicate
**role** prior (`uses_technique`/`trained_on`/`has_component` are cause-side; `outperforms`/`improves`/
`addresses` are effect-side) + directional structure, logistic regression over a K=50 pool, 5-fold CV
split by effect fact. **Bar failed** (pooled D +0.0303, CI spans 0 under both clusterings; dal-nlp
actively degrades). **The pre-registered question answered NO: A-ASYM 0.4273 ≈ B-SYM 0.4295.** The role
prior is *redundant* with dense+BM25 (coefficient ~0.56, zero ranking change).
**Two of my own flaws, disclosed in the doc:** the stratum-S entity-overlap gain is **circular** (gold's
feature = 1 on 582/582 by the stratifier's own definition) and the swap test is **vacuous** (sign flip
absorbed by the learned coefficient — the exactly-0.0000 was the tell). **The predicate PAIR prior is dead
on arrival** (1002 distinct pairs / 1043 edges, 93.2% singletons) — do not retry it.

### 4. Doc 46 — **THE WIN: a third LEXICAL fusion signal beats R4. DEMONSTRATED on both corpus pairs.**
`46-lexical-fact-signal-prereg.md`. Doc 45's learned weights were `bm25_z` **0.693** vs `dense_z` **0.129**
on *identical text* (`factEmbedTextFor` embeds `source_text`; `promotion.ts:512` writes
`sourceText: f.reasoning`; 100% coverage). And doc 34 §I1 already recorded **"lexical index MISSING"**,
with `BM25n` being BM25 over *names* and `FactRow` carrying no fact text at all.

Added **BM25 over `facts.source_text`, MAX-aggregated to entities** (same aggregation as FACTMAX, same
held-out guard) as a THIRD signal to R4's RRF-60(dense-names, dense-facts):

| | L3 − FACTNAME | byPair | byEntity | byDoc |
|---|---|---|---|---|
| dal (n=354) | **+0.0763** | [0.0395, 0.1130] | [0.0330, 0.1192] | [0.0399, 0.1141] |
| arxiv (n=387) | **+0.0801** | [0.0491, 0.1137] | [0.0391, 0.1240] | [0.0471, 0.1146] |

Above 0 on **all three bootstraps in both pairs**, **all four corpora improve**. Gain over name-only is
**+0.1186 / +0.1525** — roughly **double R4's own +0.0724**.

**Three harness validations (why I believe it):** ARM-NAME regression gate passes to the last digit
(0.20056497175141244, n=354); **R4 reproduces its banked +0.0724 on arxiv**; **doc 12's banked tie
reproduces on dal** (H60−NAME +0.0254, spans 0). Degeneracy clean (FACTMAX vs BM25f top-10 Jaccard 0.085).
Leak-hardened arm L3c (drops the 3.5% facts with no source-paper mapping) still clears (+0.0678 / +0.0801).

**Mechanism claim is NARROWER than the headline:** `L3 − L3n` **spans 0 in both pairs** — swapping the
lexical component to entity *names* is indistinguishable in the three-way. So the claim is **"add a
lexical substrate," not "fact text specifically"** (though `L2 − H60` clears in both pairs, so fact text
does win in the two-way). **RETRACTED there:** docs 44/45's "lexical beats dense at fact level" does NOT
generalise — `BM25f − FACTMAX` **flips sign** across pairs (+0.0508 dal, −0.0336 arxiv).

**Engineering payoff:** **`L2` = RRF-60(dense-names, BM25-over-fact-text) needs NO fact embeddings at all**
and still beats R4 (+0.0678 / +0.0413, all three bootstraps) — **cheaper than the current read path and
better.** `L3` is nominally best if fact embeddings are being computed anyway.

## RESUME HERE
1. **The blind adversary on doc 46 was RUNNING when this handover was written and had not reported.**
   Agent id `a3d1716bc7b359f6c`; it writes `docs/architecture/single-graph/scratch-doc46-adversary.md`.
   **Read that file first.** I aimed it at the control I did NOT run and which could kill the result:
   **fuse NAME ⊕ FACTMAX ⊕ a RANDOM/shuffled third ranking** and see how much of +0.076 a *meaningless*
   third signal reproduces through RRF mechanics alone. Also: leak interrogation, index-DESC tie-break
   re-run, and whether BM25f is partly an entity-degree prior. If the random-third-arm control reproduces
   most of the gain, **doc 46 is an RRF artifact and must be retracted.**
   **Do NOT ship `nmemo-v3g` before that verdict.** Then VERIFY its load-bearing claims yourself with your
   own SQL/code — the user's standing correction this session was that I relayed subagent findings without
   a return check, and doing the check caught real errors both times.
2. **If the adversary holds:** ship `nmemo-v3g` (P1) — wire the BM25 index over `facts.source_text` into
   `services/retrieval.ts::recallEntitiesFused` + `services/fusion.ts`. Consider **L2 as the minimal ship**
   (no fact embeddings needed). Then re-run the eval as a regression.
3. **Optional further replication:** `qbio-embed-cache.json` exists, so a third independent corpus is
   runnable for free via `CORPUS_SET` (would need a qbio entry added to `SETS`).
4. **Do NOT relitigate:** I4-as-retrieval (null in both directions tested), the predicate pair prior
   (dead), external causal benchmarks (no valid oracle exists), Corr2Cause/CLadder (closed invalid).

## How to run / verify
- **Infra:** Postgres :5433 and Qdrant :6335 are UP (docker, `nmemo-postgres-1`). **Ollama :11434 and
  ml :8000 are DOWN and were not needed** — everything this session used stored embeddings + frozen
  caches. Check ports: `for p in 8000 11434 5433 6335; do (echo > /dev/tcp/127.0.0.1/$p) >/dev/null 2>&1 && echo "$p up" || echo "$p down"; done`
- **No local psql** — use `docker exec -i nmemo-postgres-1 psql -U cognitive -d cognitive_test < file.sql`.
- **Doc 46 (the win), both pairs:**
  `cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test NODE_ENV=test npx tsx src/test/tools/lexical-fact-signal.ts`
  and the same with `CORPUS_SET=arxiv` prefixed. ~1-2 min each, zero cost.
- **Doc 44:** `npx tsx src/test/tools/i4-causal-passthrough.ts` then `i4-passthrough-bootstrap.ts`.
- **Doc 45:** `npx tsx src/test/tools/i4-asymmetric-rerank.ts` (~3 min).
- **Beads:** `C:/Users/bruce.mckay/AppData/Local/Programs/bd/bd.exe` — `bd show nmemo-asf`.

## Key locations
- **Prereg docs (frozen above RESULTS):** `docs/architecture/single-graph/44-i4-causal-passthrough-prereg.md`,
  `45-i4-asymmetric-rerank-prereg.md`, `46-lexical-fact-signal-prereg.md`.
- **Investigations / adversaries:** `scratch-asf-i4-substrate.md`, `scratch-asf-i4-benchmarks.md`,
  `scratch-asf-i4-passthrough-adversary.md`, `scratch-doc46-adversary.md` (pending).
- **New harnesses (uncommitted):** `platform/src/test/tools/{i4-causal-passthrough,i4-passthrough-bootstrap,i4-asymmetric-rerank,lexical-fact-signal}.ts`.
- **ONE shared-engine edit:** `platform/src/test/tools/retrieval-eval/data.ts` — now also SELECTs
  `source_text AS txt` and exposes `FactState.texts`. **Purely additive**; the regression gate still passes
  exactly. (Aliased `txt` because `rawQuery` rewrites snake_case→camelCase.)
- **Artifacts:** `prereg-artifacts/{i4-passthrough-results.json, i4-asymmetric-rerank-results.json, lexical-fact-signal-results-dal.json, lexical-fact-signal-results-arxiv.json}`.
- **Docs corrected this session (dated corrections of record):** `33-graph-structure-analysis.md` §4
  (stale per-corpus causal counts) and `34-query-intent-set-proposal.md` §I1 + §I4.
- **Beads:** CLOSED `nmemo-4fd`, `nmemo-9hp` (invalid-as-specified). NEW: **`nmemo-v3g` P1** (ship the
  lexical index — gated on the adversary), plus 3 bug reports (project_trajectory corpus leak;
  getCausalDelta/findEdgesCitingReference unscopable; stale_citation covers fact refs only).

## Load-bearing facts + gotchas
- **Per-corpus causal counts (verified 2026-09-17):** dal-cv 521 · dal-nlp **454** · qbio 51 ·
  arxiv-nlp **17** · arxiv-cv 0 · default **0**. Docs 33/34's old figures (dal-nlp 175, default 296,
  "arxiv has none") are STALE — a backfill re-attributed them after doc 33 was written.
- **`platform/src/index.ts` is invisible to ripgrep** (NUL bytes) — use `grep -a`.
- **`rawQuery` rewrites snake_case→camelCase**, so `row.entity_id` is silently `undefined`.
- **Bash-tool heredocs mangle `\\n`** inside python `replace()` strings — it became a real newline and
  broke a TS string literal. Use the Edit tool for anything with escapes.
- **Absolute R@10 on the entity task rides on the index-asc tie-break**; deltas are the claim, levels are
  not. On doc 44's causal task ties were a **non-issue** (opt == pess in all cells).
- **The condensed oracle is NOT arm-neutral** — it credits lexical retrieval far more than dense, so doc
  46 claims **strict only**. Do not quote its condensed numbers as the result.
- **Empirical discipline paid off again, three times:** the doc-44 adversary caught a survivorship bug and
  a CI asserted over uncomputed cells; I caught doc 45's circular feature and vacuous swap test myself by
  checking a suspicious exactly-0.0000; and doc 46's own control narrowed its claim from "fact text" to
  "any lexical substrate". **Pre-register → measure → blind adversary → return-check the adversary → bank.**
- **Commit only when the user asks. NEVER add Co-Authored-By.**
