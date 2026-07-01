# W39: Hybrid Search Reliability

**Status:** 📋 Backlog
**Priority:** P1 (High)
**Estimated Time:** 4-6 hours
**Phase:** 3 Enhancement
**Dependencies:** W19 (Hybrid Retrieval), W38 (Apache AGE Integration)

---

## Objective

Improve hybrid search fallback mechanisms, add partial result returns when components fail, and enhance error handling for service failures, making search more resilient and reliable.

---

## Prerequisites

- ✅ Hybrid search service exists (`platform/src/services/hybrid-search.ts`)
- ✅ Qdrant vector search working
- ✅ PostgreSQL queries working
- ⚠️ Stub functions with basic error handling

---

## Current State Issues

From Packet 4 analysis, the following issues exist:

1. **All-or-nothing approach:** If any component fails, entire search fails
2. **No partial results:** No graceful degradation when services unavailable
3. **Silent failures:** Errors caught but not logged/monitored
4. **No retry logic:** Transient failures cause permanent search failure

---

## Implementation Steps

### Step 1: Implement Component-Level Isolation (2 hours)

**File:** `platform/src/services/hybrid-search.ts`

```typescript
interface SearchComponent {
  name: 'vector' | 'graph' | 'keyword';
  search: (query: string) => Promise<SearchResult[]>;
  fallback?: () => Promise<SearchResult[]>;
}

interface ComponentResult {
  component: SearchComponent['name'];
  success: boolean;
  results: SearchResult[];
  error?: string;
  duration: number;
}

async function executeComponentSearch(
  component: SearchComponent,
  query: string
): Promise<ComponentResult> {
  const startTime = Date.now();

  try {
    logger.debug(`Executing ${component.name} search`, { query });

    const results = await component.search(query);

    return {
      component: component.name,
      success: true,
      results,
      duration: Date.now() - startTime
    };

  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error(`${component.name} search failed`, {
      error: errorMessage,
      duration
    });

    // Try fallback if available
    if (component.fallback) {
      try {
        logger.info(`Attempting fallback for ${component.name}`);
        const fallbackResults = await component.fallback();

        return {
          component: component.name,
          success: true,
          results: fallbackResults,
          duration: Date.now() - startTime
        };
      } catch (fallbackError) {
        logger.error(`${component.name} fallback also failed`, {
          error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
        });
      }
    }

    return {
      component: component.name,
      success: false,
      results: [],
      error: errorMessage,
      duration
    };
  }
}
```

### Step 2: Implement Partial Result Aggregation (1.5 hours)

**File:** `platform/src/services/hybrid-search.ts`

```typescript
export async function hybridSearchReliable(
  query: string,
  options: SearchOptions = {}
): Promise<{
    results: SearchResult[];
    components: ComponentResult[];
    meta: {
      totalResults: number;
      successCount: number;
      failureCount: number;
      partial: boolean;
    };
  }> {
  const components: SearchComponent[] = [
    {
      name: 'vector',
      search: (q) => qdrant.search(q),
      // No fallback for vector (critical)
    },
    {
      name: 'graph',
      search: (q) => graphService.search(q),
      fallback: () => postgres.keywordSearch(q)  // SQL fallback
    },
    {
      name: 'keyword',
      search: (q) => postgres.keywordSearch(q),
      // No fallback for keyword (already simplest)
    }
  ];

  // Execute all components in parallel with isolation
  const componentResults = await Promise.all(
    components.map(c => executeComponentSearch(c, query))
  );

  // Aggregate successful results
  const successfulResults = componentResults
    .filter(r => r.success)
    .flatMap(r => r.results);

  // Check if we have any results
  const hasResults = successfulResults.length > 0;

  if (!hasResults) {
    logger.error('All search components failed', {
      query,
      failures: componentResults.filter(r => !r.success).map(r => ({
        component: r.component,
        error: r.error
      }))
    });

    throw new Error('All search components failed');
  }

  // Re-rank using RRF (Reciprocal Rank Fusion)
  const rerankedResults = rerankWithRRF(successfulResults);

  const successCount = componentResults.filter(r => r.success).length;
  const failureCount = componentResults.length - successCount;

  return {
    results: rerankedResults,
    components: componentResults,
    meta: {
      totalResults: rerankedResults.length,
      successCount,
      failureCount,
      partial: failureCount > 0
    }
  };
}
```

### Step 3: Add Retry Logic with Exponential Backoff (1.5 hours)

**File:** `platform/src/services/hybrid-search.ts`

```typescript
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  let lastError: Error;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt === maxRetries) {
        logger.error(`Max retries exceeded`, {
          attempts: attempt + 1,
          error: lastError.message
        });
        throw lastError;
      }

      const delay = baseDelay * Math.pow(2, attempt);  // Exponential backoff
      logger.warn(`Retry attempt ${attempt + 1}/${maxRetries + 1} after ${delay}ms`, {
        error: lastError.message
      });

      await sleep(delay);
    }
  }

  throw lastError!;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Usage in component search
async function executeComponentSearchWithRetry(
  component: SearchComponent,
  query: string
): Promise<ComponentResult> {
  return retryWithBackoff(
    () => executeComponentSearch(component, query),
    2,  // 2 retries = 3 total attempts
    500  // Start with 500ms delay
  );
}
```

### Step 4: Add Quality Scoring for Results (1 hour)

**File:** `platform/src/services/hybrid-search.ts`

```typescript
interface ScoredResult extends SearchResult {
  qualityScore: number;
  sources: string[];  // Which components found this result
}

function scoreResults(
  results: SearchResult[],
  componentResults: ComponentResult[]
): ScoredResult[] {
  // Group results by memory_id
  const grouped = new Map<string, SearchResult[]>();
  for (const result of results) {
    if (!grouped.has(result.memory_id)) {
      grouped.set(result.memory_id, []);
    }
    grouped.get(result.memory_id)!.push(result);
  }

  // Score each result
  return Array.from(grouped.entries()).map(([memoryId, hits]) => {
    const topHit = hits[0];  // Highest scoring hit
    const sources = [...new Set(hits.map(h => h.source))];

    // Quality score based on:
    // - Number of components that found it (more = higher quality)
    // - Reciprocal rank (lower rank = higher quality)
    const componentCount = sources.length;
    const avgRank = hits.reduce((sum, h) => sum + h.rank, 0) / hits.length;
    const qualityScore = (componentCount * 0.6) + ((1 / avgRank) * 0.4);

    return {
      ...topHit,
      qualityScore,
      sources
    };
  })
  .sort((a, b) => b.qualityScore - a.qualityScore);  // Sort by quality
}
```

### Step 5: Update API Response (30 minutes)

**File:** `platform/src/api/routes.ts` (search endpoint)

```typescript
router.get('/api/hybrid-search', async (req, res) => {
  const { q } = req.query;

  if (!q || typeof q !== 'string') {
    return res.status(400).json({ error: 'Missing query parameter' });
  }

  try {
    const searchResult = await hybridSearchReliable(q);

    res.json({
      query: q,
      results: searchResult.results,
      meta: {
        total: searchResult.meta.totalResults,
        components: searchResult.components.map(c => ({
          name: c.component,
          success: c.success,
          resultCount: c.results.length,
          duration: c.duration,
          error: c.error
        })),
        partial: searchResult.meta.partial,
        quality: 'high' | 'medium' | 'low'  // Based on partial status
      }
    });

  } catch (error) {
    logger.error('Hybrid search completely failed', { error, query: q });

    res.status(500).json({
      error: 'Search temporarily unavailable',
      query: q,
      components: []  // Don't expose internal errors
    });
  }
});
```

### Step 6: Add Monitoring & Alerts (30 minutes)

**File:** `platform/src/services/hybrid-search.ts`

```typescript
interface SearchMetrics {
  totalSearches: number;
  successfulSearches: number;
  partialSearches: number;
  failedSearches: number;
  componentSuccessRates: Record<string, number>;
}

const searchMetrics: SearchMetrics = {
  totalSearches: 0,
  successfulSearches: 0,
  partialSearches: 0,
  failedSearches: 0,
  componentSuccessRates: {
    vector: 1.0,
    graph: 1.0,
    keyword: 1.0
  }
};

export function recordSearch(result: Awaited<ReturnType<typeof hybridSearchReliable>>): void {
  searchMetrics.totalSearches++;

  if (result.meta.partial) {
    searchMetrics.partialSearches++;
  } else if (result.meta.failureCount === 0) {
    searchMetrics.successfulSearches++;
  } else {
    searchMetrics.failedSearches++;
  }

  // Update component success rates
  for (const comp of result.components) {
    const key = comp.component;
    if (!searchMetrics.componentSuccessRates[key]) {
      searchMetrics.componentSuccessRates[key] = 1.0;
    }

    // Exponential moving average
    const currentRate = searchMetrics.componentSuccessRates[key];
    const newRate = comp.success ? 1.0 : 0.0;
    searchMetrics.componentSuccessRates[key] = (currentRate * 0.9) + (newRate * 0.1);
  }

  // Alert if component success rate drops below 80%
  for (const [component, rate] of Object.entries(searchMetrics.componentSuccessRates)) {
    if (rate < 0.8) {
      logger.warn(`Component ${component} success rate degraded`, {
        rate,
        threshold: 0.8
      });
    }
  }
}

export function getSearchMetrics(): SearchMetrics {
  return { ...searchMetrics };
}
```

---

## Testing

### Unit Tests

**File:** `platform/src/test/integration/hybrid-search-reliability.test.ts`

```typescript
describe('W39: Hybrid Search Reliability', () => {
  it('should return partial results when one component fails', async () => {
    // Mock graph search to fail
    jest.spyOn(graphService, 'search').mockRejectedValue(new Error('Graph unavailable'));

    const result = await hybridSearchReliable('test query');

    expect(result.results.length).toBeGreaterThan(0);  // Still have results
    expect(result.meta.partial).toBe(true);
    expect(result.meta.failureCount).toBe(1);
  });

  it('should retry failed components', async () => {
    let attempts = 0;
    jest.spyOn(qdrant, 'search').mockImplementation(async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error('Temporary failure');
      }
      return [];
    });

    const result = await hybridSearchReliable('test query');

    expect(attempts).toBe(3);  // Initial + 2 retries
    expect(result.meta.failureCount).toBe(0);  // Eventually succeeded
  });

  it('should score results by quality', async () => {
    const results: SearchResult[] = [
      { memory_id: '1', score: 0.9, source: 'vector' },
      { memory_id: '1', score: 0.7, source: 'graph' },
      { memory_id: '2', score: 0.8, source: 'keyword' }
    ];

    const componentResults: ComponentResult[] = [
      { component: 'vector', success: true, results: [results[0]], duration: 100 },
      { component: 'graph', success: true, results: [results[1]], duration: 150 },
      { component: 'keyword', success: true, results: [results[2]], duration: 50 }
    ];

    const scored = scoreResults(results, componentResults);

    // Memory 1 should rank higher (found by 2 components)
    expect(scored[0].memory_id).toBe('1');
    expect(scored[0].sources).toEqual(['vector', 'graph']);
    expect(scored[0].qualityScore).toBeGreaterThan(scored[1].qualityScore);
  });

  it('should throw when all components fail', async () => {
    jest.spyOn(qdrant, 'search').mockRejectedValue(new Error('Qdrant down'));
    jest.spyOn(graphService, 'search').mockRejectedValue(new Error('Graph down'));
    jest.spyOn(postgres, 'keywordSearch').mockRejectedValue(new Error('DB down'));

    await expect(hybridSearchReliable('test query')).rejects.toThrow('All search components failed');
  });
});
```

### Manual Testing

1. **Test Partial Results:**
   ```bash
   # Stop Qdrant
   docker compose stop qdrant

   # Run search
   curl "http://localhost:3001/api/hybrid-search?q=test"

   # Verify: Returns results from graph + keyword, marks as partial
   ```

2. **Test Quality Scoring:**
   ```bash
   # Search for entity that appears in multiple components
   curl "http://localhost:3001/api/hybrid-search?q=John%20Smith"

   # Verify: Results with multiple sources ranked higher
   ```

3. **Test Metrics:**
   ```bash
   curl "http://localhost:3001/api/metrics/search"
   ```

---

## Success Criteria

- [ ] Component isolation working (failures don't cascade)
- [ ] Partial results returned when some components fail
- [ ] Retry logic with exponential backoff working
- [ ] Quality scoring based on multi-component hits
- [ ] API response includes component status + quality metrics
- [ ] Metrics tracked (success rates, partial searches)
- [ ] Monitoring alerts for degraded components
- [ ] Tests pass (isolation, retry, scoring, metrics)
- [ ] Manual testing confirms graceful degradation

---

## Files to Modify

1. `platform/src/services/hybrid-search.ts` - Complete rewrite with reliability features
2. `platform/src/api/routes.ts` - Update search endpoint response format
3. `platform/src/test/integration/hybrid-search-reliability.test.ts` - Add tests
4. `platform/src/api/metrics.ts` - Add search metrics endpoint (if exists)

---

## Related Work Packets

- **W19**: Hybrid Retrieval (base implementation)
- **W38**: Apache AGE Integration (complementary reliability)

---

## Notes

- **Backwards Compatibility:** API response format changes; consider versioning
- **Performance:** Component isolation adds slight overhead; acceptable for reliability
- **Monitoring:** Set up alerts for component success rate < 80%
- **User Experience:** Partial results better than no results; communicate degraded quality

**Future Enhancements:**
- Component-specific timeout configuration
- A/B testing for RRF parameters
- Machine learning for quality scoring
- Real user monitoring (RUM) for search quality

---

**Created:** 2026-01-29 (Documentation Synchronization Project, Packet 10)
**Source:** `work-packets/PACKET4_TODO_ANALYSIS.md` (Important Stub #2)
