# nmemo-3va: Cross-Course Intelligence — Design Specification

## 1. Bridge enrichment on section pages

**Current state**: `loadCrossCourseBridge()` in viz/index.html fetches cross-course links and renders a minimal card.

**Spec**: Expand the bridge card to include:
- **Prior course title** (e.g., "JavaScript Fundamentals", from courseId in concept metadata).
- **Concept name(s)** from the prior course: for same_as overlaps, display both names (e.g., "in JavaScript this is called 'closures'; here it's 'lexical scoping'").
- **Overlap type**: distinguish visual markers for direct (same entity) vs. semantic (same_as).
- **Confidence badge**: for same_as links, show confidence ≥ 0.7 (e.g., "87% match").
- **Explainer CTA**: "Show me the bridge" button that triggers an inline explainer fetch.

**Explainer endpoint**: 
- `POST /api/learn/explain-bridge` (or reuse `/api/explain` if it exists).
- Input: `{ conceptFromId: string; conceptToId: string; fromCourseName: string; toCourseName: string }`.
- Output: 1–2 paragraph explainer text mapping concept A to concept B with reasoning.
- **Implementation**: The explainer can invoke the existing reasoning agent in "bridge" mode (async MCP call returning structured mapping text).
- **Rendering**: Inline card body below the CTA; renders as a collapsible section with light background, max-height 300px, smooth expand/collapse.

**Card layout**:
```
┌─ Prior: JavaScript Fundamentals ─────────────────────┐
│ Concept: "closures" (confidence: 87%)                │
│ This course: "lexical scoping"                       │
│ [Overlap type: Semantic equivalence]                 │
│                                                       │
│ [Show me the bridge] (CTA button)                    │
│ ┌─ Explainer (collapsed by default) ────────────────┐ (expands on click)
│ │ In JavaScript, closures are functions that...     │
│ │ Here, lexical scoping refers to...                │
│ │ Both rely on: [mapping text]                       │
│ └────────────────────────────────────────────────────┘
└───────────────────────────────────────────────────────┘
```

---

## 2. Synthesis surfaces beyond dashboard

**Current state**: Synthesis articles live as dashboard cards; no link from section pages to synthesized content.

**Spec**:

### 2a. Synthesis article route
`GET /api/articles/by-section/:sectionId`
- Input: `sectionId` (or section's conceptEntityIds).
- Query: against `sameAsLinks` + `conceptClusters` to find articles whose `relatedEntityIds` (stored in articles table) overlap with the section's concepts.
- Output: `{ articles: [{ id, title, clusterEntityIds, confidence, generatedAt }] }`.
- **Caching**: cache at dashboard composite endpoint for 24h; lazy-load per section on demand.

### 2b. Section page affordance
If `/api/articles/by-section/:sectionId` returns articles, display a card below the bridge:
```
┌─ Synthesis Available ───────────────────────────────┐
│ "Recursive Substructure Across JS, Rust & DP"      │
│ Explores how recursion patterns unify three domains.│
│                                                      │
│ [Read synthesis] [Generate new]                     │
└────────────────────────────────────────────────────┘
```

**Generate on-demand**: If no existing synthesis article matches, "Generate new" button:
- Triggers `POST /api/articles/generate` with section's conceptEntityIds + learnerHistory.
- Returns article object on success; 202 Accepted if async.
- UX: button transitions to "Generating..." spinner (3–5s typical), then updates card with new article link.

### 2c. Article storage
Minimal articles table (extend if needed):
```
id | title | clusterEntityIds (json) | relatedSectionIds (json) | generatedAt | confidence
```
Patrol/article-generator writes here; section page queries for overlap.

---

## 3. Connection moment affordance

**Spec**: When a learner enters a section AND has prior enrollment/activity in another course that contains a same_as or direct overlap concept, display a banner above the lesson:

```
┌─ You've seen these ideas before ─────────────────┐
│ In "JavaScript Fundamentals" (3 weeks ago)       │
│ [Expand] [Dismiss]                               │
└─────────────────────────────────────────────────┘
```

**Implementation**:
- Requires learner history: courses previously visited, concepts seen, timestamps.
- On section page load, query `/api/learn/learner-concept-history?learnerId=X` (new endpoint).
- Cross-reference section's conceptEntityIds against learner's prior concepts.
- If match found (same_as or direct), show banner. Click "Expand" to show bridge card above (reuse bridge UI).

**Data**: Learner concept history table (new or extend learner table):
```
learnerId | conceptEntityId | courseId | viewedAt | confidence
```
Populated by patrol or section page view events.

---

## 4. Same-as visibility

**Spec**: Distinguish direct overlaps from semantic equivalence in all bridge/connection UI:

**Direct (same entity)**:
- Pill badge: "Same concept across courses"
- Display: "[Course A] Concept: Closure" → "[Course B] Concept: Closure"
- No names differ; confidence reflects enrollment/activity alignment.

**Same-as (semantic equivalence, different names)**:
- Pill badge: "Semantically equivalent"
- Display: "[Course A] Concept: **Closure**" → "[Course B] Concept: **Lexical Scoping**"
- Color highlight on differing names; show confidence separately (e.g., "87% match").

**Rendering**: Use distinct icon/color; explainer always runs to justify the mapping.

---

## 5. Performance

**Caching strategy**:
- **Dashboard composite**: Cache `/api/learn/same-as-concepts` + `/api/learn/concept-clusters` at 24h TTL.
- **Section bridge**: Lazy-load per section (not on dashboard load). Query same-as + learner history in parallel.
- **Explainer calls**: Cache explainer output per (conceptFromId, conceptToId) pair at 72h TTL (explainers are stable).

**Lazy loading**:
- Load bridge card only when section page scroll enters viewport (Intersection Observer).
- Load synthesis affordance on section init (separate from bridge; quick query).

**DB optimization**:
- Index `sameAsLinks(entity_a_id, entity_b_id, confidence)` for fast same-as lookups.
- Index `concepts(courseId, conceptName)` for reverse lookups.
- Concept cluster query already limits to 50 clusters; acceptable latency for 30-day lookback.

---

## 6. Tests

- **Connection banner cold-start**: Learner with no prior course history views a section; no banner displayed. ✓
- **Connection banner multi-course**: Learner has touched Course A + Course B; opens section in Course B with same_as overlap to Course A concept; banner shows Course A name. ✓
- **Bridge card same-as rendering**: Section page shows bridge card with both concept names, confidence ≥ 0.7, "Semantically equivalent" badge. ✓
- **Explainer inline fetch**: Click "Show me the bridge" → POST /api/learn/explain-bridge succeeds within 2s; renders 1–2 paragraphs inline. ✓
- **Synthesis affordance present**: Section whose concepts overlap a cluster (size ≥ 3) shows "Synthesis available" card with existing article link. ✓
- **Synthesis generate on-demand**: Click "Generate new" → POST /api/articles/generate with conceptIds; returns article within 5s; section page updates. ✓

~900 words
