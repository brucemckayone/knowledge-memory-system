# Design: Chat Tutor Depth Implementation

## 1. Compelling Learner-State Reads (LearnerChatContext)

### Rationale: Pre-fetch beats prompt-only
Option A: Pre-fetch in the orchestrator (route layer). Fetch learner facts once before spawning the agent, pass as immutable context in the prompt.
Option B: Prompt-only. Tutor may forget, may waste turns calling reads it doesn't need, or may call reads for irrelevant concepts.

**Recommendation: Option A (pre-fetch).** Argument: same as nmemo-7si. A single fetch is cheaper than multi-turn reads. Facts are immutable during the response window. The tutor's context is explicit and auditable in the prompt.

### LearnerChatContext interface
```typescript
interface LearnerChatContext {
  conceptConfidences: {
    [conceptName: string]: {
      confidence: number;
      lastUpdated: string;
      misconceptions?: string[];
    }
  };
  recentGaps: Array<{
    concept: string;
    impact: number;
  }>;
  recentConfusions: Array<{
    concept: string;
    misconception: string;
  }>;
  crossCourseOverlaps: Array<{
    conceptName: string;
    otherCourses: string[];
  }>;
}
```

### Orchestration flow (route layer, chat.ts)
1. Fetch session + section metadata.
2. Call learning-mcp server: get_learner_understanding for each concept in sections.conceptEntityIds.
3. Call get_learning_gaps(section_topic) to find gaps.
4. Call find_cross_course_overlaps() once; filter to concepts in this section.
5. Build LearnerChatContext object.
6. Inject into tutor prompt: "The learner's current state in this section: [context]."
7. Spawn agent with enriched prompt.

Cost: One MCP round-trip pre-response (3-4 tool calls in parallel). Recouped by tutor not needing reads for basic state.

## 2. Toolset Audit & Exemplification

### Present tools (20+)
Read: get_learner_understanding, get_learning_gaps, get_struggle_areas, get_causal_learning_history, get_prerequisite_chain, search_curriculum, get_decay_candidates, find_cross_course_overlaps, find_dense_clusters.

Write: record_understanding, record_confusion, record_quiz_result, flag_prerequisite_gap, update_learning_trajectory, edit_lesson_section, generate_component, generate_artifact.

### Recommended exemplification changes
Add a worked example section showing cross-course weaving:
- If learner asks about "closures": check crossCourseOverlaps pre-fetch.
- If it appears in another course (e.g., "Rust"), note it.
- Call find_cross_course_overlaps() to get mapping detail.
- Weave into response: "You learned about closures in JavaScript. In Rust, the same idea is called a 'move closure'..."
- Optionally call update_learning_trajectory if a natural next step is clear.

## 3. Capturing Tool Calls (MCP Write Calls Only)

### Three options evaluated

Option A: Parse --output-format stream-json. Claude CLI emits tool calls line-by-line as JSON.
- Pros: Official CLI feature.
- Cons: Brittle if flag changes; streaming parser needed.

Option B: MCP server append-log to file. Learning-MCP appends every call to /tmp/<session>.jsonl.
- Pros: Decoupled from CLI output format.
- Cons: File-system coupling; requires cleanup.

Option C: Extract from structured result (RECOMMENDED). Tutor includes nmemoUpdates in final JSON response. Route parses and persists.
- Pros: No CLI changes; response self-contained; already using structured output for blocks.
- Cons: Tutor must emit structured response (already doing v0.2).

**Recommendation: Option C.** Tutor already outputs structured JSON. Extend shape to include nmemoUpdates. Route parses, validates, persists.

## 4. Schema for Surfaced Updates (nmemoUpdates shape)

Persist to chatMessages.nmemoUpdates (JSON column):
```typescript
type NmemoUpdate = {
  tool: 'record_understanding' | 'record_confusion' | 'flag_prerequisite_gap' | 'update_learning_trajectory';
  concept: string;
  confidence?: number;
  misconception?: string;
  evidence?: string;
  factId?: string;
  recordedAt: string;
};
```

Example row:
```json
[
  {
    "tool": "record_understanding",
    "concept": "closures",
    "confidence": 0.8,
    "evidence": "Learner explained scope retention",
    "factId": "fact_abc123",
    "recordedAt": "2026-05-08T14:32:15Z"
  }
]
```

## 5. UI Affordance: Update Chips

Under each assistant message with nmemoUpdates, render a chip strip:
```
Tutor message text...
📝 Recorded: you understand closures (0.8)
```

Each chip is a button that expands an inline detail card showing confidence, evidence, and factId.

Click-to-undo (out of scope v1): Defer for future implementation.

## 6. Privacy/UX: Writes-Only Surfacing

Surface only write calls (record_*, flag_*, update_*). Do NOT surface read calls. Why:
- Read calls are internal reasoning; too noisy.
- Write calls are the learning record; actionable and transparent.

## 7. Tests: 4-6 Specific Cases

Test 1: Pre-fetch fires on cold start. Learner with zero facts. Route pre-fetches; tutor responds gracefully. Assert: no hardcoded reads; graceful empty state.

Test 2: Compelled read fires. Pre-fetch returns empty for concept. Learner asks question. Tutor calls get_learner_understanding. Assert: read tool fired (visible in logs).

Test 3: Tool calls captured in nmemoUpdates. Tutor calls record_understanding. Response includes nmemoUpdates array. Route persists to DB. Assert: JSON shape matches spec; factId present.

Test 4: UI renders update chips. Message has nmemoUpdates. Chip strip rendered under message. Click expands detail. Assert: chip shows concept + tool; detail shows evidence.

Test 5: Cross-course overlap woven. Learner saw concept in Course A, asks about it in Course B. Pre-fetch includes overlap. Tutor mentions other course and maps concepts. Assert: bridge language present.

Test 6: Empty write calls don't create chips. Tutor responds without MCP writes. nmemoUpdates is empty. UI doesn't render chip strip. Assert: no visual clutter.
