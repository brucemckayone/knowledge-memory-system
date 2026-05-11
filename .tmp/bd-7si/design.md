# Design — Graph-aware lesson generation

## 1. Where learner state is fetched

**Recommendation: single fetch in the orchestrator, pre-stage.** Inside `generateLessonStructuredV3` at `lesson-generator.ts:387`, after `buildContext()` and before `generateLessonOutline()`, run one `loadLearnerLessonContext(section.conceptEntityIds)` call that hits the platform once via `getLearnerFacts()` plus optional `get_prerequisite_chain` per concept (capped). The same `LearnerLessonContext` object is then threaded into the outliner input, each prose writer call, and `buildOneArtifact()`.

Justification:
- **Cost / latency**: outliner + N prose + M artifacts is already 5–15 LLM calls per lesson. Fetching learner state per stage would mean 1 + N + M HTTP round-trips against `/api/learn/learner-facts` for data that does not change mid-pipeline.
- **Consistency**: pipeline wall-clock is 4–12 min. If the learner records a quiz mid-flight, we want the lesson to reflect a single coherent snapshot, not a mix of pre- and post-quiz state.
- **Existing structure**: per-stage agents are already pure functions of their inputs; threading one extra typed argument fits the contract. Per-stage fetches would force every agent module to take a dependency on `nmemo-client`, which today only the orchestrator imports.

The agent itself does *not* call MCP tools for this — pre-fetched context is cheaper, deterministic, and keeps the outliner at one LLM turn (`lesson-outliner.ts:289` `maxTurns: 1`).

## 2. Per-stage signal map

| Stage | Receives | Uses for |
|-------|----------|----------|
| Outliner | `relevantFacts` (subset of facts whose `objectEntityId` is in section's concept ids), `struggles` (filtered to section concepts), `prereqGaps`, `coldStart: boolean` | Adds 0–2 remediation items to the 6–12 item outline; tags prose intents with concrete misconceptions; biases artifact kind selection. |
| Prose writer | The full `LearnerLessonContext`, but constrained to facts referenced by `item.intent` | Quotes the learner's prior misconception verbatim where relevant; chooses examples that contrast the wrong belief with the right one. |
| Artifact builder | Existing `learnerState` shape extended with `forgottenConcepts: string[]`, `confusions: {concept, misconception}[]`, `missingPrereqs: string[]` | Drives the artifact-kind decision table (§6) and shapes the spec — e.g. flashcard fronts are exact misconceptions. |
| Composer | Nothing learner-specific (pure code). | — |
| Takeaways | Nothing learner-specific. | — |

## 3. The `LearnerLessonContext` interface

```ts
// learn/src/agents/learner-lesson-context.ts (new file)
import type { NmemoFact } from '../services/nmemo-client.js';

export interface LearnerLessonContext {
  /** True when no learner-facts touched any concept in section.conceptEntityIds. */
  coldStart: boolean;
  /** Learner facts whose objectEntityId is in section.conceptEntityIds, OR whose
   *  objectValue case-insensitively contains section.title or any objective keyword. */
  relevantFacts: NmemoFact[];
  /** Concepts the learner once knew (`understands.confidence >= 0.6`) but
   *  whose most recent fact is older than 14 days — i.e. decay candidates. */
  forgottenConcepts: Array<{ entityId: string; name: string; lastConfidence: number; daysSince: number }>;
  /** Active confusions on this section's concepts. Populated from facts with
   *  predicate ∈ {confused_by, lacks_understanding_of, struggles_with}. */
  confusions: Array<{ entityId: string | null; concept: string; misconception: string; sourceText: string | null }>;
  /** Prerequisite concepts the learner is flagged as lacking (predicate=lacks_prerequisite),
   *  intersected with the prerequisite chain reachable from this section's concepts. */
  missingPrereqs: Array<{ concept: string; neededFor: string }>;
  /** Strong understandings (`understands.confidence >= 0.7`) — the outliner can
   *  skip motivation prose for these. */
  established: Array<{ entityId: string | null; concept: string; confidence: number }>;
  /** Snapshot timestamp (ISO) for staleness checks and logging. */
  fetchedAt: string;
}
```

## 4. Outliner prompt diff

`lesson-outliner.ts:72` SYSTEM_PROMPT gains a new section "## Personalisation (when learner state is supplied)" inserted just before "# Lesson shape". The section instructs the model:
- If `confusions` are present, **at least one** outline item must directly target the listed misconception (prose intent must name the wrong belief and the corrected belief).
- If `forgottenConcepts` are present, prefer a `FlashcardDeck` artifact item over plain prose for that concept.
- If `missingPrereqs` are present, prefer a `Mermaid` or `ConceptMap` artifact item that bridges the prereq → section concept.
- If `established` already covers a learning objective, the corresponding prose item's `wordTarget` should drop to ~150 (terse review) instead of full explanation.

`buildUserPrompt()` (`lesson-outliner.ts:157`) appends, when `coldStart === false`, a "## Learner state" block listing `confusions`, `forgottenConcepts`, `missingPrereqs`, and `established` as bullet lists with concrete strings (concept name + verbatim misconception text + source-text excerpt where present, capped at ~80 chars each).

## 5. Prose writer prompt diff

`lesson-prose.ts:25` SYSTEM_PROMPT gains a "## Personalisation" section: when the user prompt includes `## Learner context`, the prose MUST address listed confusions/gaps explicitly when (and only when) the prose item's `intent` references that concept. Forbid hallucinating learner facts not in the supplied list.

`buildUserPrompt()` (`lesson-prose.ts:50`) gets a new optional block placed after `## Your block`:
```
## Learner context (use ONLY when intent above references one of these)
- confused: "<concept>" — they wrote: "<verbatim misconception>"
- forgot: "<concept>" — last seen <N> days ago at confidence <C>
- missing prereq: "<concept>" — needed for "<this section concept>"
```

Items are filtered to those plausibly relevant to the assigned prose item (string-matching the prose `intent` against concept names — over-inclusion is acceptable, the model picks).

## 6. Artifact selection decision table

| Learner signal on section concept | Preferred kind | Spec hint passed to builder |
|-----------------------------------|----------------|-----------------------------|
| `forgottenConcept` (decay) | `FlashcardDeck` (fixed) | Front = atomic fact the learner once knew; 3–5 cards. |
| `confusion` with concrete misconception text | `Callout` (variant: `warning`) followed by `CodeRunner` or `SvgFigure` contrasting wrong vs right | Spec quotes misconception verbatim and shows the corrected behaviour. |
| `missingPrereq` | `Mermaid` (flowchart prereq → section concept) OR `ConceptMap` if 3+ prereqs | Spec shows dependency direction. |
| `established` (already understands) | (no extra artifact; outline drops or trims that item) | — |
| Mix of confusion + prereq gap | `freeform Artifact` with `intent: walkthrough` | Walkthrough that builds from the prereq up through the corrected mental model. |
| Cold start | Default kind selection (current behaviour) | — |

The outliner emits the kind; the orchestrator passes the existing `learnerState` field (extended) into `generateComponent` / `generateArtifact` so the builder can calibrate complexity (`learnerState.confidence`) and reference `confusions`/`missingPrereqs` arrays via two new optional fields.

## 7. Cold-start detection

```ts
function isColdStart(facts: NmemoFact[], sectionConceptIds: string[]): boolean {
  const ids = new Set(sectionConceptIds);
  return !facts.some(f =>
    (f.objectEntityId && ids.has(f.objectEntityId)) ||
    (f.subjectEntityId && ids.has(f.subjectEntityId))
  );
}
```

When `coldStart === true`, `loadLearnerLessonContext` returns a context with all arrays empty and the orchestrator passes `undefined` (not the empty context) to outliner / prose writer / artifact builder. Each agent's prompt augmentation is gated `if (ctx?.coldStart === false)`. Result: prompts are byte-identical to today's for cold-start lessons. This is the no-regression contract.

## 8. Caching / staleness

Single in-orchestrator fetch (per §1). The fetched context is captured at `fetchedAt` and threaded through all parallel stages — every prose writer + artifact builder sees the same snapshot. No TTL needed because the snapshot is bounded by the lesson's wall-clock (≤15 min) and the next regeneration triggers a fresh fetch. The orchestrator logs `fetchedAt` and the size of each array on entry for traceability.

If `getLearnerFacts()` throws or exceeds a 5 s timeout, the orchestrator catches the error, logs a warning, treats the lesson as cold-start, and proceeds. Lesson generation MUST NOT block on a flaky platform call.

## 9. Test plan

1. **Unit — `loadLearnerLessonContext` cold start**: zero facts → `coldStart: true`, all arrays empty.
2. **Unit — `loadLearnerLessonContext` confusion**: a `confused_by` fact whose `objectEntityId` matches a section concept → ends up in `confusions[]` with the misconception text.
3. **Unit — outliner prompt augmentation**: snapshot test — given a fixed `LearnerLessonContext` with one confusion + one missing prereq, the user prompt contains the expected "## Learner state" section verbatim.
4. **Unit — outliner prompt cold-start**: when `ctx?.coldStart === true` is passed, the user prompt is byte-identical to the no-context call (ensures additive-only branch).
5. **Integration — happy path**: stub `nmemo-client` to return a confusion on concept X (in section's `conceptEntityIds`), regenerate the lesson, assert outline contains a prose item whose `intent` mentions X, AND the resulting prose markdown contains a string that names X.
6. **Integration — platform fallback**: stub `getLearnerFacts()` to throw, regenerate, assert pipeline completes in ≤ legacy time + 5 s, lesson is byte-identical to the cold-start lesson, and a `[lesson-generator] learner-state fetch failed` warning is logged.
