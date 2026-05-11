# nmemo-3va: Cross-Course Intelligence — Acceptance Criteria

## Bridge Card Enrichment

- **AC1: Bridge card appears on section page load**  
  Opening a section page triggers bridge card rendering within 500ms. Card is visible above the lesson content, not collapsed or hidden by default.

- **AC2: Same-as overlaps show both concept names**  
  When a section's concept has a same_as link to a concept in a prior course, the bridge card displays both names (e.g., "[Course X] 'closures' → [Course Y] 'lexical scoping'"). Names are visually distinct (bold or color-highlighted).

- **AC3: Confidence badge appears for same_as links**  
  Same-as overlaps with confidence ≥ 0.7 show a confidence badge (e.g., "87% match"). Confidence < 0.7 is silently filtered (not displayed).

- **AC4: Direct overlaps show single name**  
  When a section's concept is the same entity across courses (direct overlap, no same_as distinction), the bridge card displays a single concept name with an "Identical concept" badge.

- **AC5: Show-me-the-bridge CTA fetches and renders explainer**  
  Clicking "Show me the bridge" button triggers POST /api/learn/explain-bridge with conceptFromId, conceptToId, courseNames. Explainer returns within 2s; renders inline as 1–2 paragraphs below the CTA in a collapsible section (max-height 300px, smooth expand/collapse).

- **AC6: Prior course title is shown**  
  Bridge card header displays the prior course name (e.g., "Prior: JavaScript Fundamentals"). Prior course name is derived from courseId in concept metadata.

---

## Connection Moment Banner

- **AC7: Banner appears for multi-course learner with overlap**  
  A learner who has enrolled in or visited Course A, then opens a section in Course B where the section's concepts have same_as or direct overlaps to Course A concepts, sees a banner: "You've seen these ideas before in [Course A name] (X weeks ago)". Banner appears above the lesson content.

- **AC8: Banner does not appear for single-course learner (cold start)**  
  A learner who has only visited one course, or has no prior cross-course concept overlap, does not see the connection banner when opening a section.

- **AC9: Banner dismiss persists per session**  
  Clicking "Dismiss" on the banner hides it for the remainder of the session. On page reload, banner re-appears if criteria are met.

- **AC10: Banner expand shows bridge UI**  
  Clicking "Expand" on the banner reveals the full bridge card (reusing the bridge UI from AC5).

---

## Synthesis Affordance

- **AC11: Synthesis card appears for sections overlapping a dense cluster**  
  A section whose concepts participate in a concept cluster (size ≥ 3, from /api/learn/concept-clusters) displays a "Synthesis available" card below the bridge card. Card shows the synthesis article title and a short description (e.g., "Explores how recursion patterns unify three domains").

- **AC12: Synthesis card links to existing article**  
  If a synthesis article exists for the cluster (articles table has relatedEntityIds overlapping section's concepts), the card displays a "[Read synthesis]" link that navigates to the article.

- **AC13: Generate synthesis on demand**  
  If no existing article matches, the "Synthesis available" card shows a "[Generate new]" button. Clicking it triggers POST /api/articles/generate with the section's conceptEntityIds and learnerHistory. The button transitions to "Generating..." state; on success (within 5s typical), the card updates to show the new article link.

- **AC14: Articles are retrieved by section**  
  GET /api/articles/by-section/:sectionId returns a list of articles whose relatedEntityIds overlap with the section's conceptEntityIds. Returns empty array if no overlap.

---

## Same-as Visibility

- **AC15: Semantic equivalence is clearly labeled**  
  Bridge cards showing same_as overlaps include a visual label or badge ("Semantically equivalent") distinct from direct overlaps ("Same concept across courses").

- **AC16: Confidence score is visible for same_as**  
  Same-as overlaps display confidence as a percentage (e.g., "87% match"); direct overlaps do not show a separate confidence score.

---

## Performance & Data

- **AC17: Bridge lazy-loads per section (not on dashboard init)**  
  Opening a section page queries same-as links and learner history only for that section's concepts, not for all sections. Dashboard load does not pre-fetch all bridge data.

- **AC18: Explainer caching works**  
  Calling GET /api/learn/explain-bridge/:conceptFromId/:conceptToId twice within 72h returns consistent results without re-invoking the reasoning agent. Cache key is (conceptFromId, conceptToId).

- **AC19: Connection banner does not surface for cold-start**  
  A learner with no prior course enrollment/activity (first login) does not see the connection banner when opening their first section.

---

## Edge Cases & Robustness

- **AC20: Multiple overlaps handled**  
  A section with multiple same_as or direct overlaps to different prior courses shows multiple bridge cards, one per overlap. Ordering: by confidence (highest first).

- **AC21: Explainer failure graceful**  
  If POST /api/learn/explain-bridge fails (503, timeout), the bridge card still renders core info (course name, concept names, confidence); CTA shows "Learn more" disabled with tooltip "Explainer temporarily unavailable".

- **AC22: Missing learner history doesn't break banner**  
  If /api/learn/learner-concept-history returns an empty result, no banner appears, but page loads without error. No degradation to section view.

---

## Verification
- All 22 ACs must pass integration tests before merge.
- Load tests: bridge card + explainer under 250 concurrent users, p95 latency ≤ 1.5s.
