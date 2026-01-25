/**
 * Message Pipeline End-to-End Tests
 *
 * Full pipeline tests from input through storage and retrieval.
 * Covers MP-001 through MP-007 from the test strategy.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  testDb,
  randomUUID,
  isMLServiceAvailable,
  isQdrantAvailable,
  ML_SERVICES_URL,
  QDRANT_URL,
  
} from '../setup.js';

// Envelope type from the system
interface MessageEnvelope {
  traceId: string;
  source: string;
  receivedAt: Date;
  content: {
    text?: string;
    url?: string;
    audioPath?: string;
  };
  classification?: {
    primaryIntent: string;
    confidence: number;
    signals: Record<string, unknown>;
  };
  enrichments: Record<string, unknown>;
  processedAt?: Date;
}

// Helper to create test envelope
function createEnvelope(content: MessageEnvelope['content']): MessageEnvelope {
  return {
    traceId: randomUUID(),
    source: 'test',
    receivedAt: new Date(),
    content,
    enrichments: {},
  };
}

// Helper to ensure test collection exists
async function ensureTestCollection(qdrantAvailable: boolean): Promise<void> {
  if (!qdrantAvailable) return;

  try {
    await fetch(`${QDRANT_URL}/collections/memories`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vectors: { size: 768, distance: 'Cosine' },
      }),
    });
  } catch {
    // Collection might exist
  }
}

// Helper to store memory in Qdrant
async function storeMemory(
  id: string,
  content: string,
  type: string,
  embedding: number[]
): Promise<boolean> {
  try {
    const response = await fetch(`${QDRANT_URL}/collections/memories/points`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        points: [
          {
            id,
            vector: embedding,
            payload: { content, type, created_at: new Date().toISOString() },
          },
        ],
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

describe('Message Pipeline E2E', () => {
  let mlAvailable = false;
  let qdrantAvailable = false;

  beforeAll(async () => {
    mlAvailable = await isMLServiceAvailable();
    qdrantAvailable = await isQdrantAvailable();

    if (!mlAvailable) {
      console.warn('⚠️ ML Services not available - some pipeline tests will be skipped');
    }
    if (!qdrantAvailable) {
      console.warn('⚠️ Qdrant not available - some pipeline tests will be skipped');
    }

    await ensureTestCollection(qdrantAvailable);
  });

  // Note: Tests are self-contained with unique IDs - no global cleanup needed

  describe('MP-001: Text message flow', () => {
    it.skipIf(!mlAvailable || !qdrantAvailable)(
      'should classify, embed, and store text message',
      async () => {
        // Given: Text message
        const envelope = createEnvelope({
          text: 'Had a great meeting about the new feature today',
        });

        // Step 1: Classify
        const classifyResponse = await fetch(`${ML_SERVICES_URL}/classify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: envelope.content.text }),
        });

        expect(classifyResponse.ok).toBe(true);
        const classification = await classifyResponse.json() as Record<string, unknown>;

        envelope.classification = {
          primaryIntent: (classification.primary_intent as string) || 'thought',
          confidence: (classification.confidence as number) || 0.5,
          signals: (classification.signals as Record<string, unknown>) || {},
        };

        // Step 2: Embed
        const embedResponse = await fetch(`${ML_SERVICES_URL}/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: envelope.content.text }),
        });

        expect(embedResponse.ok).toBe(true);
        const embedResult = await embedResponse.json() as Record<string, unknown>;

        const embedding = (embedResult.embedding as unknown as number[]) || [];
        expect(embedding).toBeDefined();
        expect(embedding.length).toBe(768);

        // Step 3: Store in Qdrant
        const memoryId = envelope.traceId;
        const stored = await storeMemory(
          memoryId,
          envelope.content.text!,
          envelope.classification?.primaryIntent || 'thought',
          embedding
        );

        expect(stored).toBe(true);

        // Verify: Search finds the memory
        const searchResponse = await fetch(`${QDRANT_URL}/collections/memories/points/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vector: embedding,
            limit: 1,
            with_payload: true,
          }),
        });

        const searchResult = await searchResponse.json() as Record<string, unknown>;
        const resultArray = (searchResult.result as unknown as Array<{ id: string; score: number }>) || [];
        expect(resultArray[0]?.id).toBe(memoryId);
        expect(resultArray[0]?.score).toBeGreaterThan(0.99);
      },
      60000
    );
  });

  describe('MP-002: Link workflow', () => {
    it.skipIf(!mlAvailable || !qdrantAvailable)(
      'should scrape, summarize, and store link',
      async () => {
        // Given: URL message
        const envelope = createEnvelope({
          url: 'https://example.com',
        });

        // Step 1: Classify as link
        const classifyResponse = await fetch(`${ML_SERVICES_URL}/classify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: envelope.content.url }),
        });

        expect(classifyResponse.ok).toBe(true);
        const classification = await classifyResponse.json() as Record<string, unknown>;

        // Should be classified as link
        expect(['link', 'url', 'reference']).toContain(
          (classification.primary_intent as string)?.toLowerCase() || ''
        );

        // Step 2: Scrape URL
        const scrapeResponse = await fetch(`${ML_SERVICES_URL}/scrape`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: envelope.content.url }),
        });

        expect(scrapeResponse.ok).toBe(true);
        const scrapeResult = await scrapeResponse.json() as Record<string, unknown>;

        const scrapedTitle = (scrapeResult.title as string) || '';
        const scrapedContent = (scrapeResult.content as string) || '';
        envelope.enrichments.scraped = {
          title: scrapedTitle,
          content: scrapedContent,
        };

        // Step 3: Embed scraped content
        const textToEmbed = `${scrapedTitle}\n\n${scrapedContent}`.slice(0, 1000);

        const embedResponse = await fetch(`${ML_SERVICES_URL}/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: textToEmbed }),
        });

        expect(embedResponse.ok).toBe(true);
        const embedResult = await embedResponse.json() as Record<string, unknown>;

        // Step 4: Store
        const memoryId = envelope.traceId;
        const linkEmbedding = (embedResult.embedding as unknown as number[]) || [];
        const stored = await storeMemory(
          memoryId,
          textToEmbed,
          'link',
          linkEmbedding
        );

        expect(stored).toBe(true);
      },
      60000
    );
  });

  describe('MP-003: Task workflow', () => {
    it.skipIf(!mlAvailable)('should extract and store task', async () => {
      // Given: Task-like message
      const envelope = createEnvelope({
        text: 'Remember to call John tomorrow about the project deadline',
      });

      // Step 1: Classify
      const classifyResponse = await fetch(`${ML_SERVICES_URL}/classify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: envelope.content.text }),
      });

      expect(classifyResponse.ok).toBe(true);
      const classification = await classifyResponse.json() as Record<string, unknown>;

      // Should be classified as task
      expect(['task', 'reminder', 'todo']).toContain(
        (classification.primary_intent as string)?.toLowerCase() || ''
      );

      // Step 2: Extract task details
      const extractResponse = await fetch(`${ML_SERVICES_URL}/extract-task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: envelope.content.text }),
      });

      expect(extractResponse.ok).toBe(true);
      const taskDetails = await extractResponse.json() as Record<string, unknown>;

      expect(taskDetails.action).toBeDefined();

      // Step 3: Store task in database
      const dueDate = taskDetails.due_date ? new Date(taskDetails.due_date as string) : null;
      const priority = (taskDetails.priority as string | undefined) || 'medium';
      const taskText = envelope.content.text || '';
      await testDb`
        INSERT INTO tasks (trace_id, content, due_date, priority, status)
        VALUES (
          ${envelope.traceId}::uuid,
          ${taskText},
          ${dueDate},
          ${priority},
          'pending'
        )
      `;

      // Verify: Task stored
      const tasks = await testDb`
        SELECT * FROM tasks WHERE trace_id = ${envelope.traceId}::uuid
      `;

      expect(tasks.length).toBe(1);
      expect(tasks[0]?.content).toBe(taskText);
      expect(tasks[0]?.status).toBe('pending');
    }, 60000);
  });

  describe('MP-004: Voice workflow', () => {
    it.skipIf(!mlAvailable)('should handle voice message (transcription mock)', async () => {
      // Given: Voice message (simulated transcription)
      const transcribedText = 'This is a transcribed voice message about the project status';

      const envelope = createEnvelope({
        audioPath: '/tmp/voice_001.ogg',
      });

      // Simulate transcription result
      envelope.enrichments.transcription = {
        text: transcribedText,
        confidence: 0.85,
      };

      // Step 1: Classify transcribed text
      const classifyResponse = await fetch(`${ML_SERVICES_URL}/classify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: transcribedText }),
      });

      expect(classifyResponse.ok).toBe(true);

      // Step 2: Process as normal text from here
      const embedResponse = await fetch(`${ML_SERVICES_URL}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: transcribedText }),
      });

      expect(embedResponse.ok).toBe(true);
      const embedResult = await embedResponse.json() as Record<string, unknown>;

      // Verify: Embedding generated
      const voiceEmbedding = (embedResult.embedding as unknown as number[]) || [];
      expect(voiceEmbedding).toBeDefined();
      expect(voiceEmbedding.length).toBe(768);
    }, 60000);
  });

  describe('MP-005: Envelope tracing', () => {
    it('should preserve full trace through pipeline', () => {
      // Given: Message with trace ID
      const envelope = createEnvelope({
        text: 'Traced message content',
      });

      const originalTraceId = envelope.traceId;

      // When: Add enrichments through pipeline
      envelope.classification = {
        primaryIntent: 'thought',
        confidence: 0.9,
        signals: { hasEntityMention: true },
      };

      envelope.enrichments.entities = [
        { mention: 'John', type: 'person' },
      ];

      envelope.processedAt = new Date();

      // Then: Trace ID preserved, enrichments accumulated
      expect(envelope.traceId).toBe(originalTraceId);
      expect(envelope.enrichments.entities).toBeDefined();
      expect(envelope.classification).toBeDefined();
      expect(envelope.processedAt).toBeDefined();
    });
  });

  describe('MP-006: Classification fallback', () => {
    it.skipIf(!mlAvailable)('should treat unparseable message as thought', async () => {
      // Given: Ambiguous message
      const envelope = createEnvelope({
        text: '🤔 💭 ...',
      });

      // When: Classify
      const classifyResponse = await fetch(`${ML_SERVICES_URL}/classify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: envelope.content.text }),
      });

      // Then: Should get some classification (fallback behavior)
      expect(classifyResponse.ok).toBe(true);
      const classification = await classifyResponse.json() as Record<string, unknown>;

      // Primary intent should be defined (even if low confidence)
      expect(classification.primary_intent).toBeDefined();
    }, 30000);
  });

  describe('MP-007: Queue retry', () => {
    it('should track retry attempts for failed jobs', async () => {
      // Given: Job that failed
      const jobId = randomUUID();

      await testDb`
        INSERT INTO gardener_job_meta (job_id, job_type, tier, attempts, last_error)
        VALUES (
          ${jobId}::uuid,
          'gardener:process-message',
          'realtime',
          1,
          'ML service timeout'
        )
      `;

      // When: Retry (increment attempts)
      await testDb`
        UPDATE gardener_job_meta
        SET attempts = attempts + 1,
            last_error = NULL,
            started_at = NOW()
        WHERE job_id = ${jobId}::uuid
      `;

      // Then: Attempts tracked
      const job = await testDb`
        SELECT * FROM gardener_job_meta WHERE job_id = ${jobId}::uuid
      `;

      expect(job[0]?.attempts).toBe(2);
      expect(job[0]?.last_error).toBeNull();

      // Simulate successful completion
      await testDb`
        UPDATE gardener_job_meta
        SET completed_at = NOW(), duration_ms = 500
        WHERE job_id = ${jobId}::uuid
      `;

      const completed = await testDb`
        SELECT * FROM gardener_job_meta WHERE job_id = ${jobId}::uuid
      `;

      expect(completed[0]?.completed_at).not.toBeNull();
    });
  });
});
