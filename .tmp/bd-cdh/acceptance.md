# Acceptance Criteria

## Pass/Fail Bullets

1. **WebSearch tool available to prose writer**: Generating a lesson on a topic with current events (e.g. "WebGPU support in browsers June 2024") produces at least one prose block whose content references a websearch result, with a URL citation attached. PASS if lock.citations[0].url points to a live document and content echoes information from that document. FAIL if no citation or URL is dead.

2. **WebSearch disabled via env**: With LEARN_LESSON_WEBSEARCH=0 set, no Claude CLI invocation in the lesson pipeline is given access to WebSearch/WebFetch tools. Verify by intercepting --tools flag passed to claude executable; must be empty or absent. FAIL if --tools includes "WebSearch" or "WebFetch".

3. **Outliner can use WebSearch**: Outline generated for a rapidly-evolving topic (e.g. "React 19 features") includes prose/artifact items grounded in current state, not just parametric knowledge. Evidence: outline mentions specific API names, versions, or dates that match web search results. PASS if outline is dated/versioned. FAIL if generic or stale.

4. **Every cited URL ingested exactly once per lesson**: After lesson composition, URLs appearing in all lock.citations[] are POSTed to /ingest exactly once each, deduplicated by URL. Verify in logs: [lesson-ingest] ingested  appears once per unique URL. PASS if count matches deduplicated URL set. FAIL if any URL ingested 2+ times or some URLs missing.

5. **Ingest failure does not block lesson**: When POST /ingest returns 5xx or times out, lesson generation completes successfully. Learner receives full lesson with citations intact. Failure logged as warning, not surfaced to learner UI. Verify: lesson returned, citations present in blocks, error in server logs (not in response). FAIL if lesson fails or citations stripped.

6. **Source string convention followed**: Ingested content has source parameter matching learn:lesson:<sectionId>:websearch:<urlHash>. Verify in ingest call: ingestContent(text, "learn:lesson:..."). PASS if convention holds. FAIL if arbitrary or missing.

7. **Ingest result used for graph**: After ingest, returned { memoryId, entities, facts } are logged and entities are accessible via graph queries (e.g. next lesson's get_learner_understanding MCP call returns entities from ingested sources). Verify: entity from ingested URL appears in subsequent graph queries. PASS if entity ID is traceable. FAIL if entity lost or unreachable.

8. **Prose block citations schema**: Markdown blocks returned have optional citations?: {url, title?, accessedAt?}[]. Verify block structure: if 	ype === 'markdown', then citations field exists (or is undefined). PASS if schema matches. FAIL if missing or malformed.

9. **Artifact generator WebSearch only for freeform**: WebSearch is passed to artifact generator only when intent === 'free'. Fixed components (Mermaid, Callout, etc.) do NOT receive --tools WebSearch. Verify: check 	ools passed to each artifact agent call; intent === 'fixed' → 	ools: 'none', intent === 'free' → 	ools: 'WebSearch,WebFetch'. PASS if conditional holds. FAIL if web tools passed to fixed components.

10. **Search cap enforced**: Set LEARN_LESSON_WEBSEARCH_MAX_SEARCHES=1. Generate lesson naturally requiring 3+ searches. Assert: orchestrator tracks searchCount, rejects new searches after limit. Lesson still completes (no web on rejected attempts). Verify logs: [lesson-gen] search budget exhausted or similar. PASS if cap held. FAIL if searches exceed limit or lesson fails.

11. **Per-block fetch latency acceptable**: Prose writer WebFetch for a single URL completes in <10 seconds. Verify wall-clock time between agent start and WebFetch completion. PASS if <10s. FAIL if >30s (indicates unacceptable slowdown).

12. **Fallback to parametric when WebSearch empty**: Prose block where WebSearch returns no relevant results still generates valid prose using parametric knowledge alone. Content is coherent and marked (logged) as unverified. Verify: block returned, content reasonable. PASS if lesson completes. FAIL if block empty or error thrown.
