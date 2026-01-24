# Work Packet W24: Summarizer Agent

**Status:** Ready to Implement  
**Dependencies:** W22 (Ingestion Agent), W13 (Web Scraper)  
**Estimated Time:** 2-3 hours

---

## Objective

Implement the Summarizer Agent that creates concise summaries of memories, generates embeddings, and maintains context summaries for coherent knowledge retrieval.

---

## Research Reference

From [GARDENER_RESEARCH.md](../GARDENER_RESEARCH.md) lines 370-381:
- Near-term tier processing (within 1 hour)
- Generate summaries for long content
- Update context summaries

---

## Implementation

### Agent Implementation

Create `platform/src/gardener/agents/summarizer-agent.ts`:

```typescript
import { GardenerAgent, AgentContext, AgentResult } from './types.js';
import { config } from '../../config.js';
import { embed } from '../../services/ml.js';

export interface SummarizerJob {
  memoryId: string;
  content: string;
  contentType: string;
  existingSummary?: string;
}

export interface SummarizerResult {
  summary: string;
  keyPoints: string[];
  embeddingUpdated: boolean;
  contextUpdated: boolean;
}

export const summarizerAgent: GardenerAgent<SummarizerJob, SummarizerResult> = {
  name: 'summarizer',
  tier: 'nearterm',
  
  async process(
    job: SummarizerJob,
    context: AgentContext
  ): Promise<AgentResult<SummarizerResult>> {
    const startTime = Date.now();
    context.logger.info(`Summarizing memory ${job.memoryId}`);
    
    try {
      // Generate summary using LLM
      const { summary, keyPoints } = await generateSummary(
        job.content,
        job.contentType
      );
      
      // Update memory with summary
      const { updateMemoryMetadata } = await import('../../services/qdrant.js');
      await updateMemoryMetadata(job.memoryId, {
        summary,
        keyPoints,
        summarizedAt: new Date().toISOString(),
      });
      
      // Re-embed with summary for better search
      const combinedText = `${summary}\n\n${job.content.slice(0, 1000)}`;
      const embeddingResult = await embed(combinedText);
      
      await updateMemoryEmbedding(job.memoryId, embeddingResult.vector);
      
      // Update context summary if relevant
      const contextUpdated = await maybeUpdateContext(
        job.memoryId,
        summary,
        job.contentType
      );
      
      return {
        success: true,
        data: {
          summary,
          keyPoints,
          embeddingUpdated: true,
          contextUpdated,
        },
        metrics: {
          durationMs: Date.now() - startTime,
          summaryLength: summary.length,
          keyPointCount: keyPoints.length,
        },
      };
      
    } catch (error) {
      context.logger.error('Summarizer failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        metrics: { durationMs: Date.now() - startTime },
      };
    }
  },
};

/**
 * Generate summary using LLM
 */
async function generateSummary(
  content: string,
  contentType: string
): Promise<{ summary: string; keyPoints: string[] }> {
  const response = await fetch(`${config.ML_SERVICES_URL}/summarize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: content,
      style: getSummaryStyle(contentType),
      max_length: 200,
    }),
  });
  
  if (!response.ok) {
    // Fallback to simple truncation
    return {
      summary: content.slice(0, 200) + '...',
      keyPoints: [],
    };
  }
  
  const data = await response.json();
  return {
    summary: data.summary || content.slice(0, 200),
    keyPoints: data.key_points || extractKeyPoints(content),
  };
}

/**
 * Get summary style based on content type
 */
function getSummaryStyle(contentType: string): string {
  switch (contentType) {
    case 'task': return 'action-oriented';
    case 'event': return 'time-focused';
    case 'reference': return 'informative';
    case 'question': return 'question-preserving';
    case 'idea': return 'concept-focused';
    default: return 'general';
  }
}

/**
 * Extract key points from content
 */
function extractKeyPoints(content: string): string[] {
  // Simple extraction of sentences with key indicators
  const sentences = content.split(/[.!?]+/).filter(s => s.trim());
  const keyIndicators = ['important', 'must', 'need', 'key', 'main', 'first', 'should'];
  
  return sentences
    .filter(s => keyIndicators.some(k => s.toLowerCase().includes(k)))
    .slice(0, 5)
    .map(s => s.trim());
}

/**
 * Update memory embedding in Qdrant
 */
async function updateMemoryEmbedding(
  memoryId: string,
  vector: number[]
): Promise<void> {
  const response = await fetch(`${config.QDRANT_URL}/collections/memories/points`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      points: [{
        id: memoryId,
        vector,
      }],
    }),
  });
  
  if (!response.ok) {
    console.warn('Failed to update embedding:', await response.text());
  }
}

/**
 * Update context summary if relevant
 */
async function maybeUpdateContext(
  memoryId: string,
  summary: string,
  contentType: string
): Promise<boolean> {
  // Only update context for significant content types
  if (!['task', 'event', 'idea'].includes(contentType)) {
    return false;
  }
  
  const { addToContextSummary } = await import('../../services/context.js');
  await addToContextSummary(summary, contentType);
  return true;
}
```

### Enhanced Summarize Endpoint

Update `ml-services/main.py`:

```python
@app.post("/summarize")
async def summarize(request: dict):
    """Generate summary with key points"""
    text = request.get("text", "")
    style = request.get("style", "general")
    max_length = request.get("max_length", 200)
    
    style_prompts = {
        "action-oriented": "Focus on actions and deliverables.",
        "time-focused": "Emphasize dates, times, and deadlines.",
        "informative": "Extract key facts and information.",
        "question-preserving": "Preserve the core question being asked.",
        "concept-focused": "Highlight the main concept or idea.",
        "general": "Provide a balanced summary.",
    }
    
    prompt = f"""Summarize this content in {max_length} characters or less.
{style_prompts.get(style, '')}

Content: {text[:3000]}

Return JSON with:
- summary: concise summary
- key_points: array of 3-5 key points (short phrases)

Respond ONLY with valid JSON."""

    response = ollama.chat(
        model="llama3:8b",
        messages=[{"role": "user", "content": prompt}],
        format="json"
    )
    
    try:
        return json.loads(response["message"]["content"])
    except json.JSONDecodeError:
        return {
            "summary": text[:max_length] + "...",
            "key_points": []
        }
```

---

## Verification

### Automated Tests
Run simple unit tests for summarizer agent.

```bash
# Create platform/src/gardener/agents/__tests__/summarizer.test.ts
import { summarizerAgent } from '../summarizer-agent.js';
import { describe, it, expect } from 'vitest';

describe('Summarizer Agent', () => {
  it('extract key points', () => {
     // Test extraction logic
  });
});
```

### Manual Verification
```bash
# Test summarizer
curl -X POST http://localhost:3001/api/gardener/queue \
  -H "Content-Type: application/json" \
  -d '{
    "agent": "summarizer",
    "job": {
      "memoryId": "test-789",
      "content": "Long article content here...",
      "contentType": "reference"
    }
  }'
```

---

## Acceptance Criteria

- [ ] Summaries generated for long content
- [ ] Key points extracted
- [ ] Embeddings updated with summary
- [ ] Context summaries updated when relevant
- [ ] Style-appropriate summarization
- [ ] Fallback for LLM failures

---

## Next Packet

- [W26: Relationship Extraction Agent](./W26-relationship-agent.md) - Extract facts
