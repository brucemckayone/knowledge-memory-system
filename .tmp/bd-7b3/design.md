# Gap Analysis UI — Design

## 1. Where the surface lives

Recommendation: Both dashboard card and inline section-page card.

Per v0.3 carving rule, the gap surface must pull the learner toward lessons, not away.

Dashboard "Top gap" card: Primary surface. Learner lands on dashboard first. Prominently display the most recent high-impact gap (importance >= 0.6) with a "Fix this gap" CTA. Justifies itself as "here's what's blocking you most".

Section-page inline card: Secondary surface. When a section's conceptEntityIds overlap the gap's root-cause concept, render a "Why this matters for you" card inline at the top of the lesson. Grounding: "This section teaches X, which directly fixes the gap in your understanding of Y."

## 2. Card content

Each gap card renders:

1. Headline: The target concept and gap description. E.g. "Gap: You're struggling with closures because you missed scope chains."
2. One-line why: From the causal trace. E.g. "This blocks your understanding of callback patterns."
3. Prerequisite chain mini-flow: Use ConceptMap component or render a readable text flow. Highlight the root-cause concept.
4. "Fix this" CTA: Button that initiates lesson regeneration and navigates to the section.

## 3. 'Fix this' CTA mechanics

Route: POST /api/learner/fix-gap

Payload:
{
  "gapEntityId": "nmemo-entity-id",
  "sectionId": "learn-section-id"
}

Execution:
1. Look up the section owning the root-cause concept via conceptEntityIds matching.
2. Trigger generateLessonAuto(sectionId, { mode: 'regenerate', gapContext }) so the lesson-generator biases the outline toward the gap.
3. Poll GET /api/sections/:id/lesson-status until status === 'ready'.
4. Navigate to /section/:id.

## 4. Persistence so gaps don't re-surface unchanged

Recommendation: Augment the existing insights table with type='gap_analysis'.

Gaps are diagnostic findings. The insights table has idempotencyKey (prevents duplicates), dismissedAt (learner can dismiss), and importance (rank by impact).

Schema: No new table. Gaps recorded via write_insight MCP tool with:
- type: "gap_analysis"
- title: "Gap: [concept] — [one-line reason]"
- content_md: causal trace and root-cause explanation
- related_entity_ids: ["root-cause-entity-id"]
- related_section_ids: ["section-id"]
- importance: 0.7 or similar

The idempotency key is sha256("gap_analysis" | sorted([root-cause-entity-id])).

Implications for cron:

Gap-analyzer should run on-demand from the dashboard fetch path, not on patrol cron. It's expensive (~10-15 sec). Soft cache: fetch the most recent type='gap_analysis' insight. If younger than 30 min and not dismissed, return it. Otherwise trigger async fresh run and return cached result.

## 5. Surfacing top N

Dashboard shows the top 1 gap (highest importance, not dismissed).

Secondary affordance: "See other gaps" link (if 2+ gaps exist) opens a modal listing top 3.

Rationale: One prominent card is clean. Learners see *the* thing blocking them.

## 6. Cold-start: insufficient facts

Threshold: >= 10 learner facts in the graph.

When count(learner_facts) < 10:
- Don't call the gap-analyzer.
- Hide the "Top gap" card.
- Show placeholder: "Complete a quiz to surface gaps" with link to daily quiz.

Justification: The gap-analyzer needs signal. Fewer than 10 facts means insufficient interaction.

## 7. Tests

1. Happy path: Gap surfaces, card renders, "Fix this" regenerates and navigates to section.
2. Cold-start: No card; placeholder shown. After quiz, card appears.
3. Regeneration with gap context: Section outline contains remedial item targeting the gap.
4. Multiple gaps: "See other gaps" modal lists top 3.
5. Idempotency: Two gap-analyzer runs create one insight record.
6. Cross-section gaps: Multiple sections teach the concept; earliest is selected.
