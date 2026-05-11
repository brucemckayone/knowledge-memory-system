# Notes — risks, open questions, alternatives, code paths

## Risks + mitigations

1. **Hallucinated concepts.** The outliner could fabricate a "remedial item for concept Y" for a concept Y not in the learner-fact list. Mitigation: outliner system-prompt rule forbids inventing concepts beyond `confusions`/`forgottenConcepts`/`missingPrereqs`/`established`. Reinforced by snapshot tests that diff actual outline against expected concept set.
2. **Mid-pipeline fact updates.** A learner could record a quiz answer mid-generation; the lesson would still reflect the pre-fetch snapshot. Acceptable: lesson is point-in-time; the next regeneration picks up the new fact. The alternative (re-fetch per stage) breaks consistency far worse than it helps.
3. **Cross-course contamination.** `getLearnerFacts()` returns ALL learner facts globally — facts about course A could leak into course B's lesson context if concept names collide. Mitigation: the relevance filter is by `objectEntityId ∈ section.conceptEntityIds` (entity ids are course-scoped via the course generator), not by string match. String matching is fallback only and capped.
4. **Confusion amplification.** Quoting the learner's misconception verbatim in prose risks reinforcing it. Mitigation: the prose-writer prompt requires "name the misconception only to refute it; corrected belief must follow within the same paragraph". A specific lint test could check for misconception text appearing without the corrected text within ±300 chars.
5. **Personalisation makes regen behaviour user-unstable.** Two regens minutes apart could produce wildly different lessons if a quiz fact landed between. Mitigation: log `fetchedAt` + fact-count summary on every run; surface in the section status panel later.

## Open questions

1. **Concept-name matching strategy.** `objectEntityId` matching is clean but `objectValue` is free text. How aggressively should we string-match `objectValue` against `section.title` / objective keywords? Proposal: substring match case-insensitive, but only when `objectEntityId` is null. Open for review.
2. **Confidence aggregation across multiple facts.** Same learner may have 3 `understands` facts on one concept at confidences 0.4, 0.6, 0.8 from three different quiz attempts. Use most-recent or weighted average? Proposal: most-recent — Graph S already encodes temporal validity, but `getLearnerFacts()` returns them all flat. Need to verify the platform endpoint's ordering.
3. **Prereq chain depth.** `get_prerequisite_chain` returns one hop. Should we follow `lacks_prerequisite` recursively up to depth 3? Bounded recursion costs another N HTTP calls. Default to depth 1 for v1; revisit after observability.
4. **Should `gap-analyzer.ts` be reused?** It has the WOW moment and uses MCP tools. Could a per-section "gap-aware lesson" agent be a thin wrapper around it? Decision: no for v1 — `gap-analyzer` is global-scope ("learner's biggest gap"); we want section-scoped signals.
5. **Does the `LearnerLessonContext` need to flow into the takeaways generator (`generateTakeaways`, `lesson-generator.ts:338`)?** Probably — a confusion-targeted lesson should produce a takeaway that explicitly negates the misconception. Parking as follow-up.

## Alternatives considered

- **Per-stage MCP tool calls (let the agent fetch).** Costs 1 + N + M HTTP calls minimum and adds 30–90 s of LLM round-trip time across stages. Benefit: agent can ask follow-up queries (e.g. fetch causal history only when it spots a confusion). Rejected for v1 because the fixed pre-fetch is cheaper and good enough; revisit if we observe outliners "wishing" they could query mid-design.
- **Embed learner state into the outline JSON itself.** I.e. outliner returns `LessonOutline` with a `personalisationApplied: true` field. Rejected — the outline schema is a teaching artefact; tracking personalisation is a runtime concern, belongs in logs and the section row, not the outline.
- **Generate two lessons (canonical + remedial overlay).** Cleanly separable, but doubles cost and breaks the existing four-stage flow. Rejected.

## Code paths (insertion points)

- `learn/src/agents/lesson-generator.ts:387` — orchestrator entry, insert `loadLearnerLessonContext` call here.
- `learn/src/agents/lesson-generator.ts:392` — `generateLessonOutline(...)` call site, add `learnerContext` param.
- `learn/src/agents/lesson-generator.ts:411–428` — prose writer parallel map, add `learnerContext` param to `writeProseBlock` call.
- `learn/src/agents/lesson-generator.ts:163–216` — `buildOneArtifact`, extend `learnerState` payload passed to `generateComponent` / `generateArtifact`.
- `learn/src/agents/lesson-outliner.ts:52` — extend `OutlinerInput` interface with optional `learnerContext`.
- `learn/src/agents/lesson-outliner.ts:72` — append `## Personalisation` section to `SYSTEM_PROMPT`.
- `learn/src/agents/lesson-outliner.ts:157` — `buildUserPrompt`, conditionally append `## Learner state` block.
- `learn/src/agents/lesson-prose.ts:15` — extend `ProseWriterInput` with optional `learnerContext`.
- `learn/src/agents/lesson-prose.ts:25` — append `## Personalisation` section to `SYSTEM_PROMPT`.
- `learn/src/agents/lesson-prose.ts:50` — `buildUserPrompt`, conditionally append `## Learner context` block.
- `learn/src/services/nmemo-client.ts:115` — `getLearnerFacts` already exists; no platform change required.
- `learn/src/agents/learner-lesson-context.ts` — NEW file, the loader + type.

## Follow-up bead candidates (do NOT create — list only)

- Personalised takeaways: thread `LearnerLessonContext` into `generateTakeaways` so the 3–6 takeaways close the loop on remediated misconceptions.
- Per-stage MCP fetch: let the outliner call `get_causal_learning_history` mid-design when it spots an unexplained confusion (post-v1 once we have telemetry).
- Cross-course contamination guard: explicit check that `section.conceptEntityIds` are scoped to the course before any matching.
- `LearnerLessonContext` panel in the section view UI: show the learner what the system fetched and used. Transparency surface for the v0.3 vision principle.
