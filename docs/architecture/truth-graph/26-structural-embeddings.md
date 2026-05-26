# 26 — Structural Embeddings (KGE) — DEFERRED

**Phase:** 5 (deferred — design only; ship decision pending Phase 4 evaluation)
**Master:** `21-cluster-bridging-master.md`
**Status:** **Design only.** Per master §7 Phase 0 contract, deferred docs include sections 1-3 (Purpose, Design, Implementation). Sections 4-7 (Verification, Benchmark, Edge cases, Iteration cycle) are written when ship is approved.
**Bead:** to be created when ship is approved post-Phase 4 evaluation

---

## 1. Purpose

**Question it answers:** What role does each entity play in the graph, regardless of its name or text content?

T0+T1 shipping closes the obvious cluster-bridging cases — entities with shared embedding clusters or drift events get surfaced. The cases that remain are those where:
- Two entities are co-referent
- They are in different components
- They have NO shared embedding cluster (centroids diverge — Walton vs Geneva narrative)
- Neither has drifted (both have stable mention contexts)
- Their names and aliases don't overlap (so 3-signal scoring also misses them)

These are the residual hard cases. The signal we haven't exploited: their **structural roles** in the graph. "The stranger" and "Victor Frankenstein," in disjoint subgraphs with no shared neighbours, both play similar (subject, predicate, object) patterns — narrator-of relationships, rescued-by relationships, ill-on-ship relationships. KGE captures this as embedding proximity in a learned space where similar relational signatures land near each other.

KGE produces a per-entity vector (typically 100-500 dim) trained on the triple set of the graph. Entities that "play similar roles" — even in disjoint subgraphs — land near each other in KGE space. We use top-k nearest neighbours in KGE space as a candidate generator, additive to the Phase 4 pipeline.

This phase is **conditional on Phase 4 evaluation**. If T0+T1+Phase 4 deliver acceptable recall on real cluster-bridging cases, we don't need KGE. The decision point is documented in master §7 Phase 4.

## 2. Design

### 2.1 Algorithm options

Multiple KGE variants from the literature; all are O(epochs · |triples| · d) for training. We pick one based on benchmark fit:

- **TransE** (Bordes et al., NeurIPS 2013) — embeds entities and relations as vectors such that h + r ≈ t for triples (h, r, t). Simple, fast, well-understood. Limitation: cannot model symmetric/transitive relations.
- **DistMult** (Yang et al., ICLR 2015) — bilinear scoring. Handles symmetric relations naturally. Limitation: cannot distinguish (h, r, t) from (t, r, h).
- **ComplEx** (Trouillon et al., ICML 2016) — complex-valued extension of DistMult. Handles asymmetric and symmetric. Industry-standard for benchmark comparisons.
- **RotatE** (Sun et al., ICLR 2019) — relation as rotation in complex space. Handles all relation patterns (symmetric, antisymmetric, inversion, composition). Strong benchmark performance.

Default proposal: **RotatE**. Best benchmark performance on FB15k-237 and similar; handles all relation patterns; has good library support (PyKEEN). Tuneable to TransE / ComplEx if benchmarks favour them.

### 2.2 PyKEEN as the implementation library

PyKEEN (Python Knowledge Embedding) is the canonical KGE library. Provides:
- All major model implementations (TransE, ComplEx, RotatE, etc.) with consistent API
- Training pipelines with negative sampling, regularisation, early stopping
- Evaluation framework (mean rank, MRR, Hits@k)
- Persistence (save/load trained models)

We add PyKEEN to `ml-services/requirements.txt`. PyKEEN depends on PyTorch (CPU is sufficient at our scale; GPU optional). This is the **largest dependency add** so far — ~500 MB to the ml-services image.

### 2.3 Training cycle

KGE is a heavy compute. Training cadence:

- **Initial training:** triggered manually via `POST /api/kge/train`. Runs for 100-500 epochs (configurable). Persists the trained model to disk under `ml-services/kge-models/`.
- **Periodic retraining:** monthly, or when `merge_candidates_pending > THRESHOLD`. Triggered by an admin / scheduled task; not on the patrol path.
- **Inference:** at patrol time, the cross-cluster generator (`25`) loads the latest model and queries top-k nearest neighbours per entity. O(d) per query with FAISS or pgvector.

Training data: every triple `(subject_entity_id, predicate, object_entity_id)` from `facts WHERE expired_at IS NULL` plus all `same_as_links`. ComplEx and RotatE train on both directions; TransE on one direction.

### 2.4 Embeddings as candidate generator

After training, every entity has a KGE vector. The cross-cluster generator pipeline (`25`) gains a new signal:

```
score += w7 * kge_similarity(a, b)
```

Where `kge_similarity(a, b)` = cosine similarity of the entities' KGE vectors. High when both entities play similar relational roles, low otherwise.

**Weight rebalancing protocol (cold-eyes review W8):** When the new signal joins, the existing 6 weights are NOT preserved-and-renormalised. Instead, the full 7-dim weight vector is **re-tuned from scratch** via the §7.4 protocol of `25` against the same ground truth (`synthetic-10k`). This avoids silently demoting previously-tuned weights when new signals arrive. The benchmark report records both the old (6-dim) and new (7-dim) weight vectors for audit.

**Query pattern (cold-eyes review W9):** `25` uses pairwise `kge_similarity(a, b)` for known candidate pairs — no top-k nearest-neighbour query. Therefore HNSW on `entity_topology.kge_vector` is **not required at ship time**. Future top-k queries (e.g. "find the 10 entities most similar in KGE space to X") would require HNSW; that's a separate forward decision.

The reconciliation_agent's prompt is also extended (small addition) to know that some candidates are KGE-derived: "Some candidate pairs were identified by structural-role similarity in a learned embedding space. Their names and source contexts may differ entirely; investigate by examining their relational signatures."

### 2.5 Storage

KGE vectors stored in a new column on `entity_topology` (or a sibling table — TBD at ship time):

```sql
ALTER TABLE entity_topology ADD COLUMN kge_vector VECTOR(200);
ALTER TABLE entity_topology ADD COLUMN kge_model_version INTEGER;
```

Vector dimension defaults to 200 (RotatE's typical setting). Model version tracks which trained model produced the vector — old vectors persist until retraining replaces them.

### 2.6 Out of scope (for this phase, even on ship)

- **Multi-relational KGE variants** — relation-specific scoring functions (e.g. R-GCN-style). Future Phase 6 territory.
- **Inductive KGE** — embeddings for entities not seen during training. Phase 6's GNN approach handles this.
- **Active learning loop** — using reconciliation_agent verdicts to retrain. Future work.
- **GPU-accelerated training** — supported by PyKEEN but not required at our scale; would be considered if training latency becomes a bottleneck.

## 3. Implementation

### 3.1 New module

`ml-services/app/kge.py`:

```python
import pykeen
from pykeen.pipeline import pipeline_from_config

def train_kge(model_name: str = 'RotatE', epochs: int = 200) -> ModelArtifact:
    """Train KGE model on current graph state. Persists to disk."""
    triples = load_triples_from_db()
    result = pipeline(model=model_name, training=triples, epochs=epochs)
    save_model(result.model, model_version=int(time.time()))
    return ModelArtifact(...)

def get_entity_embedding(entity_id: str, model_version: int) -> np.ndarray:
    """Lookup entity embedding from the trained model."""
    model = load_model(model_version)
    return model.entity_representations[0](entity_id_to_index[entity_id])

def kge_similarity(a_id: str, b_id: str, model_version: int) -> float:
    """Cosine similarity in KGE space."""
    return float(cosine(
        get_entity_embedding(a_id, model_version),
        get_entity_embedding(b_id, model_version)
    ))
```

### 3.2 Endpoints

- `POST /api/kge/train` — trigger training. Returns the new model version after completion.
- `GET /api/kge/status` — current model version, training history.
- `POST /api/kge/embeddings/refresh` — recompute and write back `entity_topology.kge_vector` for all entities using current trained model.

Training endpoint is admin-restricted (rate-limited, possibly auth-required — solo dev defers, multi-user deployment hardens).

### 3.3 Integration with cross-cluster generator

Phase 4 pipeline (`25`) gains a configurable check:

```typescript
const KGE_AVAILABLE = await checkKgeModelExists();
if (KGE_AVAILABLE) {
  scoreVector.kge_similarity = await computeKgeSimilarity(a, b);
}
```

If no model exists, KGE signal contributes 0. The pipeline degrades gracefully when KGE isn't shipped.

### 3.4 Schema migration

`018_kge.sql`:

```sql
ALTER TABLE public.entity_topology
  ADD COLUMN IF NOT EXISTS kge_vector VECTOR(200),
  ADD COLUMN IF NOT EXISTS kge_model_version INTEGER;

CREATE INDEX IF NOT EXISTS idx_entity_topology_kge_model
  ON public.entity_topology (kge_model_version);
```

(The HNSW index for KGE vector ANN is added when needed; the column existing alone doesn't require it.)

#### 3.4.1 Onboarding a new `candidate_source` value (bead nmemo-2yv.93)

If a future KGE-driven enumerator surfaces its own candidate rows on
`merge_candidates` (rather than augmenting an existing source's signal
vector via §3.3), the new source value must be added as a coordinated
landing:

1. Extend `CANDIDATE_SOURCE_VALUES` in `src/services/enums.ts` with the
   new literal (e.g. `'kge_generator'`).
2. Ship a follow-up migration that drops + recreates the
   `valid_candidate_source` CHECK on `public.merge_candidates` to admit
   the new value. Mirror the shape of
   `030_candidate_source_check.sql` (DROP CONSTRAINT IF EXISTS, ADD
   CONSTRAINT with the full enumerated set, `-- keep in sync` comment).
3. Update the reconciliation_agent's prompt-builder
   (`ml-services/app/reconciliation_agent.py
   _build_reconciliation_prompt`) — the source tag is currently
   informational, but if the new enumerator needs branch-specific
   prompting (the legacy reason candidate_source exists at all), wire
   it in the same landing.
4. Update doc 25 §2.3 / §3.3's enumeration of valid sources.

The paired-landing rule exists because the `valid_candidate_source`
CHECK fails-closed on an unknown writer (per `030_candidate_source_check.sql`
header — schema-layer typo guard). A writer that ships before its
CHECK migration will throw on every insert; a CHECK that ships before
its writer does no harm. Land in TS-tuple-then-migration order if
splitting across PRs.

---

**Sections 4 (Verification), 5 (Benchmark), 6 (Edge cases), 7 (Iteration cycle) deferred.** They will be written if and when Phase 5 is approved for ship after Phase 4 evaluation. The decision criterion is documented in master `21` §7 Phase 4 milestone.

## 8. References

### Existing docs
- `21-cluster-bridging-master.md` §6.9 — abstract framing
- `25-cross-cluster-generator.md` — the pipeline KGE will augment
- `27-deep-entity-resolution.md` (Phase 6, deferred) — sibling, more aggressive ML

### External primary sources
- Bordes, Usunier, García-Durán, Weston, Yakhnenko, *Translating Embeddings for Modeling Multi-relational Data* (TransE), NeurIPS 2013
- Yang, Yih, He, Gao, Deng, *Embedding Entities and Relations for Learning and Inference in Knowledge Bases* (DistMult), ICLR 2015
- Trouillon, Welbl, Riedel, Gaussier, Bouchard, *Complex Embeddings for Simple Link Prediction* (ComplEx), ICML 2016
- Sun, Deng, Nie, Tang, *RotatE: Knowledge Graph Embedding by Relational Rotation in Complex Space*, ICLR 2019
- Christophides, Efthymiou, Palpanas, Papadakis, Stefanidis, *End-to-End Entity Resolution for Big Data: A Survey*, ACM CSUR 2020

### Libraries
- PyKEEN — https://pykeen.readthedocs.io
- PyTorch — https://pytorch.org

---

*This is a deferred design doc. Sections 1-3 establish the contract; sections 4-7 are written when ship is approved.*
