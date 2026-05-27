# Architectural principles

**Status:** initial fill, 2026-05-26 (bead `nmemo-2yv.73`).
**Theme:** T12 — every background cadence anchors on the right thing (DB state, time, post-event chain), not on whichever agent happens to run next.
**Discovered from:** Review #8 (reasoning patrol findings, `nmemo-2yv.71`/.72), Review #14 cross-feature synthesis (`31-review-cycle-synthesis.md` §2.7 / §3 G4 / §4 C2).

---

## 1. Purpose

A cross-cutting rule about WHO triggers WHAT in the Mnemo platform kept getting violated because it was nowhere written down. Three reviews in the May 2026 cycle (`nmemo-2yv.61` reconciliation, `nmemo-2yv.71` reasoning patrol, `nmemo-2yv.72` pattern detection + graph-stats) all surfaced the same shape: a maintenance compute was either dormant by default OR piggybacking on an unrelated agent's success edge. The fix for each instance is filed; this doc records the rule so the next instance doesn't have to be discovered the same way.

The principle is three rules. Each rule answers a question that recurs during design:

| Question | Answered by |
|---|---|
| "Should this cadence be wired to an agent run, or to a DB event?" | Rule 2 |
| "Where does this new operation belong — viz button, HTTP endpoint, scheduled job, or DB trigger?" | Rule 1 + Rule 3 |
| "Should this feature be visible in the platform UI?" | Rule 3 |
| "Is this thing user-facing, or am I building it for myself?" | Rule 3 |

Doc 32 (compute-trigger registry) operationalises Rule 2 — every compute picks one of five trigger types. This doc is the upstream principle that doc 32 enforces.

## 2. The three rules

### Rule 1 — Users invoke agents only

The only direct interaction a human has with the platform is invoking an agent. The blessed user surfaces today:

- `POST /api/ingest` → graph_agent (extraction)
- `POST /api/reason` and `POST /api/reason/query` → reasoning_agent
- `POST /api/garden` → gardener_agent
- `POST /api/reconcile` → reconciliation_agent
- `POST /api/extract`, `POST /api/parse-document`, `POST /api/transcribe` → ML-services agents

Humans do not click maintenance jobs. They do not run pattern-detection by hand. They do not refresh graph-stats by hitting a button. Every maintenance compute that has a manual HTTP endpoint or viz button is either:

- a debug surface (Rule 3), OR
- a placeholder for an auto-trigger that hasn't shipped yet (tracked in doc 32 with `MANUAL ONLY — see <bead>`).

The corollary: when an agent's job description includes "do X then maybe also do Y", and Y is a pure invariant over the graph (no LLM judgement involved), Y belongs in a DB-reactive cadence, not in the agent's tool surface. The agent stays focused on its judgement task; the platform handles the invariant work in the background.

### Rule 2 — The DB is reactive

Background maintenance cadences anchor on DB state changes, not on whichever agent happens to succeed next. The five blessed trigger mechanisms (per doc 32 §3):

1. **Post-ingest** — fires inline at the end of an `ingest()` cycle when the cost fits the latency budget.
2. **DB-reactive** — fires when a specific DB-state condition crosses a threshold (counter, row arrival, computed predicate). Implemented as an app-layer event handler at the write call site.
3. **Scheduled** — fires on a `node-cron` cadence registered in `src/scheduler.ts`. Used for streaming detectors with cold-restart cost, "no activity" detectors, or computes with no natural DB anchor.
4. **Threshold-driven** — counter-style subset of DB-reactive; simplest shape.
5. **Manual** — debug-only or placeholder. Every Rule-2-respecting compute eventually evolves to one of 1-4.

The anti-pattern Rule 2 forbids: kitchen-sinking unrelated cadences onto a single agent's success edge. `pipeline.ts` did this with `incrementPatrolCount` and `incrementGraphStatsCount` — neither pattern-detection nor graph-stats has any logical relationship to reasoning patrol, but both rode its counter. When the reasoning patrol itself stopped firing automatically, both hitched cadences went dormant silently (`nmemo-2yv.72`).

The right anchor for each compute is "the DB state change this compute cares about", not "an agent run that happens to touch that state". A pattern-detection cadence that fires when new causal events land is reactive to causal events. A graph-stats refresh that fires when entity counts cross a threshold is reactive to entity writes. Neither belongs on the reasoning patrol's coat-tails.

### Rule 3 — The viz app is a debugging surface

The viz at `platform/viz/` exists to make agent behaviour and graph state visible during development. It is not a user-facing platform. Design decisions should not be made as if it were.

What this means concretely:

- A button on the viz that POSTs to `/api/<compute>` exists to let the developer trigger a compute and watch the result. The production cadence is not "wait for the developer to click the button" — it's whatever Rule 2 says it is.
- New viz panels do not justify new compute features. The order is: the compute exists for a Rule-2 reason; the viz exposes it for debugging because the developer needed to see it.
- Viz endpoints CAN coexist with auto-triggers — `POST /api/topology/compute`, `POST /api/clustering/compute`, `POST /api/drift/compute` are all still callable as debug surfaces even after `nmemo-2yv.84` wired their real auto-triggers (doc 32 §2 explicitly preserves them).
- Viz output is read-only for production decision-making. A judgement that requires "look at the viz and then decide" is a judgement we haven't automated yet, not a feature.

## 3. Examples from the codebase

### 3.1 Rule 2 done right — derived-freshness post-merge + threshold fire

`src/services/derived-freshness.ts` registers a family of trigger paths around the shared `public.derived_freshness` counter table, populated by an AFTER-INSERT trigger on `public.facts`:

- `triggerTopologyAndClusteringAfterMerge()` (bead `.84`) — fires `/api/topology/compute` + `/api/clustering/compute` fire-and-forget after every successful `merge_entities()`. The anchor is "a merge happened", which is the DB state change those computes care about.
- `maybeFireFactThresholdCompute()` (bead `.84`) — claims-and-resets the `topology` row when its counter crosses `TOPOLOGY_CLUSTERING_FACT_THRESHOLD` (default 100), then fires both `/api/topology/compute` + `/api/clustering/compute` and resets the sibling `clustering` row in lockstep.
- `maybeFirePatternDetection()` and `maybeFireGraphStats()` (bead `.72`) — same compare-and-reset shape on their own `derived_freshness` rows (`pattern_detection` threshold 50, `graph_stats` threshold 20 by default), but fire the compute *in-process* (no HTTP self-hop) because pattern detection and graph_stats are platform-side TS functions, not ml-services proxies.

All five anchors are DB-reactive. None hitches a ride on an agent's success edge. The manual viz buttons (`/api/topology/compute`, `/api/clustering/compute`, `/api/patterns/detect`, `/api/patterns/promote`, `/api/graph-stats/compute`) stay as Rule-3 debug surfaces — production traffic flows through the `derived_freshness` helpers triggered from `createFact()`'s post-insert hook.

### 3.2 Rule 2 done right — drift patrol scheduled cadence

`src/scheduler.ts` registers a `node-cron` job for drift detection at `DRIFT_PATROL_INTERVAL_MIN` (default 60 minutes). Drift is a streaming ADWIN detector — its anchor is "elapsed time", not "an agent ran". Scheduled is the right mechanism (doc 32 §3).

The same module is the canonical home for future scheduled cadences (e.g. `nmemo-2yv.71` reasoning patrol). One `startScheduler()` / `stopScheduler()` lifecycle hooked to SIGTERM, all jobs registered in one place — instead of ad-hoc `setInterval` calls scattered across services.

### 3.3 Rule 2 done right — cross-cluster post-compute chain

`triggerCrossClusterAfterCompute` in `src/index.ts` fires the cross-cluster generator fire-and-forget after each successful `/api/topology/compute` and `/api/clustering/compute`. The anchor is "both upstream computes are fresh" — exactly the DB-state precondition cross-cluster needs. Wrapped in `pg_try_advisory_xact_lock` to deduplicate overlapping invocations.

### 3.4 Rule 2 violated — pre-bead pipeline counters

`pipeline.ts` historically had:

- `incrementGraphAgentRunCount` → gardener every 5, decay every 10, contradiction detection every 10. **Borderline.** Reactive-by-counter, anchored on graph_agent runs (which DO touch the state these computes care about, so the anchor isn't wildly wrong) but the counter resets on every server restart. Closer to Rule 2 would be a `*_since_last_run` table the computes themselves consult, not a process-local `let`.
- `incrementPatrolCount` → pattern-detection every 3. **Violation; resolved by `nmemo-2yv.72`.** Pattern detection's anchor is "new facts/causal events"; coupling it to reasoning-patrol runs meant the cadence went dormant whenever the patrol was dormant. The fix added a `pattern_detection` row to `derived_freshness` and wired `maybeFirePatternDetection()` into `createFact()`'s post-insert hook — same DB-reactive shape as topology + clustering (§3.1).
- `incrementGraphStatsCount` → graph-stats every 5. **Violation, same shape; resolved by `nmemo-2yv.72`.** Now anchored on a `graph_stats` row in `derived_freshness` with a lower threshold (default 20) so health telemetry stays fresh.

The post-`graphAgentRunCount` cadences (gardener, decay, contradictions) are the "borderline" case — close enough to the principle in spirit that they haven't been re-filed, but the right end-state is for each to be reactive-to-its-own-DB-anchor rather than counter-on-pipeline.

### 3.5 Rule 3 example — viz debug endpoints around auto-triggered computes

After `nmemo-2yv.84` shipped, the three computes (topology / clustering / drift) became auto-triggered via §3.1 + §3.2. The viz buttons at `viz/js/*` still POST to the same endpoints. These are now Rule-3 debug surfaces: a developer can click "Compute topology" to force a refresh, watch the run, inspect the `topology_compute_runs` row. Production no longer relies on the click. Doc 32 §2 explicitly marks "Manual debug surface preserved" for each of those three rows.

The post-merge HTTP integration test scaffold added by `nmemo-2yv.86` confirms the rule: tests can drive `/api/topology/compute` directly (debug-surface usage) while production traffic flows through `triggerTopologyAndClusteringAfterMerge` (auto-trigger).

### 3.6 Rule 3 violated — would be a viz feature without a production cadence

Hypothetical: "Add a button to the viz that shows the top 10 entities by drift score, sorted by recency." This is a Rule 3 violation if there's no production code path that consumes drift scores. The compute (drift detection) exists for the auto-trigger to feed `entity_drift_events`, which downstream agents consume. A viz panel that READS those events is fine. A viz panel that JUSTIFIES a new compute or scoring formula is Rule 3 backwards — designing the production system as if the viz were the consumer.

## 4. Decision boundaries

When a new cadence, trigger, or feature is being designed, the rules narrow to three concrete questions.

### 4.1 "Where does this new cadence belong?"

Anchor on the DB state change it cares about, not on an agent run that happens to touch that state. The procedure:

1. Name the DB state change the compute reacts to (a row insert, a counter crossing a threshold, a column update, elapsed time since last run).
2. Pick one of the five trigger types in doc 32 §3 that matches that anchor.
3. Add the row to doc 32 §2 in the same PR.

If no DB state change fits — the compute genuinely has no natural anchor — that's evidence it should be Scheduled (Rule 2 mechanism 3) or that the compute itself isn't well-motivated.

### 4.2 "Should this be exposed in the viz?"

Only if it helps a developer debug agent behaviour or graph state. Never as a user-facing feature. The test:

- Is this viz panel/button there because a developer needed to see/trigger it while building or diagnosing the system? → Rule 3 OK.
- Is this viz panel/button there because the spec says "the user will look at this"? → Rule 3 violation. Mnemo's user surface is the agent invocation endpoints, not the viz.

Viz read-only panels showing state agents already produce are always fine (developers need them to see what the agents did). Viz buttons that trigger computes are fine as debug surfaces but never as the production trigger.

### 4.3 "Manual API endpoint vs automatic trigger?"

Both can coexist for the same operation:

- **Automatic trigger** is the production cadence — answers "when does this run on its own?". Lives in the trigger source documented in doc 32 §2.
- **Manual endpoint** is the debug + agent-tool access surface — answers "how does a developer or an agent force a run?". HTTP route + viz button if useful.

The wrong question: "Should this be manual or automatic?" — the answer is almost always both. The right question: "What's the automatic trigger anchored on, and what's the manual endpoint's audience (developer? agent tool?)".

### 4.4 Cross-cutting implication — "what does an agent's job include?"

An agent's job is judgement — interpretation, classification, prioritisation, ranking, language generation. Anything an agent does that is a pure invariant over the graph (count, aggregate, threshold check, recompute-derived-state) belongs in a DB-reactive cadence, not the agent's tool surface. The agent calls into the platform's read APIs; the platform handles invariant maintenance in the background.

Corollary: when reviewing an agent's tool list, every tool whose implementation is "compute X and write Y" without LLM judgement is a candidate for removal — that work belongs in the background.

## 5. Cross-references

### 5.1 Beads that surfaced the principle

- `nmemo-2yv.61` (CLOSED 2026-05-26) — Reconciliation agent had no auto-trigger; `merge_candidates` piled up until a user clicked Reconcile. Rule 1 + Rule 2 fix: pipeline-level wall-clock-gated auto-trigger.
- `nmemo-2yv.71` (OPEN P1) — Reasoning patrol has no auto-trigger; only viz Reason button fires it. Rule 1 + Rule 2 fix: time-driven cadence via `entity_meta` freshness signals, registered in `src/scheduler.ts`.
- `nmemo-2yv.72` (CLOSED) — Pattern-detection + graph-stats cadences piggybacked on the reasoning-patrol success edge. Rule 2 violation; fix landed: both now react to per-kind `derived_freshness` counters (migration 035 + `maybeFirePatternDetection` / `maybeFireGraphStats` in `derived-freshness.ts`), wired into `createFact()`'s post-insert hook alongside the topology/clustering threshold helper.

### 5.2 Beads that codify the principle

- `nmemo-2yv.84` (CLOSED) — Topology / clustering / drift auto-triggers; introduced `src/scheduler.ts` + `derived_freshness` table; populated the doc 32 §3 `Scheduled` taxonomy slot.
- `nmemo-2yv.131` (CLOSED) — Compute-trigger registry doc 32; this doc is the upstream principle doc 32 enforces.
- `nmemo-2yv.86` (CLOSED) — HTTP route integration test scaffold; confirms Rule 3 debug-surface coexistence with Rule 2 auto-triggers.

### 5.3 Related architecture docs

- `31-review-cycle-synthesis.md` §2.7 — T12 theme inventory (missing auto-triggers).
- `31-review-cycle-synthesis.md` §3 G4 — auto-trigger absence cluster.
- `31-review-cycle-synthesis.md` §4 C2 — the cross-cutting finding motivating doc 32.
- `32-compute-trigger-registry.md` — operationalises Rule 2; PR contract enforces it.
- `33-implementation-lessons.md` — `.84`, `.86`, `.131` entries record the concrete lessons that surfaced when each cure landed.
