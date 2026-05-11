# Acceptance Criteria — nmemo-7b3

1. Dashboard renders a "Top gap" card whenever the gap-analyzer's most recent run produced a gap with importance >= 0.6 and dismissedAt is null.

2. The gap card displays the gap headline (target concept + one-line root cause), a readable prerequisite chain representation, and a "Fix this gap" button.

3. Clicking "Fix this gap" calls POST /api/learner/fix-gap with gapEntityId and sectionId, which triggers generateLessonAuto(sectionId, { mode: 'regenerate', gapContext: {gapEntityId, rootCauseEntityId, causalTrace} }).

4. After regeneration completes (lessonStatus='ready'), the UI navigates to /section/:sectionId and displays the regenerated lesson.

5. The regenerated lesson's outline contains at least one prose item whose intent field mentions the root-cause concept name, and the prose markdown produced for that item contains the concept name.

6. Dismissing a gap insight sets dismissedAt to the current timestamp; the gap card is hidden and does not re-surface until dismissedAt is cleared.

7. Cold-start (< 10 learner facts): The "Top gap" card is hidden; a placeholder card shows "Complete a quiz to surface gaps" with a link to the daily quiz.

8. Gap insights are stored via the insights table with type='gap_analysis' and use idempotency keys (sha256 of type + sorted root-cause entity IDs) to prevent duplicate records.

9. The dashboard fetch path runs the gap-analyzer on-demand with a 30-minute soft cache: if a fresh gap_analysis insight exists and is younger than 30 min, return it; otherwise trigger async generation.

10. If multiple gap_analysis insights exist (not dismissed), a "See other gaps" link appears on the dashboard card; clicking it opens a modal listing top 3 gaps.

11. If the gap's root-cause entity is taught in multiple sections, the earliest section (by orderIndex) is selected for regeneration.

12. If regeneration or section lookup fails, a toast error is shown and the learner remains on the dashboard; lesson generation MUST NOT block on platform errors.

13. The "Top gap" card also appears inline at the top of section pages when the section's conceptEntityIds overlap the gap's root-cause entity.

14. All gap analysis insights (type='gap_analysis') are queryable via the dashboard insights feed and support dismissal from both dashboard card and "See other gaps" modal.
