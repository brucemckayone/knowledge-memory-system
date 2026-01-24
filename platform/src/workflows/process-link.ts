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
  url?: string;
  error?: string;
}

/**
 * Process a message containing a URL
 * Flow: Extract URL -> Fetch Page -> Summarize -> Embed -> Store
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

    const firstUrlInfo = urlResult.urls[0];
    const domain = firstUrlInfo?.domain || 'unknown';

    addEnrichment(envelope, 'extract_url', {
      url: urlResult.primary_url,
      domain,
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
        domain
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
      url: urlResult.primary_url,
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
    tags: [domain.split('.')[0] || domain],
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
    url,
  };
}

/**
 * Extract tags from domain and key points
 */
function extractTags(domain: string, keyPoints: string[]): string[] {
  const tags = new Set<string>();

  // Add domain as tag
  const domainParts = domain.split('.');
  const domainBase = domainParts[0] || '';
  if (domainBase.length > 2) {
    tags.add(domainBase.toLowerCase());
  }

  // Add keywords from key points
  const stopWords = ['about', 'their', 'there', 'which', 'would', 'being', 'could', 'should'];
  for (const point of keyPoints.slice(0, 3)) {
    const words = point.toLowerCase().split(/\s+/);
    for (const word of words) {
      if (word.length > 4 && !stopWords.includes(word)) {
        tags.add(word);
      }
    }
  }

  return Array.from(tags).slice(0, 5);
}
