# Work Packet W23: Reader Agent

**Status:** Ready to Implement  
**Dependencies:** W22 (Ingestion Agent)  
**Estimated Time:** 3-4 hours

---

## Objective

Implement the Reader Agent that parses incoming memories, extracts structured information, and classifies content type. This agent transforms raw text into a normalized format for downstream processing.

---

## Research Reference

From [GARDENER_RESEARCH.md](../GARDENER_RESEARCH.md) lines 358-369:
- Real-time parsing of incoming content
- Content type classification
- Structured information extraction

---

## Implementation

### Agent Implementation

Create `platform/src/gardener/agents/reader-agent.ts`:

```typescript
import { GardenerAgent, AgentContext, AgentResult } from './types.js';
import { config } from '../../config.js';

export interface ReaderJob {
  memoryId: string;
  chunks: string[];
  type: string;
  source: string;
}

export interface ParsedContent {
  contentType: 'note' | 'task' | 'event' | 'reference' | 'question' | 'idea';
  title?: string;
  summary?: string;
  structuredData?: Record<string, unknown>;
  dates?: Array<{ text: string; parsed: string }>;
  mentions?: string[];
  links?: string[];
  tags?: string[];
}

export interface ReaderResult {
  parsed: ParsedContent;
  confidence: number;
  processingNotes: string[];
}

export const readerAgent: GardenerAgent<ReaderJob, ReaderResult> = {
  name: 'reader',
  tier: 'realtime',
  
  async process(
    job: ReaderJob,
    context: AgentContext
  ): Promise<AgentResult<ReaderResult>> {
    const startTime = Date.now();
    context.logger.info(`Reading memory ${job.memoryId}`);
    
    try {
      const fullContent = job.chunks.join('\n\n');
      
      // Use LLM to parse and classify content
      const parsed = await parseContent(fullContent, job.type);
      
      // Extract additional metadata
      const dates = extractDates(fullContent);
      const links = extractLinks(fullContent);
      const tags = extractTags(fullContent);
      
      const result: ParsedContent = {
        ...parsed,
        dates,
        links,
        tags,
      };
      
      // Store parsed data
      await storeParsedContent(job.memoryId, result);
      
      // Queue summarizer if needed
      if (fullContent.length > 500) {
        await context.queueJob('summarizer', {
          memoryId: job.memoryId,
          content: fullContent,
          contentType: result.contentType,
        });
      }
      
      return {
        success: true,
        data: {
          parsed: result,
          confidence: parsed.confidence || 0.8,
          processingNotes: [],
        },
        metrics: {
          durationMs: Date.now() - startTime,
          contentType: result.contentType,
          dateCount: dates.length,
          linkCount: links.length,
        },
      };
      
    } catch (error) {
      context.logger.error('Reader failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        metrics: { durationMs: Date.now() - startTime },
      };
    }
  },
};

/**
 * Parse content using LLM
 */
async function parseContent(
  content: string,
  hint: string
): Promise<ParsedContent & { confidence: number }> {
  const response = await fetch(`${config.ML_SERVICES_URL}/parse-content`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, hint }),
  });
  
  if (!response.ok) {
    // Fallback to simple classification
    return {
      contentType: inferContentType(content),
      confidence: 0.5,
    };
  }
  
  return response.json();
}

/**
 * Simple content type inference
 */
function inferContentType(content: string): ParsedContent['contentType'] {
  const lower = content.toLowerCase();
  
  if (lower.includes('todo') || lower.includes('task') || lower.includes('need to')) {
    return 'task';
  }
  if (lower.includes('meeting') || lower.includes('event') || lower.includes('schedule')) {
    return 'event';
  }
  if (lower.includes('?')) {
    return 'question';
  }
  if (lower.includes('idea') || lower.includes('what if')) {
    return 'idea';
  }
  if (lower.startsWith('http') || lower.includes('article') || lower.includes('link')) {
    return 'reference';
  }
  
  return 'note';
}

/**
 * Extract date mentions
 */
function extractDates(content: string): Array<{ text: string; parsed: string }> {
  const datePatterns = [
    /\b(\d{4}-\d{2}-\d{2})\b/g,
    /\b(today|tomorrow|yesterday)\b/gi,
    /\b(next|this)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
    /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/g,
  ];
  
  const dates: Array<{ text: string; parsed: string }> = [];
  
  for (const pattern of datePatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      dates.push({
        text: match[0],
        parsed: match[0],  // Would use chrono-node for real parsing
      });
    }
  }
  
  return dates;
}

/**
 * Extract URLs
 */
function extractLinks(content: string): string[] {
  const urlPattern = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
  return [...new Set(content.match(urlPattern) || [])];
}

/**
 * Extract hashtags
 */
function extractTags(content: string): string[] {
  const tagPattern = /#(\w+)/g;
  const matches = content.match(tagPattern) || [];
  return [...new Set(matches.map(t => t.slice(1).toLowerCase()))];
}

/**
 * Store parsed content
 */
async function storeParsedContent(
  memoryId: string,
  parsed: ParsedContent
): Promise<void> {
  // Update Qdrant payload with parsed metadata
  const { updateMemoryMetadata } = await import('../../services/qdrant.js');
  await updateMemoryMetadata(memoryId, {
    contentType: parsed.contentType,
    title: parsed.title,
    dates: parsed.dates,
    links: parsed.links,
    tags: parsed.tags,
  });
}
```

### Python Endpoint

Add to `ml-services/main.py`:

```python
@app.post("/parse-content")
async def parse_content(request: dict):
    """Parse and classify content using LLM"""
    content = request.get("content", "")
    hint = request.get("hint", "")
    
    prompt = f"""Analyze this content and return structured JSON.

Content type hint: {hint}
Content: {content[:2000]}

Return JSON with these fields:
- contentType: one of (note, task, event, reference, question, idea)
- title: brief title (10 words max)
- summary: one sentence summary
- mentions: array of person/company names mentioned
- structuredData: any key-value pairs extracted

Respond ONLY with valid JSON."""

    response = ollama.chat(
        model="llama3.2:3b",
        messages=[{"role": "user", "content": prompt}],
        format="json"
    )
    
    try:
        result = json.loads(response["message"]["content"])
        result["confidence"] = 0.85
        return result
    except json.JSONDecodeError:
        return {"contentType": "note", "confidence": 0.3}
```

---

## Verification

### Automated Tests
Run simple unit tests for reader agent.

```bash
# Create platform/src/gardener/agents/__tests__/reader.test.ts
import { readerAgent } from '../reader-agent.js';
import { describe, it, expect } from 'vitest';

describe('Reader Agent', () => {
  it('should infer content type', () => {
    // Test heuristics
  });
});
```

### Manual Verification
```bash
# Test reader agent
curl -X POST http://localhost:3001/api/gardener/queue \
  -H "Content-Type: application/json" \
  -d '{
    "agent": "reader",
    "job": {
      "memoryId": "test-456",
      "chunks": ["Meeting with Sarah tomorrow at 3pm about Q4 planning"],
      "type": "note",
      "source": "telegram"
    }
  }'
```

---

## Acceptance Criteria

- [ ] Content type classified correctly
- [ ] Dates extracted from text
- [ ] Links and tags extracted
- [ ] Structured data stored
- [ ] Summarizer queued for long content
- [ ] LLM parsing works with fallback

---

## Next Packet

- [W24: Summarizer Agent](./W24-summarizer-agent.md) - Generate summaries
