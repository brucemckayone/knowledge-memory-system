# Review #6 — Entity Profile / Summary — Synthesis Notes

Branch: review/entity-profile (off review/graph-meta-stats, off feat/cognitive-platform-v1)
Bead: nmemo-2yv.6 (claimed → to be closed at end)
Scope: `platform/src/services/entity-profile.ts` + `platform/src/db/migrations/004_entity_summary.sql`

## The shape of "Entity Profile" in HEAD

Three disjoint slices, with the seams in between unwired:

| Slice | Where | Role | Wired? |
|---|---|---|---|
| Read assembler / type owner | `entity-profile.ts` | Owns the `EntityProfile` TS type + `getEntityProfile`, `getEntityMemories`, `searchEntities`, `formatEntityProfile` | **Zero production callers** at HEAD. Only `entity-profile.test.ts` imports it. |
| Living-summary writer + reader | `causal-agent.ts` (`update_entity_summary` tool, `search_entity_aliases`, `get_entity_neighborhood`) | Writes/reads `entity_meta.summary` via tool-use loop. Used by the reasoning agent path through `pi-agent-bridge.ts`. | Wired (the agent actually runs and writes — `.dev-output.txt` shows 30+ tool calls in real runs). |
| Viz unified payload | `/api/viz/unified` in `index.ts` (lines 164–217) | Reads `entity_meta.summary`, emits it as `summary` on each entity node | API emits it. Frontend (`platform/viz/js/**`) has **zero `.summary` reads** — the data is dropped. |

So three writers/readers exist but the "Entity Profile" service that names the concept doesn't connect to any of them.

## Findings disposition (final)

| # | Finding | Disposition | Bead |
|---|---|---|---|
| F1 | `entity-profile.ts` has zero production callers; service that names the concept doesn't implement it | filed | **.51** (P1) |
| F2 | No canonical design doc for entity-living-summary | filed | **.59** (P2) |
| F3 | `/api/viz/test-summary` + `test-query-facts` are orphan unauthenticated wrappers (echoes `.46`) | filed | **.54** (P2) |
| F4 | `update_entity_summary` UPSERT is unconditional; concurrent writes lose work silently | filed | **.55** (P2, depends on .51) |
| F5 | Viz frontend never displays the agent-authored summary | filed | **.52** (P2, depends on .51) |
| F6 | No length bound or sanitization on `summary`; prompt-injection loop | filed | **.53** (P1) |
| F7 | Test coverage gaps (no integration test, no fixtures, no benchmarks) | filed | **.56** (P2, depends on .51 + .53) |
| F8 | `PREDICATE_CATEGORIES` is hard-coded; ~20 of 30 observed predicates fall to 'Other' | filed | **.57** (P3) |
| F9 | Mig 004 ownership comment aspirational; entity_meta is multi-feature with no per-column ownership | **absorbed into .51** (adds `COMMENT ON COLUMN` to mig 018) | — |
| F10 | Summary staleness invisible — no `summary_updated_at` column | **absorbed into .51** (extends mig 018) | — |
| F11 | Should `entity-profile.ts` be deleted or repaired? | **resolved by .51** (repair: become canonical assembler) | — |
| H6 | Qdrant errors in `getEntityMemories` swallowed silently | filed | **.58** (P3, bundled) |
| H8 | `getEntityMemories` underdelivers on multi-mention entities (no DISTINCT) | filed | **.58** (P3, bundled) |

**Dependency graph:**

```
.51 (P1) ──┬─→ .52 (P2)
           ├─→ .55 (P2)
           └─→ .56 (P2)
.53 (P1) ──→  .56 (P2)
.54 (P2)
.57 (P3)
.58 (P3)
.59 (P2)
```

## Cross-cutting themes (new for Review #6)

**T7 — The naming-mismatch trap.** Service is `entity-profile`; schema is `entity_meta.summary`; bead title is "profile / summary". The user flagged this at kickoff and it turned out to be the surface signature of real fragmentation (three slices, no integration). Resolution: `.51` collapses the surface area into one canonical path. Lesson for future reviews: when the service name, the schema column, and the bead title disagree, suspect feature fragmentation underneath.

**T8 — Tool-result content as agent input is a prompt-injection vector class.** `update_entity_summary` is one instance of a broader pattern: anywhere we let an agent write content that ends up in a subsequent agent's prompt, we have an injection loop. Other candidate surfaces:
- `create_same_as_link.reasoning` (reconciliation agent writes; possibly read back by later reconciliation runs or audit tools)
- `create_causal_edge.reasoning` (causal agent writes; read back in `get_causal_history` / pattern detection)
- `reasoning_reports.report` (reasoning agent writes; read by graph-stats? gardener?)

The fixes filed in `.53` (length cap + sanitization + delimited-block wrapping + system-prompt clause) form a template. Review #7 (Reconciliation + gardening) should apply the same audit to its surfaces.

**T2 (carried from Review #5) — multi-feature `entity_meta` confirmed.** Migrations 003, 004, 008, 015, 016 all touch this table with no per-column ownership signal. `.51` partially addresses by adding `COMMENT ON COLUMN` annotations for the summary columns; other columns remain unannotated.

**T5 (carried from Review #5) — dead endpoints found again.** `.54` echoes `.46`. Worth a one-off sweep across `index.ts` for all `/api/viz/test-*` routes during Review #7 or as a parent-epic-level cleanup.

**T6 (carried from Review #5) — fixtures vs programmatic.** `.56` adds fixtures for entity-summary following the `.50` pattern. Continues the trend toward fixture-based testing.

## Falsification log

All premises confirmed against HEAD (not working tree):
- ✓ `git grep` from repo root on `'platform/src/' :!entity-profile.ts :!test/'` for any callers of `getEntityProfile|formatEntityProfile|getEntityMemories|searchEntities` → exit 1 (no matches). [F1]
- ✓ `git ls-tree -r HEAD --name-only | grep -i bot` → no `platform/src/bot/` at HEAD. [F1, related]
- ✓ `git grep` on `platform/viz/` for `.summary\b|summary:` → one CSS class only, no JS field reads. [F5]
- ✓ `.dev-output.txt` shows real production runs calling `update_entity_summary` (30+ invocations). [F1, F4, F6 contextual]
- ✓ `update_entity_summary` tool handler at causal-agent.ts:1347–1359 is UPSERT with overwrite. [F4]
- ✓ Tool input schema at causal-agent.ts:419–422 has no `maxLength`. [F6]
- ✓ `graph-meta.ts:100, :114` INSERT/UPDATE `entity_meta.updated_at` from a different writer than `update_entity_summary`. [F10]
- ✓ `001_consolidated.sql:121-122` unique index on `(memory_id, entity_id, COALESCE(mention_start, -1))` — multi-row per (memory, entity) possible. [H8]
- ✓ `git grep "test-summary|test-query-facts" -- 'platform/'` → only definitions in index.ts, zero callers. [F3]
- ✓ Empirical predicate grep yielded ~30 distinct predicates, ~20 falling to 'Other'. [F8]
- ✓ `docs/architecture/truth-graph/` scan → no canonical doc for entity-summary; only one tangential R-GCN-training mention in 21-cluster-bridging-master.md. [F2]

Zero false-positive premises this review (Review #5 had 1/8 self-corrected). Falsification discipline held throughout.

## Headline for Review #7 (Reconciliation + gardening)

Apply the **T8 audit template** to:
- `same_as_links.reasoning`
- `merge_candidates.resolution_reasoning`
- Any reconciliation agent tool that writes content fed back into reconciliation or gardener prompts
- Gardener / patrol agent prompt assembly: is there an analogous "read prior agent output, splice into new prompt" loop?

Also expect another instance of T2 (multi-feature `entity_meta` ownership) since reconciliation likely touches several `entity_meta` columns.

Bead `.6` is ready to close with a summary referencing this notes file and the 9 filed beads.
