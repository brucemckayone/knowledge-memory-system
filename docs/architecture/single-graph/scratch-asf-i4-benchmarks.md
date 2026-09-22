# scratch — I4 (causal / explanatory): is the committed Corr2Cause / CLadder plan a valid test of nmemo?

**Read-only pre-work investigation, 2026-09-17.** No source file, migration, or DB row was modified. This
doc is the only write. It does **not** pre-register anything and does not design an experiment — it lays out
validity properties and costs so a human can pick.

**Claim labels used throughout:** `[V]` = verified from a primary source (paper/dataset card/repo) or my own
read of code/DB; `[V2]` = independently verified twice; `[V-idx]` = number came from a search index of the
primary PDF, not read directly; `[D]` = claimed by a project doc (cited by path:line); `[I]` = my inference;
`[UNVERIFIED]` = could not verify — do not cite.

**REVISED once, after a parallel primary-source survey returned** (~350 fetches across five research agents).
The revision **demoted my first external pick (ESTER)**, added four stronger candidates, added §C.2a
(published prior art that predicts a negative for causal-graph retrieval), and **retracted an unverified
Corr2Cause criticism I had drafted from a laundered AI-generated source** (§A.1, item 2). Sections changed:
§A.1 criticism, new §A.5, §C.1 (rewritten), new §C.2a, A3/A5, §C.4, BOTTOM LINE 6–8.

---

## BOTTOM LINE

1. **NO — the committed Corr2Cause/CLadder plan does not validly test nmemo's retrieval architecture.** Both
   benchmarks are **100% self-contained in the prompt** `[V]`. CLadder's items literally open *"Imagine a
   self-contained, hypothetical world with only the following conditions, and without any unmentioned factors
   or causal relationships"* `[V]` — the prompt forbids external knowledge. Corr2Cause's premises are
   *"Suppose there is a closed system of N variables, A, B, …"* over abstract letters `[V]`. There is nothing
   to retrieve, so no knowledge graph can contribute.

2. **The committed wiring makes it worse than uninformative — it is a "store the answer key, then read it
   back" round-trip.** `docs/benchmarks/plan.md:157` specifies: *"ingest the question's preamble … then ask
   the question … a one-shot ingest call followed by a query"* `[D]`. The corpus is the prompt. The Graph-C-on
   arm can only return a lossy LLM re-derivation of text the model already had.

3. **Two concrete code-level defects would void the pre-registered ablation even on its own terms** `[V]`:
   (a) **entity collision across items** — Corr2Cause variables are literally `A`/`B`/`C`/`D`, so within one
   `corpus_id` every item's "A" resolves to the same entity node and items contaminate each other. **CLadder
   is measurably worse:** it uses only **10 causal graph structures with 2–5 stories each** (~20–50 distinct
   stories total) and **50–100 questions per story-graph-query combination** `[V]` — so the same variable
   names (*education level*, *salary*) carry **different probabilities and opposite gold answers** across
   dozens-to-hundreds of items that would all fuse onto the same nodes; (b) the causal pass would fire on
   trigger (b) `promotedFactCount >= 5`
   (`config.ts:126`) on nearly every item, so ~1.1k–10k agentic Haiku invocations get spent generating
   cross-contaminating edges.

4. **Corr2Cause/CLadder answer a different question than the one we care about.** They test *"can this LLM
   emulate d-separation / do-calculus"* (a **model-capability** question, with a deterministic symbolic
   ceiling). I4 asks *"does our causal substrate help answer causal/explanatory queries better than the
   alternatives"* (an **architecture** question). No wiring converts the former into the latter.

5. **There IS one narrow valid wiring — invert the direction.** Use Corr2Cause as an **over-assertion probe
   on the causal agent**, not a lift benchmark: 81.4% of items are labelled *invalid* `[V]`, i.e. cases where
   asserting a causal edge would be **wrong**. Metric = edge-assertion precision / refusal rate, not F1. That
   tests a shipped component whose failure mode (a causal agent that manufactures edges from mere
   co-occurrence) directly poisons the graph. Cheap: ~300–500 items, Haiku, **order $1–5**.

6. **There is no large, natural, clean-oracle "why-question over a corpus" benchmark** `[V]` — a ~350-fetch
   primary-source survey confirms it; every near-miss breaks a different leg (§C.1). The closest published
   analogue to Graph-C-as-retrieval, **CausalRAG** (ACL Findings 2025), does **not** use Corr2Cause or CLadder
   — it uses 100 OpenAlex abstracts scored by a **GPT-4o-mini RAGAS judge** with no numbers in the main text
   `[V]`: exactly the LLM-judge hazard I5 was deferred for. The project already knew this:
   *"there is no causal-question oracle"* (`28-remaining-levers-feasibility.md:27` `[D]`). Also note the
   area's critique paper (arXiv 2407.08029) is an **anti-guide** — its fourth desideratum is literally
   *"**Non-retrievable**: … answers cannot simply be looked up"* `[V]`, the exact negation of what we need
   (§A.5).

7. **Top valid alternatives** (full set, costs and oracle geometry in §C.3–C.4):
   - **A1/A1b. Graph C quality audit — the cheapest honest answer to "real or theatre".** Blind adjudication
     of a stratified sample of the live 1,043 edges against their own `source_references` (precision) + a
     deterministic marker-mined coverage check (recall), with injected hollow controls and paired
     discrimination (the Leg-2/Leg-3 pattern, **not** a bare LLM rubber-stamp). **~$10–50 combined.** Claims
     edge quality, not retrieval value. §C.2a(f) predicts precision passes and **coverage is where the finding
     is**.
   - **A5a + A5b. External-corpus causal retrieval** — **Cawai / e-CARE-as-retrieval** (arXiv 2504.04700:
     **exact gold-sentence-id oracle, fully deterministic**, and dense is *measured* to fail at it — DPR
     Hit@1 16% at a 2M pool, 44% of its errors being "semantic drift") paired with **BRIGHT StackExchange**
     (~632 explanatory queries over 50–121k-doc corpora, **clean nDCG@10** on PhD-unanimous labels, and SOTA
     embedders collapse **59.0 → 18.3**) `[V]`. **~$50–300** (ingestion; scoring free), + a ~$2 edge-yield
     smoke as a kill condition. **This replaces my first pick, ESTER, which the survey demoted** (only **431
     causal test questions**, and the gold span sits *inside* the given passage ⇒ high embedding correlation).
   - **A2. Corr2Cause-as-over-assertion-probe** (bullet 5). **Clean oracle, ~$1–5.** Component precision, not
     retrieval value.
   - *(A3 on our own dal-cv stays **blocked** — no fact→document link (`facts.source_memory_id` 100% NULL;
     `fact_sources`/`fact_units`/`source_document`/`fragment` all **0 rows** `[V]`), so no leak-free held-out
     split. The survey did improve it: use **Quriosity**'s causal slice (13.5K real search-engine questions,
     up to 42% causal) instead of mining our own sentences, which removes the derived-from-gold hazard — but
     the labels then have to be built, so it is a "we built the labels" claim, not a benchmark result.)*
   - **NEVER use as the oracle:** **WorldTree/TextGraphs** (lexical overlap is a *construction constraint* on
     the gold label — our doc-30 failure reproduced exactly) or **ELI5/KILT-ELI5** ("copy the question" scores
     20.0 ROUGE-L vs RAG's 16.1; nearest-train-answer 28.5 beats every model; 81% train/dev paraphrase
     overlap; κ=0.1) `[V]`.

8. **THE PRIOR IS NEGATIVE, from outside the project — price any I4 retrieval experiment as buying a credible
   null, not a lift.** Three independent published results (§C.2a) `[V]`: (a) on CauseNet, **BERT/RoBERTa/E5
   embeddings did not beat GloVe** — *the bottleneck is edge existence, not similarity ranking*, a direct
   precedent for our R@10 ≈ 0.20–0.23 saturation; (b) on Touché 2023 — **the only purpose-built causal
   retrieval benchmark** — a CauseNet dense-expansion run was the **worst of four, 0.268 vs 0.657 nDCG@5**,
   independent corroboration of doc-28→32; (c) at corpus scale, dense causal retrieval lands at **Hit@1
   16–22%**. The one result pointing the *other* way is a **fusion** result (FreshStack: *"Fusion ensemble
   outperforms individual models on all topics"*) — the closest published analogue to our one confirmed lever.
   **And one result challenges a load-bearing nmemo design choice:** feeding the LLM a causal graph's
   *provenance text* **HURT** accuracy versus bare triples (0.768 → 0.669) — so Graph C's mandatory
   `reasoning` + `source_references` may be right for auditability and wrong for answer quality. Test it as a
   cheap separate arm; do not assume it helps.
   All of this points the same way as our own banked meta — *"dense embedding is the retrieval engine; the
   cheap graph/lexical levers do NOT add"* (`43-longmemeval-i2-multihop-prereg.md:146-148` `[D]`). **A null is
   the expected outcome, and it is only worth buying if the oracle is clean enough for the null to mean
   something** — which is exactly why A5a/A5b (deterministic, measured-embedding-orthogonal) are the right
   corpora and WorldTree/ELI5 are not.

---

## A. What Corr2Cause and CLadder actually contain

### A.1 Corr2Cause

- **Paper:** Jin et al., *Can Large Language Models Infer Causation from Correlation?* —
  https://arxiv.org/abs/2306.05836 (paper: CC BY 4.0) `[V]`. Data:
  https://huggingface.co/datasets/causalnlp/corr2cause (card's license field is literally `TODO` `[V]`).
  Code: https://github.com/causalNLP/corr2cause — repo is **MIT** `[V]`, and also ships `data_2class`,
  `data_3class`, and a **`data_paraph` paraphrased test set** (the OOD perturbation cut behind the 94.74 →
  57.42 F1 collapse).
- **Task format:** binary NLI-style entailment — premise (correlational statements) + hypothesis (a causal
  claim) → *valid / invalid* `[V]`.
- **Premise template, verbatim:** *"Suppose there is a closed system of N variables, A, B, … All the
  statistical relations among these N variables are as follows: [correlation statements]"* `[V]`
  (arXiv HTML render of the paper). A fuller instance from search corroboration: *"Suppose there is a closed
  system of 5 variables, A, B, C, D, and E. All the statistical relations among these 5 variables are as
  follows: A correlates with B. A correlates with C. … D correlates with E."*
- **The six hypothesis templates, verbatim** `[V]`:

  | Relation | Template |
  |---|---|
  | Is-Parent | "{Var i} directly causes {Var j}." |
  | Is-Child | "{Var j} directly causes {Var i}." |
  | Is-Ancestor | "{Var i} causes something else which causes {Var j}." |
  | Is-Descendant | "{Var j} is a cause for {Var i}, but not a direct one." |
  | Has-Collider | "There exists at least one collider (common effect) of {Var i} and {Var j}." |
  | Has-Confounder | "There exists at least one confounder (common cause) of {Var i} and {Var j}." |

- **Size (verified, and a correction to our plan):** **207,972 total; 205,734 train / 1,076 dev / 1,162 test**
  `[V]` (paper Table 3; the HF card rounds to 206,000/1,080/1,160). 18.57% positive labels. 424.11 tokens per
  premise on average. 2–6 variables.
  > **CORRECTION to `docs/benchmarks/plan.md:151`**, which pre-registers *"full eval set (200K+ examples). If
  > runtime is prohibitive … stratified sample of 5,000"* `[D]`. The 200K is the **train** split. The eval set
  > is **1,162 items** — smaller than the proposed 5,000 "subsample", which would have to be drawn from train
  > (a train/test confusion). `[I]`
- **HF row schema** `[V]`: `input` (string, 312–9,260 chars — premise+hypothesis rendered together), `label`
  (int 0/1), `num_variables` (4–6), `template` (one of six).
- **Known results** `[V]`: off-the-shelf LLMs are **near floor**. Best off-the-shelf **BART-MNLI 33.38 F1**;
  **GPT-4 29.08 F1** (precision 20.92 / recall 47.66 / acc 64.60); GPT-3.5 21.69 F1; random-proportional
  13.5 F1. Fine-tuned RoBERTa-Large-MNLI reaches **94.74 F1** in-distribution but collapses to **57.42 F1**
  under paraphrase perturbation — the paper's headline generalisation failure.
- **Ceiling note `[I]`:** labels are generated by a deterministic procedure over directed graphical causal
  models (Markov-equivalence / d-separation). A **symbolic solver scores ~100%**. So the benchmark measures
  how well a language model emulates an algorithm we could just run. A knowledge graph is orthogonal to that.
- **Known criticism — and a provenance warning about my own first draft.** Published criticism specific to
  Corr2Cause is **thin**. What actually exists `[V]`:
  1. **A real, unresolved primary-source complaint:** GitHub issue #5, *"Discrepancy in MEC from PC Algorithm
     vs. the generated dataset"* (opened 2026-01-22, **no maintainer response**) —
     https://github.com/causalNLP/corr2cause/issues/5. A user reports that running the PC algorithm on the
     paper's own correlation set yields a different Markov equivalence class from the one the generated labels
     imply. **This is the citable version of the labelling concern.**
  2. > **CORRECTION TO MY OWN EARLIER DRAFT.** I first recorded (from a web-search summary, flagged
     > `[UNVERIFIED]`) a stronger claim: that the construction enumerates DAGs *up to isomorphism* and then
     > computes MECs on those representatives, conflating isomorphism with Markov equivalence, which would
     > make some labels systematically wrong. **Do not propagate it.** Every search surfacing it traces back
     > to `pith.science/paper/2504.14530`, an **AI-generated "review" page**, and arXiv 2504.14530 is
     > **Zhijing Jin's own PhD thesis** — i.e. by the Corr2Cause author, so it cannot be the source of a
     > criticism of her own dataset. Status: **unverified, non-peer-reviewed, laundered provenance.** Treat as
     > a hypothesis worth checking *in the code*, not a citation. `[V2]`
  3. Generalisation failure replicates independently: *"Do LLMs Have the Generalization Ability in Conducting
     Causal Inference?"* (arXiv 2410.11385) `[V-idx]` — fine-tuning improves in-distribution only.
  4. The area-level critique is arXiv 2407.08029 — see §A.5, and note it is an **anti-guide** for our purpose.

### A.2 CLadder

- **Paper:** Jin et al., *CLadder: Assessing Causal Reasoning in Language Models* —
  https://arxiv.org/abs/2312.04350 (CC BY 4.0) `[V]`. Repo: https://github.com/causalNLP/cladder (README
  states **MIT** for the data) `[V]`. Data: https://huggingface.co/datasets/causalnlp/CLadder,
  `cladder-v1.zip` ~6.5 MB.
- **Task format:** binary **yes/no** natural-language questions grounded in a formal causal graph + query,
  spanning all three rungs of Pearl's ladder (associational / interventional / counterfactual) `[V]`.
- **A REAL VERBATIM ITEM (question_id 16825)** `[V]`:
  > **Background / given info:** *"Imagine a self-contained, hypothetical world with only the following
  > conditions, and without any unmentioned factors or causal relationships: Unobserved confounders has a
  > direct effect on education level and salary. Proximity to a college has a direct effect on education
  > level. Education level has a direct effect on salary. Unobserved confounders is unobserved. For people
  > living far from a college, the probability of high salary is 35%. For people living close to a college,
  > the probability of high salary is 53%. For people living far from a college, the probability of college
  > degree or higher is 40%. For people living close to a college, the probability of college degree or higher
  > is 73%."*
  >
  > **Question:** *"Will college degree or higher decrease the chance of high salary?"*
  > **Answer:** `no` · **query_type:** ATE · **rung:** 2 · **graph_id:** instrumental variable
- **Size** `[V]`: **10,112 questions**, balanced 5,056 yes / 5,056 no; ~6 sentences / ~81 words per item;
  3.5 nodes / 3.4 edges average. Rung split roughly 3,160 / 3,160 / 3,792.
- **Generation structure (important — this is what drives the collision problem in §B.2)** `[V]`:
  **10 distinct causal graph structures**, **2–5 stories collected per graph** from the causal-inference
  literature (so ~20–50 distinct stories in total), each expanded into commonsense / anti-commonsensical /
  nonsensical variants, crossed with the applicable query types, at **50–100 questions per
  story-graph-query combination**. The 10,112 questions are therefore a dense re-use of a *small* pool of
  named variables.
- **JSON schema** `[V]`: `question_id`, `desc_id`, `given_info`, `question`, `answer`, `reasoning`, and
  `meta{query_type, rung, story_id, graph_id, model_id, groundtruth}`. Variants:
  `cladder-v1-{balanced,easy,hard,commonsense,anticommonsense,nonsense}.json`.
- **Known results** `[V]`: **near floor but above chance.** Random 49.27%; GPT-3.5 52.18%; **GPT-4 62.03%**;
  GPT-4 + the paper's own CausalCoT prompt **70.40%** (rung 1 83.35 / rung 2 67.47 / rung 3 62.05).
- **The anti-commonsense and nonsense variants** exist precisely to isolate memorisation from formal
  reasoning `[V]` — i.e. the benchmark is *designed* to make external knowledge useless. That is a design
  goal of the benchmark and it is directly hostile to the "add a knowledge graph" hypothesis. `[I]`

### A.3 The decisive property, stated plainly

**Every item in both datasets is fully self-contained** `[V]`. Corr2Cause's variables are abstract letters
with no referent outside the item. CLadder's items open with an explicit instruction that the world contains
*"only the following conditions"* and *"no unmentioned factors or causal relationships."* There is no corpus,
no document collection, no prior session, and nothing a retriever could be scored on finding.

**And this is deliberate — it is the whole point of these two datasets.** The standing critique of the causal
benchmark literature is arXiv 2407.08029, *A Critical Review of Causal Reasoning Benchmarks for Large Language
Models*, whose abstract reads `[V]`: *"Numerous benchmarks aim to evaluate the capabilities of Large Language
Models (LLMs) for causal inference and reasoning. However, **many of them can likely be solved through the
retrieval of domain knowledge**, questioning whether they achieve their purpose."* Corr2Cause (abstract
letters `A…E`) and CLadder (self-contained world + anti-commonsense + nonsense variants) are the field's
**answer** to that critique — they are engineered specifically so that retrieving knowledge cannot help. `[I]`
Choosing them to demonstrate the value of a retrieval substrate inverts their design intent.

### A.4 Cost to run (my arithmetic, over verified sizes; pricing from the `claude-api` skill table, cached
2026-06-24: Haiku 4.5 $1.00/$5.00 per MTok in/out; Sonnet 5 $2.00/$10.00; Batch API −50%)

| Arm | Calls | Rough tokens | Rough $ |
|---|---|---|---|
| Corr2Cause, full test (1,162), direct answer, Haiku | ~1.2k | ~0.6M in / ~0.1M out | **~$1** |
| CLadder, full (10,112), direct answer, Haiku | ~10k | ~3.5M in / ~1M out | **~$10** |
| Corr2Cause 1,162 with Graph-C-on ingest (extraction + agentic causal pass, ~10–30 calls/item, growing ctx) | **~12k–35k** | ~35–100M in | **~$50–200** |
| CLadder 10,112 with Graph-C-on ingest | **~100k–300k** | ~300–900M in | **~$300–900** |

Notes: `[I]` the plan's *"~5K Sonnet judge calls"* (`plan.md:163`) is **unnecessary spend** — both benchmarks
are binary, so scoring is exact string match; no judge is needed. `[I]` The Graph-C-on arms are where the
money is, and they are the arms that (per §B) cannot be informative. Note also that these arms **write** to
the graph: ~1.1k–10k synthetic "worlds" would be ingested, which needs a throwaway corpus or database to
avoid polluting `cognitive_test`.

### A.5 The area's own critique paper is an ANTI-GUIDE for our purpose

arXiv 2407.08029 (Yang, Shirvaikar, Clivio, Falck — Oxford Statistics; AAAI 2024 workshop *"Are Large Language
Models Simply Causal Parrots?"*) surveys ~39 causal benchmarks. Its **four desiderata**, verbatim `[V]`:
(1) *"causal rather than correlative … dealing with directional interventions and/or counterfactuals"*;
(2) *"open-ended … rather than providing a fixed set list of options"*; (3) *"scalable … introduce multiple
factors"*; (4) **"Non-retrievable: The benchmark should be phrased with non-informative or fictional context,
such that answers cannot simply be looked up."**

`[I]` **Desideratum 4 is the exact negation of what an I4 substrate test needs.** This paper wants benchmarks
where nothing can be looked up; we need benchmarks where something *must* be. So its recommendations are an
**anti-guide**: the benchmark it praises most (CLadder) is useless to us, and several it dismisses as *"mere
retrieval"* are the shape we want. Anyone reaching for this paper to justify the I4 benchmark choice has it
backwards.

Its verdicts that matter here, all verbatim `[V]`:
- On the bucket containing **MAVEN-ERE, e-CARE, Causal-TimeBank, EventStoryLine, COPA, CRASS** and others:
  *"LLMs can achieve good performance without actually doing any causal reasoning"* and *"the good performance
  could be attributable to spurious language cues in the datasets."*
- On **Corr2Cause**: *"its use of letters as the basic 'algebra' is very different to a reasonable real-world
  interpretation: one may argue that **humans would also fail** to find causal relationships based purely on
  conditional independence statements between even just a handful of variables without knowledge about the
  underlying algorithm."* `[I]` A benchmark on which humans would also fail is not a measure of a memory
  system.
- On **CLadder**: *"perhaps the most advanced causal benchmark available currently"*, but *"it is possible that
  CLadder's tasks still allow the LLM to use its pre-existing knowledge"* and *"merely adding 'imagine a
  self-contained hypothetical world' to the beginning of the prompt as done in CLadder does not imply an LLM
  will actually follow the instructions."*
- On **CausalBank / CEG**: criticised under *"Unsuitable evaluation metrics"* — *"standard NLP evaluation
  metrics like n-grams or ROUGE-L … are used to measure how 'accurate' the model-generated explanation is."*
- On **e-CARE** data quality: *"there are examples where making the right decision is even difficult for a
  human, since the options are not well-crafted."*
- Memorisation: *"Experiments (Kıcıman et al. 2023) have shown that GPT-3.5 and GPT-4 memorised the Tübingen
  cause-effect dataset, or a large portion of it."*
- **It does not mention WikiWhy at all** `[V2]` — do not cite it as a WikiWhy critique.

---

## B. Would running them test nmemo at all?

### B.1 What could `causal_edges` possibly contribute? Nothing, and here is the shape of the graph to show it

Live census of `cognitive_test`, verified by read-only SQL this session `[V]`:

- `causal_edges` **1,043** rows; `causal_events` **17,847** (`transition_type`: 17,846 `created`, 1
  `strengthened`).
- Edges by the corpus of their cause event: **dal-cv 521 · dal-nlp 454 · qbio 51 · arxiv-nlp 17**.
  > Two small corrections to `33-graph-structure-analysis.md:15-19` `[V]`: **arxiv-nlp now has 17 edges**
  > (doc 33 says 0), and **dal-nlp has 454** (doc 33 says 175). No `default`-corpus edges appear in
  > `cognitive_test`.
- All 1,043 edges have `extraction_method = 'causal_promotion'`.
- **142** cause→effect pairs chain (one edge's effect is another's cause), so multi-hop causal chains exist
  but are rare relative to 1,043 edges.
- `causal_events` **is** corpus-partitioned (`corpus_id` present, qbio 6,955 / arxiv-nlp 2,863 / arxiv-cv
  2,852 / dal-nlp 2,612 / dal-cv 2,565); `causal_edges` is **not** — but `traceCauses`
  (`platform/src/services/causal.ts:858-938`) scopes by joining through `causal_events.corpus_id`, so
  corpus-scoped causal reads do work. Doc 33's "edges not corpus-partitioned (a fix)" is true of the table
  but **not** a read-path blocker. `[V]`

**What the edges actually say** — a verbatim live row from dal-cv `[V]`:

> `reasoning`: *"Operating on a pre-trained text-to-image diffusion model eliminates the need for further
> training or finetuning. MultiDiffusion's ability to work without additional training is a direct
> consequence of leveraging the existing foundation model's learned representations."*
> `source_references`: two `{type: "fact", id, relevance}` entries. `cause_pred`: `uses_artifact` →
> `effect_pred`: `requires_no_training`.

So Graph C, as populated, is **fact→fact causal claims about the technical content of research papers**.
Corr2Cause asks about d-separation over letters `A…E`; CLadder asks about an ATE in a hypothetical world with
stated conditional probabilities. The two ontologies are **categorically disjoint** `[I]`: there is no
retrieval, traversal, or fusion under which "MultiDiffusion uses a pre-trained model, therefore needs no
training" bears on "does A directly cause B given that A correlates with B."

Note also the schema semantics `[V]` (`platform/src/db/migrations/002_causal_graph.sql:67-141`): a
`causal_event` is a **transition in Graph S** (`created | strengthened | weakened | expired | invalidated`),
and a `causal_edge` links one transition to another. Graph C is, by construction, causality between
*knowledge-state changes*, not between *variables in a statistical model*. Corr2Cause/CLadder are the latter.

### B.2 Is there ANY wiring under which the graph changes the answer? Yes — and every one is a defect

The committed plan (`docs/benchmarks/plan.md:157`) ingests the item's own preamble and then queries it `[D]`.
Under that wiring the graph *can* change the answer, by three mechanisms — all of them artifacts:

1. **Lossy re-derivation.** Extraction + causal assertion + retrieval returns a compressed, LLM-rewritten
   version of text the model was already given. Any delta measures pipeline lossiness, not retrieval value.
   `[I]`
2. **Cross-item contamination via entity collision (verified, decisive).** `entities.corpus_id` is free-form
   `text` `[V]`, and entity resolution is corpus-scoped. If all items share one `corpus_id`, then **every
   item's variable "A" resolves to the same entity node.** 1,162 mutually inconsistent worlds would be fused
   onto four nodes named `A`,`B`,`C`,`D` — and 8 entities already carry those names in `cognitive_test` `[V]`.
   **CLadder is worse, and the numbers are now verified:** the dataset is built from **10 causal graph
   structures**, with **2–5 stories collected per graph** (~20–50 distinct stories for all 10,112 questions),
   and **50–100 questions per story-graph-query combination** `[V]`. So one story (*education level →
   salary*, *drug–gender–recovery*) anchors dozens-to-hundreds of items that differ only in their
   **probability values and their gold answer**. Fused onto shared entity nodes, the graph would hold
   mutually contradictory numeric facts about the same entities, and every item's retrieval would pull other
   items' numbers. The only wiring that avoids this is **one
   `corpus_id` per item** (1,162 / 10,112 corpora) — which the plan does not specify, and which reduces the
   "graph" to a single-item scratchpad, i.e. a chain-of-thought buffer. `[I]`
3. **The conditional trigger fires for the wrong reason.** `hasCausalLanguage`
   (`platform/src/services/causal-pass-trigger.ts:23-54`) matches 23 cues — `because`, `caused`, `led to`,
   `due to`, `as a result`, … — and contains **no** `correlat*` term `[V]`, so trigger (a) would *not* fire on
   a Corr2Cause premise. But trigger (b) is `promotedFactCount >= CAUSAL_PASS_FACT_THRESHOLD`, default **5**
   (`platform/src/config.ts:126`) `[V]`, and a 4–6-variable premise with ~10–15 correlation statements clears
   5 facts easily — so the pass runs anyway, on input it was never designed for. Trigger (c)
   (`touchedEntityHasCausalHistory`) then fires on every item after the first, because of mechanism 2. `[I]`

**Additional adversarial point `[I]`:** on Corr2Cause the *correct* answer is usually "invalid" (81.43% of
labels). A causal agent handed "A correlates with B" and asked to assert edges with `reasoning` and
`source_references` is under pressure to assert something — the exact opposite of the correct behaviour. So
the Graph-C-on arm is **biased toward a negative result for a reason that has nothing to do with retrieval
quality.** A negative here would be un-interpretable, and a positive would be more suspicious still.

### B.3 The circularity test: could we ingest the benchmark's causal structure and query it?

Yes, and it is the canonical failure mode this project already names. Both datasets ship the ground-truth
graph: Corr2Cause has the DGCM behind each item; CLadder has `meta.graph_id` + `formal_form` + a step-by-step
`reasoning` field `[V]`. Ingesting that structure into Graph C and then querying it **stores the answer key
and reads it back.** It would produce a near-perfect number that measures a database round-trip. `[I]`

Ingesting only the *premise* (the committed plan) is the non-circular version, and that is §B.2 — where the
graph adds nothing except contamination.

### B.3a Graph C is a SECOND-STAGE mechanism, not a retrieval engine (verified, and it reframes I4)

`trace_causes` and `project_trajectory` are both exposed as `mutates: false` MCP tools in `GRAPH_TOOLS`
(`platform/src/services/causal-agent.ts:290,314`) — so an agent can query Graph C over MCP today. But **both
require `fact_id`** (`:310,334`) `[V]`. There is no "search Graph C by question" entry point: the seed fact
must come from first-stage retrieval (dense or lexical).

`[I]` Therefore Graph C **cannot be a retrieval engine**; it is a **post-retrieval evidence expansion**. Its
only honest value proposition is: *given a correctly-retrieved seed fact, does the causal chain surface
evidence that a dense retriever would have missed?* That is narrower than "does Graph C help retrieval", and
usefully so:

- It is **not** settled by the I1/I2 meta. I1/I2 measured first-stage retrieval. A second-stage recall
  expansion is the same *shape* as the entity-traversal lever I2 de-motivated, but it has never been measured
  against **causal** gold.
- It maps onto the one confirmed lever in this project's record — the R4 entity⊕fact fusion, whose win came
  from **emergent hits** (items neither leg found alone). The testable I4 analogue is: does
  `dense-seed ⊕ traceCauses(seed)` produce emergent hits against a causal oracle?
- It also bounds the upside: only **142** of 1,043 edges chain (§B.1) `[V]`, so the expansion is usually one
  hop deep.

**Coverage is capped by construction `[D]`.** `28-remaining-levers-feasibility.md:21-23`: the causal pass is
delta-scoped and capped at `CAUSAL_PASS_SCOPE_CAP=200` per epoch (bead `nmemo-umf`), so *"cross-batch
causality is structurally invisible — an under-scoped false negative risk that must be accounted for or fixed
first."* Any coverage/recall finding about Graph C must attribute misses to this cap before attributing them
to the mechanism.

### B.4 The two questions, separated — and the one narrow valid wiring

- **(i) "Can an LLM reason causally?"** — a model-capability question with a deterministic symbolic ceiling.
  **This is what Corr2Cause and CLadder answer.** It is orthogonal to our architecture. We would be paying
  Haiku to reproduce a published GPT-4 number `[I]`.
- **(ii) "Does our causal substrate help answer causal/explanatory queries better than the alternatives?"** —
  the architecture question, which requires a corpus, competing arms, and an oracle over evidence. **Neither
  benchmark answers it, under any wiring.** `[I]`

There is, however, **one narrow valid reading of Corr2Cause** — invert the direction of the test `[I]`:

> **Corr2Cause as a causal-agent over-assertion probe.** Do not measure benchmark F1. Feed premises to the
> causal-assertion component and measure **whether it correctly refuses to assert a causal edge** when the
> input only licenses correlation. 81.43% of items are `invalid`, and the six hypothesis templates give a
> clean per-relation breakdown. Metric = assertion precision / refusal rate, with the `has-collider` and
> `has-confounder` templates as the discriminating cases. This tests a **component nmemo actually ships**,
> whose failure mode (manufacturing causal edges from co-occurrence) is a known graph-poisoning risk, and its
> ground truth is deterministic.
>
> **Feasibility caveat `[V]`:** `invokeCausalAgent(epochId, scope)`
> (`platform/src/services/causal-agent.ts:4084`) is **epoch-scoped and post-promotion** — it cannot be pointed
> at arbitrary text. Running the real component means ingest + promote per item (expensive, and it writes).
> Running just the agent's prompt + tool schema standalone is cheap but tests the prompt, not the system. That
> tradeoff must be chosen explicitly, and stated in whatever scope claim results.

---

## C. What WOULD be a valid I4 test?

### C.1 External candidates

> **REVISED after the parallel survey returned** (~350 primary-source fetches across five research agents;
> full report at
> `C:\Users\bruce.mckay\.claude\projects\C--Users-bruce-mckay-dev-nmemo\a79d5001-312a-4c19-8e01-ff904d0abc8b\tool-results\toolu_01LVCDux18B9ytsFkHGp2oZV.txt`).
> The survey **demoted my first pick (ESTER)** and surfaced four stronger candidates I had missed, plus
> **prior art that directly predicts a negative for causal-graph retrieval** (§C.2a). Read §C.2a before
> costing anything here.

The load-bearing question for every candidate is: **does the system have to RETRIEVE from a corpus, or is the
item self-contained?** Then: **is the oracle clean?** Then: **is the gold embedding-recoverable?**

**The survey's bottom line `[V]`:** *there is no large, natural, clean-oracle "why-question over a corpus"
benchmark.* Each near-miss breaks a different leg. Almost every set on the standard candidate list is
**self-contained with zero retrieval** (e-CARE, COPA/BCOPA/XCOPA, TRACIE, CRASS, CLadder, Corr2Cause,
CausalProbe-2024, CommonWhy, WIQA, CREPE, TellMeWhy) or has **gold event mentions pre-enumerated** so there is
nothing to rank (MAVEN-ERE, EventStoryLine, Causal-TimeBank, MECI, CNC, FinCausal, UniCausal, MATRES).

#### The four genuine candidates, ranked

**1. Cawai / e-CARE-recast-as-retrieval** (arXiv 2504.04700, CC BY 4.0,
https://github.com/00HS/causality-aware-retriever) `[V2]` — **the cleanest oracle, and the result that most
supports the I4 thesis.** Explicit causal sentence retrieval: given a cause, retrieve the effect sentence (and
vice versa) from distractor pools of **2,136 / 2M / 20M** Wikipedia and RedPajama sentences. **Oracle = exact
gold-sentence identity, fully deterministic.** Metrics Hit@1/@10, MRR@10. Measured: DPR Hit@1 **36.3** (small
pool) → **16.0** (2M Wikipedia); BGE-M3 42.2 → 22.1; BM25 8.9 → 4.6. And verbatim: *"A manual analysis of 50
randomly sampled cases where DPR retrieved an incorrect passage reveals that **44% of failures arise from such
semantic drift**."* `[I]` This is the mirror image of our concept-layer arc: there the oracle *was*
embedding-aligned and structure lost; here the target is embedding-**orthogonal** and the embedding loses —
which is the only geometry in which a causal substrate can show a gain. **Caveats `[V]`:** a *third-party
synthetic recasting*, not the dataset authors' task; short sentence pairs, not natural why-questions; random
distractors rather than hard negatives (so the 2M numbers are a scale stress test, not adversarial);
arm-neutrality untested.

**2. BRIGHT StackExchange subsets** (arXiv 2407.12883, CC BY 4.0, https://huggingface.co/datasets/xlangai/BRIGHT)
`[V]` — **clean oracle on real corpora, measured anti-embedding.** ~**632 explanatory queries** over
**50k–121k-document** corpora (biology 103/57,359 · earth science 116/121,249 · economics 103/50,220 ·
psychology 101/52,835 · robotics 101/61,961 · stackoverflow 117/107,081 · sustainable living 108/60,792).
Verbatim biology query: *"Why are insects attracted to light sources despite LEDs producing minimal heat?"* →
gold docs **Phototaxis** and **Proximate and ultimate causation** — i.e. the gold explains the *mechanism*,
not the topic. **Oracle: CLEAN, nDCG@10 against `gold_ids`**, labels = documents cited in accepted/highly-voted
answers, kept only where *"unanimous agreement across multiple PhD annotators"*. **Measured anti-embedding:
SFR-Embedding-Mistral scores 59.0 nDCG@10 on MTEB but 18.3 on BRIGHT**; BM25 14.8, BGE 13.6, E5 17.9,
OpenAI 17.8. `[I]` **Note the asymmetry that makes this usable:** the label mechanism (links cited in answers)
is *structurally* the same family as our co-citation oracle — but unlike co-citation (cosine AUC 0.79), here
dense performance is *measured* to be poor, so the oracle is demonstrably **not** embedding-aligned.
`[UNVERIFIED]` the fraction of BRIGHT queries that are literally why-phrased is unpublished — **count it
before committing.**

**3. Touché 2023 Task 2 — Evidence Retrieval for Causal Questions** (CLEF 2023, Zenodo
10.5281/zenodo.8259922, CC BY 4.0) `[V]` — **the only purpose-built causal *retrieval* benchmark that exists**,
and the one that carries the most important warning (§C.2a). Task verbatim: *"Given a causality-related topic
and a collection of web documents, the task was to retrieve and rank documents by relevance to the topic"*;
*"Participants retrieve documents themselves from ClueWeb22 — no candidate set is provided."* Verbatim topic:

```xml
<title>Can eating broccoli lead to constipation?</title>
<cause>eating broccoli</cause><effect>constipation</effect>
<narrative>Highly relevant documents will provide information on a potential causal connection between
eating broccoli and constipation. … Documents are not relevant if they either mention one or both
concepts, but do not provide any information about their causal relation.</narrative>
```

Direction is enforced (*"a document stating that B causes A was considered off-topic"*). Oracle: **human
graded 0/1/2**, top-5 pooling, **718 documents labelled over 50 topics**, Fleiss κ **0.58** relevance, metric
**nDCG@5**. Topics were drawn from Webis-CausalQA-22 and CauseNet — it is the retrieval-native descendant of
both. **Fatal-for-us caveats `[V]`: 50 topics, 718 judgments, n=1 participating team, one year only (the
causal task did not recur in 2024), and ClueWeb22 needs a free CMU licence.** Any nDCG@5 difference below
~0.07 sits inside the confidence intervals.

**4. QASC + eQASC** (arXiv 1910.11473 / 2010.03274, https://github.com/allenai/qasc) `[V2]` — **anti-lexical
by construction, clean, huge corpus.** 9,980 questions over a **17M-fact web corpus**, answered by composing
**two** retrieved facts, with gold 2-fact annotations; eQASC adds 98,780 candidate chains with F1 / AUC-ROC /
**P@1 / NDCG**. The property that matters, verbatim: *"In **96%** of our crowd-sourced questions, at least one
of the two annotated facts had an overlap of **fewer than 3 tokens** (ignoring stop words) with this question
+ answer query."* Consequence: **single-step retrieval gets 2.9% recall** for both gold facts in the top 10;
**two-step gets 44.4%** — a 15× gap. `[I]` A single-shot dense or lexical retriever essentially *cannot* find
the gold, which is exactly the regime where a second-stage causal expansion (§B.3a) could show a gain.
**Caveats `[V]`:** questions are mechanism-*content* but **what/which MCQ-phrased**, not why-phrased, and MC
accuracy is not a retrieval metric — you must score the retrieval leg separately (both datasets permit it).

**Also worth knowing:** **EntailmentBank Task 3** (arXiv 2104.08661) has the cleanest *why*-item in the whole
survey — verbatim Q *"Why do mosquitoes move towards CO₂?"* → A *"It helps mosquitoes find food"* with gold
leaves *"Mosquitoes eat animal blood"* / *"Animals are food sources"* — and a brutal, informative floor:
T5-11B Overall-AllCorrect **35.3% (T1, gold leaves given) → 25.6% (T2, +distractors) → 2.9% (T3, full-corpus
retrieval)**, a 12× collapse purely from adding retrieval `[V]`. Only 1,840 trees, and intermediates are
matched by **BLEURT > 0.28** (model-based, so not fully clean). **ANTIQUE** (arXiv 1905.08957) has the highest
why-density of any graded-relevance collection — *"38% and 36%"* how/why, ~**945 why-questions** over
**403,666** Yahoo!Answers passages, **34,011 four-level human judgments**, deterministic MAP/nDCG, BM25 MAP
0.198 → BERT 0.377 `[V]`; but grade 4 encodes *convincingness* not correctness, and depth-10 pooling over a
404K collection reproduces **the strict-vs-condensed oracle problem we already hit** (doc 07). **Verberne's
why-QA** (CL 36(2), 2010) is 100% why-questions over 659,388 INEX Wikipedia articles with the **lowest
embedding correlation of anything surveyed** (BOW Success@10 only 45.2%) and she articulated our exact concern
in 2010 `[V]`: *"both collections consist of questions formulated to a pre-selected answer text. Questions
that are formulated to a text are likely to show more overlap with the answer text than questions that come
from a real-life QA collection."* — but n=**186** and her regex oracle was **tuned on her own system's
output**, so it is optimistically biased by construction.

#### ESTER — DEMOTED (this corrects my own first recommendation)

`[V]` The survey's verdict on ESTER is **"NO — passage is given"**, and two numbers kill it as the primary:
- The causal **test** set is **431 questions**, not the ~2.6K I extrapolated from "43.1% causal". *(43.1% is
  the share of relation pairs across the whole dataset, not the size of the causal test split.)*
- Embedding-correlation risk is **HIGH, not moderate** `[INF, survey]`: the gold span sits **inside the given
  passage**, so pooling passages into a corpus creates exactly the derived-from-gold geometry that invalidated
  papers-as-queries.

Everything else I verified about ESTER stands (repo https://github.com/PlusLabNLP/ESTER, arXiv 2104.08350,
clean F1ᵀ / HIT@1 / EM, context shipped with `answer_indices`, duplicate `passageID` so key on raw text) — it
is a usable *secondary*, not the primary. Licence still `[UNVERIFIED]`.

#### Traps — do not use these as the oracle

- **WorldTree / TextGraphs Explanation Regeneration — THE TRAP.** `[V]` Gold explanation graphs are defined as
  *"sets of **lexically overlapping** sentences"*, and lexical sharing with the question/answer is a
  **construction constraint on the gold label**. Empirically tf-idf MAP 0.296 vs best system 0.563 — tf-idf
  alone recovers ~53%. `[I]` **This is our doc-30 co-citation failure reproduced exactly**: a similarity
  baseline looks strong and a structural signal cannot show a gain, by construction.
- **ELI5 / KILT-ELI5 — the largest genuine why-corpus (44.8% why / 48.0% causal) with a broken oracle.** `[V]`
  Krishna et al. (arXiv 2103.06332): *"**81%** of ELI5 validation questions occur in paraphrased form in the
  training set"*; *"**ROUGE-L is not an informative metric** … and can be easily gamed"*; **"copy input"
  (repeat the question 5×) scores 20.0 R-L, beating RAG's 16.1**, and **"best top-7 train answer" scores 28.5,
  beating every computational model**. Generations conditioned on *random* Wikipedia retrievals score 24.20 vs
  24.42 on predicted retrievals (Spearman ρ = 0.09) — *"our system does not actually use the documents that it
  retrieves!"* KILT-ELI5 inter-annotator agreement is **κ = 0.1**. Original ELI5 is **defunct** (Reddit terms).
  `[I]` **Reject outright.** ELI5's dedup was TF-IDF-based, so the held-out split *selects for* low lexical /
  high semantic overlap — close to a worst case for us.
- **Webis-CausalQA-22 (the "CausalQA" in our `landscape.md:184-189`) — hands the model the context.** `[V]`
  **Not a retrieval benchmark**; 1.08M causal questions, oracle **ROUGE-L**, and on its MS MARCO / NQ / SQuAD
  subsets the causality-aware retriever's gain is a *decreasing function of query–document ROUGE-L* — i.e.
  measurably embedding/lexical-correlated. `[I]` Usable only by taking its span-extractive constituents and
  keeping *their* oracle; never the ROUGE-L headline.
- **CommonWhy** (arXiv 2605.12918) — 15,000 why-questions grounded in Wikidata, but **the subgraph is provided
  in the prompt** and the oracle is **GPT-4o-as-judge** `[V]`. Not retrieval, LLM-judged.

#### Query sources and methodology templates (if we build our own oracle)

- **Quriosity** (arXiv 2405.20318, CC BY-NC-SA 4.0) `[V]` — **13.5K naturally occurring questions** from search
  engines and conversations, **up to 42% causal**. No answers, no corpus, no task. `[I]` **This is the single
  most useful artefact in the survey for us**: real why-questions that were *not* written by anyone looking at
  our documents. Pointing Quriosity's causal slice at our own corpus defuses the derived-from-gold hazard that
  is otherwise fatal to A3 (see the revised A3 below).
- **FreshStack** (NeurIPS 2025 D&B, arXiv 2504.13128) `[V]` — the best published **methodology** template for
  constructing your own labels (nuggets + α-nDCG@10 / Coverage@20 / Recall@50), though its labels are
  LLM-judged at **71.7% fully relevant**. It also found *"Fusion ensemble outperforms individual models on all
  topics"* with BM25 the best single model on all five — see §C.2a(d).
- **LitQA2 / LAB-Bench** (arXiv 2407.10362) `[V-idx]` — 248 MCQs whose answers *"appear in the main body of a
  paper, but not in the abstract, and ideally appear only once in the set of all scientific literature"*: the
  cleanest **must-retrieve-from-a-corpus** oracle found, but factoid, not causal. A design pattern worth
  copying for constructing a must-retrieve causal item.
- **SemEval-2026 Task 12 — Abductive Event Reasoning** (arXiv 2603.21720) `[V]` — explicitly *"why an event
  occurred"*, gold evidence labels exist, but MCQ-shaped and **the documents are given**. Live task; watch it.

#### Corrections to my brief and to widely-repeated numbers `[V]`

- **"CausalQA over event data" does not exist.** There is exactly one CausalQA paper (the Webis 1.08M
  meta-collection); the thing being half-remembered is **CauseNet** or **Event-QA** (arXiv 2004.11861).
- **TRACIE is arXiv 2010.12753**, NAACL 2021 (2104.08350 is ESTER). TRACIE is self-contained (the 5-sentence
  ROCStory is inlined) and self-reports that *"**65% of the instances can be correctly predicted from the
  hypotheses alone**"* — the whole narrative is worth **3.6 points** (SYMTIME 75.3 story-deleted vs 78.9).
- **MATRES** is corpus-*dependent*, not retrieval: the release is annotation-only (raw TempEval3 documents
  obtained separately), rows are `docid, verb1, verb2, …` — a deterministic key lookup with no query, no
  ranking, no relevance judgement. T5-Large scores 86.0 on trigger sentences alone vs 87.5 with the whole
  document.
- **COPA is saturated and shortcut-solvable:** **66.8% from an off-the-shelf BERT similarity model** `[V]`.
- **The WikiWhy "38.7%" figure** everyone cites is `text-davinci-002` rated by **3 undergraduates on 50
  items**, 2022. **No GPT-4 / Claude / Llama results exist for WikiWhy.** Do not cite it as evidence that
  modern LLMs cannot explain causation.

**WIKIWHY** (Ho et al., **ICLR 2023 oral, notable top 5%**, https://arxiv.org/abs/2210.12152,
https://github.com/matt-seb-ho/WikiWhy) `[V]`: **9,000+ "why" question–answer–rationale triples grounded on
Wikipedia facts**, where the auxiliary task is generating a natural-language rationale connecting question to
answer. GPT-3 reaches only **38.7% human-evaluated correctness** end-to-end.

`[I]` **Genuine why-questions, wrong oracle for us — reject as primary.** Two problems: (a) the primary metric
is **free-form explanation generation graded by humans** (or, in practice, by a model) — the LLM-judge hazard
I5 was deferred for; (b) the paper's own automatic metric is **reference similarity**, which the authors
validate by showing it correlates with human-judged correctness — for us that is precisely the
**embedding-correlated oracle** that burned doc 30 (co-citation, cosine AUC 0.79). It is also closed-book by
design ("implicit commonsense knowledge … unlikely to be easily memorized"), so it is not natively a retrieval
task. A retrieval variant could be built (gold = the source Wikipedia passage), but it would be strictly
weaker than A5 on oracle quality. Split sizes and licence `[UNVERIFIED]`.

**Candidate already in our own record — CausalQA** (Webis, COLING 2022,
https://aclanthology.org/2022.coling-1.291/), named and then demoted at `docs/benchmarks/landscape.md:184-189`
`[D]`: *"1.1M causal questions sourced from ten QA datasets"*, baseline *"UnifiedQA at ROUGE-L F1 0.48"*,
*"feels more like 'real' user causal questions."* `[I]` **ROUGE-L over free-text answers is a weak oracle** —
it is a surface-overlap metric, so it is *directly* embedding-correlated and should not be the primary. But
CausalQA is an *aggregation of ten QA datasets*, several of which are span-extractive over passages; the right
move would be to take only those constituents and keep the extractive oracle, not to adopt the ROUGE-L
headline. Constituent-level verification not done. `[UNVERIFIED]`

**Post-cutoff lead, flagged not verified:** a search hit surfaced *SemEval-2026 Task 12: Abductive Event
Reasoning: Towards Real-World Event Causal Inference for Large Language Models* (arXiv 2603.21720) — a
shared-task-shaped, real-world event-causality target. Worth a look; I did not read it. `[UNVERIFIED]`

**Standing critique of the whole area — arXiv 2407.08029** (see §A.3) `[V]`: many causal benchmarks *"can
likely be solved through the retrieval of domain knowledge, questioning whether they achieve their purpose."*
`[I]` Read this as a **two-sided warning**: benchmarks that retrieval *can* solve may not test causal
reasoning at all (bad for them), and benchmarks engineered so retrieval *cannot* help (Corr2Cause, CLadder)
cannot test a retrieval substrate (bad for us). Any I4 candidate must be checked against both edges.

**A fuller external survey** (WIKIWHY, EventStoryLine, Causal-TimeBank, CausalBank, MAVEN-ERE, TellMeWhy,
e-CARE, the COPA family, and 2407.08029's per-benchmark verdicts) was commissioned in parallel with this
investigation and had not returned when this doc was written. The per-candidate property that matters is
recorded above as the template: **self-contained vs corpus-retrieval**, then **clean vs LLM-judged oracle**,
then **embedding-correlation**. `[I]` My prior, from the structural point at the top of this section, is that
the survey will find **more self-contained and passage-given sets and no natively-retrieval causal benchmark**
— i.e. ESTER-style conversion remains the route.

### C.2 The field's own answer: there is no clean-oracle benchmark for this

The closest published work to "Graph C as a retrieval mechanism" is **CausalRAG: Integrating Causal Graphs
into Retrieval-Augmented Generation** (ACL Findings 2025, https://arxiv.org/abs/2503.19878,
https://aclanthology.org/2025.findings-acl.1165/) — it extracts directed causal triples from source text,
indexes them, and retrieves causally connected subgraphs by graph walks from query-linked seed nodes. That is
structurally what nmemo's Graph C would be used for.

**What it evaluates on `[V]`:** abstracts from **100 randomly selected OpenAlex research papers** (applied
maths, art history, library science, psychology). **Metric: the RAGAS framework with a GPT-4o-mini LLM judge**
— answer faithfulness, context recall, context precision. Baselines: regular RAG, GraphRAG-Local,
GraphRAG-Global. **No exact numbers in the main text**, only comparative figures. **It does not use Corr2Cause
or CLadder at all.**

Three things follow `[I]`:
1. The field agrees, by revealed preference, that self-contained causal-reasoning benchmarks are **not** the
   evaluation for a causal retrieval graph. That corroborates §B from outside.
2. There is **no established clean-oracle benchmark** that a causal-RAG paper reaches for — the state of the
   art falls back to an LLM judge on a 100-document corpus. Anyone claiming a settled standard here is
   mistaken. *(§C.1 does surface four usable candidates, but note that none of them is what the causal-RAG
   literature actually evaluates on; picking one is a choice we would be making, not a convention we would be
   joining — so the framing must be "we chose this oracle and here is its geometry", not "we scored on the
   standard benchmark.")*
3. **Flag the oracle correlation hazard:** RAGAS `context_recall` / `context_precision` are computed by an LLM
   comparing retrieved context to the answer — which is substantially **text-similarity-driven**, i.e. the
   same class of failure as the co-citation oracle (cosine AUC 0.79) that burned doc 30. Do not adopt RAGAS as
   the I4 oracle.

### C.2a PRIOR ART THAT PREDICTS OUR RESULT — read this before costing any I4 experiment

The survey turned up four independent published results that bear directly on whether a causal graph can add
retrieval value, and a fifth that challenges a load-bearing nmemo design decision. **Three of the four point
the same way as our own doc-28→32 negatives.**

**(a) On CauseNet, better embeddings bought nothing.** Blübaum & Heindorf, **WWW 2024** (arXiv 2311.02760),
binary causal QA as RL path-finding over CauseNet-Precision (197,806 relations / 80,223 concepts) `[V]`:
**BERT, RoBERTa and E5 embeddings did NOT improve accuracy or F1 over GloVe.** On a graph whose nodes are
surface noun phrases, better semantic embeddings bought nothing — *the bottleneck is edge existence, not
similarity ranking.* `[I]` **This is a direct published precedent for the R@10 ≈ 0.20–0.23 saturation we have
been hitting since doc 05.**

**(b) On the only true causal-retrieval benchmark, dense lookup into a causal graph was the WORST run.** Touché
2023 Task 2 `[V]` — the He-Man team embedded all CauseNet concepts with BERT and matched topics by lowest mean
cosine distance:

| Run | nDCG@5 | 95% CI |
|---|---|---|
| `no_expansion_rerank` (plain first-stage + rerank) | **0.657** | [0.564, 0.740] |
| ChatNoir baseline | 0.585 | [0.503, 0.673] |
| `gpt_expansion_rerank` | 0.374 | [0.284, 0.469] |
| **`causenet_expansion_rerank`** | **0.268** | [0.172, 0.368] |

Their working notes, verbatim: *"**Both expansion techniques significally lowered the retrieval
performance**"*, with the diagnosed failure being semantic drift — *"The pair of 'drinking wine' and 'blood
urine' was for example matched to the pair of 'eating food' and 'diarrhea'."* `[I]` **Causal-graph expansion
was 0.39 nDCG@5 BELOW a plain baseline. This is independent corroboration of doc-28→32 from outside the
project**, and it is the single most important number in this document for setting expectations. *(Caveat:
n=1 team, 50 topics — it is a strong prior, not a settled fact.)*

**(c) At corpus scale, dense causal retrieval lands at Hit@1 16–22%** (Cawai, §C.1) `[V]` — the same order as
our saturation. So the ceiling is not an artefact of our substrate; it reproduces on Wikipedia and RedPajama.

**(d) The one result that points the OTHER way is a fusion result.** FreshStack (arXiv 2504.13128) `[V]`:
*"Fusion ensemble outperforms individual models on all topics"*, with BM25 the best *individual* model on all
five topics, and reranking helping on some datasets and hurting on others. `[I]` **This is the closest
published analogue to our one confirmed lever** (the R4 names ⊕ facts retrieved-set RRF fusion), on a
different corpus and a different task. If anything in I4 is worth building, the prior says it is **fusion of
substrates**, not a single causal retriever — consistent with the project's own banked meta.

**(e) A published result challenges Graph C's non-negotiable design decision.** On CauseNet QA `[V]`:
**feeding the LLM the retrieved graph's *provenance text* HURT accuracy versus feeding bare triples** —
GPT-4-with-triples **0.768** vs GPT-4-with-provenance **0.669** on MS MARCO, same direction for UnifiedQA and
on SemEval. `[I]` Graph C's architectural commitment is that every edge carries `reasoning TEXT NOT NULL` +
`source_references JSONB NOT NULL` (`002_causal_graph.sql:123-125`), described in `31-...:138-140` as *"ahead
of the literature on the mandatory-provenance point"* `[D]`. That may be right for **auditability** — which is
its stated purpose — but this result says it is **not automatically right for answer quality**. Worth a
cheap, separate arm (triples-only vs triples+reasoning) in any I4 read-path experiment, and worth *not*
assuming the provenance payload helps.

**(f) And the precision/coverage split that A1/A1b should expect.** CauseNet reports *"Yes"-precision 0.9,
recall 0.27* `[V]`. Independent evaluation by **WikiCausal** (ISWC 2024, arXiv 2409.00331) `[V]`: its
**precision claim replicates** (92.5% re-estimate) but its **coverage claim does not** — *"CauseNet Full finds
54 of the 427 class-level causal relations … **CauseNet does not extract any instance-level causal
relations**."* `[I]` Exactly the Leg-5/Leg-6 shape: a causal extraction can be locally precise and globally
blind. Expect A1 to pass and A1b to be where the finding is.

### C.3 The internal option set, with validity properties and cost

#### A1 — Graph C edge-quality audit (recommended first move)

*Not a retrieval benchmark.* "Is Graph C real or theatre" decomposes into two independent questions, and the
committed plan conflates them:

- **(a) Are the 1,043 edges TRUE?** — answerable now, cheaply, on the live substrate.
- **(b) Do they HELP retrieval?** — needs a corpus, an oracle, and the provenance backbone (see A3).

Corr2Cause/CLadder answer **neither**. A1 answers (a): stratified sample of live edges (dal-cv 521 /
dal-nlp 454 / qbio 51 / arxiv-nlp 17), adjudicated **blind** against each edge's own
`source_references`-cited facts and `source_text`.

- **Oracle quality:** this *does* reintroduce an LLM/human judge — **mitigated, not eliminated**, by the
  project's own established pattern: ground-truth-by-construction + **injected hollow controls** (synthetic
  non-causal fact pairs; the Leg-5 precedent rejected 12/12) + **paired discrimination** (Leg-3's 0.78) so the
  measure is *discrimination*, not a rubber-stamp rate. Report inter-adjudicator agreement FIRST; if
  adjudicators disagree, that is itself the finding (the Leg-7 lesson, memory `project_cross_corpus_audit`).
- **Needs a corpus:** no. Runs on what exists.
- **Embedding-correlation hazard:** none — nothing is retrieved.
- **Cost:** n=100–150 adjudications. Capable model recommended for the judge role; Haiku for the
  hollow-control generation. **Order $5–30.** Deterministic parts are free.
- **What it can and cannot claim `[I]`:** it can establish an edge-precision floor and that the asserter
  discriminates. It **cannot** claim retrieval value, coverage, or that Graph C beats dense embedding.

#### A1b — Graph C coverage test (A1's twin; cheap, mostly deterministic)

A1 measures edge **precision**. The Leg-5/Leg-6 lesson from the cross-corpus arc was that **coverage** was the
unmeasured gap that invalidated the precision story. The complement: deterministically mine the dal-cv /
dal-nlp source text for explicit causal statements (the discourse-marker set already exists in-tree as
`CAUSAL_CUES`, `platform/src/services/causal-pass-trigger.ts:23-47` `[V]`), then check what fraction have a
corresponding Graph C edge.

- **Oracle:** the marker mining is **fully deterministic and checkable**; only the "does this edge correspond
  to this statement" match needs judgment, and that judgment is over a *specific pair*, which is the regime
  where the project's adjudicator has floor-passed before.
- **Mandatory control `[D]`:** attribute misses to `CAUSAL_PASS_SCOPE_CAP=200` (§B.3a) before calling them a
  mechanism failure.
- **Cost:** mining is **free**; ~100–200 pair adjudications, **order $5–20**.

#### A2 — Corr2Cause as an over-assertion probe

As specified in §B.4. **Oracle: CLEAN and deterministic** (published binary labels, exact match). **Cost:
~$1–5** on a 300–500-item stratified cut (Haiku), plus the epoch-ingest overhead if the real component is
used rather than the prompt. Claims a component-precision property, not a retrieval property.

#### A3 — Corpus-native why-question retrieval on dal-cv

The only design that is architecture-comparative *and* matches the banked I1/I2 methodology (arms scored by
recall@k of gold evidence, clustered bootstrap, **Claude-free scoring**).

Sketch: mine dal-cv / arxiv source text for explicit causal statements; form a why-question from the effect
clause; gold = the evidence unit containing the cause. Arms: dense-over-facts, dense-over-source-text,
`traceCauses` traversal, RRF fusion.

**Four blockers and hazards, all verified:**

1. **BLOCKER — no fact→document link, so no leak-free held-out split.** `facts` has exactly one document
   column, `source_memory_id`, and it is **100% NULL** on dal-cv (0/2565) and dal-nlp (0/2612) `[V]`.
   `fact_sources`, `fact_units`, `source_document`, and `fragment` are **all 0 rows** `[V]`. There is no
   `memories` table in `cognitive_test` at all `[V]`. This is doc 32 §1.1's provenance backbone, and it is the
   same failure that produced the `.8` leak. **Raw text does exist** — Qdrant holds `memories` 20,395 points
   and `memories_dal` 6,849 points with `unit_text` + `char_start`/`char_end` `[V]` — but its payload carries
   `stream_id`, not `corpus_id`, so **there is no join from a Graph C edge to its source unit.** An oracle
   would have to be built from the raw-text side independently of the graph.
   - *Mitigating correction to my own earlier read:* `facts.source_text` **is** 100% populated on every
     research corpus (`33-graph-structure-analysis.md:21`, `:33-39` `[D]`), so retrieval arms do have inline
     evidence text to score. What is missing is the **lineage**, which is precisely what a held-out split
     needs.
2. **HAZARD — circularity double bind `[I]`.** Graph C's edges were extracted from the same sentences an
   oracle would be mined from. Build the oracle on sentences that *did* produce an edge → you are retrieving
   the answer key. Build it on sentences that did *not* → Graph C cannot answer by construction, and the
   negative is pre-determined. The only non-circular version is a **document-level train/test split with a
   fresh causal pass on the test split** — which requires blocker 1 to be fixed *and* costs a new Claude
   extraction pass.
3. **HAZARD — embedding correlation (the exact doc-30/doc-42 trap) `[I]`.** A question derived from its own
   gold sentence shares lexical and dense signal with it. This is `papers-as-queries` again
   (`42-longmemeval-i1-local-prereg.md:20-24` `[D]`: ~80% of targets appeared verbatim in the query). Verberne
   named this failure mode in 2010 `[V]`: *"Questions that are formulated to a text are likely to show more
   overlap with the answer text than questions that come from a real-life QA collection."*
   > **FIX SURFACED BY THE SURVEY — this substantially improves A3.** Do **not** mine the questions from our
   > own sentences. Use **Quriosity**'s causal slice (arXiv 2405.20318, CC BY-NC-SA 4.0): **13.5K naturally
   > occurring questions from search engines and conversations, up to 42% causal** `[V]`. They were written by
   > real users with no sight of our documents, which removes the derived-from-gold geometry at a stroke.
   > **Residual cost:** the *gold* then has to be labelled by hand or by adjudication (the questions are
   > shipped with no answers and no corpus), which re-introduces a judged oracle — so scope it as
   > *"we built the labels"*, never *"we scored on benchmark X"*. **FreshStack** (arXiv 2504.13128) is the
   > best published methodology template for exactly that, and its own LLM-judged labels are
   > **71.7% fully relevant** — a realistic ceiling on what label quality to claim.
   The older mitigations (LLM paraphrase, or a **low-cosine slice** per doc-31) both still cost and the
   low-cosine slice historically collapsed coverage to a few percent.
4. **Expected outcome `[I]`:** given the banked meta (`43-...:146-148` `[D]`), the prior is a **null**. That
   is a legitimate banked outcome — but only if blockers 1–3 are handled, otherwise the null is
   un-interpretable.
- **Cost:** deterministic retrieval scoring is **free** (local nomic embeds, as in I1/I2). The expensive parts
  are the paraphrase pass and/or a fresh causal extraction pass on a held-out split: **order $50–300**, plus
  real engineering on the provenance backbone.

#### A5 — external-corpus causal retrieval (REVISED after the survey)

The shape is the same whichever corpus is chosen: ingest the corpus so Graph C exists over it, then compare
arms on **recall@k / nDCG@k of the gold evidence**, scored **deterministically**:

- `DENSE-FLAT` over passage chunks (the I1/I2 floor — free, already built),
- `DENSE ⊕ traceCauses(seed)` — the second-stage expansion of §B.3a, RRF-60 (the R4 pattern),
- `BM25` leg for completeness,
- `[optional, cheap]` **triples-only vs triples+`reasoning`** — the §C.2a(e) arm.

**My first pick was ESTER; the survey demoted it** (431 causal *test* questions, and the gold span sits inside
the given passage ⇒ HIGH embedding correlation). Revised ranking of corpora:

| Corpus choice | Oracle | Anti-embedding? | n | Blocking issue |
|---|---|---|---|---|
| **A5a Cawai / e-CARE-as-retrieval** | **exact gold-sentence id — fully deterministic** | **YES, measured** (DPR Hit@1 16% @2M) | 2M/20M pools | third-party recast; sentence pairs, not natural why-questions |
| **A5b BRIGHT StackExchange** | **CLEAN nDCG@10 vs `gold_ids`** | **YES, measured** (59.0→18.3) | ~632 queries / 50–121k docs | why-fraction uncounted; must ingest up to 121k docs (cost) |
| **A5c Touché 2023 Task 2** | human 0/1/2 qrels, nDCG@5 | **YES** (§C.2a(b)) | **50 topics / 718 judgments** | underpowered; n=1 team; ClueWeb22 licence |
| **A5d QASC / eQASC** | **CLEAN** P@1 / NDCG | **YES, by construction** (96% <3-token overlap) | 9,980 Qs / 17M facts | MCQ-phrased, not why-phrased |
| A5e ESTER-converted | clean EM/F1/HIT@1 | **NO — gold is in the given passage** | 431 causal test Qs | demoted to secondary |

`[I]` **Recommended pairing if A5 is run: A5a for the clean oracle + A5b for the realistic corpus.** A5a
settles "can the substrate beat dense when the target is embedding-orthogonal" with a deterministic oracle;
A5b checks it survives on a real 50–121k-document corpus with human-validated labels. Either alone is
attackable; together they cover each other's weakness.

**Why A5 beats A3 `[I]`:** external questions are non-circular by construction, and the harness can record its
own passage→fact-id mapping, so it does **not** depend on `facts.source_memory_id` (which would still write
NULL). Scoring stays Claude-free.

**Costs and risks:**
- **Ingestion is the spend**, and it scales with corpus size — A5a's small pool or a sampled A5b subset is
  ~1–2K passages × extraction + conditional causal pass ≈ **10k–60k Haiku calls, order $50–300**; ingesting a
  full 121k-document BRIGHT subset is **an order of magnitude more** and should not be attempted without
  sampling. The dense/BM25/scoring side is **free** (local nomic, as in I1/I2).
- **Graph C edge yield is the real risk `[I]`:** if the causal pass extracts few edges over short
  sentence-pair or StackExchange text, the Graph C arm has nothing to contribute and the result is a
  **coverage null, not a mechanism null** — the doc-32 lesson (extraction sparsity, not mechanism, killed the
  concept layer). **Mitigation: measure edge yield on a ~50-passage smoke FIRST and pre-register a minimum
  yield as a kill condition.** ~$2 of insurance.
- **§C.2a is the prior:** three independent published results predict this comes back **negative or null**.
  That is a legitimate banked outcome and it would be well-powered evidence — but price the experiment as
  *buying a credible null*, not as buying a lift.
- **Verify before committing:** A5a is a third-party recast (check arm-neutrality); A5b's why-fraction must be
  **counted**; A5c needs a CMU ClueWeb22 licence; ESTER's licence is `[UNVERIFIED]`.
- **`CAUSAL_PASS_SCOPE_CAP=200`** and the epoch-scoped `invokeCausalAgent` shape the ingest design (§B.3a).

#### A4 — Do not run I4 now; step back

Given (a) the committed benchmark is invalid, (b) the only architecture-comparative design is blocked on the
provenance backbone, and (c) the banked I1/I2/I3 meta predicts a null for cheap graph levers, "close I4 as
**specified-and-paused**, run A1 to answer the theatre question, and spend the engineering on the provenance
backbone instead" is a defensible option and should be on the table. `[I]`

### C.4 Oracle-quality summary

| Option | Needs a corpus? | Oracle | LLM-judge hazard | Embedding-correlation hazard | Rough $ |
|---|---|---|---|---|---|
| Corr2Cause / CLadder **as committed** | **No** (self-contained) | clean *for the wrong question* | none | none | $50–900 |
| A1 Graph C edge audit (precision) | No | construction + paired discrimination + hollow controls | **yes, mitigated** | none | $5–30 |
| A1b Graph C coverage | No | deterministic marker mining + per-pair adjudication | yes, narrow | none | $5–20 |
| A2 Over-assertion probe | No | **clean** (published binary labels) | none | none | $1–5 |
| A3 dal-cv + **Quriosity** questions | **Yes** | we build the labels (judged) | **yes — scope as "we built the labels"** | **low** once questions are external | $50–300 + build |
| A3 dal-cv, questions mined from our own text | **Yes** | span identity (clean *only if* held-out — **blocked**) | none | **severe** | — (rejected) |
| **A5a Cawai / e-CARE-as-retrieval** | **Yes** | **exact gold-sentence id — deterministic** | **none** | **none — measured orthogonal** | **$50–300** |
| **A5b BRIGHT StackExchange** | **Yes** | **CLEAN nDCG@10** (PhD-unanimous `gold_ids`) | **none** | **none — measured (59.0→18.3)** | **$50–300** (sampled) |
| A5c Touché 2023 Task 2 | **Yes** | human 0/1/2 qrels, nDCG@5, κ=0.58 | labels judged | **none** | $50–300 + ClueWeb22 licence |
| A5d QASC / eQASC | **Yes** | **CLEAN** P@1 / NDCG | none | **none — by construction** | $50–300 |
| A5e ESTER-converted | Yes (after pooling) | clean EM / F1 / HIT@1 | none | **high — gold is in the given passage** | $50–300 |
| EntailmentBank T3 | Yes | tree F1 / AllCorrect (one leg **BLEURT**) | partial | low | — (only 1,840 items) |
| ANTIQUE | Yes | 4-level human qrels, MAP/nDCG | labels judged | partial (BM25 0.198 → BERT 0.377) | — (pooling ⇒ our strict/condensed problem) |
| Verberne why-QA | Yes | regex patterns — **self-tuned on system output** | no, but **biased** | **lowest of anything surveyed** | — (n=186) |
| CausalQA / Webis-CausalQA-22 as published | **No — context handed to model** | **ROUGE-L on free text** | none | **severe, measured** | — (extractive constituents only) |
| WIKIWHY as published | Mostly no (closed-book) | **human-judged free text**; auto metric = BERTScore validated at **r=0.82** vs human | **severe** | **severe** (metric *is* similarity) | — (not recommended) |
| **WorldTree / TextGraphs** | Yes (9,216-fact KB) | MAP / NDCG | none | **THE TRAP — lexical overlap is a gold-label construction constraint** | — (never) |
| **ELI5 / KILT-ELI5** | KILT yes | **ROUGE-L, κ=0.1**; "copy the question" beats RAG | **severe** | **catastrophic** | — (never) |
| RAGAS-style (CausalRAG's own method) | Yes | **LLM judge** | **severe** | **severe** | — (not recommended) |

---

## D. Internal context — what the project already decided and learned

- **`34-query-intent-set-proposal.md:42-49`** (committed 2026-09-02) `[D]`: I4 = *"what caused X / why did Y
  happen / what would changing X affect"*; substrate = Graph C explicit cause→effect edges + mandatory
  provenance; benchmark = *"Corr2Cause / CLadder … **note these test causal reasoning, the 'is Graph C real or
  theatre' question, more than causal retrieval**"*; ground truth *"clean for the reasoning question"*; fit =
  *"substrate only on dal-cv (521 edges) and default; arxiv has none, qbio 0.7%. Runs on dal-cv, not arxiv.
  Edges not corpus-partitioned (a fix). Never evaluated."* **The doc already flagged the exact defect this
  investigation confirms.** `:72` ranks I4 fourth precisely because *"benchmark tests reasoning-not-
  retrieval."*
- **`34-...:75-79` — the proxy caveat (load-bearing)** `[D]`: *"Do not optimise hard against any single
  benchmark as if it were the real target (the papers-as-queries lesson)."*
- **`34-...:94-118` — the composite-reasoning layer** `[D]`: the user's real I4-shaped queries are
  *composites* — causal trajectory (I4×I3), "why is it the way it is" (I2×I4), causal-chain failure analysis
  (I4×I3 over a traversal), thematic cause over time (I5×I4×I3). Disposition: handled by the **client agent
  composing primitives**, explicitly *"flagged as untested / hard-to-test"*, **not** a sixth substrate.
  `[I]` Note the mismatch: none of those composites resemble a Corr2Cause item.
- **`32-intent-adaptive-retrieval-program.md:61`** `[D]`: the benchmark table's own ground-truth column for
  causal reads *"reasoning, not retrieval — **scope carefully**."* `:80`: *"causal → run the causal pass +
  corpus-partition edges; gate on Corr2Cause (is Graph C real or theatre)."* `:40` flags the
  `causal_edges`-no-`corpus_id` gap as a Phase-0 item.
- **`31-retrieval-strategy-ingestion-matrix.md:63`** `[D]`: causal graph = *"HAVE schema (Graph C:
  `reasoning`+`source_references` mandatory) but edges not corpus-partitioned, underlying fact provenance
  BROKEN, never evaluated."* `:138-140`: *"Least-mature cluster = causal/temporal … Our Graph C schema is
  actually ahead of the literature on the mandatory-provenance point — but it's unevaluated and its
  underlying fact provenance is broken."* `:130-131`: *"Communities/traversal/causal cost a lot of LLM
  indexing and only pay on relational/global/temporal/causal queries."*
- **`33-graph-structure-analysis.md:49-52`** `[D]`: *"Graph C exists only on dal + default; arxiv has none,
  qbio is near-empty … the causal intent (Phase 4) must run on **dal-cv** (richest), never arxiv."* See §B.1
  for two verified numeric corrections to this table.
- **`28-remaining-levers-feasibility.md:25-31`** `[D]` — **the project already reached this conclusion and
  wrote it down.** Verbatim: the Corr2Cause reality-check *"is **NOT** a reuse of the single-graph
  retrieval-eval engine (that engine is entity-target-finding; **there is no causal-question oracle**). It
  requires a labelled causal-reasoning benchmark + a Claude judge … and, if run on the in-house graph, the
  best-populated substrate is `dal-cv` (521 edges), NOT arxiv. **Blocked for autonomous single-graph work:
  needs an oracle + Claude (org spend-cap risk) + the `nmemo-umf` scoping decision.**"* `:21-23` adds the
  `CAUSAL_PASS_SCOPE_CAP=200` under-scoping caveat (see §B.3a). `[I]` "There is no causal-question oracle" is
  the same finding as §C.2 — reached internally, then not carried into the doc-34 benchmark row.
- **`.handovers/handover-007.md:54-68`** `[D]`: I4 is the priority-next fork; *"LIKELY SPENDS CLAUDE
  (causal-reasoning/LLM-judged) → needs explicit consent. Start with a read-only pre-work investigation
  agent."* `:124`: *"Anything that spends Claude needs consent (org spend cap has bitten)."*
- **House style of a pre-registration** (`42-longmemeval-i1-local-prereg.md`, `43-...-i2-multihop-prereg.md`)
  `[D]`: frozen before any number is computed; explicit **Data**, **Arms** (query + candidate set held
  identical), **Metric** (one primary, secondaries reported-not-gated, a tie-break sensitivity control),
  **Bootstrap + bar** (clustered bootstrap, 10k resamples, fixed seed; DEMONSTRATED = CI lower bound > 0 AND
  directional consistency across strata; McNemar reported), **Kill / invalid conditions** (fix the harness,
  don't report as a finding), a **pre-registered expectation stated before computing**, and **discipline**
  (deterministic/Claude-free where possible → freeze → run → **blind adversary** → bank; NULL is a valid
  banked outcome). Pre-run corrections are recorded inline as quoted blocks, timestamped, with the reason.
- **The banked meta** (`43-...:146-148`) `[D]`: *"across I1+I2 on LongMemEval real-query SESSION retrieval,
  **dense embedding … IS the retrieval engine; the cheap graph/lexical levers (BM25 fusion, entity-traversal)
  do NOT add**"* — same conclusion as the concept-layer arc (docs 28–32). I4 must be designed knowing this.
- **`docs/benchmarks/landscape.md:160-198`** `[D]` — the origin of the plan, and worth reading as a red flag:
  *"Graph C is our most differentiated piece"*; *"This is the benchmark where pure LLMs publicly fail. **Even a
  modest Mnemo lift here is a big story**"*; *"**Invest in Corr2Cause + CLadder as a pair.** Corr2Cause gives
  us a public floor (LLMs fail badly) where any lift is a story."* `[I]` A benchmark selected because its
  floor is low and therefore any lift makes a headline is selected for the **headline, not the question** —
  the HARKing shape this project has been burned by five times (memory `project_cross_corpus_audit`).
  `landscape.md:168` is, however, honest about what CLadder measures: *"Tests the 'do you understand what
  causality means' axis, **not** 'do you retrieve causal facts well'."*
- **`docs/benchmarks/landscape.md:184-189`** `[D]` — the project's own record already names a
  **corpus-oriented** alternative it then demoted: **CausalQA** (Webis, COLING 2022,
  https://aclanthology.org/2022.coling-1.291/), *"1.1M causal questions sourced from ten QA datasets"*,
  baseline *"UnifiedQA at ROUGE-L F1 0.48"*, *"feels more like 'real' user causal questions. Good
  supplementary metric."* `[I]` ROUGE-L on free text is a weak oracle, but its constituent datasets are the
  right *shape* — see §C.1a.
- **Beads** `[V]`:
  - **`nmemo-4fd`** "Corr2Cause baseline (Graph C reality-check, on/off variant pair)", P1, OPEN, created
    2026-05-27, under epic `nmemo-bki`, depends on the closed `nmemo-ko0` workspace setup. Design: *"Single-
    turn structured causal QA — ingest the correlation statement, query the causal claim, score. Metric: F1."*
    Acceptance: both Graph-C-on and Graph-C-off arms write separate JSONs; each records how often the causal
    agent triggered; *"If Mnemo F1 is at or below pure-Haiku-with-no-memory, the notes field says so verbatim
    — no quiet filing"*; pre-registered cut = full eval set, else a stratified 5K sample with a checked-in
    seed. `[I]` The honest-reporting clause is good discipline; the 5K/full-eval-set cut is the train/test
    confusion flagged in §A.1.
  - **`nmemo-9hp`** "CLadder baseline (Pearl's ladder, all three rungs)", P2, OPEN. Same on/off variant
    structure, accuracy per rung + overall, no subsampling, reuses `_common/judge.py`.
  - **`nmemo-bki`** [EPIC] P1 OPEN, 1/7 complete. Model stack *"Haiku system / Sonnet judge / no comparator
    reruns"*; order LongMemEval → Corr2Cause+CLadder → LOCOMO → GraphRAG-Bench → CronQA; acceptance includes
    *"Graph C reality-check from plan.md §2.2 has produced a yes/no answer on causal-layer lift, recorded
    verbatim in the relevant notes fields."* `[I]` That acceptance criterion can be satisfied **without**
    running Corr2Cause — by recording the verdict of this investigation plus (if run) A1/A2.

### D.1 Corrections this investigation produces, for the record

1. `docs/benchmarks/plan.md:151` — Corr2Cause's **eval set is 1,162 items**, not "200K+"; the 200K is train.
   The proposed 5,000-item "subsample" is larger than the test split. `[V]`
2. `docs/benchmarks/plan.md:163` — no LLM judge is needed for either benchmark; both are binary, so scoring is
   exact match. The ~5K Sonnet judge calls are pure waste. `[V]`
3. `33-graph-structure-analysis.md:15-19` — live `cognitive_test` now shows **arxiv-nlp 17** causal edges
   (doc says 0) and **dal-nlp 454** (doc says 175); total 1,043. `[V]`
4. `33-...:49-51` / `32-...:40` — "edges not corpus-partitioned" is true of the `causal_edges` table but is
   **not** a read-path blocker: `traceCauses` scopes via `causal_events.corpus_id`, which is populated on all
   17,847 events. `[V]`
5. The provenance picture is worse than "`source_memory_id` NULL": `fact_sources`, `fact_units`,
   `source_document`, and `fragment` are **all 0 rows**, and there is **no `memories` table** in
   `cognitive_test`. Raw text lives only in Qdrant (`memories` 20,395 / `memories_dal` 6,849 units), keyed by
   `stream_id` rather than `corpus_id`, so there is no graph→source-unit join. `[V]`
6. **`docs/benchmarks/landscape.md:184-189`'s CausalQA entry needs a caveat:** Webis-CausalQA-22 **hands the
   model the context — it is not a retrieval benchmark**, and its ROUGE-L oracle is measurably
   lexical-overlap-correlated (the causality-aware retriever's gain is a *decreasing function* of
   query–document ROUGE-L). `[V]` Usable only via its span-extractive constituents. Also: **"CausalQA over
   event data" does not exist** — there is one CausalQA paper; the thing half-remembered is **CauseNet** or
   **Event-QA** (arXiv 2004.11861). `[V]`
7. **A correction to my own first draft, recorded because the failure mode is the one this project polices:**
   I drafted a Corr2Cause labelling criticism from a web-search summary that traces to an **AI-generated
   review page**, about a paper that turns out to be the Corr2Cause author's own thesis. I had flagged it
   `[UNVERIFIED]`, but flagging is not enough — it should not have been in the doc at all. The citable version
   is **GitHub issue #5** (unresolved). `[V2]` See §A.1 item 2.

---

## E. Open questions for the human

1. Do you accept the verdict that Corr2Cause/CLadder cannot test the architecture, and want `nmemo-4fd` /
   `nmemo-9hp` **re-scoped or closed as invalid-as-specified** rather than run?
2. If a Graph C verdict is still wanted, is **A1/A1b (quality audit, ~$10–50)** the right first spend? It is
   the only option that answers "real or theatre" without a corpus, a conversion, or an ingestion pass.
3. Do you want an **A5 external-corpus retrieval test** (~$50–300)? If so: **A5a Cawai + A5b BRIGHT** is the
   recommended pairing, and the honest sequence is: count BRIGHT's why-fraction + check Cawai's arm-neutrality
   → **~$2 edge-yield smoke with a pre-registered minimum as a kill condition** → freeze a pre-registration
   in the doc-42/43 house style → run → blind adversary. **Price it as buying a credible null** (§C.2a).
3b. Cheap and independent of all of the above: the **§C.2a(e) arm** — does Graph C's mandatory `reasoning` +
   `source_references` payload help or hurt an answer, versus bare triples? Published prior art says it
   **hurts** (0.768 → 0.669). This is a small arm on any I4 read-path run and it touches a
   "non-negotiable" design decision.
4. Is **A2 (over-assertion probe, ~$1–5)** worth running as the salvage of the Corr2Cause purchase — and if
   so, against the real epoch-scoped agent (expensive, writes) or a standalone prompt harness (cheap, narrower
   claim)?
5. **A3 would require building the provenance backbone first** (doc 32 §1.1). Is that a better use of the
   engineering than any I4 measurement right now — noting A5 routes *around* it?
6. Every option above that spends Claude needs explicit consent. **Nothing here has been run**; no source
   file, migration, or DB row was modified by this investigation.
