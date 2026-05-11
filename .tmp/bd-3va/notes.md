# nmemo-3va: Cross-Course Intelligence — Notes, Risks & Open Questions

## Risks

### False-positive same_as detection
- **Risk**: Patrol reasoning agent may incorrectly flag semantically similar concepts as same_as (e.g., "array" and "list" in different languages).
- **Impact**: Learner sees a mapping that feels wrong, erodes trust in bridge UX.
- **Mitigation**: Require confidence ≥ 0.7 before surfacing; explainer always runs inline to show reasoning; add learner feedback ("this mapping is wrong") to retrain patrol.
- **Follow-up bead**: Confidence calibration / feedback loop for patrol's same_as detection.

### Banner and bridge card clutter
- **Risk**: If a learner has touched 5+ courses and many concepts have cross-course overlaps, every section page may be crowded with banners and multiple bridge cards.
- **Impact**: Visual noise; learner dismisses all banners, losing value.
- **Mitigation**: Limit banner to top 1–3 most recent/confident overlaps; collapse multiple bridge cards into a single "X overlaps found" summary that expands on demand.
- **Alternative**: Learner preference: "Show me connection moments" toggle in settings.

### Article generation cost and latency
- **Risk**: Generating synthesis articles on demand (POST /api/articles/generate) may be slow (5–15s) or expensive (MCP calls, LLM inference).
- **Impact**: UX stalls; user clicks "Generate" and waits or navigates away; article generated but user never sees it.
- **Mitigation**: Queue generation as async job; return 202 Accepted; provide polling endpoint to check status; FE shows "Generating... this may take 30s" with cancel button.
- **Alternative**: Pre-generate synthesis articles for top N clusters on patrol cycle, surface from dashboard.

### Learner history table performance
- **Risk**: If learner-concept-history table grows unbounded (every page view = new row), queries on banner load may slow down.
- **Impact**: Section page load delays.
- **Mitigation**: Archive stale rows (> 90 days old); aggregate per learner, per course, store only "last viewed" timestamp; index learnerId + courseId + conceptId.

---

## Open Questions

### Per-cluster vs. per-pair synthesis articles
- **Q**: Should we generate one synthesis article per dense cluster (e.g., "Recursion in JS, Rust, DP"), or one article per learner's unique pair of courses they're currently taking?
- **Implication**: Per-cluster is more efficient (reusable); per-pair is more personalized.
- **Decision needed**: Design decision before implementation. Recommend per-cluster + learner-contextualized summary in explainer.

### Cache invalidation on patrol writes
- **Q**: When patrol writes new same_as links or discovers a new cluster, how do we invalidate the cache for affected sections?
- **Implication**: Cache TTL (24h) vs. event-driven invalidation (publish event when same_as link is written, invalidate relevant sections).
- **Decision needed**: Trade-off between cache efficiency and freshness. Recommend 24h TTL + optional webhook for invalidation if patrol writes are frequent.

### Multi-overlap rendering UX
- **Q**: If a section has 3+ overlaps to different prior courses, do we show:
  - (a) 3 separate bridge cards (cluttered)?
  - (b) One "3 overlaps detected" card with expandable list?
  - (c) Tabs to switch between overlaps?
- **Decision needed**: Design review required. Recommend (b) initially; expand to tabs if volume warrants.

### Learner history granularity
- **Q**: Should we track every page view, or only "first view of concept" per learner per course?
- **Implication**: Granular history = more storage, better journey reconstruction; coarse history = less storage, faster queries.
- **Decision needed**: Start with coarse (first view + last view); add granularity if needed for analytics.

### Same-as symmetry
- **Q**: Are same_as links stored as bidirectional (A ↔ B) or unidirectional (A → B)?
- **Implication**: Affects query design and duplicate detection in bridge UI.
- **Decision needed**: Check current sameAsLinks table schema. Assume bidirectional; handle duplication in query.

---

## Alternatives Considered

### Banner as floating widget
- Instead of a fixed banner above the lesson, render the connection moment as a floating widget (bottom-right corner, dismissible).
- **Pro**: Less obtrusive; learner initiates interaction.
- **Con**: Easy to miss; takes longer to notice.
- **Status**: Rejected in favor of banner (more salient).

### Synthesis articles per section, not per cluster
- Generate one synthesis article per section (summarizing all clusters the section participates in), not one per cluster.
- **Pro**: Simpler generation (fewer articles); more section-specific.
- **Con**: Duplicates content (same cluster, multiple sections); harder to maintain.
- **Status**: Rejected in favor of per-cluster.

### One-click explainer (no CTA)
- Show explainer by default in bridge card (expanded), not collapsed behind a CTA.
- **Pro**: No extra click; learner sees mapping logic immediately.
- **Con**: Clutters card; may slow page load if explainer is slow.
- **Status**: Rejected; explainer as CTA is better (on-demand, responsive).

---

## Code Paths & Entry Points

### Section page load
```
1. GET /learn/section/:sectionId
2. FE fetches section.conceptEntityIds
3. FE calls GET /api/learn/learner-concept-history?learnerId=X (banner check)
4. FE calls GET /api/learn/same-as-concepts?conceptIds=[...] (bridge card data)
5. FE calls GET /api/learn/concept-clusters?lookback_days=30 (synthesis check)
6. FE calls GET /api/articles/by-section/:sectionId (existing articles)
7. Render banner, bridge cards, synthesis affordance
```

### Bridge card CTA click
```
1. User clicks "Show me the bridge"
2. FE calls POST /api/learn/explain-bridge with conceptFromId, conceptToId, courseNames
3. BE invokes reasoning agent (MCP call) with bridge context
4. FE renders response inline, collapsible
5. FE caches response per (conceptFromId, conceptToId) for 72h
```

### Synthesis generate on-demand
```
1. User clicks "Generate new" in synthesis card
2. FE calls POST /api/articles/generate with conceptEntityIds, learnerHistory
3. BE queues async MCP call to article-generator agent
4. FE polls GET /api/articles/generate/:jobId for status
5. On completion, FE refreshes synthesis card with new article link
```

---

## Follow-up Beads

1. **nmemo-3va-perf**: Benchmark bridge + explainer latency under load; optimize queries and caching.
2. **nmemo-3va-feedback**: Add learner feedback loop ("this mapping is wrong") to retrain patrol's same_as detection.
3. **nmemo-3va-cluster-viz**: Visualize concept clusters on a new cluster dashboard; show synthesis articles per cluster.
4. **nmemo-3va-multi-course-nav**: Recommend sections from other courses based on connection moments.
5. **nmemo-3va-settings**: Learner preference: "Show connection moments" toggle, explainer verbosity control.
6. **nmemo-patrol-calibration**: Improve patrol's same_as confidence scoring using learner feedback + ground truth.

---

## Unknowns

- Patrol reasoning agent implementation details (external, internal, async?).
- Current article-generator capability (speed, quality, multi-cluster support?).
- Existing learner history tracking (does it exist? granularity?).
- Explainer agent mode / MCP interface (how to invoke? parameters?).
- Database indexes on sameAsLinks and concepts tables (current state?).

**Action**: Clarify during design review / kickoff.
