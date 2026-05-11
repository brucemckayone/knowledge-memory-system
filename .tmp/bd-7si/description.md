# Graph-aware lesson generation

## Problem statement

The current lesson pipeline (`learn/src/agents/lesson-generator.ts`) drives a four-stage agent flow — outliner → prose writers → artifact builders → composer — but it never reads the **learner's** Graph S/C state. Every lesson is generated as if the learner were a freshly-minted novice. This violates the v0.3 learn-platform vision principle #1 ("does this lean on the graph?"): the same hand that writes the lesson is unaware of the learner's existing facts, struggle areas, or causal history.

Concretely: `buildContext()` (lines 92–117) loads only `courses` + `sections` rows. The outliner (`lesson-outliner.ts:157`) and prose writer (`lesson-prose.ts:50`) are told the section title, description, and learning objectives. Neither receives a single learner-fact, prerequisite gap, or causal trace. The artifact builder accepts a `learnerState` field but the orchestrator passes only `conceptName: ctx.sectionTitle` (lines 174–199) — the field is structurally vestigial.

## Signals already available

`learn/src/services/nmemo-client.ts` exposes everything we need over HTTP. The MCP layer (`learn/src/mcp/learning-mcp.ts`) re-exposes the read paths to in-process callers with cheap shapes:

- `getLearnerFacts()` → `{ facts: NmemoFact[] }` where `NmemoFact = { id, subjectEntityId, predicate, objectEntityId?, objectValue?, confidence?, sourceText? }`. Predicates relevant here: `understands`, `confused_by`, `lacks_understanding_of`, `struggles_with`, `lacks_prerequisite`, `practiced`.
- `getStruggleAreas()` → `{ weakAreas: StruggleArea[]; confusions: StruggleArea[] }` derived from learner-facts where `understands.confidence < 0.6` or predicate ∈ {`confused_by`, `lacks_understanding_of`, `struggles_with`}.
- `getConcept(name)` → `{ entity: NmemoEntity | null; facts: NmemoFact[] }` for a specific concept.
- `queryReasoning(question)` → `{ triggered, result, durationMs }` — the heavyweight Graph C path; only worth calling on confirmed struggle areas.
- `get_prerequisite_chain` (MCP, backed by `getGraphS()` + filter on `prerequisite_of|prerequisite_for|requires|builds_on`) → `{ concept, prerequisiteChain: [{from, predicate, to}, …] }`.

`sections.conceptEntityIds` (`learn/src/db/schema.ts:23`) is the join key — a JSON array of Nmemo entity IDs already attached to each section by the course generator.

## Desired end-state

When the orchestrator generates (or regenerates) a lesson for a section whose `conceptEntityIds` overlap a learner-fact, the outliner spends one or two outline items on the learner's specific weakness, the prose writer for those items references the misconception in concrete terms ("you previously wrote that closures capture by value — they don't"), and the artifact selection rule prefers FlashcardDeck for forgotten concepts and ConceptMap/Mermaid for prerequisite gaps. When the learner has zero relevant facts, the lesson is byte-for-byte the canonical lesson — the personalisation branch is a strict additive overlay, not a rewrite.
