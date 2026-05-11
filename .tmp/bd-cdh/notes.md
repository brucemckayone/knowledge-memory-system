# Notes: Risks, Open Questions, Alternatives, Code Paths

## Risks

### 1. Hallucinated citations
**Risk**: Agent cites a URL that doesn't exist or doesn't contain the content it claims. Learner clicks dead link or finds mismatched content. Ingest also fails on fetch, leaving hole in graph.

**Mitigation**: 
- Prose writer system prompt: "If you cite a URL, you MUST have called WebFetch on it and seen the content. Never cite URLs you haven't fetched."
- Orchestrator verifies each citation by calling WebFetch before ingest; fail-gracefully if fetch fails.
- Long-term: add a fact to the graph linking ingested content back to original URL + timestamp for debuggability.

### 2. Paywalled / protected content
**Risk**: WebFetch retrieves paywalled article (e.g. Medium paywall, academic database, GitHub gist behind auth) and agents cite it. Learner can't access. Ingest may contain incomplete text.

**Mitigation**:
- Agent system prompt: "Prefer open/public resources. If you access restricted content, mark it in the block: [behind paywall]."
- Verify response headers for 401/403 during fetch; skip ingest if auth required.
- Ingest what's available (abstract, intro) but tag it as partial in the graph.

### 3. LLM judging its own sources
**Risk**: Agent runs WebSearch, sees results, trusts its own selection without human curation. Low-quality or misleading content gets ingested and becomes "truth" in the graph.

**Mitigation**:
- System prompt emphasizes source credibility: "Prefer official docs, peer-reviewed sources, or widely-cited references. Avoid user forums, Reddit, Stack Overflow unless high-signal."
- Ingest sources are tagged with lesson context (can be audited later).
- Patrol agent can flag suspicious entities ingested from web sources for learner review.

### 4. Privacy of ingested content
**Risk**: Proprietary or sensitive content (e.g. a company's internal blog, confidential docs accidentally indexed) is ingested into Nmemo and linked to learners.

**Mitigation**:
- Robots.txt and X-Robots-Tag headers respected (via WebFetch library).
- Ingest source tag includes URL; operators can audit and purge if needed.
- Learner-facing: no ingested content appears in learner export without consent.

## Open Questions

### 1. Sync or async ingest?
**Question**: Should ingest happen during lesson generation (blocking) or async after the learner receives the lesson?

**Trade-offs**:
- Sync (current design): Lesson waits for ingest; latency +10-30s for 1-3 URLs. Ensures graph is consistent when lesson renders. Simpler orchestration.
- Async: Lesson returns immediately; background job ingests. Lower learner latency. But graph may lag (confusing if learner asks related question seconds later and graph hasn't caught up).

**Recommendation**: Start with sync; if wall-clock becomes unacceptable, add async with a note to learner ("this content will improve search results in 30s").

### 2. Per-stage or end-of-pipeline ingest?
**Question**: Ingest after prose finishes? Or only after composer?

**Trade-offs**:
- Per-stage: Each agent sees entities from prior stages immediately. But more ingest calls, higher cost.
- End-of-pipeline: Single batch ingest after all blocks done. Lower cost, simpler orchestration. But agents can't cross-pollinate (prose can't discover entity from artifact).

**Recommendation**: End-of-pipeline (stage 4 composer). Lesson coherence is more important than cross-stage graph awareness.

### 3. Cache WebFetch results for ingest reuse?
**Question**: If outliner calls WebFetch on a URL, should ingest-phase reuse the cached response instead of re-fetching?

**Trade-offs**:
- Reuse (cache 10 min): Fast ingest phase, avoids redundant network. But requires cache key & expiry logic.
- Re-fetch: Simpler, ensures fresh content, catches transient errors. But doubles network cost.

**Recommendation**: Implement cache at agent.ts layer; WebFetch results are memoized by URL for 10 min within a single lesson generation. Ingest phase checks cache before fetching.

### 4. Should ingest-back be learner-configurable?
**Question**: Can the learner opt out of web content being ingested into their graph?

**Trade-offs**:
- Opt-in: More privacy; learner controls what's ingested. But 90% won't change it (UX clutter).
- Opt-out: Default on; learner can disable in settings. Cleaner UX. Respect preference globally.

**Recommendation**: Default to ingest; add LEARN_DISABLE_INGEST env flag + future UI toggle. No learner prompt per lesson (too noisy).

## Alternatives Considered

### 1. Dedicated research stage
**Alternative**: Insert a new stage 0: "Research Agent" runs WebSearch once per lesson, synthesizes findings, passes a "research brief" to outliner.

**Why not**: Adds latency (another agent turn), complexity (new state threading). Outliner already does research naturally when generating outline items. Per-stage WebSearch is more flexible and fault-tolerant (if outliner fails, prose still has access).

### 2. Learner-controlled sources
**Alternative**: Learner specifies URLs/docs to cite in a lesson; agent prioritizes them.

**Why not**: Out of scope for this bead (lesson generation, not content curation). Future bead for learner-provided materials.

### 3. Ingest only high-confidence sources
**Alternative**: Agent assigns confidence to each WebFetch result; only ingest if confidence > 0.7.

**Why not**: Overcomplicates orchestration. Better to ingest everything and let the graph's own fact-deduplication and contradiction detection handle quality.

## Code Paths (File:Line)

### agent.ts — Extend tools parameter
- **File**: learn/src/services/agent.ts
- **Lines**: 42-50 (AgentOptions interface), 59-95 (buildArgs function)
- **Change**: Parse composite 	ools string; pass --tools 'WebSearch,WebFetch' to Claude CLI when requested.

### lesson-outliner.ts — Add WebSearch to system prompt
- **File**: learn/src/agents/lesson-outliner.ts
- **Lines**: 72-155 (SYSTEM_PROMPT)
- **Change**: Clarify when WebSearch is worth calling; instruct agent to mark queries in outline with [via websearch] flag for logging.

### lesson-prose.ts — Add WebSearch to system prompt & cite
- **File**: learn/src/agents/lesson-prose.ts
- **Lines**: 25-48 (SYSTEM_PROMPT), 100-116 (parseLoose)
- **Change**: Instruct agent to output [CITATIONS] {...} JSON block after markdown. Extend output parser to extract citations.

### artifact-generator.ts — Conditionally enable WebSearch
- **File**: learn/src/agents/artifact-generator.ts
- **Lines**: 389-399 (generateArtifact function)
- **Change**: Pass 	ools: input.intent === 'free' ? 'WebSearch,WebFetch' : 'none' to runAgent.

### lesson-generator.ts — Orchestrate ingest & track state
- **File**: learn/src/agents/lesson-generator.ts
- **Lines**: 376-443 (generateLessonStructuredV3)
- **Change**: Add esearch state object tracking search count & URLs. After compose, call ingestLessonSources() (new function). Handle failures gracefully.

### nmemo-client.ts — Already supports ingest
- **File**: learn/src/services/nmemo-client.ts
- **Lines**: 72-74 (ingestContent function)
- **Status**: No change needed; already returns { memoryId, entities, facts }.

### lesson-generator.ts — New ingestLessonSources function
- **File**: learn/src/agents/lesson-generator.ts (append after line 370)
- **New function**: ingestLessonSources(sectionId: string, blocks: LessonBlock[]): Promise<{...}>
- **Responsibilities**: Collect URLs from citations, deduplicate, fetch via WebFetch, call ingestContent, log results.

### lesson-generator.ts — Extend LessonBlock schema
- **File**: learn/src/agents/lesson-generator.ts
- **Lines**: 50-52 (LessonBlock type)
- **Change**: Add citations?: Array<{url: string; title?: string; accessedAt?: string}> to markdown variant.

## Follow-Up Beads

1. **Prompt caching for lesson agents**: Outline + prose system prompts are large (1-2 KB each) and are called repeatedly. Use Claude API prompt caching to reduce cost.

2. **Async ingest queue**: If sync ingest latency becomes problematic, implement async queue (POST to /ingest/queue instead of /ingest).

3. **Web sources audit log**: Build a learner-facing UI to browse all web sources ingested across their lessons. Link to the lessons that cited them; see entities created.

4. **Patrol agent web monitoring**: Extend patrol agent to detect out-of-date web content (URL gone 404, content changed) and surface as decay candidate to learner.

5. **Multi-modal artifacts**: Extend artifact generator to embed images from WebFetch results (e.g. screenshot of live API docs, animated GIF from tutorial).
