# nmemo-3va: Cross-Course Intelligence — Description

## Vision asks
The platform architecture identifies two demonstrable "moments" where cross-course learning surfaces:
- **Connection moment**: "You saw this idea before in another course." When a learner enters a section whose concepts overlap (direct entity match OR semantic equivalence via same_as links) with concepts they've encountered elsewhere, a persistent signal should prompt recognition and transfer.
- **Synthesis moment**: When concepts from multiple courses co-occur in dense clusters or fact graphs, a synthesis article bridges the domains, showing how the same pattern manifests differently (e.g., recursion in JS, Rust, and dynamic programming all share stack-frame substructure).

## What's there today
- **Patrol agent** runs periodically, writing `cross_course_link` insights (identifying overlaps) and `synthesis_candidate` insights (flagging dense clusters).
- **Article-generator agent** can produce synthesis articles mapping concepts across courses.
- **Platform data layer** exposes:
  - `/api/learn/same-as-concepts` — returns concept pairs with semantic equivalence, confidence, and reasoning.
  - `/api/learn/concept-clusters` — returns dense connected components of co-occurring concepts (BFS-based, size ≥ 3).
  - `sameAsLinks` table stores bidirectional semantic links with confidence scores.
- **Viz bridge UI** (`loadCrossCourseBridge` in viz/index.html) surfaces a small card at the top of section pages showing adjacent course links.
- **Dashboard cards** list insights and articles, but require active navigation.

## What's thin
1. **Bridge visibility**: The existing bridge card is easy to miss on section pages. It lacks richness — doesn't name the prior course, prior concept name(s) for same_as overlaps, or confidence. No affordance to explain the mapping inline (learner sees "overlap detected" but not *why* or *how*).
2. **Synthesis reach**: Synthesis articles live as dashboard cards; no signal from the section page itself. A learner visiting a section that participates in a dense cluster won't discover the synthesis article without actively visiting the dashboard.
3. **Cold-start friction**: Learners new to multi-course study won't see connection moments at all.
4. **Same-as transparency**: Direct overlaps (same entity) and semantic equivalence (different entities, different names) blend together in the UI. The distinction matters for confidence calibration — "closure" and "move closure" are *named* differently in different courses, requiring richer labeling.

## Design scope
- **UI enrichment** on section pages: richer bridge card, inline explainer on demand, synthesis affordance.
- **New routes** supporting explainer calls and section-to-articles mapping.
- **Connection banner** above lessons when learner has prior cross-course history with the section's concepts.
- **Lazy-loaded bridge UI** per section (cache at dashboard endpoint, fetch as needed per section).
- **Performance** considerations: same-as and cluster queries are platform calls; recommend caching and lazy-load strategies.
- **Out of scope**: Patrol/article-generator logic, detection threshold improvements, new entity resolution algorithms.

~500 words
