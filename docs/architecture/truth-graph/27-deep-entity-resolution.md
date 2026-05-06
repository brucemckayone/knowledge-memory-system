# 27 — Deep Entity Resolution (GNN / Biencoder) — DEFERRED

**Phase:** 6 (deferred — design only; ship decision pending Phase 5 evaluation)
**Master:** `21-cluster-bridging-master.md`
**Status:** **Design only.** Per master §7 Phase 0 contract, deferred docs include sections 1-3 (Purpose, Design, Implementation). Sections 4-7 deferred until ship is approved.
**Bead:** to be created when ship is approved post-Phase 5 evaluation

---

## 1. Purpose

**Question it answers:** Given everything we know about A and B, are they the same identity?

Phases 1–5 produce a series of independent signals — graph topology, embedding clusters, drift, KGE similarity, 3-signal scores. Each signal is heuristic, hand-crafted, and added to the cross-cluster generator's weight vector. The architecture's natural endpoint, if cluster-bridging proves a load-bearing capability long-term, is to **learn the right combination** end-to-end via a deep model trained on labelled pairs.

Two paths from the literature:

- **GNN-based entity resolution** (R-GCN, GraphSAGE, BLINK-style) — train a graph neural network on the entity-fact triples, producing a per-entity embedding that incorporates BOTH textual context and graph structure. Pairs are scored by a downstream classifier on the concatenated embeddings. State-of-the-art for entity resolution benchmarks (Christophides et al., CSUR 2020).
- **Biencoder + cross-encoder** (Wu et al., EMNLP 2020 BLINK; De Cao et al., ICLR 2021 GENRE) — encode each entity's source-context window with a Transformer biencoder; retrieve top-k via FAISS; rerank with a cross-encoder. Designed for entity-linking-against-canonical-entity-list, but adapts to entity resolution.

This phase ships only if the previous phases' precision/recall is insufficient AND the labelled dataset (collected from reconciliation_agent verdicts over Phases 4 and 5) is large enough to train. Both are open questions that the iteration cycle of earlier phases will answer.

## 2. Design

### 2.1 Approach: GNN, biencoder, or hybrid

Decision deferred until ship time. Three contenders:

**A. R-GCN trained on the triple set.**
- Inputs: entity nodes + relational edges (from `facts`)
- Output: per-entity embedding (~256 dim)
- Pros: leverages graph structure naturally; handles multi-relational data
- Cons: doesn't directly use textual context; needs supervised pairs for fine-tuning
- Library: PyTorch Geometric or DGL

**B. Biencoder + cross-encoder over source-memory windows.**
- Inputs: each entity's set of source memories (text + 768-dim embedding from nomic-embed-text)
- Output: per-entity learned profile vector via Transformer biencoder
- Pros: directly leverages textual context; well-aligned with how nomic-embed-text already works
- Cons: doesn't use graph structure; needs supervised pairs
- Library: sentence-transformers, FAISS

**C. Hybrid: combine GNN graph features with biencoder text features.**
- Inputs: both
- Output: concatenated embedding fed to a small MLP head trained on labelled pairs
- Pros: best of both
- Cons: more complex; more hyperparameters

Default proposal at ship time: **C (hybrid)**. R-GCN handles relational signature; biencoder handles textual context; concatenation + MLP head learns the right combination from labelled data. PyTorch Geometric for the GNN side; sentence-transformers for the text side.

### 2.2 Training data

The natural labels come from the existing reconciliation_agent's same_as / merge / distinct verdicts in `merge_candidates.resolution`. Each row is a labelled pair:

- Positive: `resolution = 'same_as'` or `resolution = 'merge'`
- Negative: `resolution = 'distinct'`

**Label richness (cold-eyes review X3):** today's `merge_candidates.resolution_reasoning` is unstructured prose, not a clean training signal. For Phase 6, training quality depends on whether we extract structured features (positive evidence sources, predicate role overlaps, etc.) from the prose — or treat the verdict as a binary label and rely on input features to carry the signal. The default approach is the latter: input = (entity-a-features, entity-b-features), label = verdict. Prose is logged but not parsed.

By the time Phase 6 is considered, the system has accumulated months-to-years of reconciliation verdicts. **Pre-ship validation:** before code is written, count `merge_candidates WHERE resolution IN ('same_as', 'merge')` and `WHERE resolution = 'distinct'`. If the dominant class is < 1k, Phase 6 is postponed pending more verdicts. If labels are highly imbalanced (e.g. 100 positives vs 10000 negatives), invest in label-bootstrapping (active learning loop with the existing reconciliation_agent) before training.

Training set size requirement: at least 1k positives + 1k negatives for biencoder fine-tuning; 10k+ each for the hybrid model to outperform simpler approaches.

**Weight rebalancing (cold-eyes review W8):** like Phase 5, the new signal joins via re-tuning the full vector from scratch against ground truth. By Phase 6 the vector is 8-dim (T0+T1 4 weights, drift 2, role 1, centrality 1 → 6 from `25`; KGE adds 1; deep ER adds 1).

### 2.3 Compute placement

This phase requires significant compute. Two scenarios:

- **CPU-only (small graph, small label set):** training is slow but feasible. R-GCN on 10k triples: ~hours per epoch on CPU. Biencoder fine-tuning: ~hours. OK for periodic retraining (weekly).
- **GPU-required (large graph, large label set):** > 50k entities, > 100k triples. Training becomes infeasible on CPU. We commit to GPU support for this phase if the criteria require it. Likely deferred indefinitely if the user remains solo dev on a laptop.

Compute placement decision is itself part of the ship criterion. If the user's environment doesn't justify GPU, Phase 6 doesn't ship.

### 2.4 Inference vs training

- **Training:** offline, scheduled monthly or on demand. New labels accumulated since last training trigger retraining.
- **Inference:** at patrol time, the cross-cluster generator (`25`) queries the trained model for top-k similar entities per candidate. O(d) per query with FAISS.

### 2.5 Out of scope (even on ship)

- **End-to-end pipeline replacement.** Phase 6 augments the cross-cluster generator; it does not replace the heuristic combination from Phase 4.
- **Multi-task learning.** Training a single model that predicts entity resolution AND fact validity AND temporal validity. Future research direction.
- **Continual learning.** Online updating of the model as labels arrive. Initial implementation is offline batch.
- **Cross-corpus transfer.** Models trained on one user's graph may not transfer to another's (different entity types, different predicate distributions). No transfer-learning ambition.

## 3. Implementation

### 3.1 New module

`ml-services/app/deep_er.py`:

```python
import torch
import torch_geometric
import sentence_transformers

def train_hybrid_er_model(epochs: int = 50) -> ModelArtifact:
    """Train hybrid GNN + biencoder + MLP on labelled pairs."""
    labels = load_labelled_pairs_from_db()
    triples = load_triples_from_db()
    
    rgcn = train_rgcn_on_triples(triples)
    biencoder = fine_tune_biencoder_on_pairs(labels)
    head = train_classifier_head(rgcn, biencoder, labels)
    
    save_model(rgcn, biencoder, head, version=...)
    return ModelArtifact(...)

def score_pair(a_id: str, b_id: str) -> float:
    """Run inference on a candidate pair."""
    model = load_latest_model()
    return float(model.predict_pair(a_id, b_id))
```

### 3.2 Endpoints

- `POST /api/deep-er/train` — trigger training (admin-only)
- `POST /api/deep-er/score` — score a pair (used by the cross-cluster generator)
- `GET /api/deep-er/status` — model version, training history

### 3.3 Integration with cross-cluster generator

Phase 4 pipeline gains another configurable check:

```typescript
if (DEEP_ER_AVAILABLE) {
  scoreVector.deep_er_score = await scoreDeepEr(a, b);
}
```

The Phase 4 weight vector grows from 7 to 8. Tuned via the iteration cycle.

The reconciliation_agent's prompt extension recognises that some candidates carry deep-ER scores and may have higher confidence than others.

### 3.4 Schema migration

`019_deep_er.sql`:

```sql
ALTER TABLE public.merge_candidates
  ADD COLUMN IF NOT EXISTS deep_er_score FLOAT,
  ADD COLUMN IF NOT EXISTS deep_er_model_version INTEGER;

CREATE INDEX IF NOT EXISTS idx_merge_candidates_deep_er
  ON public.merge_candidates (deep_er_score DESC NULLS LAST);
```

---

**Sections 4 (Verification), 5 (Benchmark), 6 (Edge cases), 7 (Iteration cycle) deferred.** Written when Phase 6 is approved for ship. The decision criterion is documented in master `21` §7 Phase 5 evaluation.

## 8. References

### Existing docs
- `21-cluster-bridging-master.md` §6.10 — abstract framing
- `25-cross-cluster-generator.md` — the pipeline this phase augments
- `26-structural-embeddings.md` (Phase 5, deferred) — sibling, simpler ML

### External primary sources
- Schlichtkrull, Kipf, Bloem, van den Berg, Titov, Welling, *Modeling Relational Data with Graph Convolutional Networks* (R-GCN), ESWC 2018
- Hamilton, Ying, Leskovec, *Inductive Representation Learning on Large Graphs* (GraphSAGE), NeurIPS 2017
- Wu, Petroni, Josifoski, Riedel, Zettlemoyer, *Zero-Shot Entity Linking with Dense Entity Retrieval* (BLINK), EMNLP 2020
- De Cao, Izacard, Riedel, Petroni, *Autoregressive Entity Retrieval* (GENRE), ICLR 2021
- Christophides, Efthymiou, Palpanas, Papadakis, Stefanidis, *End-to-End Entity Resolution for Big Data: A Survey*, ACM CSUR 2020
- Li, Li, Suhara, Doan, Tan, *Deep Entity Matching with Pre-Trained Language Models* (Ditto), VLDB 2020
- Narayan, Chami, Orr, Ré, *Can Foundation Models Wrangle Your Data?*, VLDB 2022

### Libraries
- PyTorch Geometric — https://pytorch-geometric.readthedocs.io
- DGL — https://www.dgl.ai
- sentence-transformers — https://www.sbert.net
- FAISS — https://faiss.ai

---

*This is a deferred design doc. Sections 1-3 establish the contract; sections 4-7 are written when ship is approved.*
