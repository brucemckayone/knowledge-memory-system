# Primitives, Control Surface & the Plugin Model — Living Scaffold

**Status:** Investigation / position doc — a *living scaffold*, not a build spec. No branch, no code, no migration ships with this. Sibling to `00-design-space.md`; where that doc works one use case (cross-corpus code compliance), this one works the layer underneath it.
**Date:** 2026-07 · **Base branch context:** `feat/cognitive-platform-v2`
**Provenance:** extends `00-design-space.md`; the current-code facts in Part I and the audit in Part II were re-verified against `feat/cognitive-platform-v2` by a four-agent read-only pass (2026-07-03), so the file:line cites here are current, not inherited from the design-space doc's older branch.

---

## Part 0 — The reframe (why this doc exists)

The larger goal is not "add a cross-corpus feature." It is **a set of primitives you can build memory systems on top of, for many different use cases** — cross-corpus code compliance being only the first.

The realization that forced this doc: **Mnemo's substrate already has a control surface. It is just hardcoded to one policy** — the assimilating, personal-memory behavior it was born with. Every place the system decides "merge these, resolve that, treat this disagreement as a contradiction" is a behavioral decision baked into code with no way for a caller to vary it. `corpus_id` from the design-space doc is not a feature; it is *one knob* (resolution/merge scope) on a board of roughly a dozen.

So this doc does three things:
1. **Catalogs the board** — a control-surface audit of the existing substrate (Part II): every mechanism, the policy it currently hardcodes, and the control axis it implies.
2. **Proposes the model that exposes the board** — the plugin model, sorted along a determinism spectrum (Part III).
3. **Names the hard core** — the translation layer between graph systems (Part IV), which the cross-corpus feature already depends on without naming it.

The empirical bets that gate the *code use case* (embedding recall, hallucination) live in the separate validation plan and are unaffected by any of this — see Part VI.

---

## Part 0.5 — The composition question, resolved by investigation (2026-07-03)

A review surfaced a fork this doc had silently resolved: the stated goal is *"build memory systems from primitives"* (composition), but the doc delivered *"configure one fixed pipeline"* (configuration). Two targeted read-only investigations of current `feat/cognitive-platform-v2` code settled it.

**Resolution: a hybrid, grounded in a subsystem that already works — the causal subsystem.** The core ingestion pipeline stays *fixed and neutral* (config, not reshaped — the pipeline should not change per use case). Composition happens at **two boundaries**, and *both are generalizations of the causal subsystem*, not greenfield:

**Boundary 1 — a pass registry (post-promotion agent passes).**
- The core `store -> extract -> promote` is fixed. Additional agent passes hang off the post-promotion seam. The **causal pass is a live instance**: conditional trigger (`shouldRunCausalPass` — cue words / fact-count / prior causal history), scope-bounded, invoked over HTTP to ml-services, writes via `propose_causal_edge -> applyCausalPromotion`, best-effort — never fails the epoch (`pipeline.ts:1052`; `causal-pass.ts`).
- Everything safety-relevant is already **actor-parameterized** — actor identity, tool allow-list, MCP config, staging-only writes, deterministic promotion. The seam has been **exercised twice** (`extraction_proposer`, then `causal_agent` reusing its machinery).
- **Missing only the outer loop:** each pass is a hardcoded call (`runCausalPass` at `pipeline.ts:1052`; gardener/decay/contradiction as counter-gated blocks in `extract()`). Generalizing "call `runCausalPass`" into "for each registered pass: if `trigger` then `invoke` then `dispose`" is a *one-abstraction refactor* — all four existing passes already have those three parts.
- **Honesty caveat:** the registry unifies *orchestration* only. Each pass still carries code — its own ml-services endpoint + system prompt, and (if it emits a new row type, as a bridge/audit pass does) its own staging table, migration, and promotion disposer. "A new use case is just data" is false; the *wiring* becomes declarative, the *pass body* stays code.

**Boundary 2 — a rule vocabulary on edge types.**
- Relation semantics as declarative data. **One rule is already fully wired end-to-end: exclusivity** — declared on `fact_predicates.is_exclusive` (`001_consolidated.sql:135`) plus cross-predicate `AUGMENTATION_GROUPS` (`exclusive-groups.ts`), and *enforced* by both the contradiction detector (`contradictions.ts:142-145`) and `createFact` supersession with a total-order tiebreak (`facts.ts:159-163`).
- **One structurally-transitive edge type exists — causal edges** — traversed by recursive CTEs (`causal.ts:801,914`; `impact.ts:544`) with cycle-safe path accumulators, but its "chain-forming" and "cause-precedes-effect" rules are **hardcoded per query/detector**, not declared on an edge-type row.
- `inverse_predicate` is **declared but inert** (consumed only by resolution anti-merge, never materialized). Relation **composition** (`parent_of . parent_of => grandparent_of`) and **symmetry** do not exist at runtime.
- **Net-new piece (small, well-shaped):** a declarative rule vocabulary — a few attributes on the relation-type row (`transitive`, `symmetric`, `acyclic`, composition rules) — plus **one generic rule-dispatching traversal/validator** that reads them, replacing the causal-only hardcoding. `depends_on` chains = the causal-chain walker re-pointed at a typed edge table; kinship = the exclusivity/inverse patterns extended with composition.

**The unifying insight:** the cross-corpus feature *and* the primitive layer under it are essentially **the causal subsystem generalized along two axes** — generalize the *pass* (Boundary 1), generalize the *edge-type rules* (Boundary 2). `bridge_edges` already commits to reusing the causal-edge row shape wholesale (V.2 of `00`). This bounds the risk: we are generalizing a subsystem that already works, not inventing one. A use case therefore = **fixed default pipeline + selected passes + declared edge-type rules + guidance** — configuration of the spine, composition at the boundaries.

This resolves the config-vs-composition fork and supersedes the "determinism spectrum" framing in Part III: the composition *mechanisms* are these two boundaries; the plugin *kinds* below are just how each boundary is configured.

---

## Part I — What the code re-verification established (build on facts, not the doc's older cites)

Four read-only agents checked the design-space doc's load-bearing claims against current code. Summary of what is now *known*, not assumed:

- **Today's behavior is near-total assimilation.** Two independently-ingested bodies of text fuse into one shared graph. The *only* stream-scoped anti-merge is `stream_participants` (mig `046_stream_participants.sql:34-41`), and it covers just the USER/ASSISTANT speaker anchors — it deliberately *bypasses* the resolver (`entities.ts:73` docstring; `:131-145` direct insert). Every subject-matter entity flows through the global resolver. So "keep corpora separate" is a genuinely new capability, and the design-space doc's premise ("core corpus assimilates = today's merge behavior") is confirmed true.
- **Four distinct, unscoped fusion paths exist** (Part II rows 1, 4, 5, 6). None are already scoped by stream or corpus. The subtlest is the word-prefix path, which auto-binds on a first-token string match with *no embedding gate* and *no arbiter escalation* on a single match.
- **The reuse primitives are real** — causal-edge `NOT NULL` reasoning/source invariant (`002_causal_graph.sql:124-125`), `edge_source_refs` (`010_source_ref_index.sql:18-19`), flag-don't-repoint staleness (`044_causal_pass.sql:20-22,60-62`; `causal.ts:568,1101`), pure-planner/single-writer/idempotent `promote()` (`promotion.ts:91,479,442-443`), corroborate-or-insert (`facts.ts:299-301`), deny-by-default double-enforced actor allowlist (`causal-agent.ts:1402-1406,1504,1587-1595`; `graph-mcp.ts:43`).
- **The external MCP server is dead**; only its stdio transport shell is salvageable (`mcp-server/src/index.ts:46-49` advertises empty inputSchemas; `.mcp.json.disabled`; its 6 endpoints 404 against the current platform). The actor/allowlist reuse points for a new `audit_agent` are real and current.
- **One live safety gap:** `pi-agent-bridge.ts` trusts a *client-supplied* `actor` (`:137,168,175`), validated against `VALID_ACTORS` but not route-pinned. Any new integration route must derive/pin the actor server-side.

---

## Part II — The control-surface audit (the spine)

Each row is a mechanism whose policy is currently frozen. The **control axis** is the knob a plugin would set; the **varies for** column is the evidence that at least one real use case wants it different (which is what makes it a knob and not a constant).

| # | Mechanism | Current hardcoded policy | Current cite | Control axis | Varies for |
|---|---|---|---|---|---|
| 1 | Entity resolution scope | Global candidate set; pgvector by embedding + optional type only, no scope predicate | `entities.ts:361,401` | Candidate-set scope: global / per-corpus / per-namespace | Cross-corpus needs per-corpus; chat wants global |
| 2 | Resolution thresholds | Fixed 0.92 auto-merge / 0.75 LLM-verify | `entities.ts:235-236,408,426` | Per-use-case thresholds | Compliance may want *no* auto-merge; chat wants aggressive |
| 3 | Mint/create dedup key | `lower(name) + type`, no scope | `promotion.ts:264-268`; `entities.ts:246-256` | Dedup key + scope | Same as (1) |
| 4 | Word-prefix binding | Single first-token word-prefix match auto-binds, **no embedding gate, silent** | `promotion-plan.ts:319-321,416-426` | Whether/how prefix binding is scoped + gated | The sneakiest fusion path — likely off entirely for separated corpora |
| 5 | Gardener merge (centroid) | Merge on centroid similarity, enumerated globally | mig `003_graph_meta.sql:40-51`; `merge-scorer.ts:437,761-801`; `entities.ts:708`; `graph-meta.ts:163-193` | Merge policy (aggressive/conservative/off) + scope | Comparison corpora must not centroid-merge across the boundary |
| 6 | Contradiction handling | Same subject+predicate, different object -> a contradiction (flagged, later resolved) | mig `011_contradictions.sql:63`; `contradictions.ts:105-149,132-139` | Contradiction stance: **resolve** vs. **record as finding** | **The key one** — cross-corpus and fiction both want record-as-finding, not resolve |
| 7 | Fact identity / dedup | Active-triple partial-unique; 23505 -> corroboration | mig `037`; `facts.ts:299-301` | Dedup key / corroboration policy | Mostly stable; scope-sensitive if corpora share predicates |
| 8 | Retrieval scope | Qdrant stream filter is opt-in, defaults OFF (cross-stream) | `qdrant.ts:213,258` | Retrieval scope + cross-scope-allowed | Comparison reads want scoped-by-default |
| 9 | Extraction stance | Neutral extraction in the pipeline | (pipeline) | Where the caller's lens is injected | Design-space rule: neutral within-corpus, opinionated at the bridge |
| 10 | Write discipline / actors | propose->promote single writer; deny-by-default allowlist; staging-only by exclusion from audit CHECK | `causal-agent.ts:1402-1406,1504`; mig `009_audit_trail.sql:47-50,92-95` | Mostly a *fixed primitive*, not a knob — but new actors + route-pinning are per-integration | New `audit_agent`; the `pi-agent-bridge` actor-pinning gap |
| 11 | Staleness / invalidation | Flag, never auto-repoint | `044_causal_pass.sql:20-22`; `causal.ts:568` | Invalidation policy on source change | Feeds directly into the translation-layer staleness problem (Part IV) |
| 12 | Agent guidance channel | Finite `content_type` enum switch, no free-text | `graph_agent.py:762-777` | The seam a markdown plugin opens (data-driven, not enum) | Every use case wants its own guidance |
| 13 | MCP teaching primitives | `capabilities: { tools: {} }` only — no instructions/resources/prompts | `graph-mcp.ts:35` | Empty slots for a plugin's instructions/vocab/playbook to fill | Every use case |

Rows 1, 3, 4, 5 are the same underlying axis — **scope of identity** — surfacing in four different places. That is why "add `corpus_id`" is not a one-line change: the scope knob has to be threaded through four choke points, and the DB constraint is the last line of defence behind three of them.

---

## Part III — The plugin model (two axes, configuring the two composition boundaries)

A "plugin" is not one thing, and it is *not* a single "determinism spectrum" (an earlier framing here conflated three different axes — corrected). It is a bundle of behaviors attached to a corpus / use case, described by **two independent axes**: *determinism* (declarative/LLM ↔ executable) and *lifecycle* (on-demand ↔ scheduled). Each behavior configures one of the two composition boundaries from Part 0.5 (a pass, or an edge-type rule). The mental model closest to home: **a use-case plugin is to Mnemo what a skill or subagent is to Claude Code** — frontmatter carries the declarative policy, the body carries the guidance the agent reads.

### (a) Reasoning-stance plugins — markdown, non-deterministic, on-demand
How the agent *thinks about* the corpus over the graph.
- **Frontmatter = the knobs** from Part II: resolution scope, merge policy, thresholds, contradiction stance, retrieval scope, relation vocabulary.
- **Body = the guidance**: the mental model, the when-to-bridge golden rules, the epistemic caveats ("never emit compliant").
- **Grounding:** this opens an existing seam, not a new subsystem. The guidance channel today is a *hardcoded* enum switch (`graph_agent.py:762-777`); the MCP surface has *empty* slots for instructions/resources/prompts (`graph-mcp.ts:35`). A markdown plugin is "load these from a file instead of hardcoding them."

### (b) Scheduled-maintenance plugins — declarative schedule, deterministic *or* LLM body
"Each night, do X." A use case declares its own upkeep cadence.
- Examples: re-ground stale citations, sweep for new bridges, recluster *only* the active corpus, run the gardener scoped to one corpus.
- This is a genuinely separate axis: not *what* the agent does on demand, but *when* upkeep fires. Today the gardener and causal pass run global and hardcoded; the plugin idea lets a use case own its cadence.
- **Grounding:** low-risk and close at hand — the repo already carries a `.claude/scheduled_tasks` mechanism and this environment has routines/cron. Small step.

### (c) Deterministic graph-maintainer plugins — code, keeps a whole graph alive
The codebase-graph-alongside idea. Not a one-shot import — a live tree-sitter / SCIP / CodeQL graph kept in sync with the code, co-resident with Mnemo's LLM-built entity/fact/causal graphs.
- This is the part that resists markdown: you cannot express a code-graph integration declaratively. It is executable, and it is the largest net-new engineering (the design-space doc, Part VII.5, agrees).
- Most use cases have *no* such plugin (research, fiction, learning have no oracle). Code is the outlier. That inversion is the tell that the markdown layer is the general case and code is the special one.

### (d) The translation unit between graph systems — substrate, not a plugin kind (see Part IV)
How a bridge spans graphs with different node types, id schemes, and update cadences. This is **not** a plugin kind — it is the substrate everything else sits on once more than one graph is alive. Listed here only to retire it from the plugin taxonomy; it lives in Part IV.

**Two axes, not one spectrum (corrected):** *determinism* — (a) declarative/LLM guidance ↔ (c) executable/deterministic maintainer; and *lifecycle* — on-demand ↔ (b) scheduled. A capability is a point in that 2-D space (a nightly deterministic re-ground is "scheduled × deterministic"), not a single low-to-high ranking. Engineering cost rises with the *determinism* axis (executable > declarative), and both (a) and (b) configure Boundary 1/2 from Part 0.5.

---

## Part IV — The translation layer (the hard core)

The cross-corpus doc already depends on this — it just hides behind one innocent word. `00-design-space.md` V.5 states that `element_ref` must be **"the deterministic code-graph node id (AST-hash / SCIP symbol id), *not* the canonical entity UUID."** The moment you accept that line, a cross-corpus bridge is *already* spanning two different graph systems — Mnemo's UUID graph and the code's SCIP graph — and *something already has to translate between them.* The `bridge_edges` table is the primitive form of this translation unit; the general form is the seam between any two co-resident graphs.

Three hard problems concentrate here, and they are the most likely to be underestimated:

1. **Id mapping.** A stable correspondence between a Mnemo canonical entity id and a foreign graph's node id (SCIP symbol, AST hash). Must survive mutation on both sides.
2. **Cross-graph staleness — from either side.** The code graph updates on every commit; the LLM graph updates on ingest. A bridge between them can go stale because the *code* changed *or* because the *fact* it cites expired. The flag-don't-repoint mechanism (row 11) handles one direction; a co-resident code graph adds a second staleness source that mechanism was not designed for.
3. **Update-cadence reconciliation.** The two graphs breathe at different rates. What is the consistency model when they disagree at a moment in time?

This is a known-hard problem (graph federation / multi-store consistency). **Recommendation:** pull the translation layer up as a *first-class* investigation question, not a schema footnote. It is the piece where "build on a false premise" is most likely to bite, because the cross-corpus feature quietly assumes it works.

---

## Part V — Safety boundary (footgun containment)

"User-defined plugins" is the goal, but the knobs are not all equal:

- **Author-your-own early:** prompts, guidance body, relation vocabulary, epistemic caveats. Low blast radius.
- **Curated presets first, raw values later:** the identity/merge knobs (rows 1-5). A user who sets auto-merge to 0.5 fuses their own graph. Start the plugin *selecting from vetted presets* ("assimilating," "comparative," "append-only") and open individual raw knobs only as each proves out.
- **Not a preference — a security surface:** write discipline and actor pinning (row 10). These are not plugin-configurable. The `pi-agent-bridge` client-supplied-actor gap (Part I) means any new integration route must pin the actor server-side regardless of what a plugin says.

The principle: **declarative-and-safe is user-authorable; behavior-changing-and-risky is preset-gated; safety-critical is code-only.**

---

## Part VI — Relationship to the validation plan (two parallel tracks)

This doc is the **architectural track**. It does not de-risk the **empirical track**, and neither replaces the other:

- **Empirical bets** (from the validation plan) gate the *code use case* no matter how clean the control surface is: E1 behaviour<->rule embedding recall (>=0.65 recall@5), E2 Haiku wrong-attribution rate, E5 CodeQL/SARIF coverage. A perfect plugin model over a semantic-match path that recalls 0.3@5 is still a dead feature.
- **Architectural track** (this doc): the control surface, the plugin model, the translation layer.
- **Live checks that serve both:** AGE sync health, and the cross-corpus fusion demonstration (which of the four paths actually fires on realistic data — directly informs Part II rows 1/4/5).

The two run in parallel; the phase gate for the *code use case* is still the empirical one.

---

## Part VII — Open questions / to think about (living — add freely)

1. **Second use case as forcing function — [sharpened by Part 0.5].** Config vs composition is now resolved (fixed core + two composition boundaries). The fiction pass has a sharper job: does a no-oracle use case (story-bible vs. manuscript) fit by *configuring the spine + selecting passes + declaring edge-type rules*, or does it demand a pipeline shape the two boundaries can't reach? If it fits, the hybrid holds; if not, we learn the boundaries are insufficient before building. Fiction is the right probe precisely because it shares contradiction-as-finding but has *no oracle*. **Still open: which use case; the fork itself is closed.**
2. **corpus_id: bespoke column or first instance of a general scope primitive?** If rows 1/3/4/5 are all the "scope of identity" axis, maybe the knob is a general `identity_scope`, and `corpus_id` is one value.
3. **How far to expose raw knobs vs. presets, and on what timeline?** (Part V.)
4. **Translation-layer id scheme** (Part IV.1) — AST-hash vs. SCIP symbol vs. a Mnemo-side mapping table.
5. **Cross-graph consistency model** (Part IV.3) — what happens when the code graph and the LLM graph disagree at a point in time.
6. **Do maintenance plugins (b) carry deterministic bodies, LLM bodies, or both?** And how do they compose with the single-writer promote() discipline?
7. **Does the plugin registry live in-repo (like skills) or user-space?** And what is the loading/validation story (a bad plugin should fail closed).
8. **Is there a fifth plugin kind** we have not named yet? (The spectrum is a scaffold, not a closed set.)

---

## Appendix — Relationship to `00-design-space.md`

`00-design-space.md` is one worked instantiation (code compliance) of the general capability. This doc is the layer under it. Where the two overlap:
- Its "domain-agnostic core + thin adapters" (Part 0) *is* the plugin model here — adapters are plugins.
- Its `corpus_id` (V.1) is row 1/3/4/5 of the audit here.
- Its `bridge_edges` (V.2) is the primitive form of the translation unit (Part IV).
- Its MCP surface (V.4) is the *runtime* half of the integration layer; the plugin model here is the *config/policy* half it did not cover.
- Its deterministic code graph (Part IV, V.6) is plugin kind (c), elevated from one-shot import to a live co-resident graph.
