# The Perpendicular Causal Graph: A Novel Architecture for Longitudinal Knowledge Systems

## Abstract

This paper proposes a dual-graph architecture for longitudinal knowledge systems in which a temporal state graph (Graph S) capturing entity-relationship snapshots over time is paired with an independently traversable causal graph (Graph C) that encodes the chain of causality between state transitions. We argue that causality should be treated as a first-class, perpendicular data structure rather than an emergent property computed through temporal traversal of the state graph. Combined with a self-defining (emergent) ontology and semantic vector-based cross-epoch alignment, this architecture enables both backward causal tracing and forward trajectory projection without requiring reconstruction from raw temporal data.

We situate this proposal within the current research landscape — bi-temporal knowledge graphs (Graphiti/Zep), schema-generative construction (EDC, AutoSchemaKG), causal knowledge graph formalisation (CausalKG), and hierarchical temporal memory (TiMem) — and identify three genuinely novel contributions: the perpendicular causal index as an independent data structure, meta-causal patterns as first-class runtime objects, and the architectural integration required for lifetime-scale operation.

---

## 1. Motivation

### 1.1 The Limitations of Temporal State Graphs

Temporal knowledge graphs (TKGs) have advanced significantly. Systems such as Graphiti [1] maintain validity windows on edges, enabling queries like "what was true at time T." Facts are not overwritten but timestamped and invalidated, preserving full history via a bi-temporal model with four timestamps per fact.

However, these systems encode **what changed** and **when**, but not **why**. To reconstruct causality, an agent must traverse the state graph backwards through temporal snapshots, inferring causal links from co-occurrence and temporal precedence. This approach has three fundamental limitations:

**Traversal cost scales with history depth.** Answering "why does this state exist?" in a decade-scale graph requires walking years of snapshots. Point-in-time queries are efficient; causal chain reconstruction is not.

**Causality is lossy under reconstruction.** Inferring that event A caused state change B from temporal co-occurrence is probabilistic at best. The actual causal link — the lived experience of one thing leading to another — existed at the moment of capture and is lost if not recorded.

**Forward projection is impossible without causal structure.** A state graph can show current state. It cannot show where active dynamics are likely to lead without re-deriving the causal structure each time.

### 1.2 The Snake Metaphor as Data Structure

Consider a system tracking an evolving knowledge domain over time. At any cross-section — any discrete moment — the state graph reveals the full configuration of entity-relationships. But the system is not a collection of disconnected cross-sections. Each state was caused by the previous state, which was caused by the state before that.

This causal chain — the spine of temporal evolution — is a structure that exists **perpendicular** to the state graph. It does not live within any single temporal snapshot. It connects snapshots through directed causal edges. And critically, it can be traversed independently.

```d2
direction: right

t1: "Time T₁" {
  s1: "Graph S snapshot" {
    a: "Entity A"
    b: "Entity B"
    a -> b: "relationship₁"
  }
}

t2: "Time T₂" {
  s2: "Graph S snapshot" {
    a: "Entity A"
    b: "Entity B"
    c: "Entity C"
    a -> b: "relationship₁ (strengthened)"
    b -> c: "relationship₂ (new)"
  }
}

t3: "Time T₃" {
  s3: "Graph S snapshot" {
    a: "Entity A"
    c: "Entity C"
    a -> c: "relationship₃ (new)"
  }
}

t1 -> t2: "Δ₁→₂\n(transitions)" {style.stroke-dash: 3}
t2 -> t3: "Δ₂→₃\n(transitions)" {style.stroke-dash: 3}

spine: "Graph C (the spine)" {
  style.opacity: 0.4
  e1: "Transition: rel₂ created"
  e2: "Transition: rel₁ strengthened"
  e3: "Transition: rel₁ expired"
  e4: "Transition: rel₃ created"
  e1 -> e2: "caused (0.7)"
  e2 -> e3: "caused (0.6)"
  e1 -> e4: "caused (0.8)"
}
```

Graph S cross-sections are the body of the snake at each moment. Graph C — the spine — connects state transitions across time. Each causal edge says "this change caused that change." The spine can be traversed independently of the body.

---

## 2. Architecture

### 2.1 The Dual-Graph Model

**Graph S (State Graph):** A temporal knowledge graph where nodes represent entities and edges represent relationships between them at a given time. Each edge carries a validity window `[valid_at, invalid_at]` and a transaction window `[created_at, expired_at]` following the bi-temporal model established by Graphiti [1] and consistent with Wikidata's temporal qualifiers and YAGO's interval timestamps.

**Graph C (Causal Graph):** A directed graph where nodes represent **state transitions** — discrete changes in Graph S — and edges represent causal links between those transitions. Each causal edge carries:

| Property | Purpose |
|----------|---------|
| Strength | Confidence or magnitude of the causal relationship |
| Pathway | Optional mediator transitions capturing the mechanism |
| Temporal span | Delay between cause and effect |
| Extraction method | Explicit (stated in source text) or inferred (computed) |
| Source provenance | The raw data from which the causal link was extracted |
| Corroboration count | Independent sources supporting this link |

### 2.2 The Perpendicularity Principle

Graph C is not embedded within Graph S. It is a separate, perpendicular index. The nodes of Graph C are not entities — they are **transitions** in Graph S. A causal edge connects two events: "the strengthening of edge X in Graph S was caused by the appearance of edge Y in Graph S."

```d2
direction: down

graph_s: "Graph S (State Graph)" {
  nodes: "Nodes = Entities\n(people, places, concepts)"
  edges: "Edges = Relationships\n(works_at, lives_in, knows)"
  temporal: "Each edge: [valid_at ... invalid_at]\n[created_at ... expired_at]"
  query: "Answers: What was true at time T?"
}

graph_c: "Graph C (Causal Graph)" {
  nodes: "Nodes = State Transitions\n(fact created, strengthened, expired)"
  edges: "Edges = Causal Links\n(A caused B, with reasoning + sources)"
  temporal: "Each edge: strength, reasoning,\nsource_references, temporal_span"
  query: "Answers: Why did this change?\nWhere is this heading?"
}

graph_s -> graph_c: "state transitions\nbecome nodes in Graph C" {
  style.stroke-dash: 3
}
```

This perpendicularity means:
- Backward traversal (causal tracing) walks Graph C directly, without temporal snapshot reconstruction
- Forward traversal (trajectory projection) walks Graph C in the forward direction
- Graph S and Graph C can be queried independently or jointly

This is architecturally analogous to CQRS/Event Sourcing patterns [2], where events are the source of truth and multiple "read model" projections are independently maintained. Graph C is a causal projection of the event stream, not a derived view within Graph S.

### 2.3 Causal Extraction — Agentic Reasoning

Causal edges in Graph C are created by an **agentic LLM** (a tool-use model) that actively queries Graph S, the source text vector store, and Graph C itself to reason about causality. This is fundamentally different from pattern-based extraction or simple causal language detection.

The agent is triggered by Graph S changes (new entities, new or modified facts). It receives the delta (what changed) and has tools to:
- Query entity facts and graph neighbours in Graph S
- Search semantically related source texts in the vector store
- Retrieve existing causal chains from Graph C
- Assert new causal edges with structured reasoning and source traceability

This agentic approach captures causality that is never explicitly stated. If a user mentions sleeping badly, and the graph shows a recent job change, and a past input established a pattern between work stress and sleep disruption, the agent can connect these across time and across inputs.

Every causal edge stores: (1) a confidence strength, (2) detailed reasoning explaining why the agent believes the causal link exists, and (3) a structured list of source references — every memory, fact, and entity that informed the conclusion. This traceability is essential for revising the graph as new information arrives and for debugging false positives.

Over time, as Graph C densifies, the agent's reasoning improves because it has richer context to draw from. Deterministic causal patterns (recurring structures in Graph C) emerge from the agent's repeated assertions and are promoted to first-class objects through the same staging lifecycle used for predicates.

---

## 3. Emergent Ontology and Convergence

### 3.1 Self-Defining Schema

Neither Graph S nor Graph C operates on a predefined ontology. The schema emerges from the data through a process the literature calls schema-generative construction.

The EDC framework (Zhang & Soh, EMNLP 2024) [3] demonstrates this with a three-phase pipeline: Extract (few-shot LLM prompting for open triples) → Define (schema induction from extracted triples) → Canonicalize (post-hoc mapping to induced schema). AutoSchemaKG [4] scales this to 900M+ nodes from 50M documents, achieving 92% alignment with manually curated schemas.

Our approach extends this work in a critical dimension: **continuous evolution**. EDC and AutoSchemaKG induce schemas once from a corpus. Our system operates on a continuous stream where the ontology must evolve over months and years without full re-induction. The mechanism is:

1. **Open extraction:** The LLM extracts raw triples freely
2. **Canonicalisation:** Each new entity or predicate is compared against the existing graph's semantic vector space. Close matches merge; novel items create new nodes.
3. **Convergence:** Repeated patterns stabilise the vocabulary. The richer the graph, the higher the matching surface, the harder it is to create duplicates.

This convergence has a critical property: **more data means more constraint**. Each extraction round encounters a denser matching surface, increasing the probability of canonicalisation over creation.

```d2
direction: right

early: "Early Graph\n(sparse)" {
  style.fill: "#f8d7da"
  style.opacity: 0.4
  n1: "dad"
  n2: "father"
  n3: "my old man"
  n4: "parent"
  note: "4 nodes, no merges\nlow matching surface"
}

mid: "Growing Graph\n(convergent)" {
  style.fill: "#fff3cd"
  style.opacity: 0.4
  n1: "Father" {style.fill: "#d4edda"; style.opacity: 0.4}
  aliases: "aliases: dad, father,\nmy old man, parent"
  note: "1 canonical node\nhigh matching surface"
}

mature: "Mature Graph\n(constrained)" {
  style.fill: "#d4edda"
  style.opacity: 0.4
  n1: "Father" {style.fill: "#d4edda"; style.opacity: 0.4}
  aliases: "aliases: dad, father,\nmy old man, parent,\nthe old man, papa, ..."
  note: "New mentions almost\nalways merge"
}

early -> mid: "convergence\n(semantic matching)"
mid -> mature: "more data =\nmore constraint"
```

### 3.2 Ontological Convergence in Graph C

Graph C develops its own emergent ontology of **causal pathway types**. Early in a system's history, causal links are idiosyncratic. Over time, recurring causal patterns crystallise into named archetypes — first-class objects with instances, temporal evolution, and queryable properties.

**This is novel.** The Ontology Design Patterns for Causality (Jaimini, Henson, Sheth, WOP 2023) [5] formalise causal relations as reusable templates, but these are design-time artifacts. Our proposal reifies them as **runtime objects** that emerge from data, evolve over time, and participate in higher-order relationships. We are aware of no published system where recurring causal patterns are promoted to first-class graph objects through an automated convergence process.

The promotion mechanism is identical to predicate canonicalisation: extract freely → detect recurring patterns via subgraph matching → meet a frequency threshold → enter staging → LLM classification and naming → promotion to canonical.

---

## 4. Cross-Epoch Alignment via Semantic Vectors

### 4.1 The Problem of Identity Across Time

In a decade-scale system, the entity landscape at year 1 and year 10 may be fundamentally different. Dominant entity types shift. Relationship vocabularies change. The state graph undergoes **ontological fission** — categories fragment and the conceptual vocabulary diverges between life epochs.

Structural graph matching fails across epochs because the topology is different. Standard entity resolution handles name changes but not philosophical identity continuity.

### 4.2 Semantic Vector Resolution

We propose that alignment — both across time epochs and across independent graphs — is resolved through the **semantic base** of each node rather than graph topology.

Each node carries an embedding vector enriched by its type tags, accumulated extraction context, relational metadata, and temporal metadata. Two nodes from different epochs resolve as equivalent if their semantic vectors are sufficiently proximate, regardless of local structural divergence.

This approach treats cross-temporal alignment as a special case of cross-graph entity alignment. The same embedding-based methods used in cross-lingual KG alignment [6] apply to the "languages" of different temporal epochs.

### 4.3 The Same-Problem Insight

Cross-client alignment and cross-epoch alignment for a single individual are the **same problem**. Both involve resolving entities across graphs with different structure but shared semantic meaning. The perpendicular causal graph provides the bridge — a causal chain that begins in one epoch and terminates in another can be traced through Graph C even when the entities at each end live in semantically distant regions of Graph S.

```d2
direction: right

epoch1: "Epoch 1 (age 25)" {
  style.fill: "#e8f4fd"
  style.opacity: 0.4
  career: "Career" {style.fill: "#fff3cd"; style.opacity: 0.4}
  ambition: "Ambition"
  proving: "Proving Myself"
  career -> ambition
  career -> proving
}

epoch2: "Epoch 2 (age 55)" {
  style.fill: "#e8f4fd"
  style.opacity: 0.4
  career2: "Career" {style.fill: "#fff3cd"; style.opacity: 0.4}
  legacy: "Legacy"
  meaning: "Meaning"
  career2 -> legacy
  career2 -> meaning
}

vectors: "Semantic Vector Space" {
  style.fill: "#d4edda"
  style.opacity: 0.4
  note: "Career₂₅ and Career₅₅\nshare semantic core\ndespite different topology"
}

epoch1.career -> vectors: "embedding" {style.stroke-dash: 3}
epoch2.career2 -> vectors: "embedding" {style.stroke-dash: 3}

graph_c: "Graph C bridges epochs" {
  style.fill: "#fff3cd"
  style.opacity: 0.4
  e1: "career_start (T₁)"
  e2: "career_crisis (T₂)"
  e3: "career_reframe (T₃)"
  e1 -> e2: "caused"
  e2 -> e3: "caused"
}
```

Structural alignment fails because the topology is different. Semantic vectors resolve the identity. Graph C provides the causal bridge across the epoch boundary.

---

## 5. Operations

### 5.1 Backward Trace (Causal Archaeology)

The system identifies relevant nodes in Graph S, then enters Graph C and walks backwards along causal edges. Because Graph C is pre-computed and independently indexed, this does not require temporal reconstruction. The system returns a causal chain with provenance links to source data at each step.

### 5.2 Forward Projection (Trajectory Estimation)

The system identifies currently active transitions in Graph S, locates their corresponding nodes in Graph C, and walks forward along established causal pathways. If a known causal chain has previously led from A → B → C, and A is currently active, B and C are flagged as downstream risk.

This is not prediction from statistical correlation. It is traversal of a concrete causal structure built from the system's own recorded experience.

```d2
direction: right

backward: "Backward Trace" {
  style.fill: "#e8f4fd"
  style.opacity: 0.4
  current: "Current state:\nAnxiety → Work\n(strengthened)" {style.fill: "#f8d7da"; style.opacity: 0.4}
  c1: "Boss criticism\n(Tuesday)" {style.fill: "#fff3cd"; style.opacity: 0.4}
  c2: "Project deadline\n(last week)" {style.fill: "#fff3cd"; style.opacity: 0.4}
  c3: "Team conflict\n(2 weeks ago)" {style.fill: "#fff3cd"; style.opacity: 0.4}
  c1 -> current: "caused (0.8)"
  c2 -> c1: "caused (0.6)"
  c3 -> c2: "caused (0.5)"
}

forward: "Forward Projection" {
  style.fill: "#e8f4fd"
  style.opacity: 0.4
  active: "Active transition:\nJob dissatisfaction\n(strengthening)" {style.fill: "#fff3cd"; style.opacity: 0.4}
  f1: "Insomnia\n(likely in 3 days)" {style.fill: "#f8d7da"; style.opacity: 0.4}
  f2: "Irritability\n(likely in 1 week)" {style.fill: "#f8d7da"; style.opacity: 0.4}
  f3: "Relationship friction\n(likely in 2 weeks)" {style.fill: "#f8d7da"; style.opacity: 0.4}
  active -> f1: "historical pattern (0.7)"
  f1 -> f2: "historical pattern (0.6)"
  f2 -> f3: "historical pattern (0.5)"
}
```

Backward trace walks Graph C from effect to causes. Forward projection walks from active cause to known downstream effects. Both are direct graph traversals — not statistical inference.

### 5.3 Temporal Rewind at Variable Resolution

The state graph can be "rewound" to any prior moment by querying edge validity windows. At decade scale, this is expensive at full resolution. We propose **hierarchical temporal abstraction**:

- **Fine** (days/weeks): Full state graph, all edges and validity windows
- **Medium** (months/quarters): Summary nodes replace clusters. Key edges preserved; daily fluctuations compressed.
- **Coarse** (years/epochs): Chapter-level summaries. Dominant entity clusters, major causal chains, ontological regime shifts.

Graph C provides the scaffolding for compression. **Causality determines what is signal and what is noise.** Causal chains that drove actual state transitions are preserved at all resolutions. Entries with no downstream causal effect are compressed away.

TiMem [7] demonstrates a similar hierarchical approach with a Temporal Memory Tree (segments → sessions → days → weeks → profiles), achieving 75.30% accuracy on the LoCoMo benchmark. Our proposal extends this with adaptive boundaries (epoch detection from regime change in Graph C) rather than fixed temporal divisions.

### 5.4 Causal Delta Reports

Delta reports become **causal**, not merely structural. Instead of "edge X increased 30% this week," the system reports: "Edge X increased 30%. Graph C attributes this to event Y (confidence 0.8), consistent with causal pattern Z that has activated N times in the past year. Downstream risk: edge W likely within 72 hours based on historical pattern."

---

## 6. Research Landscape and Novelty Assessment

### 6.1 What Exists

| System | Contribution | Limitation for Our Use Case |
|--------|-------------|---------------------------|
| **Graphiti/Zep** [1] | Bi-temporal KG with entity resolution, community detection. Three-tier ER (exact → fuzzy → LLM). | Python-only. Requires Neo4j/FalkorDB. LLM-heavy entity resolution. No causal structure. |
| **EDC** [3] | Extract-Define-Canonicalize for schema-free KG construction. LLM-gated merge decisions. | One-shot schema induction, not continuous evolution. |
| **AutoSchemaKG** [4] | Schema-generative at massive scale (900M nodes, 50M docs). 92% alignment with human schemas. | 78,400 GPU hours. One-shot. No temporal or causal dimension. |
| **CausalKG** [8] | Hyper-relational causal formalisation using RDF-star. Mediator variables, effect magnitude. | Formalization only, not a production system. No temporal dimension. |
| **HyperCausalLP** [9] | Causal link prediction in hyper-relational KGs. +5.94% MRR with mediator knowledge. | Only handles serial causal structures. Fork/collider configurations not addressed. |
| **HugRAG** [10] | Hierarchical graph with three edge sets including causal gates. Best-First Search with causal weighting. | Causal gates are edge attributes within one graph, not an independent structure. |
| **TiMem** [7] | Hierarchical temporal memory tree. Complexity-aware recall. | Fixed temporal boundaries. No forgetting mechanism. No causal reasoning. |
| **Causality ODP** [5] | Reusable ontology design patterns for causal relations. Composable templates. | Design-time artifacts, not runtime objects. No emergence mechanism. |

### 6.2 What's Novel

**Three contributions have no direct precedent:**

1. **The perpendicular causal index.** Maintaining causality as a separate, independently traversable data structure with its own query interface, consistency model, and evolution rules. The architectural pattern of separating a causal projection from the state graph, analogous to CQRS read models, has not been applied to knowledge graphs.

2. **Meta-causal patterns as runtime objects.** Recurring causal chains reified as first-class graph objects that emerge through automated convergence, have temporal trajectories, and participate in higher-order queries. Published work on causal ontology patterns [5] provides design-time templates; our proposal automates their discovery and lifecycle.

3. **The lifetime-scale integration challenge.** Individual components exist (temporal KGs, causal discovery, emergent ontology, hierarchical abstraction), but the full integration — temporal state + perpendicular causality + emergent schema + cross-epoch alignment + adaptive compaction — has not been demonstrated or designed as a unified architecture.

**Three concepts build on existing work:**

4. **Bi-temporal fact model** — well-established (Graphiti [1], Wikidata, YAGO)
5. **Emergent ontology** — active frontier (EDC [3], AutoSchemaKG [4]), extended here with continuous evolution
6. **Semantic vector alignment** — well-studied for cross-lingual/cross-graph ER, novel application to cross-epoch alignment

### 6.3 Honest Gaps

**Causal validation.** The system records causality as stated or inferred. Self-reported causality may not reflect actual causality — attribution errors are well-documented in psychology. The system must balance honouring the source's narrative with maintaining causal integrity. Our approach: confidence-weighted edges, corroboration tracking, and decay for unconfirmed inferences.

**Graph C density at scale.** Every state transition potentially has multiple causes and effects. At decade scale, Graph C could become extraordinarily dense. Pruning strategies are needed — edges corroborated by multiple independent instances are promoted; one-off inferred links decay.

**Continuous ontology evolution.** No existing system has demonstrated continuous schema evolution over years. The convergence hypothesis (more data = more constraint) is theoretically sound but empirically unverified at lifetime scale. Ontology fission between epochs is a real risk.

**Computational cost.** Maintaining two independent graph structures, running causal extraction on every input, and detecting meta-causal patterns all add computational overhead. The architecture must be designed for eventual consistency and asynchronous derivation.

---

## 7. Open Problems

### 7.1 Causal Graph Density and Computability

At lifetime scale, every state transition potentially has multiple causes and effects. Pruning strategies are needed:
- Causal edges corroborated by multiple independent instances are promoted to permanent status
- One-off inferred links decay over a configurable window
- Pattern-level abstraction compresses sequences of individual causal edges into single pattern instances

### 7.2 The Pattern vs. Truth Distinction

The system identifies patterns in data, not truths about reality. A causal edge that says "X caused Y" means "the data consistently shows X preceding Y, and the source sometimes explicitly states the connection." This is correlation + attribution, not verified causation.

This distinction matters for how the system presents its outputs. Framing matters: "the data shows a pattern where X precedes Y" is accurate. "X causes Y" is an overclaim.

### 7.3 Hierarchical Abstraction Boundaries

TiMem [7] uses fixed temporal boundaries (day/week/month). Lifetime-scale systems need adaptive boundaries — detected from the data, not imposed. Epoch boundaries should correspond to genuine regime changes in the graph, not arbitrary calendar divisions.

Detecting epoch boundaries requires monitoring:
- Rate of new entity creation (spikes indicate life changes)
- Causal pattern frequency shifts (established patterns stopping, new ones appearing)
- Ontological vocabulary drift (new predicate types emerging)

### 7.4 Estate, Ownership, and Node Sovereignty

A knowledge graph that operates over decades contains not just the owner's data but their **model of other people**. Nodes for every person they had a relationship with, tagged with how they perceived that person. Causal chains that implicate others in outcomes.

This creates unresolved questions:
- Does the graph belong to the individual or to their estate?
- Do nodes representing other living people have independent sovereignty?
- Can patterns that implicate others be surfaced without consent?

These are not technical problems but they constrain technical design — the architecture must support granular access control and selective redaction without breaking graph integrity.

---

## References

[1] Graphiti/Zep. "Graphiti: Building Real-Time, Evolving Knowledge Graphs for AI Agents." arXiv:2501.13956, Jan 2025. https://github.com/getzep/graphiti

[2] Young, G. "CQRS Documents." 2010. https://cqrs.files.wordpress.com/2010/11/cqrs_documents.pdf

[3] Zhang, B. & Soh, H. "Extract, Define, Canonicalize: An LLM-based Framework for Knowledge Graph Construction." EMNLP 2024. https://aclanthology.org/2024.emnlp-main.548/

[4] AutoSchemaKG. "AutoSchemaKG: Schema-Generative Knowledge Graph Construction at Scale." arXiv:2505.23628, May 2025. https://github.com/HKUST-KnowComp/AutoSchemaKG

[5] Jaimini, U., Henson, C., & Sheth, A. "An Ontology Design Pattern for Representing Causality." WOP 2023, CEUR-WS Vol-3636. https://ceur-ws.org/Vol-3636/paper4.pdf

[6] Chen, M., et al. "Multilingual Knowledge Graph Embeddings for Cross-lingual Knowledge Alignment." Springer, 2020.

[7] TiMem. "TiMem: Temporal Memory Tree for Hierarchical LLM Agents." arXiv:2601.02845, Jan 2026. https://github.com/TiMEM-AI/timem

[8] Jaimini, U. & Sheth, A. "CausalKG: Causal Knowledge Graph Explainability." IEEE Internet Computing, arXiv:2201.03647, Jan 2022.

[9] HyperCausalLP. "Causal Link Prediction in Hyper-Relational Knowledge Graphs." arXiv:2410.14679, Oct 2024.

[10] HugRAG. "HugRAG: Hierarchical Unified Graph Retrieval-Augmented Generation." arXiv:2602.05143, Feb 2026.
