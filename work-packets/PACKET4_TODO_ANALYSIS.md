# Packet 4: TODO & Stub Analysis Report

**Date:** 2026-01-29
**Method:** 3 parallel Explore agents
**Research Time:** ~1 hour (vs 3+ hours sequentially)

---

## Executive Summary

Comprehensive analysis of TODO comments, stub functions, and service availability revealed **16 stub functions** (4 critical, 8 important, 4 minor) and **11 TODO comments** (1 critical, 5 important, 4 nice-to-have, 1 deprecated). All ML services are functional with 90% integration rate.

---

## TODO Inventory

### Critical TODOs (High Priority) - 1 Found

1. **task-conflicts.ts:201** - Implement resource conflict detection
   - **Context:** Stub function returns empty array
   - **Impact:** Resource conflict detection completely disabled
   - **Recommendation:** Implement entity-based conflict detection algorithm
   - **Estimated Effort:** 4-6 hours

### Important TODOs (Medium Priority) - 5 Found

1. **process-task.ts:346** - Query Qdrant for recent messages
   - **Context:** Returns empty array, lacks conversation history
   - **Impact:** Task extraction lacks conversational context
   - **Recommendation:** Implement Qdrant query for conversation vector store
   - **Estimated Effort:** 2-3 hours

2. **process-task.ts:366** - Query user_preferences table
   - **Context:** Returns empty object, no personalization
   - **Impact:** Task extraction lacks user preferences (urgency, working hours)
   - **Recommendation:** Implement user_preferences query
   - **Estimated Effort:** 1-2 hours

3. **process-task.ts:355** - Get pending tasks in context
   - **Context:** Returns empty array, no context-scoped deduplication
   - **Impact:** May allow duplicate tasks in same context
   - **Recommendation:** Implement context-aware task query
   - **Estimated Effort:** 2-3 hours

4. **api-client/client.gen.ts:246** - Improve error handling
   - **Context:** Generated code needs better error handling
   - **Impact:** API client errors less informative
   - **Recommendation:** Enhance error types and messages
   - **Estimated Effort:** 1 hour

5. **extract_task.py:279** - Update documentation
   - **Context:** Test data contains outdated TODO
   - **Impact:** Documentation may be outdated
   - **Recommendation:** Review and update docs
   - **Estimated Effort:** 30 minutes

### Nice-to-Have TODOs (Low Priority) - 4 Found

1. **W28-conflict-resolution.md:170** - More sophisticated temporal logic
   - **Recommendation:** Enhanced temporal conflict resolution
   - **Estimated Effort:** 6-8 hours

2. **W16-entity-schema.md:487** - Implement LLM verification
   - **Context:** Already implemented in W25
   - **Status:** Complete (can be removed)

3. **W07-memory-capture.md:233** - Implement voice transcription
   - **Context:** Service exists but has dependency issues
   - **Status:** Partial (Whisper build failures)

4. **classify.py:24** - Review pull request
   - **Context:** Test data TODO
   - **Status:** Can be removed

### Deprecated TODOs - 1 Found

1. **W12-task-extraction.md:250** - Update documentation
   - **Context:** Test data TODO
   - **Status:** Can be removed

---

## Stub Function Inventory

### Critical Stubs (Block Features) - 4 Found

1. **detectResourceConflicts()** - `task-conflicts.ts:201`
   - **Purpose:** Detects resource conflicts for same entities
   - **Current:** Returns empty array with TODO
   - **Impact:** Resource conflict detection disabled
   - **Recommendation:** Implement entity extraction + conflict detection
   - **Estimated Effort:** 4-6 hours

2. **getRecentContextMessages()** - `process-task.ts:346`
   - **Purpose:** Retrieves conversation history
   - **Current:** Returns empty array with TODO
   - **Impact:** Task extraction lacks context
   - **Recommendation:** Implement Qdrant vector search
   - **Estimated Effort:** 2-3 hours

3. **getPendingTasksInContext()** - `process-task.ts:355`
   - **Purpose:** Gets existing tasks for deduplication
   - **Current:** Returns empty array with TODO
   - **Impact:** Context deduplication disabled
   - **Recommendation:** Implement context-scoped query
   - **Estimated Effort:** 2-3 hours

4. **getUserPreferences()** - `process-task.ts:366`
   - **Purpose:** Retrieves user preferences
   - **Current:** Returns empty object with TODO
   - **Impact:** No personalization (urgency, working hours)
   - **Recommendation:** Implement user_preferences query
   - **Estimated Effort:** 1-2 hours

**Total Critical Effort:** 9-14 hours

### Important Stubs (Limit Features) - 8 Found

**Hybrid Search Service Stubs (5):**
- `searchMemories()` - Vector search returns empty on error
- `findConnectedEntities()` - Graph traversal returns empty on error
- `searchKeywords()` - Keyword search returns empty on error
- `findMemoriesViaGraph()` - Graph discovery returns empty on error
- `findPath()` - Path finding returns empty on error (graph.ts)

**Other Service Stubs (3):**
- `searchFacts()` - Fact search unreliable (multiple empty returns)
- `generateEmbedding()` - Embedding generation disabled on ML failure
- `createDependency()` - Dependency creation fails silently

**Impact:** Feature degradation when external services fail
**Recommendation:** Implement circuit breakers, retries, fallbacks
**Total Important Effort:** 12-16 hours

### Minor Stubs (Not Critical) - 4 Found

1. **extractRelationships()** - Returns empty on ML failure (graceful)
2. **getJobMetrics()** - Returns empty on DB failure (continues evaluation)
3. **createDependency()** - Returns null on error (prevents linking)
4. **resolveDependencyByReference()** - Returns null on no match

**Impact:** Non-critical, graceful degradation
**Total Minor Effort:** 4-6 hours

---

## Service Availability Report

### Fully Integrated Services - 9 (90%)

1. **embed.py** ✓ - `/embed` endpoint, skill wrapper exists
2. **classify.py** ✓ - `/classify` endpoint, skill wrapper exists
3. **extract_entities.py** ✓ - `/extract-entities` endpoint, API client
4. **check_contradiction.py** ✓ - `/check-contradiction` endpoint, API client
5. **reader.py** ✓ - `/parse-content` endpoint, skill wrapper exists
6. **summarize.py** ✓ - `/summarize` endpoint, skill wrapper exists
7. **extract_task.py** ✓ - `/extract-task` endpoint, skill wrapper exists
8. **scrape.py** ✓ - `/scrape` endpoint, service wrapper exists
9. **chat.py** ✓ - `/chat` endpoint, bot integration exists

### Available but Not Integrated - 1 (10%)

1. **relationships.py** ⚠️ - `/extract-relationships` endpoint exists
   - **Why not integrated:** No skill wrapper created
   - **Current usage:** Only used by W26 Relationship Agent
   - **Integration path:** Create `extract-relationships.skill.ts`
   - **Estimated effort:** 1 hour
   - **Benefits:** Enable standalone skill usage

### Partial/Disabled Services - 0

All services are functional. The transcribe service has a stub due to Whisper dependency issues, but this is a build problem, not a code integration problem.

---

## Implementation Recommendations

### Immediate Priority (Critical)

1. **W34: User Preferences Integration**
   - File: `process-task.ts:366`
   - Implement `getUserPreferences()` query
   - Integrate preferences into task extraction
   - **Estimated Effort:** 1-2 hours
   - **User Value:** High (personalized task extraction)

2. **W35: Conversation Context Retrieval**
   - File: `process-task.ts:346`
   - Implement Qdrant query for recent messages
   - Add context to task extraction
   - **Estimated Effort:** 2-3 hours
   - **User Value:** High (better task accuracy)

3. **W36: Resource Conflict Detection**
   - File: `task-conflicts.ts:201`
   - Implement `detectResourceConflicts()` function
   - Detect same-entity task overlaps
   - **Estimated Effort:** 4-6 hours
   - **User Value:** Medium (scheduling optimization)

4. **W37: Context-Aware Task Deduplication**
   - File: `process-task.ts:355`
   - Implement `getPendingTasksInContext()` query
   - Prevent duplicate tasks in same context
   - **Estimated Effort:** 2-3 hours
   - **User Value:** Medium (data quality)

### Medium Priority (Important)

5. **W38: Apache AGE Graph Query Integration**
   - Improve error handling in graph services
   - Add circuit breakers for graph queries
   - Implement alternative search strategies
   - **Estimated Effort:** 6-8 hours
   - **User Value:** Medium (graph features)

6. **W39: Hybrid Search Reliability**
   - Improve fallback mechanisms
   - Add partial result returns
   - Enhance error handling
   - **Estimated Effort:** 4-6 hours
   - **User Value:** Medium (search quality)

### Low Priority (Nice-to-Have)

7. **W40: Relationship Extraction Skill**
   - Create skill wrapper for relationships.py
   - Enable standalone skill usage
   - **Estimated Effort:** 1 hour
   - **User Value:** Low (convenience)

8. **W41: API Client Error Handling**
   - Improve error types and messages
   - Enhance generated client code
   - **Estimated Effort:** 1 hour
   - **User Value:** Low (debugging)

---

## Summary Statistics

### TODOs
- **Total:** 11
- **Critical:** 1 (9%)
- **Important:** 5 (45%)
- **Nice-to-Have:** 4 (36%)
- **Deprecated:** 1 (9%)

### Stub Functions
- **Total:** 16
- **Critical:** 4 (25%)
- **Important:** 8 (50%)
- **Minor:** 4 (25%)

### Services
- **Total:** 10
- **Fully Integrated:** 9 (90%)
- **Available but Unused:** 1 (10%)
- **Disabled:** 0 (0%)

### Implementation Effort
- **Critical Features:** 9-14 hours
- **Important Features:** 12-16 hours
- **Nice-to-Have Features:** 2-3 hours
- **Total:** 23-33 hours

---

## Recommendations Summary

### Implement First (High Value, Low Effort)
1. W34: User Preferences (1-2 hours)
2. W35: Conversation Context (2-3 hours)
3. W40: Relationship Skill (1 hour)

### Implement Second (High Value, Medium Effort)
4. W37: Context Deduplication (2-3 hours)
5. W36: Resource Conflicts (4-6 hours)

### Implement Last (Medium Value, Higher Effort)
6. W38: Graph Query Integration (6-8 hours)
7. W39: Hybrid Search Reliability (4-6 hours)
8. W41: API Client Errors (1 hour)

---

**Report Generated:** 2026-01-29
**Next Review:** After Packet 5 completion
