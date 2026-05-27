# Mnemo Benchmark Landscape

**Status:** Research / decision input. Not a commitment.
**Date:** 2026-05-27
**Audience:** Mnemo team, picking which 3-5 benchmarks to invest in.

## Why this doc

Mnemo is a dual-graph memory + reasoning layer for LLMs:

- **Graph S (state)** — entities + bi-temporal facts (valid-time and transaction-time) in Postgres + Apache AGE; pgvector for entity/fact similarity; Qdrant for raw source-text semantic search. Entity resolution, relationship matching, and fact dedup are first-class.
- **Graph C (causal)** — perpendicular causal-event graph with LLM-asserted causal edges (Claude via MCP, 7 causal tools). Every edge carries `reasoning TEXT NOT NULL` and `source_references JSONB NOT NULL`.
- **Pipeline** — synchronous `ingest(text) = store() -> extract() -> conditional causal agent`.

Mnemo sits in the same product space as **Zep/Graphiti, Mem0, Letta (née MemGPT), HippoRAG, LangMem, MemMachine**. We need numbers. Numbers require benchmarks. This doc inventories the candidates, names what each measures, and ends with a recommendation table so we can pick.

A consistent thread: **the agent-memory benchmark space is openly contested.** Vendor papers fight over methodology (the Zep–Mem0 LOCOMO dispute is the canonical case, with Zep claiming 84%, Mem0 recomputing it as 58.44%, and Zep counter-claiming 75.14% — see issue [#5 on getzep/zep-papers](https://github.com/getzep/zep-papers/issues/5)). Treat any single headline figure with skepticism; run our own evals on the same harness.

---

## 1. LLM long-term / agentic memory

**This is the most important category for Mnemo's positioning.** Mem0, Zep, and Letta all live here. We need to publish on at least one of these or we cannot be compared.

### LongMemEval (ICLR 2025) — the de facto standard

- **Maintainer:** Xiaowu Wu et al. (Salesforce / ICLR 2025). Paper: [arXiv 2410.10813](https://arxiv.org/abs/2410.10813). Repo: [github.com/xiaowu0162/LongMemEval](https://github.com/xiaowu0162/LongMemEval).
- **What it measures:** 500 hand-curated questions over multi-session chat histories, probing five abilities: information extraction, multi-session reasoning, temporal reasoning, knowledge updates, abstention.
- **Why it matters for us:** It directly exercises the things Graph S is built for — fact dedup across sessions, temporal updates ("X moved jobs in March, what's their employer now?"), and abstention when information is missing.
- **Scores to beat (2024–2026):**
  - Commercial long-context LLMs drop ~30% accuracy across sustained interactions (paper baseline).
  - Zep: **63.8% on GPT-4o** (Zep's own paper, [arXiv 2501.13956](https://arxiv.org/abs/2501.13956)); independently cited up to **71.2%** in vendor surveys.
  - Mem0: **49.0% on GPT-4o** (per Zep's comparison); Mem0's own 2026 number with the "token-efficient memory algorithm" claims **94.4 / 94.8** on LongMemEval ([mem0.ai/research](https://mem0.ai/research)).
  - OMEGA: **95.4% on GPT-4.1**; Mastra Observational Memory: **94.87%**; MemPalace: **96.6%** ([mempalace.tech/benchmarks](https://www.mempalace.tech/benchmarks)).
  - LiCoMemory: **73.8% accuracy / 76.6% recall on GPT-4o-mini**.
- **Realistic to run:** Yes. Dataset is on HuggingFace, harness is Python, scoring is LLM-as-judge plus exact match. Most expensive part is replaying multi-session dialogues into our ingest pipeline; we already need to do that for our own tests. Estimated **1–2 weeks** to wire and run baseline + Mnemo variant.
- **Watch out:** Multiple sub-tracks (LongMemEval_S, LongMemEval_M); vendors quote whichever flatters them. Pick the harder track and be explicit.

### LOCOMO (ACL 2024) — the contested one

- **Maintainer:** Maharana et al. at Snap Research. Paper: [aclanthology.org/2024.acl-long.747](https://aclanthology.org/2024.acl-long.747/). Repo: [github.com/snap-research/locomo](https://github.com/snap-research/locomo). Site: [snap-research.github.io/locomo](https://snap-research.github.io/locomo/).
- **What it measures:** Very-long-term conversational memory — synthetic dialogues across up to 32 sessions, ~600 turns, ~16K tokens, multi-month timelines, optional multimodal images. Tasks: QA, event summarisation, multi-modal dialogue generation.
- **Why it matters for us:** Temporal/causal event graph design lines up well with LOCOMO's causal+temporal event seeding. Bi-temporal facts should help on "what did the user know in week 3 vs week 12" questions.
- **Scores to beat:**
  - Baselines: Mistral-7B 13.9 F1 → GPT-4 32.1 F1; human ceiling 87.9 F1.
  - Mem0 reports **66–68% accuracy** on its own paper ([arXiv 2504.19413](https://arxiv.org/abs/2504.19413)), latest token-efficient algorithm **91.6–92.5** ([mem0.ai/research](https://mem0.ai/research)).
  - Zep claims **75.14% J-score** after correcting their original 84%.
  - MemMachine v0.2 reports top scores in the [memmachine.ai blog](https://memmachine.ai/blog/2025/12/memmachine-v0.2-delivers-top-scores-and-efficiency-on-locomo-benchmark/).
- **Realistic to run:** Medium. Repo is public but the eval glue is opinionated; need to be careful about which metric variant we report (the Zep–Mem0 fight was over exactly this). Estimated **2 weeks**.
- **Watch out:** Heavy methodological dispute. If we publish on LOCOMO, we should also publish on LongMemEval to triangulate.

### BEAM (1M / 10M tokens) — the new million-token bar

- **Maintainer:** Mem0 team / authors of [arXiv 2510.27246](https://arxiv.org/abs/2510.27246) — "Beyond a Million Tokens".
- **What it measures:** 100 conversations up to 10M tokens each, 2K probing questions, 10 task categories. Designed to surface the gap between long-context LLMs and dedicated memory.
- **Why it matters for us:** Mnemo's whole value-prop is that you don't need an infinite context window. BEAM is the benchmark that proves that point. Also the only public benchmark at the volumes production agents actually hit.
- **Scores:** Mem0 reports **64.1 / 48.6 on BEAM (1M / 10M)** under 7K tokens per retrieval call. Long-context LLM baselines drop sharply past ~1M.
- **Realistic to run:** Unknown — benchmark is new (late 2025/early 2026) and Mem0-authored. Need to check independent reproducibility before committing.
- **Watch out:** Single-vendor benchmark. Wait for independent results or accept that "BEAM number" reads as a Mem0-friendly framing.

### DMR (Deep Memory Retrieval, from MemGPT) — legacy but still cited

- **Maintainer:** MemGPT/Letta team. Smaller, simpler retrieval-from-conversation benchmark.
- **Status:** Largely superseded by LongMemEval but still appears as a secondary number in Zep and Letta materials.
- **Recommendation:** Don't invest. Mention only if we need to engage directly with the Zep paper.

### Letta Leaderboard / Letta Evals

- **Maintainer:** Letta. [letta.com/blog/letta-leaderboard](https://www.letta.com/blog/letta-leaderboard).
- **What it measures:** Agentic memory (i.e. memory used inside a tool-using agent loop), not pure retrieval. Open-source eval framework: Letta Evals.
- **Why it matters for us:** Closer to how Mnemo will actually be used — as a memory layer inside an agent — than pure retrieval QA.
- **Status:** Emerging. Few published cross-vendor numbers yet. Worth tracking; probably too early to invest engineering time.

---

## 2. Multi-hop / KG-QA

We have a knowledge graph. We do multi-hop reasoning across it. These are obvious targets but the older ones are saturated.

### MuSiQue — still discriminating in 2026

- **Paper:** [arXiv 2108.00573](https://arxiv.org/abs/2108.00573). [Papers-with-Code](https://paperswithcode.com/sota/multi-hop-question-answering-on-musique-ans).
- **What it measures:** 2–4-hop questions composed from single-hop primitives, explicitly designed to be cheat-resistant (no shortcut answers).
- **Discrimination in 2026:** **Yes.** Single-paragraph baseline gets ~32 F1 on MuSiQue vs ~65 F1 on HotpotQA — still a real gap between shortcut and genuine multi-hop reasoning. Recent work [arXiv 2604.18234](https://arxiv.org/html/2604.18234v1) (ECIR 2026) still benchmarks against MuSiQue.
- **SOTA-ish:**
  - HippoRAG2 + NV-Embed-v2: **MuSiQue F1 51.9**, Recall@5 **74.7%**.
  - StepChain GraphRAG and Beam Retrieval class systems push past F1 60+ on the answer side.
- **Realistic to run:** Yes. Public, scriptable, fast. Estimated **3–5 days** for a baseline.

### 2WikiMultiHopQA — still useful, easier than MuSiQue

- **What it measures:** 2-hop questions over Wikipedia + Wikidata, with explicit reasoning paths annotated.
- **Discrimination:** Saturated for vanilla RAG but still meaningfully open for graph-aware systems. HippoRAG2 reports **2Wiki Recall@5 90.4% vs 76.5%** for the strong embedding baseline.
- **Recommendation:** Bundle with MuSiQue if running either — same harness, near-zero marginal cost.

### HotpotQA — legacy

- **Status:** Effectively saturated. StepChain GraphRAG: **66.70 EM / 79.50 F1**. New systems still report it but the signal is muddy. Mention for completeness; do not prioritise.

### ComplexWebQuestions / WebQSP — legacy

- **Status:** Pre-2023 standards for KGQA over Freebase/Wikidata. Still in some papers but the field has migrated to MuSiQue/2Wiki for harder evaluation and to GraphRAG-Bench for graph-specific eval. Skip unless we want a SPARQL-style story.

### GraphRAG-Bench (ICLR 2026) — the new graph-RAG comparator

- **Paper:** [arXiv 2506.02404](https://arxiv.org/pdf/2506.02404), "When to use Graphs in RAG". Repo: [github.com/GraphRAG-Bench/GraphRAG-Benchmark](https://github.com/GraphRAG-Bench/GraphRAG-Benchmark). Dataset on [HuggingFace](https://huggingface.co/datasets/GraphRAG-Bench/GraphRAG-Bench).
- **What it measures:** Standardised harness comparing Microsoft GraphRAG (local + global), LightRAG, HippoRAG, HippoRAG2, and others on domain-specific reasoning, with consistent token/latency accounting.
- **Why it matters for us:** This is the **direct competitive harness for graph-based memory/RAG systems**. If we publish on one thing in this category, this is it.
- **Realistic to run:** Yes, harness is open. Estimated **1–2 weeks**.

---

## 3. Temporal reasoning

We have bi-temporal facts (valid-time + transaction-time). This is one of our most defensible angles — most competitors don't have it.

### TempReason — the standard probe

- **Paper:** [arXiv 2306.08952](https://arxiv.org/abs/2306.08952), ACL 2023.
- **What it measures:** 5,397 event-time + 4,426 event-event reasoning entries. Tests temporal span extraction and reasoning over time-sensitive facts.
- **Realistic to run:** Yes. Estimated **1 week**.

### Test of Time (Google, 2024) — synthetic, knowledge-leakage-free

- **Paper:** [arXiv 2406.09170](https://arxiv.org/abs/2406.09170). [Google Research page](https://research.google/pubs/test-of-time-benchmarking-llms-on-temporal-reasoning/).
- **What it measures:** Two sub-benchmarks — ToT-Semantic (semantics of time) and ToT-Arithmetic (date math). Synthetic, so models can't lean on memorised facts.
- **Why it matters for us:** The arithmetic subset isolates the "did our temporal logic work" question from "did the LLM happen to remember the answer". Good for clean ablation.
- **SOTA:** GPT-4 strong on arithmetic, Gemini 1.5 Pro stronger on semantics. No memory-vendor has published.
- **Realistic to run:** Yes. Generator is in the repo.

### CronQuestions / CronQA — temporal KGQA, large scale

- **Maintainer:** Saxena et al., ACL 2021 + extensions. [aclanthology.org/2021.acl-long.520](https://aclanthology.org/2021.acl-long.520/).
- **What it measures:** Largest temporal KGQA dataset, 340x prior. Simple lookups → multi-hop temporal reasoning.
- **Why it matters for us:** Directly tests "the right answer changes over time" — exactly what bi-temporal facts encode.
- **Recommendation:** **Strong fit.** If we want one temporal benchmark, this is the one most aligned with Mnemo's data model.

### TimeQA — legacy but still cited

- **Status:** Still appears in 2024–2026 papers as a temporal QA baseline. ~smaller and narrower than CronQA. Bundle if convenient.

### TRAM — broad temporal aspects

- **Paper:** [arXiv 2310.00835](https://arxiv.org/html/2310.00835).
- **What it measures:** Ten datasets covering order, arithmetic, frequency, duration.
- **Status:** Good breadth, moderate adoption. Worth a row on the scorecard.

### MenatQA / TempLAMA — narrow

- **Status:** Useful as targeted probes (MenatQA = 999 items focused on scope/order/counterfactual; TempLAMA = explicit temporal context probe). Not headline benchmarks. Add them as ablation noise if running TempReason or CronQA, otherwise skip.

### TimeBench — comprehensive umbrella

- **Paper:** [arXiv 2311.17667](https://arxiv.org/abs/2311.17667), ACL 2024.
- **What it measures:** Comprehensive evaluation across ordering, arithmetic, co-temporal inference.
- **Status:** Good integration target — running TimeBench gives us most of TempReason + MenatQA + Test-of-Time-style coverage in one harness. Worth checking before committing to multiple separate benchmarks.

---

## 4. Causal reasoning

Graph C is our most differentiated piece. If the LLM-asserted causal layer actually works, we should be visibly above pure-LLM baselines on these.

### CLadder — formal causal reasoning on synthetic graphs

- **Paper:** [CLadder on Semantic Scholar](https://www.semanticscholar.org/paper/CLadder%3A-A-Benchmark-to-Assess-Causal-Reasoning-of-Jin-Chen/f30b720e34d405f200270a6ef2d09e98585fb4d1).
- **What it measures:** Pearl's ladder of causation — association, intervention, counterfactual — with confounding-bias probes.
- **Why it matters for us:** Tests the "do you understand what causality means" axis, not "do you retrieve causal facts well". A clean ablation: pure LLM vs LLM + Mnemo's Graph C edges. If we can't move the needle here, the causal layer is performance theatre.
- **Realistic to run:** Yes, fully synthetic, scriptable.

### Corr2Cause — inferring causation from correlation

- **Paper:** [Corr2Cause](https://arxiv.org/abs/2306.05836). 200K+ examples.
- **Brutal baseline:** GPT-4 reaches only **29.08 F1**; best fine-tuned baseline **33.38 F1**. Most LLMs at random-guess level.
- **Why it matters for us:** This is the benchmark where pure LLMs publicly fail. Even a modest Mnemo lift here is a big story.
- **Realistic to run:** Yes. Large dataset but evaluation is simple.

### CausalBench — comprehensive causal reasoning

- **Paper:** [CausalBench on ResearchGate](https://www.researchgate.net/publication/384206623_CausalBench_A_Comprehensive_Benchmark_for_Evaluating_Causal_Reasoning_Capabilities_of_Large_Language_Models).
- **What it measures:** Multi-task causal reasoning suite covering causal discovery, effect estimation, counterfactual reasoning.
- **Status:** Newer and less standardised than CLadder/Corr2Cause. Worth tracking but probably not the first investment.

### CausalQA (Webis) — open-domain causal QA

- **Paper:** [aclanthology.org/2022.coling-1.291](https://aclanthology.org/2022.coling-1.291/).
- **What it measures:** 1.1M causal questions sourced from ten QA datasets.
- **Baseline:** UnifiedQA at ROUGE-L F1 0.48.
- **Status:** Less SOTA-y than CLadder but feels more like "real" user causal questions. Good supplementary metric.

### CauSciBench (2025) — scientific causal reasoning

- **Paper:** [CauSciBench](https://zhijing-jin.com/files/papers/2025_CauSciBench.pdf).
- **Status:** Newer, domain-specific. Mention for context; probably not a first investment.

### Causal reasoning, summary recommendation

**Invest in Corr2Cause + CLadder as a pair.** Corr2Cause gives us a public floor (LLMs fail badly) where any lift is a story. CLadder gives us controlled ablation. Both are runnable in well under a week each.

---

## 5. GraphRAG / structured retrieval

Our Graph S is structurally similar to GraphRAG/HippoRAG/LightRAG — entity-extraction → graph build → graph-aware retrieval. We should be comparing directly.

### Microsoft GraphRAG / LazyGraphRAG / BenchmarkQED

- **Maintainer:** Microsoft Research. [BenchmarkQED](https://www.microsoft.com/en-us/research/blog/benchmarkqed-automated-benchmarking-of-rag-systems/).
- **Numbers published:** LazyGraphRAG wins across "comprehensive / diverse / overall" quality metrics vs 1M-context vector RAG and standard GraphRAG. Mostly LLM-as-judge win-rate framing.
- **Realistic to run:** Medium. Microsoft's harness is opinionated and LLM-as-judge heavy.

### HippoRAG / HippoRAG2

- **Paper:** [arXiv 2405.14831](https://arxiv.org/html/2405.14831v1) (HippoRAG, NeurIPS 2024). HippoRAG 2 ([arXiv 2502.14802](https://arxiv.org/html/2502.14802v1), 2025): "From RAG to Memory: Non-Parametric Continual Learning". Repo: [github.com/OSU-NLP-Group/HippoRAG](https://github.com/OSU-NLP-Group/HippoRAG).
- **Numbers:** HippoRAG 2 reports **+7 F1 over NV-Embed-v2** on associative QA, **MuSiQue F1 51.9** (up from 44.8), **2Wiki Recall@5 90.4%** (up from 76.5%).
- **Why it matters for us:** Closest architectural cousin to Mnemo. They use a KG + Personalized PageRank; we use KG + AGE traversal + vector. Direct head-to-head is informative.
- **Realistic to run:** Yes — code is on GitHub, datasets and OpenIE outputs included.

### LightRAG

- **Paper / blog:** [analyticsvidhya summary](https://www.analyticsvidhya.com/blog/2025/01/lightrag/), [learnopencv writeup](https://learnopencv.com/lightrag/).
- **Numbers:** Reports retrieval-accuracy + latency wins vs vanilla RAG; **~50% faster incremental update** time, **20–30ms faster response** vs GraphRAG. GraphRAG keeps a ~10% lead on relational fidelity (cause/effect) on some QA.
- **Realistic to run:** Yes, lightweight.

### GraphRAG-Bench

- Covered above under multi-hop. **Strongly recommend this as the harness for everything in this category** — it already runs Microsoft GraphRAG, LightRAG, HippoRAG, HippoRAG2 under one roof.

---

## 6. Entity resolution / fact dedup

Smaller category for us but directly load-bearing on Phase A acceptance.

**WDC Products** ([arXiv 2301.09521](https://arxiv.org/abs/2301.09521), EDBT 2024) is the current standard — multi-dimensional product matching benchmark designed specifically to avoid saturation. Evaluates against Magellan, Ditto, RoBERTa-base, R-SupCon, HierGAT. **DeepMatcher** and **Magellan** datasets ([Magellan paper on ResearchGate](https://www.researchgate.net/publication/307896907_Magellan_Toward_building_entity_matching_management_systems)) are the legacy reference set covering products, electronics, citations, software. **VLDB 2023** has [a useful experimental survey](https://www.vldb.org/pvldb/vol16/p2225-skoutas.pdf) of pre-trained embeddings on ER. None of these directly probe the temporal/cross-session entity-resolution we care about (resolving "Alice" across a 6-month conversation as one person), so they're useful for the static matching component but not the end-to-end story. **Recommendation:** Use WDC Products as a sanity check on the entity-matching subroutine, but do not lead with it. Our better story will be entity-resolution quality measured inside LOCOMO/LongMemEval ablations.

---

## 7. Embedding / retrieval baselines

We have Qdrant + nomic-embed-text. We should know roughly where that sits.

**MTEB** ([leaderboard](https://huggingface.co/spaces/mteb/leaderboard), [overview](https://embeddings-benchmark.github.io/mteb/overview/available_benchmarks/)) is the umbrella — 56+ tasks across retrieval, classification, clustering, etc. **BEIR** ([beir-benchmark.github.io](https://app.ailog.fr/en/blog/news/beir-benchmark-update)) is the 18-dataset zero-shot retrieval subset, now folded into MTEB. Current SOTA in mid-2026: **Gemini Embedding 2 at 67.71 on MTEB retrieval**, then Voyage 4 Large, then **NV-Embed-v2 at ~69.32** on MTEB overall ([NVIDIA blog](https://developer.nvidia.com/blog/nvidia-text-embedding-model-tops-mteb-leaderboard/)). MTEB v2 (2026) numbers are not directly comparable to v1. We don't need to "publish on" MTEB — we just need to be honest about which embedding model we ship with, where it sits, and whether the upgrade story is "swap nomic-embed-text for X". **Recommendation:** No investment. Cite as context.

---

## Competitive systems we should benchmark head-to-head against

Only includes systems with **published, reproducible numbers** that we can actually compare against.

| System | Architecture | Primary published benchmark | Headline number | Eval harness open? | Source |
|---|---|---|---|---|---|
| **Zep / Graphiti** | Temporal knowledge graph (Neo4j) + LLM extraction | LongMemEval, LOCOMO, DMR | **LongMemEval: 63.8% (GPT-4o)**; **LOCOMO: 75.14% J-score** (after correction) | Partly — Zep paper repo public, Graphiti OSS, but eval reproducibility disputed | [arXiv 2501.13956](https://arxiv.org/abs/2501.13956), [issue #5 zep-papers](https://github.com/getzep/zep-papers/issues/5) |
| **Mem0 / Mem0g** | Fact memory + optional Neo4j graph layer | LOCOMO, LongMemEval, BEAM | **LOCOMO: 66–68% (paper), 91.6–92.5 (latest token-efficient algo)**; **LongMemEval: 94.4**; **BEAM 1M: 64.1** | Yes — [github.com/mem0ai/mem0](https://github.com/mem0ai/mem0); benchmarks scripted | [arXiv 2504.19413](https://arxiv.org/abs/2504.19413), [mem0.ai/research](https://mem0.ai/research) |
| **Letta (was MemGPT)** | Agent + tiered memory (core / archival / recall) | DMR (legacy), Letta Leaderboard (new) | No published LongMemEval/LOCOMO. Letta Leaderboard scores in their blog | Yes — [letta.com/blog/letta-leaderboard](https://www.letta.com/blog/letta-leaderboard), Letta Evals OSS | [letta.com/blog/benchmarking-ai-agent-memory](https://www.letta.com/blog/benchmarking-ai-agent-memory) |
| **HippoRAG / HippoRAG2** | KG + Personalized PageRank | MuSiQue, 2Wiki, HotpotQA, NarrativeQA, PopQA | **MuSiQue F1: 51.9 (+7 over NV-Embed-v2)**; **2Wiki Recall@5: 90.4%** | Yes — [github.com/OSU-NLP-Group/HippoRAG](https://github.com/OSU-NLP-Group/HippoRAG); reproducibility scripts included | [arXiv 2502.14802](https://arxiv.org/html/2502.14802v1) |
| **LangMem** | LangGraph-native (episodic/semantic/procedural) | None of the standard benchmarks (no public LongMemEval/LOCOMO numbers) | N/A — vendor comparisons exist but no head-to-head paper | Partial — open SDK, no published harness | [agentmarketcap landscape](https://agentmarketcap.ai/blog/2026/04/10/agent-memory-vendor-landscape-2026-letta-zep-mem0-langmem) |
| **Memary** | Knowledge-graph long-term memory | None standardised | N/A | OSS but no benchmark publication | — |
| **MemMachine** | Vector + structured memory | LOCOMO | Claims **top scores on LOCOMO v0.2**; specific numbers in [memmachine blog](https://memmachine.ai/blog/2025/12/memmachine-v0.2-delivers-top-scores-and-efficiency-on-locomo-benchmark/) | Partial | — |
| **OMEGA / Mastra / MemPalace / Engram** | Various (recent commercial entrants) | LongMemEval, LOCOMO | **OMEGA 95.4% LongMemEval (GPT-4.1)**; **Mastra 94.87% LongMemEval**; **MemPalace 96.6% LongMemEval**; **Engram 92% DMR / 80% LOCOMO** | Mostly closed; numbers from vendor blogs | [mempalace.tech/benchmarks](https://www.mempalace.tech/benchmarks), [engram.fyi/research](https://www.engram.fyi/research) |

**Practical implication.** If we want a credible competitive story, **the two we must beat (or at least sit beside) are Mem0 and Zep on LongMemEval and LOCOMO**. HippoRAG2 is the structural-comparison cousin we should also beat on MuSiQue/2Wiki via GraphRAG-Bench. Letta is the wildcard — they intentionally don't play the LongMemEval game; we shouldn't either, but we should be able to *speak* to their Letta Leaderboard story.

---

## Recommendation: what to actually invest in

Ranked by **(impact for our story) × (cost to run)**. Be opinionated.

| Rank | Benchmark | Why we should do this | Cost (eng-weeks) | Impact for our story | Notes |
|---|---|---|---|---|---|
| **1** | **LongMemEval** (ICLR 2025) | Unavoidable. Every credible memory vendor publishes on it. If we don't have a LongMemEval number, we don't exist in this market. Tests temporal updates and abstention — both directly in Mnemo's wheelhouse. | 1–2 | **Very high** | Pick the harder LongMemEval_S variant; report both. Use GPT-4o-mini and GPT-4o backbones for comparability with Zep/Mem0. |
| **2** | **LOCOMO** | The other side of the LongMemEval coin. Multi-session, multi-month, causal events — lines up well with our Graph C story. Lets us speak in the same idiom as Mem0/Zep/MemMachine. | 2 | **Very high** | Be transparent about which J-score variant we report; cite the Zep/Mem0 dispute explicitly. |
| **3** | **GraphRAG-Bench** (ICLR 2026) | Single harness, head-to-head against Microsoft GraphRAG, LightRAG, HippoRAG, HippoRAG2. Best one-shot way to establish "yes we're a real graph-RAG system" without re-running each tool's bespoke eval. | 1–2 | **High** | If we cut this to make room, we lose direct architectural comparison. Otherwise our graph claims are unsubstantiated against the canonical OSS comparators. |
| **4** | **Corr2Cause + CLadder** (pair) | Cheap to run, brutal LLM-baseline floor (GPT-4 at 29 F1 on Corr2Cause), and they exercise Graph C — the most differentiated piece of Mnemo. Even a modest lift is a publishable headline. | 1 (both) | **High (if Graph C works)** | This is also our self-check on Graph C. If we *don't* improve over pure-LLM here, Graph C is performance theatre and we need to know that before launch. |
| **5** | **CronQuestions (CronQA)** | Best public benchmark aligned with Mnemo's bi-temporal data model. Exercises "right answer changes over time" directly. Reasonably independent of the LongMemEval/LOCOMO axis, so it diversifies the story. | 1 | **Medium-High** | If we'd rather consolidate, swap CronQA for TimeBench (broader, single harness) — but we lose direct KG framing. |

**Bench cut from the top 5 but worth tracking:**

- **MuSiQue + 2Wiki** — if we run GraphRAG-Bench, we get these effectively for free. Report alongside.
- **BEAM** — strong story (1M-token agent memory) but single-vendor benchmark; wait for independent reproducibility before committing.
- **Test of Time** — useful Graph S ablation but not a headline number.
- **WDC Products** — only as a sanity check on the entity-matching subroutine.

**Bench explicitly deprioritised:**

- HotpotQA — saturated.
- DMR — superseded by LongMemEval.
- ComplexWebQuestions / WebQSP — legacy.
- MTEB / BEIR — context only, no investment.
- MenatQA / TempLAMA — useful as ablation noise inside another benchmark, not standalone.

---

## A note on methodology hygiene

The Zep–Mem0 dispute is the cautionary tale. To stay above the fold:

1. **Always publish the eval harness commit and config alongside the number.** Vendors who refuse to do this get caught.
2. **Report at least two backbones** (GPT-4o-mini and GPT-4o, or equivalent Claude tier). Single-model results are easy to cherry-pick.
3. **For LOCOMO specifically, name the metric variant** (J-score, F1, accuracy@k). The 84 → 58 → 75 swing happened because nobody was specific.
4. **Run baselines on the same harness.** Don't compare our Mnemo-on-our-harness against Zep-on-their-harness.
5. **Pre-register the cuts.** Decide before running whether we're reporting LongMemEval_S, _M, or both.

If we can ship LongMemEval + LOCOMO + GraphRAG-Bench + Corr2Cause/CLadder + CronQA with that hygiene, we have a defensible benchmark story for Phase A close-out and a credible competitive position at v1.
