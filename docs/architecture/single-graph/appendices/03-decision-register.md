# Appendix 3 — The decision register (arc docs 00–19)

Docs 00–19 are the design and specification era of the cross-corpus arc. **Doc 39, the synthesis this
project has been operating from, declares its basis as "docs 20–38" and contains zero mentions of the
register below.** So D1–D10 were being cited without ever having been read. This appendix exists so that
cannot happen again.

---

## A.1 `04-hardened-spec.md` §1 — the closed register (D1–D10)

`04` supersedes the decision-level content of `00`–`03`. Its closing tally: *"of the 15 register
questions, 13 are resolved; the 2 that remain open (Q12, Q13) are Phase-C empirical bets that do not
block v1."*

| ID | decision | still live? |
|---|---|---|
| **D1** endpoint identity | `element_ref = uuidV5(scheme\|corpus\|symbol)`. Code/rule elements are **bare catalog rows**, **never `entities`** — "zero fusion surface by construction". `bridge_edges` endpoints are polymorphic UUIDs validated at disposal against the catalogs. Behaviour/rule embeddings live in a dedicated table the parser fills eagerly | **REVERSED IN SHIPPED CODE.** `corpus-ingest.ts` writes elements as `entities` rows; doc 19 §2 calls the catalogs "superseded for ingest". The `uuidV5` derivation and polymorphic-endpoint shape survive; the anti-fusion *principle* is reusable, the *mechanism* was abandoned. **And the hazard D1 designed away actually fired — see C1** |
| **D2** AGE authority | Ratified, verdict-scoped: **no fusion or verdict decision is ever sourced from an AGE traversal**; Postgres is sole source of truth; bridges do not sync to AGE in v1. Caveat kept: graph-anchored recall fallback walks AGE and fails silently on unsynced data | **LIVE and reinforced** — doc 39 §3.5 independently found AGE untrustworthy (both sync triggers bare-catch) |
| **D3** derived state | Query-time default for inverse / symmetric / single-hop composition / carry-forward. Guards: `fanout_cap` NOT NULL with a low default; low `max_depth` over an unweighted store; **recursive composition forbidden at query time** | **LIVE as a rule, never built.** The `fanout_cap`/`max_depth` guidance is directly relevant to the `maxPairs = 100_000` silent truncation |
| **D4** inter-pass contract | Passes commit **independently**, communicate via **committed reads** (no shared tx). Every `dispose` must be replay-idempotent **including aggregates** — corroboration scoped to `invocation_id`/staged-row identity. A downstream pass **may not** make a deterministic decision off a prior pass's mutable aggregate | **LIVE and BUILT** — mig 051. Binding when a 2nd pass lands. Note the bridge path kept a weaker single-slot form |
| **D5** word-prefix binding | **Adopt A4 verbatim.** `assimilating` corpora keep the rule-3 single-match bind; `comparative` corpora replace **only** that branch with **arbiter escalation** — never an embedding gate, never touching rule-4. Rationale: an embedding gate is illegal in the pure/DB-free planner (breaks the order-independence litmus); the same line refs power rule-4 fresh-cluster folding; global removal regresses genuine short-form→full-name coreference | **LIVE, BUILT** (mig 055 + `corpus-policy.ts`), and the single most reusable decision for many-graphs-per-user — though `setCorpusPolicy` has no production caller, so `comparative` is unreachable |
| **D6** `no_violation` provenance fork | **Fork by provenance, not blanket.** Sweep-level "checked, nothing worth keeping" → coverage-only. **LLM-reasoned `satisfies`** → emit a `satisfies` bridge row **and** stamp the coverage cell. Add a `not_applicable` bin so the "satisfied nowhere" anti-join is single-table | **PARK — compliance-specific, but BUILT.** `audit-ledger.ts` ships the 5-value `CoverageVerdict`. Contradicts `04` §2's own "coverage is deferred" |
| **D7** exclusivity | Model exclusivity as `exclusive_group_id` (**not a bool**); preserve `AUGMENTATION_GROUPS`. A bool regresses supersession | **LIVE as a constraint on future edge-rule work; unbuilt.** Orthogonal to isolation |
| **D8** carry-forward | Query-time JOIN across runs; **no verdict copying**. Avoids detachment if an `element_ref` ever moves | **PARK** — only meaningful with re-audit runs |
| **D9** corpus immutability | The composite-FK backstop is correct (incl. `MATCH SIMPLE` on nullable `object_entity_id`). **Add** a BEFORE-UPDATE trigger rejecting any change to `corpus_id`. Closes the silent bypass where a bulk `UPDATE … SET subject_entity_id=X, corpus_id=<X's>` satisfies the FK and skips `entity_merges` | **LIVE, BUILT, load-bearing.** Mig 052 applies the trigger to entities, facts **and `causal_events`** — a third table beyond what D9 names (and one no code writes) |
| **D10** Q12/Q13 | **Genuinely open, deferred to Phase C.** Working assumption: anchored-snapshot consistency (a bridge is "true as-of `(commit, model_version, valid-time)`"). SCIP-symbol stability across real file moves is a new empirical bet | **MOOT.** Phase C never started; nothing references SCIP/`onCodeChange` |

## A.2 `03-detailed-plan.md` Part A — cross-cutting decisions A1–A5

These are the inputs D1–D10 ratified or killed; they carry rationale `04` compresses away.

| ID | decision | status |
|---|---|---|
| **A1** | Endpoint identity: **"the headline hole"**. `00` V.2 (bare catalog rows, no FK) contradicts `00` IX.1 (canonical entities, UUID FK). Proposed: endpoints always UUID + `kind` discriminator. Sub-decision left open: are code elements *also* run through the entity resolver, or bare rows? — because **"the E1 semantic-recall path needs the code side to be embedded"**, so A1 decides *where the semantic-recall substrate lives* | Resolved into D1 → then reversed by shipped code. The sub-decision was answered **"also entities"** in practice, the opposite of D1 |
| **A2** | AGE is a **non-authoritative hint-index**. `corpus_id` can only ride as a *node* property, so every `MATCH (a)-[:REL]->(b)` silently walks across corpora unless it self-filters `WHERE a.corpus_id = b.corpus_id` | LIVE → D2. **The self-filter requirement is a concrete, still-unbuilt obligation** for anyone using AGE with multiple graphs |
| **A3** | Derived state: query-time by default, materialise only behind a maintainer with `derived_from` provenance + an all-parents-active re-check | LIVE → D3 |
| **A4** | Behaviour knobs are **policy presets, not global constants** — ship as `assimilating`\|`comparative`, **"not as `if (corpus)` branches sprinkled through the code"** | LIVE → D5; BUILT. **The template for many-graphs-per-user policy** |
| **A5** | **Hallucinated *reasoning* has no structural gate.** FK/existence validation catches hallucinated *ids*; it does not catch valid endpoints + wrong attribution (prior art 1.8–10.3%/project). Levers: `model_version` + `source_commit`/`source_ast_hash` anchoring + **mandatory human review in iteration one**. *"Accept this as a stated limit; do not pretend a CHECK covers it"* | **LIVE and vindicated** — the whole doc 09/15/16 arc is this limit playing out. Note the anchor columns A5 depends on are **never written** (Appendix 1, Table 3) |

## A.3 `03` Part C — the open-questions register Q1–Q15

**R** resolved · **S** sharpened · **O** still open at time of writing.

| Q | question | then | closed by | now |
|---|---|---|---|---|
| Q1 | Endpoint identity: entity-UUID-FK vs external id | O | D1 | Superseded — elements ARE entities |
| Q2 | Are code elements *also* embedded entities, or bare rows? | O | D1 (bare rows) | **Answered the other way in code** — see C1 |
| Q3 | AGE authority under multi-corpus | S | D2 | LIVE |
| Q4 | Derived edges/coverage: materialise vs query-time | S | D3 | LIVE (unbuilt) |
| Q5 | Same-epoch inter-pass visibility | O | D4 | LIVE (binds when a 2nd pass lands) |
| Q6 | `is_exclusive` generalisation (bool vs group-id) | S | D7 | LIVE (unbuilt) |
| Q7 | Word-prefix: scope vs disable | S | D5 | LIVE, BUILT |
| Q8 | Contradiction stance: resolve vs record-as-finding | R | *"falls out for free"* — cross-corpus entities are distinct so the self-join never fires across corpora | LIVE, BUILT (guard #4). **But only 1 of 4 detectors got the corpus predicate** |
| Q10 | Does `satisfies` emit a bridge row or coverage-only? | O | D6 | PARK (built as a 5-value enum) |
| Q11 | Re-audit carry-forward: copy vs JOIN-at-report-time | O | D8 | PARK |
| Q12 | Cross-cadence consistency model | O | D10 — remains open | MOOT |
| Q13 | Empirical SCIP-symbol stability across file moves | O | D10 — remains open | MOOT |
| Q14 | `checker_unavailable` fall-through to LLM | O | `04` §2 calls the bin *"vacuous with no checker until Phase C"* | MOOT; bin exists dormant |
| Q15 | Global vocabulary leakage + per-corpus `is_exclusive` override | S | Accept vocabulary sharing for v1; per-corpus override deferred | **LIVE and relevant** — with many graphs per user, `fact_predicates`/`entity_types` stay global. **The one deliberate cross-graph channel** |

`03` Part C notes two brand-new holes the exercise surfaced (Q5, Q13) and **one doc contradiction found:
Q1**.

## A.4 `19-concept-layer-design.md` §4 — concept decisions D-C1…D-C7

| ID | decision | status |
|---|---|---|
| **D-C1** | Concepts = `entities` rows with `entity_type='concept'` ("concept resolution IS entity resolution"); reuses `mergeEntities`/gardener wholesale | Mechanism BUILT; **purpose DEAD as retrieval.** The "reuse entity resolution for a second node class" pattern survives |
| **D-C2** | All concepts live in **one reserved corpus `_concepts`**, so concept merge is native under the same-corpus guards — no fusion-guard surgery. Flagged "open for sign-off" | BUILT. **A reusable pattern for a shared-vocabulary graph alongside isolated per-purpose graphs — and simultaneously a cross-graph read leak (Appendix 1, Table 4)** |
| **D-C3** | exhibits/addresses = `bridge_edges` entity→entity, **not facts** — because mig 052's composite FK forbids a fact crossing corpora | **LIVE as the general rule: cross-graph links must be bridges, never facts.** BUILT |
| **D-C4** | Two relations: `exhibits` (code→concept), `addresses` (rule→concept) | BUILT; domain-specific → PARK |
| **D-C5** | `reasoning` + `source_references` stay **non-negotiable** on exhibits edges | LIVE — CHECK-enforced |
| **D-C6** | Concept extraction is a Haiku pass, may share the authoring call | BUILT; value unproven |
| **D-C7** | JOIN recall **augments, does not delete**, cosine `recallAcrossCorpus` | Decision inverted by outcome — the JOIN lost, cosine is the engine |

## A.5 `00-design-space.md` Part I — settled framing 1–8

| # | framing | status |
|---|---|---|
| 1 | **Partition by `corpus_id` on the canonical tables**, reusing the `stream_participants` anti-merge mechanism. Chosen over overloading `stream_id`, and over **separate databases "which would make the comparison — the whole point — hard"** | LIVE. **The explicit rejection of separate DBs is the key precedent for "many graphs per user, same store"** |
| 2 | **Durable cross-corpus bridge edges, not ephemeral per-run reports.** *"Findings persist, accumulate, and are the product; the report is a query over them"* | LIVE — reusable as the mechanism for explicitly relating separate graphs |
| 3 | **Neutral within-corpus extraction; opinionated cross-corpus bridges.** Base graphs stay reusable and objective; the caller's lens lives only at the bridge layer | LIVE — a strong constraint on any per-purpose-graph design |
| 4 | **Code-up audit direction** (walk the code, find governing rules) | Domain-specific → PARK. Doc 09 §11 showed the direction distinction was empirically load-bearing |
| 5 | **The external agent self-adjudicates; Mnemo stores the verdict.** *"Mnemo does not reason about the use case — it enforces write discipline"* | LIVE as a division of labour |
| 6 | Retrieval pipeline: coarse recall (symbolic join ∪ semantic search) → LLM adjudication → durable bridge → cheap traversal | **DEAD as specified** — the semantic leg lost to lexical (doc 18), the symbolic-JOIN leg lost to dense embedding |
| 7 | Non-goals (a–e) | Domain-specific → PARK |
| 8 | **Two modes of connection-making, one tool surface:** systematic sweep (coverage-tracked) and free exploration (agent roams, asserts anything worth asserting). *"The graph is the agent's reasoning surface, not just an output store"* | DESIGNED-ONLY. **The free-exploration idea is the least-tested in the arc** and the one doc 39 §5.3 partially bears on — but that was measured on a factless substrate, so it is [U] |

`00` Part IX's open questions 1–7 were folded into `03` Part C. One dissolved outright: **one-vs-many
reference corpora** — *"the architecture is N-corpora native; 'MISRA-only vs multi-standard' is just
data, not a design decision."*

## A.6 `05-preconditions.md` — Phase 0 readiness register PC-1…PC-8

| ID | item | gate | exit status (2026-07-09) |
|---|---|---|---|
| **PC-1** | Migration drift — live DB can lag repo | Blocker | ✅ verified; 3 non-idempotent migrations filed as `nmemo-ved` P3 |
| **PC-2a** | AGE can silently fail to sync | Blocker (verify) | ✅ localtimestamp-clean, AGE populates (1067 nodes). **Superseded — doc 39 §3.5 finds AGE untrustworthy again.** PC-2a verified *population*, not *fidelity* |
| **PC-2b** | AGE sync fails *invisibly* (bare-catch WARNING); edge-`SET` silently dropped | Should-fix | **Not closed** |
| **PC-2c** | Graph-anchored fallback returns `[]` silently when AGE unsynced | Should-fix | **Not closed** |
| **PC-3** | Corroboration count inflates on epoch-replay; **test only checks row-set** | **Blocker** — elevated because Phase A clones corroborate-or-insert | ✅ fixed = **migration 051**, 5/5 count-stability tests green |
| **PC-4** | Client-supplied `actor` validated but **not route-pinned** (anti-spoof gap), `pi-agent-bridge.ts:137,168,175` | Should-fix | **DEFERRED to Phase B — which never landed, so this is a live security gap with no owner.** *"allowlist-gating ≠ anti-spoof"* |
| **PC-5** | Word-prefix single-match auto-bind, no embedding gate, silent | Should-fix | Addressed by D5 |
| **PC-6** | **Two write disciplines** — legacy `extract()` writes canonical directly on run-count triggers vs the clean epoch propose→promote | Hygiene | **LEAVE-AS-LEGACY, documented.** Revisit when a pass registry makes migration cheap |
| **PC-7** | Dead code / inert schema | Hygiene | Retire dead `mcp-server/` endpoints, keep the transport shell. **CORRECTION (PC8-5): `inverse_predicate` is LIVE, not inert** — contradicts the earlier entry and a memory file |
| **PC-8** | Unknown-unknowns beyond the blast radius | Discovery, Step 0 | ✅ no new hard Blocker |

**PC-8's own findings:** **PC8-1** `embed()` swallowed ML failure → NULL-embedding entity — **since
fixed** (`embedForWrite` throws). **PC8-2** `/api/reset` clears 17 of ~42 tables. **PC8-3**
`LLM_PROVIDER` unknown → silent Claude fallback + TS(`'pi'`)/Python(`'claude'`) default drift. **PC8-4**
dead `event_embedding`/`pattern_embedding` columns carry live HNSW indexes. **PC8-6** no test asserts a
minted entity carries an embedding. **PC8-7** POSITIVE: legacy passes are logged, not silently wrong.

---

## Reusable for graph isolation / many graphs per user

**1. `08-future-hierarchical-corpora.md` — the per-edge assimilate/compare DAG (the headline).**
*"The assimilate-vs-compare knob is not a per-corpus flag, it is a per-edge policy on a corpus graph."*
Assimilate edge = blend up (child into parent, same domain, fuse on shared anchors). Compare edge =
bridge (cross-domain, reasoned, no fusion). **Unified fusion rule: your fusion candidate set is the
transitive closure of assimilate edges (you + your ancestors); compare edges never contribute fusion
candidates, they get bridges instead.**

Three cases become one model: today's flat blend-everything = one root, everything assimilating up;
cross-corpus v1 = two roots + one compare edge; chats-in-a-codebase = codebase root with assimilate
edges down to each chat. Edge policy is chosen by one question: same-domain shared referent (blend) or
cross-domain (bridge)?

- **Why attractive:** **O(N) not O(N²)** ("the parent *is* the join index"); disagreement surfaces free
  as a contradiction on the shared node; generalises the scope primitive from a flat tag to a graph.
- **Named risks:** god-object bloat; ubiquitous anchors are low-signal (needs **specificity
  weighting** — share a rare entity = strongly related, a ubiquitous one = barely); same-domain only;
  directional fusion is new machinery; provenance must survive the blend (per-child views); contradiction
  accumulation on hubs; and **the sharp one — "blending into two independent gods is a trap"** (child-`foo`
  = A-`foo` = B-`foo` transitively fuses two unrelated graphs). **Resolution: a stream blends up *one
  lineage* and *compares* (bridges) to any additional independent anchors.**
- **Forward-compatibility, explicit:** flat `corpus_id TEXT` is compatible; add `corpus_relationships`
  *without touching* `corpus_id`; the v1 guards are the special case (no relationships ⇒ scope is just
  self); *"the hierarchy only widens the candidate set along assimilate edges, it never removes the
  'different corpus does not fuse' rule."* **The one axis to preserve now, for free: keep *fuse* vs
  *bridge* clean and explicit in the vocabulary.**
- **Six open questions if built:** single-blend-parent vs multi-parent with an anti-transitive guard
  (lean single); specificity weighting; hub contradiction policy; per-child views; child
  graduation/detach; god-object mitigation.

**2. D5 + mig 055 — the policy-preset mechanism**, already built. Doc 19's D-C2 shows the pattern
extended (a reserved corpus deliberately set `assimilating` so intra-graph fusion is wanted).

**3. D9 + mig 052 — enforcement, not convention.** `05` and `01` are emphatic that three of four guards
are bypassable in application code, so **the DB constraint is the last line of defence**.

**4. `01` Part II — the 13-row control-surface audit** is the concrete checklist of everything that is
currently one global policy and would need per-graph scoping: resolution scope, thresholds (0.92/0.75),
mint/dedup key, word-prefix binding, gardener centroid merge, contradiction stance, fact identity,
**retrieval scope (Qdrant stream filter defaults OFF)**, extraction stance, write discipline/actors,
staleness policy, guidance channel, MCP teaching primitives. Rows 1/3/4/5 are *"the same underlying
axis — scope of identity — surfacing in four different places."*

**5. Access control.** `01` Part I + V and PC-4: `pi-agent-bridge.ts` *validates* a client-supplied
`actor` against `VALID_ACTORS` but does **not route-pin** it. Deny-by-default is double-enforced
(advertise-filter + `handleToolCall` re-check). **Per-graph access control is nowhere specified in docs
00–19** — no tenant, no user, no ACL model. `corpus_id` is a partition, not a permission.

**6. Safety boundary for knobs** (`01` Part V): author-your-own early (prompts, guidance, relation
vocab) · curated presets first (identity/merge knobs) · **code-only (write discipline, actor pinning)**.
*"A user who sets auto-merge to 0.5 fuses their own graph."*

---

## Abandoned or superseded designs

| design | killed by |
|---|---|
| **"Anchored entity" bridge endpoint** | Refuted in three-adversary review — *"it re-introduced the exact fusion hazard `00` V.2 designed away"* |
| **"Remove the word-prefix bind globally"** | Illegal in the pure planner (breaks the order-independence litmus); the same line refs power rule-4; global removal regresses genuine coreference |
| **Original Phase A (as in `03`)** | *"Cut hard — most of it was building machinery for a code graph and a sweep that don't exist yet"* |
| **Fact-with-analysis-predicate as the bridge** | No reasoning invariant, and it forces code/rule to *be* entities → exposed to >0.92 auto-merge |
| **Reusing `causal_edges` for bridges** | Endpoints FK `causal_events` (fact *transitions*); *"two-corpus-id problem is decisive"* |
| **D1's bare-catalog elements** | Superseded in shipped code by elements-as-entities |
| **Original E1 gate** (embed verbalised behaviour, ≥0.65 recall@5) | Doc 09 §1: mis-targeted — *"measured the weakest single tool in isolation and reported it as the system's ceiling"* |
| **Doc 09 §10's "gate answered for code v1"** | RETRACTED as overclaimed: direction conflation, adjudication untested, HARKing |
| **Doc 09 §6's pre-registered Tier-2 bar** | Killed as low-information (~1.0 by construction) |
| **Faceted-description authoring as ingest default** | Doc 14: pre-registered FAIL on both conditions |
| **"Concepts win because the formula is semantically better" (doc 11)** | Adversary: the win is a **lexical/format artifact** (pure token-Jaccard reproduced it). Partially re-corrected by doc 12 — cite **0.681**, not 0.778 |
| **Prose + hybrid fusion as an escape from keyword authoring** | Doc 12: negative, bootstrap Δ CI excludes 0 |
| **Doc 15's composition-pilot positive** | Blind adversary: **INFLATED** — the intelligence lived in *authoring*, not adjudication; a 12-line defect-word regex reproduced 7/7; a "confirm the #1 recalled rule" stub beat the LLM |
| **Doc 16's "raw code" fix for that leak** | The "raw" snippets re-leaked the verdict **through code comments** in 6 of 7 violations; run FAILED its bar. *"Root cause is the CORPUS, not the model"* |
| **Embedding as the meaning-bridge** | Doc 17 Stage 1 **FAIL**, robust across all nomic prefixes (R@1 39% vs BM25 72%) |
| **Fuzzy layer as load-bearing** | Doc 18: lean symbolic; demote embedding to a helper; **"stop running synthetic FLOOR experiments on the fuzzy layer"** |
| **Symbolic concept-JOIN as the recall path** | Docs 28–37 — dense embedding ~2× every concept arm |
| **Phase C entirely** | Never started; the gate it sat behind never cleared |

---

## Contradictions and stale claims

**C1 — D1 vs shipped ingest (the big one).** D1 decides elements are *"bare catalog rows … never
`entities`"*, justified as *"zero fusion surface by construction"*. Doc 19 §2 records the opposite as
shipped, treats it as a finding rather than a reversal, and never re-states D1 as dead. **Worse, the
hazard D1 designed away actually fired:** doc 14's adversary found **six ES.45 elements fused to one
entity** on a shared symbol name (`INITIAL_VARIANCE_SCALAR`), silently dropping 5 of 29 items and
inflating the headline — fixed by making identity `ast:sha256` on `properties.element_key`.
**D1 should be recorded as SUPERSEDED with the fusion incident attached.**

**C2 — `00` V.2 vs `00` IX.1** on endpoint identity. Self-flagged by `03` A1: *"They cannot both be
true."* Resolved on paper by D1; then see C1.

**C3 — `bridge_edges` column shape.** `03` B4 uses `source_element_id`/`target_rule_id` TEXT; B6 uses
polymorphic `a_kind`/`a_ref` UUID; `00` V.2 says *"unify on one"*. Reconciled to polymorphic UUID; stale
naming survives in `00` V.2.

**C4 — coverage deferred vs coverage built.** `04` §2 puts `audit_runs`/`audit_coverage` and the sweep
**out of v1** and repeatedly says *"(Coverage is deferred)"* — but `audit-ledger.ts` ships the whole
thing. The deferral was overtaken.

**C5 — `inverse_predicate` inert vs live.** `01` Part 0.5/Part II and PC-7 say *"declared but inert"*.
PC8-5 corrects it: **live**. `05` §6 records the correction; **`01` was never amended, and a memory file
carries the stale version.**

**C6 — doc 11 vs doc 12** on "the concepts win is fully lexical". Doc 11 claims token-Jaccard
*"reproduces the winner exactly (0.778/0.931)"*; doc 12 got **0.681** under the frozen tokenizer and
notes 0.778 *"is exactly this cell's vector score"*. **Doc 11's headline is stale; cite doc 12's 0.681.**

**C7 — PC-2a "AGE verified healthy" vs doc 39 §3.5 "AGE cannot be trusted".** PC-2a verified
*population*, not *fidelity*; PC-2b/2c were never closed. The ✅ reads stronger than it is.

**C8 — PC-4 status.** Deferred to a Phase B that never shipped, so the client-supplied-`actor` gap is
live with no owner.

**C9 — `04` §5's seven acceptance tests.** Docs 00–19 never record a result. `src/test/cross-corpus.test.ts`
exists and is reported 8/8 elsewhere; the acceptance evidence lives outside these docs.

**C10 — doc 39 omits docs 00–19 entirely.** Its basis line reads *"docs 20–38 of this arc"*. Consequences:
**no decision register** (a grep for `D[0-9]` returns only unrelated hits), no `08` hierarchical model,
no `assimilating|comparative` policy, no Phase-0/PC register, no E1 terminal state, no A5
hallucinated-reasoning limit, and no record of the doc 09/15/16/17 adjudication findings. Doc 39 §2.1
also reads as complete on corpus scoping, whereas `corpus-ingest.ts`'s own header documents
`createEntity`'s global dedup as *routed around* rather than fixed.

---

## What this survey could not determine

- Whether `04` §5's seven acceptance tests all passed — no doc in 00–19 records a result.
- Whether the mig-053 catalogs still have any live reader (needs a call-graph check — subsequently
  answered: no service importer at all).
- Whether `bridge_edges` has ever been written outside tests/harnesses.
- **Any per-user / per-tenant / access-control model.** Docs 00–19 specify partitioning and write
  discipline, never identity or permissions. There is no user or tenant column anywhere in the design.
- What "many graphs per user" costs at the derived layers — per-corpus HDBSCAN, `graph_stats` PK surgery
  (`id=1` singleton → `PRIMARY KEY (corpus_id)`), per-corpus adaptive-weight recompute. All deferred in
  `04` §2 as *"only bites with two live corpora at scale"*. No doc says whether the `graph_stats` surgery
  landed.
- Whether the four fusion guards are actually all four — the shipped code reveals at least a fifth
  (`createEntity`) plus a sixth class (`resolve_anchor`'s read path). **Docs 00–19 do not enumerate the
  read-side paths at all.**
- The empirical status of the `08` hierarchical model — zero measurement, zero code, and its two named
  must-haves (specificity weighting, single-blend-lineage) unspecified beyond a lean.
- Whether Qdrant's stream/corpus payload filter was ever made default-on. `01` Part II row 8 records it
  as *"opt-in, defaults OFF (cross-stream)"*; no later doc in 00–19 revisits it.
- Whether `EMBED_DESCRIPTIONS` is on in production. Doc 10 licenses it as the default for cross-corpus
  ingest; `corpus-ingest.ts` embeds descriptions regardless; `entities.ts` respects the flag. The global
  default is stated nowhere in 00–19.
