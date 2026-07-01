# W38: Apache AGE Query Integration

**Status:** 📋 Backlog
**Priority:** P1 (High)
**Estimated Time:** 6-8 hours
**Phase:** 3 Enhancement
**Dependencies:** W18 (Apache AGE Infrastructure)

---

## Objective

Improve Apache AGE graph query error handling, implement circuit breakers for graph failures, and add alternative search strategies when graph queries fail, making hybrid search more robust and reliable.

---

## Prerequisites

- ✅ Apache AGE extension installed (migration 005_apache_age.sql)
- ✅ Graph service exists (`platform/src/services/graph.ts`)
- ✅ Hybrid search exists (`platform/src/services/hybrid-search.ts`)
- ⚠️ Stub functions with placeholder error handling

---

## Current State Issues

From Packet 4 analysis, the following stub functions need improvement:

1. **`graph.ts`**: Query errors return empty results (graceful degradation but silent failures)
2. **`hybrid-search.ts`**: Graph query failures not logged/monitored
3. **No circuit breaker**: Repeated graph failures continue attempting queries
4. **No fallback strategies**: When graph fails, no alternative search paths

---

## Implementation Steps

### Step 1: Add Circuit Breaker Pattern (2 hours)

**File:** `platform/src/services/graph.ts`

```typescript
import CircuitBreaker from 'opossum';

// Circuit breaker configuration
const circuitBreakerOptions = {
  timeout: 5000,           // 5 second timeout
  errorThresholdPercentage: 50,  // Open circuit after 50% failures
  resetTimeout: 30000,      // Try again after 30 seconds
  rollingCountTimeout: 10000,   // Statistics window
  rollingCountBuckets: 10
};

// Wrap graph queries in circuit breaker
const graphQueryCircuitBreaker = new CircuitBreaker(
  async (query: string, params: Record<string, unknown>[]) => {
    return executeCypherQuery(query, params);
  },
  circuitBreakerOptions
);

// Circuit breaker event listeners
graphQueryCircuitBreaker.on('open', () => {
  logger.warn('Graph query circuit breaker OPEN - graph queries disabled');
});

graphQueryCircuitBreaker.on('halfOpen', () => {
  logger.info('Graph query circuit breaker HALF-OPEN - testing queries');
});

graphQueryCircuitBreaker.on('close', () => {
  logger.info('Graph query circuit breaker CLOSED - graph queries enabled');
});

// Export wrapped function
export async function executeCypherQueryWithBreaker(
  query: string,
  params: Record<string, unknown>[] = []
): Promise<any> {
  try {
    return await graphQueryCircuitBreaker.fire(query, params);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Circuit breaker')) {
      logger.warn(`Graph query skipped: ${error.message}`);
      return null;  // Circuit open, don't attempt query
    }
    throw error;
  }
}
```

### Step 2: Improve Error Handling & Logging (1.5 hours)

**File:** `platform/src/services/graph.ts`

```typescript
interface GraphQueryResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  fallbackUsed: boolean;
}

export async function safeGraphQuery<T>(
  query: string,
  params: Record<string, unknown>[] = []
): Promise<GraphQueryResult<T>> {
  try {
    const result = await executeCypherQueryWithBreaker(query, params);

    if (!result) {
      return {
        success: false,
        error: 'Circuit breaker open - graph queries disabled',
        fallbackUsed: true
      };
    }

    return {
      success: true,
      data: result,
      fallbackUsed: false
    };

  } catch (error) {
    logger.error('Graph query failed', {
      query: query.substring(0, 100),  // First 100 chars
      error: error instanceof Error ? error.message : String(error)
    });

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      fallbackUsed: true
    };
  }
}
```

### Step 3: Implement Fallback Strategies (2 hours)

**File:** `platform/src/services/hybrid-search.ts`

```typescript
interface SearchResult {
  memory_id: string;
  score: number;
  source: 'vector' | 'graph' | 'keyword';
}

export async function hybridSearchWithFallback(
  query: string,
  options: SearchOptions
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];

  // Strategy 1: Vector search (always works)
  try {
    const vectorResults = await qdrant.search(query);
    results.push(...vectorResults.map(r => ({
      memory_id: r.id,
      score: r.score,
      source: 'vector' as const
    })));
  } catch (error) {
    logger.error('Vector search failed', { error });
  }

  // Strategy 2: Graph search (with fallback)
  const graphResult = await safeGraphQuery<any>(
    `MATCH (e:Entity)-[r]-(related:Entity)
     WHERE e.name = $entityName
     RETURN related.name, r.predicate
     LIMIT 10`,
    [{ entityName: extractEntity(query) }]
  );

  if (graphResult.success && graphResult.data) {
    // Convert graph results to search results
    const graphSearchResults = await convertGraphResultsToSearchResults(graphResult.data);
    results.push(...graphSearchResults);
  } else {
    logger.warn('Graph search failed, using fallback', {
      error: graphResult.error
    });

    // Fallback: SQL-based relationship search
    const sqlFallbackResults = await searchRelationshipsViaSQL(query);
    results.push(...sqlFallbackResults.map(r => ({
      memory_id: r.memory_id,
      score: 0.5,  // Lower confidence for fallback
      source: 'keyword' as const
    })));
  }

  // Strategy 3: Keyword search (PostgreSQL full-text)
  try {
    const keywordResults = await postgres.keywordSearch(query);
    results.push(...keywordResults.map(r => ({
      memory_id: r.id,
      score: r.ts_rank,
      source: 'keyword' as const
    })));
  } catch (error) {
    logger.error('Keyword search failed', { error });
  }

  // Deduplicate and re-rank using Reciprocal Rank Fusion (RRF)
  return rerankWithRRF(results);
}

async function searchRelationshipsViaSQL(
  query: string
): Promise<{ memory_id: string; [key: string]: any }[]> {
  // Fallback SQL query for relationships
  return db
    .select({
      memory_id: memories.id,
      content: memories.content
    })
    .from(memories)
    .innerJoin(memory_entities, eq(memories.id, memory_entities.memoryId))
    .innerJoin(entities, eq(memory_entities.entityId, entities.id))
    .where(sql`${entities.canonicalName} ILIKE ${`%${query}%`}`)
    .limit(10);
}
```

### Step 4: Add Monitoring & Metrics (1 hour)

**File:** `platform/src/services/graph.ts`

```typescript
interface GraphMetrics {
  totalQueries: number;
  successfulQueries: number;
  failedQueries: number;
  circuitBreakerOpens: number;
  averageQueryTime: number;
}

const graphMetrics: GraphMetrics = {
  totalQueries: 0,
  successfulQueries: 0,
  failedQueries: 0,
  circuitBreakerOpens: 0,
  averageQueryTime: 0
};

export function recordGraphQuery(duration: number, success: boolean): void {
  graphMetrics.totalQueries++;
  if (success) {
    graphMetrics.successfulQueries++;
  } else {
    graphMetrics.failedQueries++;
  }

  // Update average query time
  graphMetrics.averageQueryTime =
    (graphMetrics.averageQueryTime * (graphMetrics.totalQueries - 1) + duration) /
    graphMetrics.totalQueries;
}

export function getGraphMetrics(): GraphMetrics {
  return { ...graphMetrics };
}

// Circuit breaker open event
graphQueryCircuitBreaker.on('open', () => {
  graphMetrics.circuitBreakerOpens++;
});
```

### Step 5: Add Health Check Endpoint (30 minutes)

**File:** `platform/src/api/routes.ts` or new file

```typescript
import { getGraphMetrics } from '../services/graph';

router.get('/health/graph', async (req, res) => {
  const metrics = getGraphMetrics();
  const successRate = metrics.totalQueries > 0
    ? metrics.successfulQueries / metrics.totalQueries
    : 1.0;

  const health = {
    status: successRate > 0.8 ? 'healthy' : 'degraded',
    metrics: metrics,
    circuitBreakerOpen: !graphQueryCircuitBreaker.closed
  };

  res.json(health);
});
```

### Step 6: Update Tests (1 hour)

**File:** `platform/src/test/integration/graph-circuit-breaker.test.ts`

```typescript
describe('W38: Apache AGE Circuit Breaker', () => {
  it('should open circuit breaker after 50% failures', async () => {
    // Trigger 5 failures, then 5 successes
    for (let i = 0; i < 5; i++) {
      await executeCypherQueryWithBreaker('INVALID QUERY').catch(() => {});
    }

    // Circuit should be open now
    expect(graphQueryCircuitBreaker.open).toBe(true);

    // Subsequent queries should fail fast
    const result = await safeGraphQuery('MATCH (n) RETURN n LIMIT 1');
    expect(result.success).toBeFalsy();
    expect(result.fallbackUsed).toBe(true);
  });

  it('should use fallback when circuit open', async () => {
    const result = await hybridSearchWithFallback('test query', {});

    // Should return results from vector/keyword search
    expect(result.length).toBeGreaterThan(0);

    // At least one result should be from fallback source
    const fallbackResults = result.filter(r => r.source !== 'graph');
    expect(fallbackResults.length).toBeGreaterThan(0);
  });

  it('should log graph query failures', async () => {
    const spy = jest.spyOn(logger, 'error');

    await safeGraphQuery('INVALID CYPER QUERY');

    expect(spy).toHaveBeenCalledWith(
      'Graph query failed',
      expect.objectContaining({
        query: expect.any(String),
        error: expect.any(String)
      })
    );
  });
});
```

---

## Testing

### Manual Testing

1. **Trigger Graph Failure:**
   ```bash
   # Stop Apache AGE extension
   docker compose exec postgres psql -U postgres -d cognitive -c "DROP EXTENSION age;"
   ```

2. **Run Hybrid Search:**
   ```bash
   curl "http://localhost:3001/api/hybrid-search?q=test"
   ```

3. **Verify:**
   - Circuit breaker opens after failures
   - Fallback to SQL keyword search works
   - Results returned from vector + keyword sources
   - Error logged

4. **Check Health Endpoint:**
   ```bash
   curl http://localhost:3001/health/graph
   ```

### Integration Tests

```typescript
describe('W38: Hybrid Search with Fallback', () => {
  it('should work when AGE is unavailable', async () => {
    // Simulate AGE failure
    jest.spyOn(graphService, 'executeCypherQuery').mockRejectedValue(new Error('AGE unavailable'));

    const results = await hybridSearchWithFallback('test', {});

    // Should still return results from vector + keyword
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(r => r.source === 'keyword')).toBe(true);
  });
});
```

---

## Success Criteria

- [ ] Circuit breaker implemented for graph queries
- [ ] Graph query failures logged with context
- [ ] Fallback strategies working (SQL keyword search)
- [ ] Hybrid search works when graph fails
- [ ] Health check endpoint reports graph status
- [ ] Metrics tracked (success rate, query time, circuit opens)
- [ ] Tests pass (circuit breaker, fallback, health check)
- [ ] Manual testing confirms graceful degradation

---

## Files to Modify

1. `platform/src/services/graph.ts` - Add circuit breaker, improve error handling
2. `platform/src/services/hybrid-search.ts` - Add fallback strategies
3. `platform/src/api/routes.ts` - Add `/health/graph` endpoint
4. `platform/src/test/integration/graph-circuit-breaker.test.ts` - Add tests
5. `platform/package.json` - Add `opossum` dependency

---

## Related Work Packets

- **W18**: Apache AGE Infrastructure (upstream dependency)
- **W19**: Hybrid Retrieval (consumer of graph queries)
- **W39**: Hybrid Search Reliability (complementary)

---

## Notes

- **Circuit Breaker Library:** Use `opossum` ( battle-tested, TypeScript support)
- **Fallback Quality:** SQL keyword search is less accurate than graph but better than nothing
- **Monitoring:** Track success rate; alert if below 80% for extended period
- **Performance:** Circuit breaker prevents cascading failures

**Future Enhancements:**
- Retry logic with exponential backoff
- Multiple circuit breakers (per query type)
- Automatic fallback tuning based on success rates
- Graph query performance optimization

---

**Created:** 2026-01-29 (Documentation Synchronization Project, Packet 10)
**Source:** `work-packets/PACKET4_TODO_ANALYSIS.md` (Important Stub #1)
