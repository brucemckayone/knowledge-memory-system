# Design: WebSearch & Ingest Loop for Lesson Agents

## 1. Websearch Coverage by Lesson Stage

### Outliner (enable WebSearch only)
- **Why**: Breadth over depth. The outliner must decide *which topics* to teach; WebSearch helps discover current frameworks, recent API changes, and trending approaches.
- **Cost/benefit**: Single call, ~1-2 min wall-clock, ~200 output tokens. Informs 8-12 outline items. High leverage.
- **Decision rule**: Enable by default when section title or objectives contain keywords (e.g. "latest", "WebGPU", "2024", or match a curated "fast-moving" topic list).

### Prose Writer (enable WebSearch + WebFetch)
- **Why**: Accuracy on factual claims. Each prose block can pull current documentation to verify API signatures, feature status, code examples.
- **Cost/benefit**: Per-block cost (15-30s each) is acceptable because we have ~4-6 prose blocks in parallel. WebFetch is lightweight (cached); WebSearch is heavier (~5-15s).
- **Decision rule**: Enabled by default. Prose writer's system prompt instructs it to call WebSearch for: version numbers, API stability status, deprecated features, new releases mentioned by section title.

### Artifact Generator (enable WebSearch + WebFetch for freeform only)
- **Why**: Interactive code examples need real libraries, correct syntax, current best practices. Fixed components (Mermaid, Callout, etc.) are too constrained; freeform artifacts benefit most.
- **Cost/benefit**: Artifact generation is already 3-8 min; adding 5-15s for research is acceptable. Verification pass can reuse cached results.
- **Decision rule**: Enabled only when artifact intent === 'free'. Disabled for fixed kinds to keep compose latency predictable.

### Global cap
Max 3-5 WebSearch calls per lesson (aggregated across all stages). Rationale: 5 searches × 10s avg = 50s per lesson on research; beyond that, cost outweighs benefit and learner wait-time becomes frustrating. Enforcement: track searchCount in orchestrator state, decline new searches if exceeded.

## 2. Extension of agent.ts to Permit Web Tools

### Current signature (line 42-50)
`	ypescript
export interface AgentOptions {
  model?: AgentModel;
  effort?: AgentEffort;
  systemPrompt?: string;
  mcpConfigPath?: string;
  mcpServerName?: string;
  maxTurns?: number;
  timeoutMs?: number;
  tools?: 'none' | 'mcp' | string;  // ← string permits arbitrary --tools arg
}
`

### Proposed behavior
- 	ools: 'none' → pass --tools '' (current)
- 	ools: 'mcp' → pass --mcp-config … + --tools mcp__learn__* (current)
- 	ools: 'WebSearch,WebFetch' → pass --tools 'WebSearch,WebFetch' (new)
- 	ools: 'WebSearch,WebFetch,mcp' → pass both --tools 'WebSearch,WebFetch' --mcp-config … (future)

### Implementation in buildArgs() (line 59-95)
`	ypescript
const tools = opts.tools ?? 'none';
if (tools === 'mcp') {
  // MCP tools, no --tools flag
} else if (tools === 'none') {
  cmd.push('--tools', '');
} else if (tools.includes(',')) {
  // Composite: "WebSearch,WebFetch" or "WebSearch,WebFetch,mcp"
  const parts = tools.split(',').map(s => s.trim());
  const webTools = parts.filter(p => /^(WebSearch|WebFetch)$/.test(p)).join(',');
  const hasMcp = parts.includes('mcp');
  
  if (webTools) cmd.push('--tools', webTools);
  if (hasMcp) { /* add MCP config */ }
} else {
  // Bare string: pass as-is for forward compatibility
  cmd.push('--tools', tools);
}
`

## 3. Source Attribution in Lesson Blocks

### Current LessonBlock schema
`	ypescript
type LessonBlock =
  | { type: 'markdown'; content: string }
  | { type: 'component'; kind: string; props: Record<string, unknown>; children?: string };
`

### Extended schema
`	ypescript
export interface LessonCitation {
  url: string;
  title?: string;        // Document title from WebFetch or search result
  accessedAt?: string;   // ISO timestamp when content was fetched
}

type LessonBlock =
  | { type: 'markdown'; content: string; citations?: LessonCitation[] }
  | { type: 'component'; kind: string; props: Record<string, unknown>; children?: string; citations?: LessonCitation[] };
`

### Prose writer contract
System prompt instructs: "If you use WebSearch or WebFetch results in your markdown, append a JSON metadata block at the end of your output (outside the markdown block): [CITATIONS] {...}. Include every URL you cite inline or implicitly pull from." The prose writer's output parser extracts this and populates citations[].

### Ingest-back uses citation
When collecting content to ingest (step 4 below), the orchestrator queries all citations from all blocks and deduplicates by URL before fetching and ingesting.

## 4. Ingest-Back Logic — URLs → Graph

### Trigger
End of stage 3 (artifacts done) or in the composer (stage 4). The orchestrator collects all unique URLs from LessonBlock.citations[] across the completed lesson.

### Execution
`	ypescript
interface UrlIngestJob {
  url: string;
  sourceLesson: string;  // section ID or lesson ID
  mentionedIn: string[]; // block IDs or prose item IDs
}

async function ingestLessonSources(
  sectionId: string,
  blocks: LessonBlock[],
): Promise<{ succeeded: UrlIngestJob[]; failed: UrlIngestJob[] }> {
  const urls = new Map<string, UrlIngestJob>();
  for (const [i, block] of blocks.entries()) {
    if (block.citations) {
      for (const cit of block.citations) {
        if (!urls.has(cit.url)) {
          urls.set(cit.url, { url: cit.url, sourceLesson: sectionId, mentionedIn: [] });
        }
        urls.get(cit.url)!.mentionedIn.push(lock_);
      }
    }
  }

  const succeeded: UrlIngestJob[] = [];
  const failed: UrlIngestJob[] = [];

  for (const job of urls.values()) {
    try {
      // Reuse WebFetch result from agent cache if available; else call WebFetch here
      const content = await fetchUrlContent(job.url);  // Impl below
      const source = learn:lesson::websearch:;
      const ingestResult = await ingestContent(content, source);
      succeeded.push(job);
      console.log([lesson-ingest] ingested  → memoryId );
    } catch (err) {
      console.warn([lesson-ingest] failed to ingest : );
      failed.push(job);
    }
  }

  return { succeeded, failed };
}
`

### Fetch implementation
Agent caches WebFetch results for 10 min within a single lesson generation; orchestrator checks cache before re-fetching.

### Source string convention
learn:lesson:<sectionId>:websearch:<urlHash> — stable, scoped to lesson, distinguishable from other ingest sources in the graph.

### Return value handling
ingestContent returns { memoryId, entities, facts }. Orchestrator logs this for observability but does not surface to learner. Entities automatically populate the graph; future lessons see them immediately via get_learner_understanding and search_curriculum MCP tools.

## 5. Cost & Latency Caps

### Per-lesson constraints
- **Max WebSearch calls**: 3-5 (default 4). Enforced: track in orchestrator, reject new searches if count reached.
- **Max ingest calls**: 1-3 unique URLs per lesson. Rationale: ingest is expensive (entity extraction, AGE writes). Deduplication already handles this; cap prevents pathological cases (100 citations from copy-paste).
- **Wall-clock budget per stage**: outliner +30s, prose +15s per block, artifact +20s per freeform.

### Enforcement
`	ypescript
interface LessonResearchState {
  searchCount: number;
  searchBudget: number;     // max allowed
  urlsToIngest: Set<string>;
  ingestBudget: number;
}

async function generateLessonStructuredV3(sectionId, opts) {
  const research = { 
    searchCount: 0, 
    searchBudget: 4,
    urlsToIngest: new Set(),
    ingestBudget: 3,
  };
  
  // Pass to each stage agent
  const outline = await generateLessonOutline({ ..., research });
  // Outline agent declines WebSearch if research.searchCount >= research.searchBudget
  
  // After composing, collect URLs and ingest
  const { succeeded, failed } = await ingestLessonSources(sectionId, blocks);
  console.log([lesson-gen] ingested / lesson sources);
}
`

## 6. Failure Modes & Degradation

### WebSearch returns no useful results
- Prose writer's instruction: "If no search results are relevant, proceed with parametric knowledge only. Mark the block as [unverified web search] for logging."
- Lesson continues; no learner-facing error.
- Logged as a quality signal (future filtering of low-confidence blocks).

### WebSearch hits rate limit
- Claude CLI returns 429 or timeout.
- Agent-level retry: built into Claude CLI (transparent).
- Orchestrator-level: if search fails after 2 retries, fallback to parametric knowledge.
- Flag: LEARN_LESSON_WEBSEARCH_RETRY=1 (default enabled).

### Ingest fails (5xx, timeout, malformed content)
- Catch and log. Do not surface to learner.
- Lesson generation succeeds; the missed URL is not ingested but learner sees the lesson without artifacts.
- Future lessons can try again; Nmemo eventually sees the source if another lesson pulls it.

### Network error during WebFetch (lesson block has citation)
- Orchestrator catches fetch failure during ingest phase.
- Citation remains in lesson block (learner can click the URL).
- Ingest is skipped; learner is not blocked.

## 7. Configuration & Env Flags

`ash
# Disable all websearch (for cheap dev / CI)
LEARN_LESSON_WEBSEARCH=0

# Disable specific agents
LEARN_OUTLINER_WEBSEARCH=0    # default: 1
LEARN_PROSE_WEBSEARCH=0       # default: 1
LEARN_ARTIFACT_WEBSEARCH=0    # default: 1

# Tweak caps
LEARN_LESSON_WEBSEARCH_MAX_SEARCHES=4       # default: 4
LEARN_LESSON_WEBSEARCH_MAX_INGEST_URLS=3    # default: 3

# Retry policy
LEARN_LESSON_WEBSEARCH_RETRY=1              # default: 1
LEARN_LESSON_WEBSEARCH_RETRY_DELAY_MS=1000  # default: 1000
`

Read at start of lesson generation; cascade to agents as part of orchestrator context.

## 8. Tests (4-5 test cases)

### Test 1: "Prose block with cited content is ingested"
- Generate lesson on "WebGPU in 2024" (current topic).
- Assert: prose block returned with citations: [{url: "...", title: "..."}].
- Assert: POST to /ingest called with source learn:lesson:<sectionId>:websearch:*.
- Assert: returned memoryId and entities are non-empty.

### Test 2: "Websearch disabled via env"
- Set LEARN_LESSON_WEBSEARCH=0.
- Generate same lesson.
- Assert: Claude CLI invoked with --tools '' (no WebSearch).
- Assert: lesson completes; prose blocks do not have citations.

### Test 3: "WebSearch cap enforced"
- Set LEARN_LESSON_WEBSEARCH_MAX_SEARCHES=1.
- Generate lesson requiring 3+ web searches naturally.
- Assert: outliner calls WebSearch (1st search, succeeds).
- Assert: prose writer requests WebSearch but is rejected by orchestrator.
- Assert: artifact generator requests WebSearch but is rejected.
- Assert: lesson generation succeeds (degrades gracefully).

### Test 4: "Ingest failure does not block lesson"
- Mock POST /ingest to return 500.
- Generate lesson with web sources.
- Assert: lesson returned successfully.
- Assert: error logged but not surfaced to learner.
- Assert: citations remain in blocks (learner can read them).

### Test 5: "Duplicate URLs deduplicated during ingest"
- Generate lesson where 2 prose blocks cite the same article.
- Assert: POST to /ingest called once for that URL, not twice.
- Assert: ingestLessonSources deduplicates by URL.
