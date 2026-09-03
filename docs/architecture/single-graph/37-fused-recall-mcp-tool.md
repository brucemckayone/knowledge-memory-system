# 37 — Wiring the proven fusion as an MCP tool (nmemo-asf.4, Phase 1.3)

Bead `nmemo-asf.4`. Doc 32 Phase 1.4 / doc 30 step 1. **No new science** — the two-signal fusion
(`recallEntitiesFused`, RRF-60 of dense-over-names ⊕ dense-over-facts) was already confirmed as the one
retrieval lever that beats name-only (`nmemo-u8j.1`). It just had no live caller. This makes it real.

## What shipped

**A new read tool `recall_entities_fused`** in `causal-agent.ts`. Two code edits + one import; nothing
else needed because the per-actor allow-lists and both transports (MCP `graph-mcp.ts` ListTools, Pi
`pi-agent-bridge.ts`) derive from `GRAPH_TOOLS` filtered by the `mutates` flag — a `mutates: false` entry
auto-exposes to `reasoning_agent` (via `LEGACY_SURFACE`) and every other actor, on both transports, with
no set/map edits.

- **Tool definition** (`GRAPH_TOOLS`): `query`, optional `limit` (10) and `threshold` (0). No `corpus_id`
  arg — corpus is a property of the invocation (`context.corpusId`, nmemo-asf.3), not an agent choice.
- **Dispatch case** (`_handleToolCallInner`): calls `recallEntitiesFused(query, { corpusId:
  context.corpusId ?? undefined, limit, threshold })` and returns each `FusedEntity` projected to
  `{ id, canonicalName, entityType, corpusId, nameSimilarity, factSimilarity }` — the last two are the
  per-hit provenance (null = that signal did not surface the entity). Array order is the fused rank.
  `recallEntitiesFused` embeds the query itself and degrades to `[]` on ML failure (never throws), so the
  tool surfaces "no results" rather than erroring.
- **Reasoning-agent prompt** (`ml-services/app/reasoning_agent.py`): added the tool to the read-tool
  catalogue and made it PHASE-1 step 1 (PREFERRED over `search_similar_entities`, which is now labelled
  name-only). Soft guidance, not a gate — this is what makes the agent actually reach for the lever.

## Proof

`platform/src/test/tools/fused-tool-probe.ts` — deterministic, no Claude, self-cleaning scratch corpora.
Calls the real MCP dispatch entry `handleToolCall('recall_entities_fused', …)` with the production env
carrier (`MNEMO_AGENT_ACTOR=reasoning_agent`, `MNEMO_CORPUS_ID`), i.e. the exact path the MCP transport
uses. Fixture: corpus A holds a NAME-signal entity (name matches the query) and a FACT-signal entity
(opaque name, but a fact whose source text matches the query → `fact_embedding` hit); corpus B holds a
same-concept decoy. 12/12 assertions PASS: the call runs through the agent surface, returns both A
entities (name hit + fact hit, both provenance fields live across the set), excludes the B decoy, and a
corpus-B call returns the decoy and neither A entity. tsc held at the 69-error baseline.

This proves the tool RUNS through the agent surface and honours the corpus; it does not re-litigate the
fusion science (banked as `nmemo-u8j.1`, and covered directly by `platform/src/test/services/retrieval.test.ts`).

## Notes

- Corpus scoping composes with nmemo-asf.3: `context.corpusId` (from `MNEMO_CORPUS_ID`) flows straight
  into `recallEntitiesFused`'s three internal corpus filters (name leg, fact leg, final hydration).
- `candidateLimit` (50), `factLimit` (200), and `k` (60) are left at the proven defaults, not exposed on
  the tool surface — the confirmed config used them.
