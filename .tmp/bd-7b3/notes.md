# Notes — Risks, Open Questions, Alternatives, Code Paths

## Risks and mitigations

**1. Gap analysis is slow (~10–15 seconds).**
Mitigation: Run on-demand, not on cron. Soft cache prevents redundant runs. Dashboard fetch doesn't block on gap analysis — other cards load immediately; gap card populates async via polling or websocket.

**2. Gaps spanning multiple sections.**
If the root-cause concept is taught in sections A, B, and C, which section should "Fix this" regenerate? Mitigation: Pick the earliest by orderIndex. If the learner prefers a different section, they can manually navigate to it and regenerate from there. Document this choice in future.

**3. The 'fix this' CTA fails if regeneration crashes.**
Mitigation: Regeneration already has error handling (lessonStatus='error', lessonError field). Show a toast if status becomes 'error' after polling; let the learner retry from the section page. Don't leave the dashboard pending forever.

**4. Gap-analyzer model upgrade (post-v1).**
The agent uses Sonnet 4.6 for diagnosis and triggers Graph C reasoning agent for causal traces. If Sonnet is upgraded, gap quality may improve or regress. Mitigation: Log gap analyzer model version on each run so findings can be versioned.

**5. Confusion re-enforcement risk.**
If the card quotes a learner's misconception, it could reinforce it. Mitigation: The card renders "Root cause: [concept]" not "[misconception]". The full causal trace is in contentMd, which must phrase misconceptions as "you believed X, but it's actually Y".

## Open questions

**1. Gap analyzer cron timing post-v1.**
Current plan: on-demand + 30-min cache. If learners don't click "Fix this gap" for a week, no fresh gap analysis happens. Is that okay? Alternative: Light cron job (every 6 hours) that runs gap-analyzer in the background and updates the cached insight. Deferred — decide based on learner engagement data.

**2. Confidence aggregation for cold-start threshold.**
The 10-fact threshold is heuristic. Should it be fact count, fact diversity (number of distinct concepts), or weighted by fact age? Recommendation: Start with count. Revisit if cold-start card appears too late or too early.

**3. Section card appearance — always or only on-demand?**
The inline section-page "Why this matters for you" card currently appears when conceptEntityIds overlap the gap. Should it always appear, or only when the learner visits a section _after_ the gap was diagnosed? Recommendation: Always appear if conceptEntityIds match (simpler, no state). If the gap is dismissed, the section card vanishes too (via shared insights table).

**4. Multi-learner implications.**
This design assumes single learner. If multi-learner is added, each learner has their own gap insights (learnerId field exists in insights table but is not currently used). No change needed here; design scales.

## Alternatives considered

**1. Standalone "My Gaps" tab (v0.2 original).**
Rejected per v0.3 principle. Pulls learner away from lessons.

**2. Gap analysis on every dashboard fetch (no cache).**
Simpler but slow (~10–15 sec adds to dashboard load every time). Soft cache balances freshness and performance.

**3. Separate gap_dismissals table.**
Instead of dismissedAt on insights, create a new table. Rejected — insights table already has dismissedAt; reusing it is simpler and idempotency-friendly.

**4. Regenerate all section lessons when a gap is fixed.**
Overkill. Only regenerate the section(s) teaching the root-cause concept. Justification: Graph-aware lesson generation reads learner facts at regeneration time, so all lessons are automatically personalized on next regen.

**5. Show top 3 gaps on dashboard instead of top 1.**
Tried in v0.2 prototypes. Too cluttered; learner didn't know which to act on first. Single prominent card is cleaner. "See other gaps" modal is the secondary affordance.

## Code paths (insertion points)

**In learn/src/routes/dashboard.ts:**
- Add `buildTopGaps()` function (calls gap-analyzer on-demand with 30-min cache, queries insights table for type='gap_analysis').
- Add gap card data to DashboardResponse.
- Update `/api/dashboard` GET to include gaps in the response.

**New route in learn/src/routes/learner.ts or new file learn/src/routes/gaps.ts:**
- `POST /api/learner/fix-gap` with { gapEntityId, sectionId } payload.
- Logic: Look up root-cause entity, find owning section, call generateLessonAuto with gapContext.
- Returns { ok, sectionId, messageOrError }.

**In learn/src/routes/sections.ts:**
- Add optional `gapContext` field to GenerateLessonOpts.
- Thread it into generateLessonAuto call (existing function signature must support it).

**In learn/src/agents/lesson-generator.ts:**
- Extend GenerateLessonOpts interface with optional gapContext: { gapEntityId, rootCauseEntityId, causalTrace }.
- Pass gapContext into buildContext() or thread into outliner input.

**In learn/src/viz/components/Dashboard.js:**
- Add GapCard component to DashboardCards.
- Render headline, one-liner, mini-flow (or ConceptMap if available), "Fix this" button.
- "See other gaps" link opens GapModal (new component) listing top 3.
- CTA calls POST /api/learner/fix-gap, then polls /api/sections/:id/lesson-status, navigates on ready.

**In learn/viz/index.html:**
- Add GapCard, GapModal component definitions (preact + htm).
- Wire CTA click handler to POST /api/learner/fix-gap.

**In learn/src/mcp/learning-mcp.ts:**
- Gap analysis already uses existing MCP tools (get_struggle_areas, get_prerequisite_chain, get_causal_learning_history).
- No new MCP tool needed; write_insight is already available.

**In learn/src/db/schema.ts:**
- No schema changes. The insights table already has the fields needed (type, dismissedAt, importance, relatedEntityIds, relatedSectionIds).

## Follow-up beads (do NOT create — list only)

- Inline dismissal and re-appearance logic: Learner dismisses gap; system monitors when the learner's facts on the root-cause concept improve significantly (confidence bump); re-surface the gap with "Great! You've fixed this gap" or "You're improving on this; keep going."
- Cross-section gap bridging: If a learner's gap spans two sections (X and Y, both teach the root-cause), suggest a learning path: "Fix this gap by doing X first, then Y."
- Gap patterns: Patrol agent detects recurring gap patterns ("this learner keeps struggling with recursion across three different courses") and suggests a foundational review course.
- Gap-triggered micro-lessons: Generate on-demand explainers (not full section regeneration) for gaps using the artifact-generator agent.
