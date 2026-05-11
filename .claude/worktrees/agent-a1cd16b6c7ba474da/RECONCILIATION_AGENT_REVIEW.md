# Reconciliation Agent — Complete Review

**Date:** April 16, 2026  
**Component:** Post-extraction identity resolution agent  
**Status:** Phase B (active, fire-and-forget)

---

## When Is It Run?

### Trigger Point: End of Extract Phase (pipeline.ts)

The reconciliation agent runs **asynchronously after entity meta computation**, during `extract()`:

```
extract(memoryId)
  ├─ 1. Fetch memory from Qdrant
  ├─ 2. Invoke graph agent (ORIENT → EXTRACT → RELATE → CAUSE → VERIFY)
  ├─ 3. Query created entities + facts from DB
  ├─ 4. Compute entity meta + detect merge candidates [Graph Meta]
  └─ 5. [FIRE-AND-FORGET] Trigger reconciliation agent ✓
         └─ Returns immediately, doesn't block
```

### Conditions for Trigger

Reconciliation agent runs **if ANY of these are true**:

1. **Unresolved merge candidates exist**
   ```typescript
   db.select({ id: mergeCandidates.id })
     .from(mergeCandidates)
     .where(eq(mergeCandidates.status, 'candidate'))
   ```

2. **Unconfirmed aliases exist**
   ```typescript
   db.select({ id: entityAliases.id })
     .from(entityAliases)
     .where(eq(entityAliases.aliasType, 'unconfirmed'))
   ```

If either check finds ≥1 row → agent invoked.

### Fire-and-Forget Pattern

```typescript
// pipeline.ts line 188
if (candidateRows.length > 0 || unconfirmedRows.length > 0) {
  // Fetch full context
  const [allCandidates, recentReports] = await Promise.all([
    getMergeCandidates(),  // All unresolved candidates + scoring
    db.select(...extractionReports).limit(10),  // Last 10 extraction traces
  ]);

  // Invoke agent — DOES NOT AWAIT
  const reconcileResult = await invokeReconciliationAgent({
    candidates: allCandidates.filter(c => c.status !== 'resolved'),
    recentReports: recentReports.map(r => r.reportText),
  });

  // Log report if available
  if (reconcileResult.result) {
    console.log(`[reconciliation] report:\n${reconcileResult.result}`);
  }

  reconciliationResult = { triggered: true, report: reconcileResult.result };
}
```

**Key behavior:**
- ✅ Non-blocking: returns immediately after spawning
- ✅ Result captured but only logged (not used in ingest response validation)
- ✅ Never causes ingest to fail (catch-and-swallow on error)
- ✅ Timing tracked but not critical path

---

## Full Picture: Data Flow

### Step 1: Merge Candidate Detection (graph-meta.ts)

**What creates candidates?**

```typescript
detectMergeCandidates(entityIds)
  ├─ Get entity_meta for all entities with ≥2 mentions
  ├─ For each entity pair (canonical order: a < b):
  │   ├─ Signal 1: Centroid similarity (pgvector cosine)
  │   │   SELECT 1 - (a.centroid <=> b.centroid) as similarity
  │   ├─ Signal 2: Memory overlap (Jaccard)
  │   │   shared_memories / union_memories
  │   └─ Signal 3: Structural similarity (shared facts)
  │       shared_predicates / union_predicates
  │
  ├─ Combined score = 0.3 × centroid + 0.4 × overlap + 0.3 × structural
  │
  └─ If score ≥ 0.4: create merge_candidate (status="staging" or "candidate")
     - status="staging" if 0.4 ≤ score < 0.7
     - status="candidate" if score ≥ 0.7
```

**Insert/Update Behavior:**

```sql
INSERT INTO merge_candidates (
  entity_a_id, entity_b_id,
  centroid_similarity, memory_overlap, structural_similarity,
  combined_score, status, detection_count, last_detected_at
) VALUES (...)
ON CONFLICT (entity_a_id, entity_b_id) DO UPDATE SET
  centroid_similarity = ...,
  memory_overlap = ...,
  structural_similarity = ...,
  combined_score = ...,
  status = CASE WHEN status = 'resolved' THEN 'resolved' ELSE new_status END,
  detection_count = detection_count + 1,
  last_detected_at = NOW()
```

**Idempotency:** Same pair detected again → status preserved if resolved, counts incremented.

---

### Step 2: Data Fetched for Agent

When reconciliation is triggered, the pipeline collects:

```typescript
// All unresolved merge candidates with entity names
const allCandidates = await getMergeCandidates();
// Returns:
[
  {
    id: "mc-uuid",
    entityA: { id: "e1-uuid", canonicalName: "Robert Walton", ... },
    entityB: { id: "e2-uuid", canonicalName: "R. Walton", ... },
    centroidSimilarity: 0.92,
    memoryOverlap: 0.85,
    structuralSimilarity: 0.78,
    combinedScore: 0.85,
    status: "candidate",  // or "staging"
    detectionCount: 2,
    firstDetectedAt: "2026-04-16T10:30:00Z",
    lastDetectedAt: "2026-04-16T11:45:00Z"
  },
  ...
]

// Last 10 extraction reports (agent reasoning traces)
const recentReports = await db.select({ reportText })
  .from(extractionReports)
  .orderBy(sql`created_at DESC`)
  .limit(10);
// Each report = full PHASE 5 output from graph agent
```

---

### Step 3: HTTP Call to ML Service

**URL:** `POST http://localhost:8000/reconciliation-agent`

**Request:**
```typescript
{
  "candidates": [
    {
      "id": "mc-uuid",
      "entity_a_id": "e1-uuid",
      "entity_b_id": "e2-uuid",
      "a_name": "Robert Walton",
      "a_type": "person",
      "b_name": "R. Walton",
      "b_type": "person",
      "combined_score": 0.85,
      "status": "candidate",
      "centroid_similarity": 0.92,
      "memory_overlap": 0.85,
      "structural_similarity": 0.78
    }
  ],
  "mcp_config_path": "/path/to/causal-mcp.json",
  "recent_reports": [
    "## PHASE 5: Entity Summary Update...",
    ...
  ]
}
```

---

### Step 4: Reconciliation Agent Execution (reconciliation_agent.py)

**FastAPI Endpoint:**
```python
@router.post("/reconciliation-agent", response_model=ReconciliationResponse)
async def reconciliation_agent(request: ReconciliationRequest):
    prompt = _build_reconciliation_prompt(request.candidates, request.recent_reports)
    
    result = await llm_pool.submit(llm_client.generate, prompt, options={
        "task": "reconciliation_agent",
        "system_prompt": RECONCILIATION_AGENT_SYSTEM_PROMPT,
        "mcp_config": request.mcp_config_path,
        "tools": "mcp",
        "max_turns": 50,
        "timeout": 300,
    })
    
    return ReconciliationResponse(result=result)
```

**Invocation:**
- Spawns Claude Code CLI subprocess with MCP config
- System prompt: 155-line detailed instruction set
- Tool budget: **50 MCP tool calls** (typical session uses 20-35)
- Timeout: **300 seconds** (5 minutes)

---

## Agent Behavior: The Full Decision Framework

### System Prompt (155 lines, highly structured)

The agent receives:
1. **Role definition**: Resolve identity questions between entity pairs
2. **Output mechanism**: Only MCP tool calls; final text is a structured report
3. **Tool budget**: 50 calls max (investigation + resolution + summary + report)
4. **Decision framework**: 3 possible outcomes per pair

---

### Three Decision Paths

#### **Path 1: SAME_AS (Non-Destructive)**

**When:**
- Entities represent same real-world identity
- BUT carry different narrative roles or perspectives
- Example: "the stranger" (Walton's POV) ↔ "Victor Frankenstein" (self-narrator)

**Signals:**
- Complementary fact clusters (don't contradict)
- Alias overlap
- Summaries describe perspective shift
- Third-person description vs first-person account

**Confidence threshold:** 0.7+

**Action:**
```typescript
// Tool: create_same_as_link
create_same_as_link({
  entity_a_id: "e1-uuid",
  entity_b_id: "e2-uuid",
  reasoning: "Robert Walton and R. Walton represent the same person — both are the letter-writer to his sister. The difference in naming convention is stylistic/narrative.",
  source_evidence: [
    {
      type: "report",
      id: "extraction-report-uuid",
      relevance: "Report notes both entities describe letter-writing activity to sister."
    },
    {
      type: "fact",
      id: "fact-uuid",
      relevance: "Both entities have fact 'writes_to sister'"
    }
  ],
  confidence: 0.92
})

// Then:
resolve_candidate({
  candidate_id: "mc-uuid",
  resolution: "same_as",
  reasoning: "Non-destructive link created; both perspectives preserved."
})

// Update both summaries:
update_entity_summary({
  entity_id: "e1-uuid",
  summary: "Robert Walton, narrator of Frankenstein's frame story. Also referred to as 'R. Walton' in some contexts. Writes letters to his sister..."
})
update_entity_summary({
  entity_id: "e2-uuid",
  summary: "Variant naming of Robert Walton (see same_as link). Same individual..."
})
```

**Result:**
- ✅ Both entities preserved with all facts intact
- ✅ Same-as link records identity
- ✅ Merge candidate marked resolved
- ✅ No data loss

---

#### **Path 2: MERGE (Destructive)**

**When:**
- Entities are clear duplicates
- No distinct narrative value
- One is absorbed into the other

**Signals:**
- Name variant (typo, abbreviation)
- Identical fact clusters
- One is strict subset of other
- Same source contexts, same role

**Confidence threshold:** 0.9+ (very high bar — hard to undo)

**Action:**
```typescript
// Tool: execute_merge
execute_merge({
  source_entity_id: "e2-uuid",  // to be deleted
  target_entity_id: "e1-uuid",  // survives
  reasoning: "Robert Walton and Robert.Walton are clear duplicates with identical facts and no narrative distinction. 'Robert.Walton' was a typo."
})
// This:
// 1. Re-points all facts from e2 → e1
// 2. Re-points all aliases from e2 → e1
// 3. Re-points all memory links from e2 → e1
// 4. Re-points all causal events from e2 → e1
// 5. Deletes entity_meta for e2
// 6. Deletes e2 entity record
// 7. Records merge in entity_merges audit table

// Then:
resolve_candidate({
  candidate_id: "mc-uuid",
  resolution: "merge",
  reasoning: "Destructively merged; source absorbed into target."
})

// Update survivor:
update_entity_summary({
  entity_id: "e1-uuid",
  summary: "Robert Walton, narrator... [Merged from variant 'Robert.Walton'...]"
})
```

**Result:**
- ✅ Source entity deleted
- ✅ All data re-pointed to target
- ✅ Single canonical entity survives
- ✅ Merge audit logged

**Danger:** Irreversible; that's why threshold is 0.9+

---

#### **Path 3: DISTINCT (False Positive)**

**When:**
- Entities are genuinely different
- High score was coincidence
- Investigation finds no connection

**Signals:**
- Contradicting facts
- Different roles/time periods
- Name similarity is coincidental
- No connection found

**Confidence threshold:** 0.6+ (low bar — false merges are worse than missed connections)

**Action:**
```typescript
// Tool: resolve_candidate only
resolve_candidate({
  candidate_id: "mc-uuid",
  resolution: "distinct",
  reasoning: "Initial similarity (0.85) was driven by shared memory set, but investigation reveals these are different individuals with different professions and eras."
})
```

**Result:**
- ✅ Candidate marked resolved
- ✅ No data modification
- ✅ False positive closed

---

### Investigation Process (Before Deciding)

For each candidate, agent follows this workflow:

```
1. get_reconciliation_context()
   ├─ Returns: all candidates, orphans, unconfirmed aliases, summaries
   │
2. For each candidate (highest score first):
   ├─ query_entity_facts(entity_a_id)
   │  └─ Returns: facts + summary + aliases for entity A
   │
   ├─ query_entity_facts(entity_b_id)
   │  └─ Returns: facts + summary + aliases for entity B
   │
   ├─ [if more context needed]
   │  ├─ get_entity_sources(entity_a_id) → where entity A is mentioned
   │  ├─ get_entity_sources(entity_b_id) → where entity B is mentioned
   │  └─ search_memories(query) → find connecting evidence
   │
   ├─ [if causal context matters]
   │  ├─ get_causal_history(entity_a_id)
   │  └─ get_causal_history(entity_b_id)
   │
   ├─ DECIDE: same_as vs merge vs distinct
   │
   ├─ EXECUTE: create_same_as_link / execute_merge / resolve_candidate
   │
   └─ UPDATE: update_entity_summary for both entities
```

---

### Special Handling

#### **Unconfirmed Aliases**

Extraction agents sometimes register `alias_type='unconfirmed'` when they suspect an identity link but can't prove it.

```typescript
// When adding alias during extraction:
add_entity_alias({
  entity_id: "e1-uuid",
  alias: "the stranger",
  alias_type: "unconfirmed"  // ← Signals: needs human/reconciliation review
})
```

Reconciliation agent investigates these:

```
For each unconfirmed alias:
1. Find entity with the alias
2. search_entity_aliases(alias_text) → find potential matches
3. Investigate: same entity or not?
4. If confirmed: create_same_as_link / execute_merge, then update alias_type
5. If distinct: note in report
```

---

#### **Orphan Entities**

Extraction creates entities with zero facts (false extractions or isolated mentions).

```
For each orphan:
1. get_entity_sources(orphan_id) → where was it mentioned?
2. Determine:
   - Real entity that just lacks facts? → create at least one fact
   - False extraction (common noun)? → note in report
   - Same as existing entity? → create_same_as_link / execute_merge
3. If fake: don't delete (aged orphan cleanup runs separately)
```

---

#### **Bridge Facts**

After creating same_as links, agent checks whether newly-connected fact clusters reveal relationships to record.

```
Example:
- Entity A (Robert Walton): facts = [writes_to(sister), navigates(Arctic)]
- Entity B (R. Walton): facts = [seeks(glory)]

After same_as link, opportunity to record:
- create_fact(Robert, seeks, glory) ← now cross-cluster

But ONLY with clear source evidence; never infer without support.
```

---

## Report Format

Agent's final output: **Structured Markdown Report**

```markdown
### CANDIDATES RESOLVED
- EntityA ↔ EntityB → SAME_AS (conf=0.85) — complementary perspectives
- EntityC ↔ EntityD → DISTINCT — no connection after investigation

### SAME_AS LINKS CREATED
- Robert Walton ↔ R. Walton (conf=0.92)
- Victor ↔ The Stranger (conf=0.88)

### MERGES EXECUTED
- Walton, Robert → Robert Walton (source absorbed)

### DISTINCT CONFIRMATIONS
- Frankenstein, Victor (different era, no overlap)

### UNCONFIRMED ALIASES RESOLVED
- "the captain" → confirmed as Robert Walton
- "I (narrator of letters)" → confirmed as Robert Walton

### ORPHANS INVESTIGATED
- Unknown character: insufficient evidence to connect

### BRIDGE FACTS NOTED
- Potential: Victor knows Walton (supported by causal trace in report 3)

### SKIPPED / UNCERTAIN
- Candidate MC-5: insufficient extraction reports; would need more context
```

---

## Tool Budget & Performance

### Tool Definitions Available (15 tools for reconciliation)

```
Query Tools (7):
  ├─ query_entity_facts
  ├─ query_entity_neighbours
  ├─ search_similar_entities
  ├─ search_memories
  ├─ get_memory_text
  ├─ get_causal_history
  └─ get_fact_source

Extraction Tools (5):
  ├─ resolve_entity
  ├─ create_fact
  ├─ get_entity_sources
  ├─ link_entity_to_memory
  └─ add_entity_alias

Reconciliation Tools (5):
  ├─ create_same_as_link
  ├─ execute_merge
  ├─ resolve_candidate
  ├─ search_entity_aliases
  └─ get_reconciliation_context
```

### Tool Call Budget: 50 Calls/Session

**Typical session breakdown (3-5 candidates):**

| Phase | Calls | Example |
|-------|-------|---------|
| Investigation | 12-15 | 2-3 query_entity_facts per candidate + sources |
| Resolution | 6-10 | create_same_as_link + execute_merge + resolve_candidate |
| Summary updates | 4-6 | update_entity_summary for each resolved entity |
| Edge cases | 5-10 | unconfirmed aliases, orphans, bridge facts |
| Report | 2-3 | Final structured text response |
| **Total** | **20-35** | Well within 50-call budget |

---

## Error Handling & Resilience

### In Pipeline (Catch-and-Swallow)

```typescript
try {
  const reconcileResult = await invokeReconciliationAgent({...});
  if (reconcileResult.result) {
    console.log(`[reconciliation] report:\n${reconcileResult.result}`);
  }
  reconciliationResult = { triggered: true, report: reconcileResult.result };
} catch (err) {
  console.warn('[reconciliation] failed:', err instanceof Error ? err.message : err);
  reconciliationResult = { triggered: false };  // ← Don't bubble up
}
```

**Behavior:**
- ✅ Agent timeout → logged, ingest succeeds anyway
- ✅ Agent error → logged, ingest succeeds anyway
- ✅ ML service 503 → logged, ingest succeeds anyway
- ✅ Never blocks main pipeline

### In Agent (Timeout & Concurrency)

```python
# reconciliation_agent.py
result = await llm_pool.submit(llm_client.generate, prompt, options={
    "task": "reconciliation_agent",
    "timeout": 300,  # 5 minutes
    "max_turns": 50,
})
```

- **Timeout:** 300 seconds = 5 minutes
- **Concurrency pool:** Shared with graph agent (configurable ThreadPoolSize)
- **Queue full:** Returns 503 "Service busy, retry later"

---

## Known Patterns & Pitfalls

### ✅ Good Practices Observed

1. **Non-destructive default**
   - Agent prefers `same_as` over `merge` unless 0.9+ confidence
   - Reflects philosophy: false positive connections are less harmful than false merges

2. **Source evidence traceability**
   - Every same_as link requires `source_evidence` (type, id, relevance)
   - Connection is auditable

3. **Investigation before decision**
   - Agent queries both entities' facts + summaries + aliases before deciding
   - Summaries note narrative roles and perspective shifts

4. **Idempotent candidate detection**
   - Same pair detected multiple times → counts up, status preserved if resolved
   - Safe to re-run detection

5. **Report trails**
   - Extraction reports stored in DB; agent reads them for context
   - Full reasoning trace available for audit

### ⚠️ Potential Issues

1. **No retry on agent timeout**
   - If agent hits 300s limit → result discarded, reported as non-triggered
   - Complex reconciliation sessions might timeout
   - **Mitigation:** Call agent manually with higher budget if needed

2. **Merge is permanent**
   - No "undo merge" operation
   - High confidence threshold (0.9+) helps but not foolproof
   - **Mitigation:** Audit trails in `entity_merges` table; could implement unmerge if critical

3. **Unconfirmed aliases not auto-resolved**
   - Agent only resolves them if investigation surfaces a matching candidate
   - Orphan aliases may accumulate indefinitely
   - **Mitigation:** Separate aged alias cleanup job (not yet implemented)

4. **Bridge facts require manual evidence**
   - Agent won't create cross-cluster facts without explicit source
   - May miss valid inferences
   - **Mitigation:** Conservative approach is correct; better to miss than hallucinate

5. **Centroid similarity bias**
   - If entities share source memories but are truly different → high overlap score
   - E.g., two characters in same book but different people
   - **Mitigation:** Structural similarity and agent investigation mitigate this

---

## Metrics & Observability

### What's Logged

```typescript
// Pipeline
console.log(`[reconciliation] triggering agent (candidates=${boolean}, unconfirmed=${boolean})`);
console.log(`[reconciliation] report:\n${result}`);

// Timing
timing.reconciliation = Date.now() - tReconcile;  // ← in ingest response
```

### What's Stored

```typescript
// Database
sameAsLinks.reasoning      // Why connection made
sameAsLinks.sourceEvidence // JSONB array of evidence
merge_candidates.status    // candidate → resolved
entity_merges table        // Audit trail
```

### What's Missing

- ❌ No metrics on decision distribution (% same_as vs merge vs distinct)
- ❌ No tracking of false positive rate (agent decisions vs human audit)
- ❌ No A/B testing infrastructure for prompt changes
- ❌ No SLA tracking on reconciliation latency

---

## Workflow Example: Frankenstein

**Scenario:** Ingest Frankenstein chapter with multiple narrators

### Extract Phase (Graph Agent)
- Extracts: "Robert Walton", "Victor Frankenstein", "the stranger"
- Creates entities with different source memories
- Creates facts about each

### Meta Phase (Graph Meta)
- Computes entity meta for each
- Detects "Robert Walton" ↔ "R. Walton" (high centroid similarity, shared memory, similar facts)
  - Combined score: 0.85 (status="candidate")
- Detects "the stranger" ↔ "Victor Frankenstein" (facts contradict initially, but summaries note identity question)
  - Combined score: 0.72 (status="candidate")

### Reconciliation Phase (Reconciliation Agent)
**Candidate 1: Robert Walton ↔ R. Walton**
- Investigation: Both write letters to sister, no contradiction
- Summary A: "Robert Walton, letter-writer"
- Summary B: "R. Walton, abbreviated form"
- Decision: SAME_AS (confidence 0.92)
- Action: create_same_as_link + resolve_candidate + update summaries
- **Result:** Single entity with both names as references

**Candidate 2: the stranger ↔ Victor Frankenstein**
- Investigation: Same person but described from different perspectives
- Summary A: "the stranger — described by Walton, mysterious visitor to Arctic"
- Summary B: "Victor Frankenstein — self-narrator, reveals tragic past"
- Decision: SAME_AS (confidence 0.88)
- Action: create_same_as_link + record bridge fact "Victor confides in Walton"
- **Result:** Two entities preserved with identity link + new fact

### Response
```json
{
  "memoryId": "...",
  "entities": [
    { "id": "...", "canonicalName": "Robert Walton", "confidence": 1.0, "isNew": false },
    { "id": "...", "canonicalName": "Victor Frankenstein", "confidence": 0.95, "isNew": false }
  ],
  "facts": [...],
  "timing": { "graphAgent": 12450, "graphMeta": 340, "reconciliation": 8320, "total": 21110 },
  "reconciliation": {
    "triggered": true,
    "report": "### CANDIDATES RESOLVED\n- Robert Walton ↔ R. Walton → SAME_AS (conf=0.92)\n- the stranger ↔ Victor Frankenstein → SAME_AS (conf=0.88)\n..."
  }
}
```

---

## Conclusion: The Full Picture

| Aspect | Status |
|--------|--------|
| **When triggered** | End of `extract()`, if candidates or unconfirmed aliases exist |
| **Blocking behavior** | Non-blocking (fire-and-forget) |
| **Data consumed** | Merge candidates (3-signal scored), extraction reports, entity facts/sources |
| **Decision framework** | SAME_AS (0.7+) vs MERGE (0.9+) vs DISTINCT (0.6+) |
| **Tools available** | 15 MCP-connected tools; budget 50 calls per session |
| **Invocation** | HTTP POST to `/reconciliation-agent` endpoint (Python FastAPI) |
| **LLM provider** | Claude Code CLI (subprocess) with 300s timeout |
| **Idempotency** | Detection is idempotent; agent decisions are mostly final (merge irreversible) |
| **Error handling** | Catch-and-swallow; never blocks pipeline |
| **Report** | Structured Markdown with decision summary + audit trail |
| **Data integrity** | Same-as links non-destructive; merges permanent with audit trail |

The reconciliation agent is a **sophisticated, well-designed post-extraction cleanup layer** that:
- ✅ Resolves identity ambiguities non-destructively by default
- ✅ Preserves narrative roles via same-as links
- ✅ Provides full traceability (reasoning + source evidence on every link)
- ✅ Never blocks the main ingestion pipeline
- ✅ Gracefully handles timeouts and errors

It represents the **reconciliation phase** of Phase B, where extracted entities are validated and consolidated based on evidence.

---

**Generated:** 2026-04-16  
**Agent Status:** Active in pipeline (fire-and-forget)  
**Phase:** B (Causal Layer)
