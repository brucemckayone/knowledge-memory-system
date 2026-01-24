# Work Packet W11: Link Processing

**Status:** Ready to Implement  
**Dependencies:** W08 (Skill Framework), W13 (Web Scraper)  
**Estimated Time:** 2-3 hours

---

## Objective

When a message contains a URL, fetch the page content, generate a summary, and store the enriched memory with title, summary, and original content.

---

## Background

### Current State
- `classifySimple()` detects URLs with regex
- Messages with URLs are stored as `type: 'link'`
- No content fetching or summarization

### Target State
- Detect URLs in messages
- Fetch page content via Python scraper
- Generate summary via LLM
- Store with rich metadata:
  - Original URL
  - Fetched title
  - Summary
  - Domain
  - Key points

---

## Architecture

### Link Processing Flow

```
Message with URL
       ↓
  [Detect URL] extract-url skill
       ↓
  [Fetch] /scrape endpoint (Python)
       ↓
  Page content (title, text)
       ↓
  [Summarize] /summarize endpoint (LLM)
       ↓
  Summary + key points
       ↓
  [Embed] summary text
       ↓
  [Store] Rich memory payload
```

---

## Step 1: Create URL Extractor Skill

Create `platform/src/skills/core/extract-url.skill.ts`:

```typescript
import type { Skill, SkillContext } from '../types.js';

export interface ExtractUrlInput {
  text: string;
}

export interface ExtractUrlOutput {
  found: boolean;
  urls: Array<{
    url: string;
    domain: string;
    position: number;
  }>;
  primary_url?: string;
}

// URL regex that captures most common URLs
const URL_REGEX = /https?:\/\/(?:[\w-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/gi;

export const extractUrlSkill: Skill<ExtractUrlInput, ExtractUrlOutput> = {
  name: 'extract-url',
  description: 'Extract URLs from text',
  version: '1.0.0',

  async execute(input: ExtractUrlInput, context: SkillContext): Promise<ExtractUrlOutput> {
    const matches = [...input.text.matchAll(URL_REGEX)];
    
    if (matches.length === 0) {
      context.log('No URLs found');
      return { found: false, urls: [] };
    }

    const urls = matches.map(match => {
      const url = match[0];
      let domain = 'unknown';
      try {
        domain = new URL(url).hostname.replace('www.', '');
      } catch {
        // Invalid URL, keep as-is
      }
      
      return {
        url,
        domain,
        position: match.index || 0,
      };
    });

    context.log(`Found ${urls.length} URL(s): ${urls.map(u => u.domain).join(', ')}`);

    return {
      found: true,
      urls,
      primary_url: urls[0].url,
    };
  },
};
```

---

## Step 2: Create TypeScript Scrape Service

Create `platform/src/services/scrape.ts`:

```typescript
import { config } from '../config.js';

export interface ScrapeResult {
  url: string;
  title: string;
  content: string;
  text: string;
  domain: string;
  word_count: number;
}

/**
 * Scrape and extract content from a URL
 */
export async function scrapeUrl(url: string): Promise<ScrapeResult> {
  const response = await fetch(`${config.ML_SERVICES_URL}/scrape`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Scraping failed: ${response.status} - ${error}`);
  }

  return response.json() as Promise<ScrapeResult>;
}
```

---

## Step 3: Create TypeScript Summarize Service

Create `platform/src/services/summarize.ts`:

```typescript
import { config } from '../config.js';

export interface SummarizeResult {
  summary: string;
  key_points: string[];
  word_count: number;
}

/**
 * Summarize text content using LLM
 */
export async function summarize(
  content: string,
  title?: string,
  maxLength = 4000
): Promise<SummarizeResult> {
  // Truncate content if too long
  const truncated = content.slice(0, maxLength);
  
  const response = await fetch(`${config.ML_SERVICES_URL}/summarize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      content: truncated,
      title: title || 'Untitled',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Summarization failed: ${response.status} - ${error}`);
  }

  return response.json() as Promise<SummarizeResult>;
}
```

---

## Step 4: Create Fetch Webpage Skill

Create `platform/src/skills/core/fetch-webpage.skill.ts`:

```typescript
import type { Skill, SkillContext } from '../types.js';
import { scrapeUrl, ScrapeResult } from '../../services/scrape.js';

export interface FetchWebpageInput {
  url: string;
}

export type FetchWebpageOutput = ScrapeResult;

export const fetchWebpageSkill: Skill<FetchWebpageInput, FetchWebpageOutput> = {
  name: 'fetch-webpage',
  description: 'Fetch and extract content from a webpage',
  version: '1.0.0',

  async execute(input: FetchWebpageInput, context: SkillContext): Promise<FetchWebpageOutput> {
    context.log(`Fetching: ${input.url}`);
    
    const result = await scrapeUrl(input.url);
    
    context.log(`Fetched "${result.title}" (${result.word_count} words)`);
    
    return result;
  },
};
```

---

## Step 5: Create Summarize Skill

Create `platform/src/skills/core/summarize.skill.ts`:

```typescript
import type { Skill, SkillContext } from '../types.js';
import { summarize, SummarizeResult } from '../../services/summarize.js';

export interface SummarizeInput {
  content: string;
  title?: string;
}

export type SummarizeOutput = SummarizeResult;

export const summarizeSkill: Skill<SummarizeInput, SummarizeOutput> = {
  name: 'summarize',
  description: 'Summarize text content using LLM',
  version: '1.0.0',

  async execute(input: SummarizeInput, context: SkillContext): Promise<SummarizeOutput> {
    context.log(`Summarizing: ${input.content.slice(0, 50)}...`);
    
    const result = await summarize(input.content, input.title);
    
    context.log(`Summary: ${result.summary.slice(0, 100)}...`);
    
    return result;
  },
};
```

---

## Step 6: Create Link Processing Workflow

Create `platform/src/workflows/process-link.ts`:

```typescript
import type { Envelope } from '../types/envelope.js';
import type { SkillContext } from '../skills/types.js';
import { addEnrichment } from '../core/envelope-factory.js';
import { extractUrlSkill } from '../skills/core/extract-url.skill.js';
import { fetchWebpageSkill } from '../skills/core/fetch-webpage.skill.js';
import { summarizeSkill } from '../skills/core/summarize.skill.js';
import { embedSkill } from '../skills/core/embed.skill.js';
import { storeMemorySkill } from '../skills/core/store-memory.skill.js';

export interface ProcessLinkResult {
  success: boolean;
  memory_id?: string;
  title?: string;
  summary?: string;
  error?: string;
}

/**
 * Process a message containing a URL
 */
export async function processLink(
  envelope: Envelope,
  context: SkillContext
): Promise<ProcessLinkResult> {
  const content = envelope.raw.content || '';
  const startTime = Date.now();
  
  try {
    // Step 1: Extract URL
    context.log('Step 1: Extracting URL');
    const urlResult = await extractUrlSkill.execute({ text: content }, context);
    
    if (!urlResult.found || !urlResult.primary_url) {
      return { success: false, error: 'No URL found in message' };
    }
    
    addEnrichment(envelope, 'extract_url', {
      url: urlResult.primary_url,
      domain: urlResult.urls[0].domain,
    }, startTime);
    
    // Step 2: Fetch webpage
    context.log('Step 2: Fetching webpage');
    const fetchStart = Date.now();
    let fetchResult;
    
    try {
      fetchResult = await fetchWebpageSkill.execute(
        { url: urlResult.primary_url }, 
        context
      );
    } catch (error) {
      context.log(`Fetch failed: ${error}`, 'warn');
      
      // Store without content if fetch fails
      return await storeLinkWithoutContent(
        envelope, 
        context, 
        urlResult.primary_url,
        urlResult.urls[0].domain
      );
    }
    
    addEnrichment(envelope, 'fetch', {
      title: fetchResult.title,
      content: fetchResult.text.slice(0, 1000), // Truncate for storage
    }, fetchStart);
    
    // Step 3: Summarize
    context.log('Step 3: Summarizing');
    const summarizeStart = Date.now();
    const summaryResult = await summarizeSkill.execute({
      content: fetchResult.text,
      title: fetchResult.title,
    }, context);
    
    addEnrichment(envelope, 'summarize', {
      summary: summaryResult.summary,
      key_points: summaryResult.key_points,
    }, summarizeStart);
    
    // Step 4: Generate embedding (from summary for better retrieval)
    context.log('Step 4: Embedding');
    const embedStart = Date.now();
    const embedText = `${fetchResult.title}\n\n${summaryResult.summary}`;
    const embedResult = await embedSkill.execute({ text: embedText }, context);
    
    addEnrichment(envelope, 'embed', {
      vector: embedResult.vector,
      model: embedResult.model,
    }, embedStart);
    
    // Step 5: Store memory
    context.log('Step 5: Storing');
    const storeStart = Date.now();
    const storeResult = await storeMemorySkill.execute({
      id: envelope.trace_id,
      vector: embedResult.vector,
      type: 'link',
      content: content, // Original message
      summary: summaryResult.summary,
      tags: extractTags(fetchResult.domain, summaryResult.key_points),
      metadata: {
        url: urlResult.primary_url,
        domain: fetchResult.domain,
        title: fetchResult.title,
        key_points: summaryResult.key_points,
        fetched_at: new Date().toISOString(),
      },
    }, context);
    
    addEnrichment(envelope, 'store', { memory_id: storeResult.memory_id }, storeStart);
    
    envelope.routing.status = 'completed';
    
    return {
      success: true,
      memory_id: storeResult.memory_id,
      title: fetchResult.title,
      summary: summaryResult.summary,
    };
    
  } catch (error) {
    context.log(`Link processing failed: ${error}`, 'error');
    envelope.routing.status = 'failed';
    return { success: false, error: String(error) };
  }
}

/**
 * Store link without fetched content (fallback)
 */
async function storeLinkWithoutContent(
  envelope: Envelope,
  context: SkillContext,
  url: string,
  domain: string
): Promise<ProcessLinkResult> {
  const content = envelope.raw.content || url;
  
  const embedResult = await embedSkill.execute({ text: content }, context);
  
  await storeMemorySkill.execute({
    id: envelope.trace_id,
    vector: embedResult.vector,
    type: 'link',
    content: content,
    summary: `Link to ${domain}`,
    tags: [domain.split('.')[0]],
    metadata: {
      url,
      domain,
      fetched: false,
    },
  }, context);
  
  return {
    success: true,
    memory_id: envelope.trace_id,
    title: domain,
    summary: `Link saved (content not fetched)`,
  };
}

/**
 * Extract tags from domain and key points
 */
function extractTags(domain: string, keyPoints: string[]): string[] {
  const tags = new Set<string>();
  
  // Add domain as tag
  const domainBase = domain.split('.')[0];
  if (domainBase && domainBase.length > 2) {
    tags.add(domainBase.toLowerCase());
  }
  
  // Add keywords from key points
  for (const point of keyPoints.slice(0, 3)) {
    const words = point.toLowerCase().split(/\s+/);
    for (const word of words) {
      if (word.length > 4 && !['about', 'their', 'there', 'which', 'would'].includes(word)) {
        tags.add(word);
      }
    }
  }
  
  return Array.from(tags).slice(0, 5);
}
```

---

## Step 7: Register New Skills

Update `platform/src/skills/index.ts`:

```typescript
// Add imports
import { extractUrlSkill } from './core/extract-url.skill.js';
import { fetchWebpageSkill } from './core/fetch-webpage.skill.js';
import { summarizeSkill } from './core/summarize.skill.js';

// Update registerCoreSkills
export function registerCoreSkills(): void {
  registry.register(embedSkill);
  registry.register(storeMemorySkill);
  registry.register(transcribeSkill);
  registry.register(classifySkill);
  registry.register(extractUrlSkill);     // Add
  registry.register(fetchWebpageSkill);   // Add
  registry.register(summarizeSkill);      // Add
  
  console.log('✅ Core skills registered');
  console.log(`   Available: ${registry.list().map(s => s.name).join(', ')}`);
}

// Export
export { 
  embedSkill, 
  storeMemorySkill, 
  transcribeSkill, 
  classifySkill,
  extractUrlSkill,
  fetchWebpageSkill,
  summarizeSkill,
};
```

---

## Step 8: Update Message Processor

Update `platform/src/workers/message-processor.ts`:

```typescript
import { processLink } from '../workflows/process-link.js';
import { createSkillContext } from '../skills/index.js';

// In processMessage, after classification:

// Route to appropriate workflow
if (classification.primary_intent === 'link') {
  console.log('🔗 Routing to link workflow');
  const context = createSkillContext(envelope);
  const result = await processLink(envelope, context);
  
  if (result.success) {
    // Notify user
    await bot.api.sendMessage(data.chatId, 
      `🔗 **Link saved!**\n\n` +
      `📰 ${result.title}\n\n` +
      `📝 ${result.summary}`,
      { parse_mode: 'Markdown' }
    );
  } else {
    console.warn('Link processing failed:', result.error);
    // Continue with basic storage as fallback
  }
  return;
}
```

---

## Testing

### Test URL Extraction

```typescript
// Test in console
const result = extractUrlSkill.execute(
  { text: 'Check out https://example.com/article!' },
  mockContext
);
// Expected: { found: true, urls: [...], primary_url: 'https://example.com/article' }
```

### Test End-to-End

1. Send message with URL to bot: "Check out https://news.ycombinator.com"
2. Should receive:
   - "Processing link..."
   - "🔗 **Link saved!**\n📰 Hacker News\n📝 Summary..."
3. Check Qdrant for stored memory with:
   - type: 'link'
   - url, domain, title, summary in payload

---

## Acceptance Criteria

- [ ] `extract-url.skill.ts` extracts URLs correctly
- [ ] `fetch-webpage.skill.ts` calls scraper
- [ ] `summarize.skill.ts` calls LLM
- [ ] `process-link.ts` chains all skills
- [ ] Link memories have rich metadata
- [ ] Bot replies with title and summary
- [ ] Fallback when fetch fails
- [ ] Skills registered at startup
- [ ] `pnpm typecheck` passes

---

## Dependencies on W13

This packet requires [W13: Web Scraper](./W13-web-scraper.md) to be completed first, as it provides:
- `/scrape` Python endpoint
- `/summarize` Python endpoint

---

## Next Packet

After completing W11, proceed to:
- [W12: Task Extraction](./W12-task-extraction.md) - Similar workflow pattern
- [W15: Enhanced Telegram](./W15-enhanced-telegram.md) - Integrate responses
