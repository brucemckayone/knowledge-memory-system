# Proposed Architecture — Cross-Corpus & the Primitive Layer

**Status:** Proposal, contingent on the validation gate (Part 9). Visual companion to `00-design-space.md` (the code-compliance use case) and `01-primitives-and-control-surface.md` (the primitive/control-surface reframe). This doc exists to make the *proposed* architecture legible without reading code — every change is a diagram plus a paragraph.
**Date:** 2026-07 · **Base branch context:** `feat/cognitive-platform-v2`
**Grounding:** the "exists today" claims were verified by six read-only code investigations (2026-07-03). Nothing here is built yet.

**Diagram legend:** plain node = exists today (reuse) · **orange** node = proposed new (build) · **red** node = the hard-core risk we must not underestimate.

---

## 1. The shape in one picture

The goal is a set of primitives you build memory systems on. Cross-corpus code compliance is only the first use case. The whole proposal is: **keep the ingestion core fixed and neutral, and add composition at two boundaries.** A use case is then *assembled*, not forked.

```d2
direction: down
classes: {
  new: { style: { fill: "#fff7ed"; stroke: "#ea580c"; stroke-width: 2 } }
}

core: {
  label: Fixed neutral core (unchanged)
  ingest: {
    label: Ingest pipeline
  }
  stores: {
    label: Stores (Postgres, AGE, Qdrant)
    shape: cylinder
  }
  ingest -> stores
}

b1: {
  label: Boundary 1 - Pass registry
  class: new
}
b2: {
  label: Boundary 2 - Edge-type rule vocabulary
  class: new
}

uc: {
  label: Use cases (declared as plugins)
  cc: {
    label: Cross-corpus compliance (first)
  }
  fic: {
    label: Fiction (bible vs manuscript)
  }
  res: {
    label: Research synthesis
  }
}

core -> b1: extend
core -> b2: extend
b1 -> uc: select passes
b2 -> uc: declare edge rules
```

Everything orange is the build. Everything below the core is *the causal subsystem generalized* — we already ship one agent pass (causal) and one rule-bearing edge type (causal chains), so both boundaries generalize working code rather than inventing new machinery.

---

## 2. What exists today — the fixed spine (this does not change)

This is the current ingestion pipeline. The proposal leaves it alone; that is the point of "the pipeline should not change per use case."

```d2
direction: right
classes: {
  new: { style: { fill: "#fff7ed"; stroke: "#ea580c"; stroke-width: 2 } }
}

text: {
  label: Source text
  shape: document
}
store: {
  label: store - embed and upsert
}
qdrant: {
  label: Qdrant (source text)
  shape: cylinder
}
extract: {
  label: extract - graph agent (LLM)
}
promote: {
  label: promote - single canonical writer
}
pg: {
  label: Postgres (entities, facts, causal)
  shape: cylinder
}
passes: {
  label: Post-promotion passes (hardcoded today)
  causal: {
    label: causal pass (conditional)
  }
  other: {
    label: gardener, decay, contradictions
  }
}

text -> store -> extract -> promote
store -> qdrant
promote -> pg
promote -> passes: best-effort
passes -> pg: propose then promote
```

Key facts about the spine: extraction is one neutral LLM pass; `promote` is the *sole* canonical writer (agents only ever write staging); and there is already **one conditional agent pass after promote** — the causal pass. That last box is the seam the whole proposal hangs on.

---

## 3. Proposed change 1 — the pass registry (composition boundary 1)

Today each post-promotion pass is a hardcoded call. We propose generalizing that into a **registry**: a list of passes, each with a `trigger / invoke / dispose` lifecycle the existing passes already have under different names. Adding a use case's processing becomes "register a pass," not "edit the pipeline."

```d2
direction: down
classes: {
  new: { style: { fill: "#fff7ed"; stroke: "#ea580c"; stroke-width: 2 } }
}

promote: {
  label: promote completes (canonical written)
}
registry: {
  label: Pass registry (NEW - the outer loop)
  class: new
  t: {
    label: trigger(ctx)?
  }
  i: {
    label: invoke agent (staging-only)
  }
  d: {
    label: dispose (deterministic promotion)
  }
  t -> i -> d
}
passes: {
  label: Registered passes
  causal: {
    label: causal pass (exists)
  }
  bridge: {
    label: bridge / audit pass (NEW)
    class: new
  }
  custom: {
    label: custom domain pass (NEW)
    class: new
  }
}
guard: {
  label: Shared discipline (already actor-parameterized)
  a: {
    label: actor identity
  }
  al: {
    label: tool allow-list (deny by default)
  }
  st: {
    label: staging-only writes
  }
}

promote -> registry: for each pass
registry -> passes: iterate
passes -> guard: every pass conforms
```

**Reuse vs build.** Reuse: actor identity, per-actor tool allow-list, staging-only writes, deterministic promotion — the seam was already exercised twice (`extraction_proposer`, then `causal_agent`). Build: the outer loop only.

**Honesty caveat.** The registry makes the *wiring* declarative. Each new pass still carries code — its own ML-service endpoint and prompt, and (if it emits a new kind of edge, as a bridge/audit pass does) its own staging table and promotion step. "A new use case is pure config" is not true; the pass *body* stays code.

---

## 4. Proposed change 2 — rule-bearing edge types (composition boundary 2)

Relation semantics as declarative data instead of hardcoded queries. Today exactly one rule is fully wired (exclusivity); one edge type is transitive (causal, but hardcoded); inverse is declared but inert; composition and symmetry do not exist. We propose a small **rule vocabulary on the relation-type row** plus **one generic walker** that reads it.

```d2
direction: down
classes: {
  new: { style: { fill: "#fff7ed"; stroke: "#ea580c"; stroke-width: 2 } }
}

vocab: {
  label: Edge-type rule vocabulary (on the relation-type row)
  excl: {
    label: exclusive (EXISTS - wired end to end)
  }
  inv: {
    label: inverse (declared but inert today)
  }
  trans: {
    label: transitive (NEW)
    class: new
  }
  sym: {
    label: symmetric (NEW)
    class: new
  }
  comp: {
    label: composition (NEW)
    class: new
  }
}
dispatch: {
  label: Generic rule-dispatching walker and validator (NEW)
  class: new
}
consumers: {
  label: Consumers
  contra: {
    label: contradiction detector (uses exclusive today)
  }
  chain: {
    label: chain queries (causal-only today)
  }
  cyc: {
    label: cycle and order checks
  }
}

vocab -> dispatch: read declared rules
dispatch -> consumers: apply per edge type
```

**Worked examples.** A `depends_on` edge = transitive plus acyclic, so it reuses the existing recursive chain-walker (today hardwired to causal edges) and gains cycle detection. A `family` edge = inverse plus composition (`parent_of` then `parent_of` gives `grandparent_of`) — inverse is already *declared* in the ontology, so what is missing is only the runtime that acts on it.

---

## 5. Proposed change 3 — corpus scoping (the assimilate-vs-compare toggle)

Today the system assimilates everything into one graph. To keep comparison corpora separate, `corpus_id` is threaded through the four places where entities currently fuse globally, with a same-corpus guard. This is the "keep them separable" prerequisite for cross-corpus.

```d2
direction: down
classes: {
  new: { style: { fill: "#fff7ed"; stroke: "#ea580c"; stroke-width: 2 } }
}

a: {
  label: Corpus A (code)
}
b: {
  label: Corpus B (standard)
}
scope: {
  label: corpus_id guard at the 4 fusion choke points (NEW)
  class: new
  r: {
    label: resolution candidate set
  }
  p: {
    label: word-prefix auto-bind
  }
  gd: {
    label: gardener centroid merge
  }
  cd: {
    label: contradiction detection
  }
}
pg: {
  label: One graph, two partitions - no cross-corpus fusion
  shape: cylinder
}

a -> scope: tagged corpus A
b -> scope: tagged corpus B
scope -> pg: same-corpus only
```

The four inner boxes are the four unscoped fusion paths verified in current code. Three of them fuse *before* any application guard is reached, so a database-level `corpus_id` is the last line of defence. Note the second box (word-prefix auto-bind) fuses on a first-token string match with no similarity check — the subtlest one.

---

## 6. Proposed change 4 — the cross-corpus use case, assembled

Now the first use case is *composed* from the pieces above: two corpus-scoped partitions, a bridge/audit pass (from boundary 1) that writes rule-bearing `bridge_edges` (boundary 2), an MCP surface the external agent drives, and a coverage matrix that tracks what has been checked.

```d2
direction: right
classes: {
  new: { style: { fill: "#fff7ed"; stroke: "#ea580c"; stroke-width: 2 } }
}

agent: {
  label: External audit agent
}
mcp: {
  label: MCP surface (NEW - approx 8 tools)
  class: new
  read: {
    label: search, traverse, find candidates
  }
  write: {
    label: assert connection
  }
}
a: {
  label: Corpus A (code entities)
  shape: cylinder
}
b: {
  label: Corpus B (rules)
  shape: cylinder
}
bridge: {
  label: bridge_edges (NEW) - reasoning, sources, corpus pair
  class: new
}
cov: {
  label: coverage matrix (NEW) - element x rule to verdict
  class: new
}

agent -> mcp: reads and asserts
mcp -> a: scoped read
mcp -> b: scoped read
mcp -> bridge: assert (staging then promote)
bridge -> cov: tracks coverage
```

`bridge_edges` reuses the causal-edge row shape wholesale (reasoning and source-references are mandatory, non-negotiable) but is its own table because a bridge spans two corpora and its endpoints are code/rule elements, not fact transitions. For the *decidable* rules, a deterministic checker (CodeQL/SARIF) seeds ground-truth edges; the agent only reasons about the *undecidable* remainder.

---

## 7. The hard core — the translation unit between graphs

The one piece most likely to be underestimated. The moment a code element's id is a compiler-graph symbol (SCIP/AST) rather than a Mnemo entity UUID, a bridge already spans *two graph systems* that update at different rates. The seam between them is where the genuine difficulty lives.

```d2
direction: right
classes: {
  hard: { style: { fill: "#fee2e2"; stroke: "#dc2626"; stroke-width: 2 } }
}

llm: {
  label: Mnemo graph (entity UUIDs, updates on ingest)
  shape: cylinder
}
code: {
  label: Code graph (SCIP or AST ids, updates on commit)
  shape: cylinder
}
bridge: {
  label: bridge_edges span both graphs
}
trans: {
  label: Translation unit (HARD CORE)
  class: hard
  idmap: {
    label: id mapping (UUID to SCIP symbol)
  }
  stale: {
    label: cross-graph staleness (either side changes)
  }
  cad: {
    label: update-cadence reconciliation
  }
}

llm -> trans
code -> trans
trans -> bridge: stable element_ref
```

A bridge can go stale because the *code* changed or because the *fact* it cites expired — two independent staleness sources. The proposal's answer is anchor-and-flag (never silently re-point), but the consistency model between the two graphs is an open design question, not a solved one.

---

## 8. How a use case is declared (the plugin)

Pulling it together: a use case is a plugin, closest in spirit to a Claude Code skill — **frontmatter carries the policy knobs, the body carries the agent guidance.** Two independent axes describe what a plugin contributes: *determinism* (declarative guidance vs executable maintainer) and *lifecycle* (on-demand vs scheduled).

```d2
direction: down
classes: {
  new: { style: { fill: "#fff7ed"; stroke: "#ea580c"; stroke-width: 2 } }
}

plugin: {
  label: Use-case plugin (NEW)
  class: new
  fm: {
    label: frontmatter - policy knobs (scope, merge policy, edge rules, relation vocab)
  }
  body: {
    label: body - agent guidance (mental model, golden rules, caveats)
  }
}
core: {
  label: Fixed core + registry + edge-rule vocabulary
}

plugin -> core: selects passes and declares rules (config)
```

**Safety boundary.** Guidance prose and relation vocabulary are user-authorable early. The identity/merge knobs ship as *curated presets* first (a bad threshold can fuse a whole graph), and write-discipline plus actor-pinning are **code-only, never plugin-configurable**. So the *safely* user-authorable surface in v1 is thinner than "any user-defined use case" — that is an honest limit, not the end state.

---

## 9. What must be proven first (the gate)

This architecture is a proposal, not a decision to build. It is gated on a separate empirical validation plan, because no amount of clean architecture rescues a semantic-match path that does not recall the right rule. The load-bearing bets, cheapest-to-falsify first:

- **E1 — behaviour-to-rule embedding recall** (bar: recall@5 >= 0.65 on >= 50 hand-labelled pairs). The flagship; a disproof here saves the whole design.
- **AGE sync health** and a **live cross-corpus fusion demo** (confirms which of the four paths in Part 5 actually fire).
- **E2 — LLM wrong-attribution rate** (valid references, wrong reasoning — structurally uncatchable).
- **E5 — CodeQL/SARIF coverage** of the decidable rules.

Code is the only use case with a deterministic oracle, so E1/E2 gate not just the code feature but the credibility of the whole primitive thesis.

---

## 10. Phasing

```d2
direction: right
classes: {
  new: { style: { fill: "#fff7ed"; stroke: "#ea580c"; stroke-width: 2 } }
}

gate: {
  label: Gate - E1 recall + live checks
  class: new
}
pa: {
  label: Phase A - corpus_id + guards + bridge_edges (hand-seeded, no external tool)
}
pb: {
  label: Phase B - pass registry + audit pass + coverage + MCP
}
pc: {
  label: Phase C - CodeQL/SARIF + deterministic code graph (largest, partly external)
}

gate -> pa: only if E1 passes
pa -> pb
pb -> pc
```

Phase A is end-to-end testable with hand-seeded data and no external tooling — it is the cheapest way to prove the write-query-expire round-trip before committing to the largest external piece (the deterministic code graph and its translation unit).

---

## Appendix — how this maps to the other docs

- The **fixed core + two boundaries** model is `01-*.md` Part 0.5.
- The **four fusion choke points** (Part 5) are `01-*.md` Part II rows 1/3/4/5 and were verified in current code.
- **bridge_edges reusing the causal-edge shape** is `00-*.md` V.2.
- The **decidable/undecidable routing** and the **never-emit-compliant** rule are the code-compliance adapter in `00-*.md` Part III — one worked instantiation, not the core.
- The **translation unit** (Part 7) is `01-*.md` Part IV, the named hard core.
