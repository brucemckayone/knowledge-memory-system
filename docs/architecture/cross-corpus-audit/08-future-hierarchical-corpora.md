# Design Consideration — Hierarchical / Overlapping Corpora (the shared-anchor parent)

**Status:** Design consideration, recorded on request. **Not v1, not committed.** Captured so the core model is checked against it and so v1 does not paint us into a corner. It may prove a bad idea; it is recorded here honestly, with its risks, because it is aligned with what we are building and worth designing *toward*.

---

## The idea (as floated)

Corpora are not a flat list of tags. They form a graph. Certain corpora are **anchors** ("gods") — a codebase, a manuscript, a branch. There is **a pantheon, not a single god**: many anchors coexist, and you **explicitly declare which streams anchor to which god(s)**. A stream (an individual agent chat) **blends into its anchor** on the entities they share, but stays separate from other streams. Two streams are related not by comparing them pairwise, but **through** the anchor entities they both touch. The anchor is a "god object": a single path to all related streams, and the connective tissue for how those streams relate.

**Anchors nest into lineages.** A god can itself be a stream to a higher god — a branch is an anchor to its chats *and* is itself anchored to the codebase (chat → branch → codebase). So the structure is a DAG, and blending up a single lineage transitively relates the whole chain. Git framing: streams are like branches off master; unlike git, they don't merge back by default, and their relatedness runs through the shared anchors.

Refinement from the original floating (which had children *comparing* to the parent): children **blend** with the parent, and the blend is what makes the parent an anchor. Blend was judged likely more effective than comparison for relating same-domain children.

---

## The unifying model it reveals

The most valuable thing this surfaced: the **assimilate-vs-compare knob is not a per-corpus flag, it is a per-edge policy on a corpus graph.**

- **Assimilate edge** = blend up (child into parent; same domain; fuse on shared anchors). This idea.
- **Compare edge** = bridge (cross-domain; reasoned, sourced links; no fusion). The cross-corpus feature (`04`).
- **The unified fusion rule:** *your fusion candidate set is the transitive closure of assimilate edges (you + your ancestors); compare edges never contribute fusion candidates, they get bridges instead.*

This makes three things one model:

| Case | Corpus graph | Behaviour |
|------|--------------|-----------|
| Today (flat, "blend everything") | one root, everything assimilates up to it | global fusion — current default |
| Cross-corpus v1 (`04`) | two separate roots + one compare edge | no fusion; bridges between them |
| Chats-in-a-codebase (this doc) | codebase root, assimilate edges down to each chat; optional compare edge across to a standard | chats blend to the codebase, stay separate from each other, and the codebase can still be compared to MISRA |

The right edge policy is chosen by a single question: **same-domain shared referent (blend) or cross-domain (bridge)?** A chat about the code and the code are the same thing, so blend is correct. Code and a rulebook are different things, so bridge is correct.

---

## Why it is attractive

- **O(N), not O(N²).** Comparing N children pairwise needs an active comparison pass over every pair. Blend-to-anchor blends each child up once; relatedness falls out of shared nodes for free. The parent *is* the join index — "which chats touched `foo`?" is one query on `foo`.
- **Surfaces disagreement for free.** Two chats with conflicting claims about the same `foo` produce a contradiction *on the shared node* automatically — no comparison pass needed.
- **Matches reality.** A chat about code and the code are the same domain; fusing them is correct behaviour, not a workaround.
- **Unifies rather than bolts on.** It is the assimilate policy we already have, scoped along parent edges instead of globally. It does not add a subsystem; it generalises the scope primitive from a flat tag to a graph (answering the open question parked in `01` VII.2: scope is a graph, and each edge carries the blend/compare policy).

---

## The honest risks (why it might be a bad idea)

- **God-object bloat.** Shared nodes accumulate everything from every child. Hub nodes are expensive to traverse, and the gardener/centroid logic misbehaves on giant nodes.
- **Ubiquitous anchors are low-signal.** Two chats "related" only because they both touched a utility used everywhere is noise. Relatedness-through-anchor needs **specificity weighting** (share a rare entity = strongly related; share a ubiquitous one = barely). Without it, the god object relates everything to everything.
- **Same-domain only.** You cannot blend a standard into a codebase. This *complements* cross-corpus bridges; it does not replace them.
- **Directional fusion is new machinery.** "Blend up, not sideways" means the fusion candidate scope must follow the ancestor chain, not just "my corpus." A clean generalisation of the guard predicate (`corpus_id = $c` becomes `corpus_id IN (self + assimilate-ancestors)`), but a real change.
- **Provenance must survive the blend.** To keep per-chat views ("what did chat A say about `foo`?") after the entity fuses into the shared node, facts must stay attributed to their originating child even when their subject entity is the parent's. Mostly already true (facts carry sources), but it must be explicit.
- **Contradiction accumulation.** Blending surfaces disagreements as contradictions on the hub. Good for discovery, but the god object accumulates unresolved contradictions that need a policy.
- **The sharp one — blending into two *independent* gods is a trap.** A pantheon is fine; nesting into a lineage (chat → branch → codebase) is fine, because that is a single blend-chain. The trap is one stream blending into two **independent** anchors that both have a `foo`: then child-`foo` = anchor-A-`foo` = anchor-B-`foo`, transitively fusing two unrelated gods' `foo` into one node (two codebases' `foo` are different functions). **Resolution (per-node, not per-graph): a stream blends up **one lineage** (its direct anchor, which may itself be anchored upward), and *compares* (bridges) to any additional *independent* gods.** Blend up one chain; bridge across to the rest. This preserves "a stream may be relevant to more than one corpus" without fusing the independent anchors.

---

## Forward-compatibility (so v1 does not preclude it)

v1's flat `corpus_id TEXT` is compatible with this. When/if we build it:
- Add a `corpus_relationships` table (`parent_id`, `child_id`, `edge_policy ∈ {assimilate, compare}`) *without touching* `corpus_id`.
- Generalise the fusion candidate-scope predicate from `corpus_id = $c` to `corpus_id IN (self + assimilate-ancestors($c))`. The v1 guards are a special case (no relationships ⇒ scope is just self).
- Compare edges already have a home: they are the cross-corpus bridges.
- The composite-FK backstop and all four fusion guards keep working unchanged; the hierarchy only *widens* the candidate set along assimilate edges, it never removes the "different corpus does not fuse" rule for sibling/compare edges.

**The one design axis to preserve now, for free:** keep the distinction between *fuse (same-domain shared referent)* and *bridge (cross-domain)* clean and explicit in v1's vocabulary, so that when edges gain policy, "assimilate" and "compare" are already the two words we use.

---

## Open questions to resolve if/when we build it

1. Blend into at most one parent (+ compare to others), or allow multi-parent blend with some anti-transitive-fusion guard? (Lean: single blend-parent.)
2. Specificity weighting for anchor-based relatedness — how is a rare shared anchor scored above a ubiquitous one?
3. Contradiction policy on hub nodes — resolve, or record-as-finding, per the same assimilate/compare framing?
4. Per-child views — confirmed to work via fact provenance even after entity fusion; verify no read path assumes entity-level corpus scoping.
5. Does a child ever "graduate" or detach from its parent, and what happens to the blended entities if so?
6. God-object mitigation — hub-size limits, or is the sparse-truth design enough?

---

## Bottom line

The blend-to-anchor hierarchy is genuinely more effective than pairwise comparison for relating *same-domain* children, and it makes the overall design *more* coherent by revealing that assimilate-vs-compare is a per-edge policy on a corpus graph, with today's flat behaviour and v1's cross-corpus both as special cases. Its real dangers are hub bloat, the need for specificity weighting, and the multi-parent fusion trap. It is explicitly **not v1**, but v1 is forward-compatible with it, and the one thing to protect now is keeping the *blend vs bridge* distinction clean in the vocabulary.
