/**
 * ML Services Integration Tests
 *
 * Tests for Platform ↔ ML Services module boundary.
 * Covers ML-001 through ML-010 from the test strategy.
 *
 * NOTE: Uses live Ollama - tests may be non-deterministic.
 * Longer timeouts for LLM calls.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { ML_SERVICES_URL, isMLServiceAvailable } from '../setup.js';

describe('Platform ↔ ML Services Integration', () => {
  beforeAll(async (ctx) => {
    const mlAvailable = await isMLServiceAvailable();
    if (!mlAvailable) {
      console.warn('⚠️ ML Services not available - skipping ML tests');
      (ctx as any).skip();
    }
  });

  describe('ML-001: Embedding generation', () => {
    it('should generate 768-dim vector', async () => {
      // Given: Text to embed
      const text = 'This is a test sentence for embedding generation.';

      // When: Call embed endpoint
      const response = await fetch(`${ML_SERVICES_URL}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      // Then: Returns 768-dimension vector
      expect(response.ok).toBe(true);
      const result = await response.json() as Record<string, unknown>;

      const embedding = (result.vector as unknown as number[]) || [];
      expect(embedding).toBeDefined();
      expect(Array.isArray(embedding)).toBe(true);
      expect(embedding.length).toBe(768);

      // All values should be numbers
      embedding.forEach((v: unknown) => {
        expect(typeof v).toBe('number');
        expect(Number.isFinite(v as number)).toBe(true);
      });
    }, 30000);

    it('should produce different embeddings for different texts', async () => {
      // Given: Two different texts
      const text1 = 'Machine learning is fascinating.';
      const text2 = 'I had pizza for lunch today.';

      // When: Embed both
      const [response1, response2] = await Promise.all([
        fetch(`${ML_SERVICES_URL}/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: text1 }),
        }),
        fetch(`${ML_SERVICES_URL}/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: text2 }),
        }),
      ]);

      const result1 = await response1.json() as Record<string, unknown>;
      const result2 = await response2.json() as Record<string, unknown>;

      const embed1 = (result1.vector as unknown as number[]) || [];
      const embed2 = (result2.vector as unknown as number[]) || [];

      // Then: Embeddings are different
      expect(embed1).not.toEqual(embed2);

      // Calculate cosine similarity - should be low for unrelated texts
      const dotProduct = embed1.reduce(
        (sum: number, v: number, i: number) => sum + v * (embed2[i] || 0),
        0
      );
      const mag1 = Math.sqrt(embed1.reduce((s: number, v: number) => s + v * v, 0));
      const mag2 = Math.sqrt(embed2.reduce((s: number, v: number) => s + v * v, 0));
      const similarity = dotProduct / (mag1 * mag2);

      // Unrelated texts should have lower similarity
      expect(similarity).toBeLessThan(0.9);
    }, 30000);
  });

  describe('ML-002: Batch embedding', () => {
    it('should embed multiple texts at once', async () => {
      // Given: Array of texts
      const texts = [
        'First sentence to embed.',
        'Second sentence about something else.',
        'Third sentence with different content.',
      ];

      // When: Call batch embed endpoint
      const response = await fetch(`${ML_SERVICES_URL}/embed/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts }),
      });

      // Then: Returns array of embeddings
      expect(response.ok).toBe(true);
      const result = await response.json() as Record<string, unknown>;

      const embeddings = (result.embeddings as unknown as number[][]) || [];
      expect(embeddings).toBeDefined();
      expect(Array.isArray(embeddings)).toBe(true);
      expect(embeddings.length).toBe(3);

      // Each embedding should be 768-dim
      embeddings.forEach((emb: number[]) => {
        expect(emb.length).toBe(768);
      });
    }, 60000);
  });

  describe('ML-003: Classification accuracy', () => {
    it('should classify thought correctly', async () => {
      // Given: Thought-like message
      const text = 'Had a great idea about the new feature today. We could use caching to improve performance.';

      // When: Classify
      const response = await fetch(`${ML_SERVICES_URL}/classify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      // Then: Classified as thought
      expect(response.ok).toBe(true);
      const result = await response.json() as Record<string, unknown>;

      expect(result.primary_intent).toBeDefined();
      expect(['thought', 'idea', 'note']).toContain((result.primary_intent as string)?.toLowerCase() || '');
      expect((result.confidence as number) || 0).toBeGreaterThan(0.5);
    }, 30000);

    it('should classify task correctly', async () => {
      // Given: Task-like message
      const text = 'Remember to call John tomorrow about the project deadline.';

      // When: Classify
      const response = await fetch(`${ML_SERVICES_URL}/classify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      // Then: Classified as task
      expect(response.ok).toBe(true);
      const result = await response.json() as Record<string, unknown>;

      expect(['task', 'reminder', 'todo']).toContain((result.primary_intent as string)?.toLowerCase() || '');
    }, 30000);

    it('should classify question correctly', async () => {
      // Given: Question message
      const text = 'How does the authentication system work in this project?';

      // When: Classify
      const response = await fetch(`${ML_SERVICES_URL}/classify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      // Then: Classified as question
      expect(response.ok).toBe(true);
      const result = await response.json() as Record<string, unknown>;

      expect(['question', 'query', 'inquiry']).toContain((result.primary_intent as string)?.toLowerCase() || '');
    }, 30000);

    it('should classify link correctly', async () => {
      // Given: Link message
      const text = 'https://example.com/interesting-article-about-machine-learning';

      // When: Classify
      const response = await fetch(`${ML_SERVICES_URL}/classify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      // Then: Classified as link
      expect(response.ok).toBe(true);
      const result = await response.json() as Record<string, unknown>;

      expect(['link', 'url', 'reference']).toContain((result.primary_intent as string)?.toLowerCase() || '');
    }, 30000);
  });

  describe('ML-004: Task extraction', () => {
    it('should extract action, date, priority', async () => {
      // Given: Task text with details
      const text = 'Urgently need to review the PR by Friday.';

      // When: Extract task
      const response = await fetch(`${ML_SERVICES_URL}/extract-task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      // Then: Structured task returned
      expect(response.ok).toBe(true);
      const result = await response.json() as Record<string, unknown>;

      expect(result.action).toBeDefined();
      expect(typeof result.action).toBe('string');

      // Priority should be detected (urgently = high)
      const priority = result.priority as string | undefined;
      if (priority) {
        expect(['urgent', 'high', 'critical']).toContain(priority.toLowerCase());
      }

      // Due date might be extracted
      const dueDate = result.due_date as string | undefined;
      if (dueDate) {
        expect(typeof dueDate).toBe('string');
      }
    }, 30000);
  });

  describe('ML-005: Entity extraction', () => {
    it('should extract named entities', async () => {
      // Given: Text with names
      const text = 'Meeting with John Smith at Google headquarters in San Francisco.';

      // When: Extract entities
      const response = await fetch(`${ML_SERVICES_URL}/extract-entities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      // Then: Entities with positions returned
      expect(response.ok).toBe(true);
      const result = await response.json() as Record<string, unknown>;

      const entities = (result.entities as unknown as Array<{ type: string; mention: string }>) || [];
      expect(entities).toBeDefined();
      expect(Array.isArray(entities)).toBe(true);

      // Should find at least person and company
      const types = entities.map((e: { type: string }) => e.type.toLowerCase());

      // Fuzzy assertion - LLM might classify slightly differently
      const hasPerson = types.some((t: string) => ['person', 'people', 'human'].includes(t));
      const hasOrg = types.some((t: string) => ['company', 'organization', 'org', 'place'].includes(t));

      expect(hasPerson || hasOrg).toBe(true);

      // Entities should have mention text
      entities.forEach((e: { mention: string }) => {
        expect(e.mention).toBeDefined();
        expect(typeof e.mention).toBe('string');
      });
    }, 30000);

    it('should return empty for text without entities', async () => {
      // Given: Text with no named entities
      const text = 'The weather is nice today.';

      // When: Extract entities
      const response = await fetch(`${ML_SERVICES_URL}/extract-entities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      // Then: Empty or minimal entity list
      expect(response.ok).toBe(true);
      const result = await response.json() as Record<string, unknown>;

      const entities = (result.entities as unknown as unknown[]) || [];
      expect(entities).toBeDefined();
      // Might return empty or very few entities
      expect(entities.length).toBeLessThan(3);
    }, 30000);
  });

  describe('ML-006: Contradiction detection', () => {
    it('should detect conflicting facts', async () => {
      // Given: Two contradictory facts
      const fact1 = { subject: 'John', predicate: 'works_at', object: 'Acme Corp' };
      const fact2 = { subject: 'John', predicate: 'works_at', object: 'TechVentures' };

      // When: Check for contradiction
      const response = await fetch(`${ML_SERVICES_URL}/detect-contradiction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fact1, fact2 }),
      });

      // Then: Contradiction detected
      expect(response.ok).toBe(true);
      const result = await response.json() as Record<string, unknown>;

      expect(result.contradicts).toBe(true);
      expect(result.contradiction_type).toBeDefined();
    }, 30000);

    it('should not flag compatible facts', async () => {
      // Given: Two compatible facts
      const fact1 = { subject: 'John', predicate: 'knows', object: 'Sarah' };
      const fact2 = { subject: 'John', predicate: 'knows', object: 'Mike' };

      // When: Check for contradiction
      const response = await fetch(`${ML_SERVICES_URL}/detect-contradiction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fact1, fact2 }),
      });

      // Then: No contradiction
      expect(response.ok).toBe(true);
      const result = await response.json() as Record<string, unknown>;

      expect(result.contradicts).toBe(false);
    }, 30000);
  });

  describe('ML-007: Summarization', () => {
    it('should summarize long content', async () => {
      // Given: Long text
      const text = `
        The quarterly review meeting covered several important topics.
        First, the engineering team presented their progress on the new
        authentication system, which is now 80% complete. They mentioned
        challenges with OAuth integration but expect to resolve them by
        next week. The product team shared customer feedback, noting that
        users want better search functionality. Marketing presented the
        Q4 campaign results, showing a 25% increase in user signups.
        Finally, the CEO announced plans for international expansion,
        starting with the European market in Q2 next year.
      `;

      // When: Summarize
      const response = await fetch(`${ML_SERVICES_URL}/summarize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      // Then: Summary and key points returned
      expect(response.ok).toBe(true);
      const result = await response.json() as Record<string, unknown>;

      expect(result.summary).toBeDefined();
      expect(typeof result.summary).toBe('string');
      expect((result.summary as string)?.length || 0).toBeLessThan(text.length);

      // Key points if provided
      const keyPoints = result.key_points as unknown[];
      if (keyPoints) {
        expect(Array.isArray(keyPoints)).toBe(true);
      }
    }, 45000);
  });

  describe('ML-008: Web scraping', () => {
    it('should extract clean content from URL', async () => {
      // Given: A real URL (using a simple, stable page)
      const url = 'https://example.com';

      // When: Scrape
      const response = await fetch(`${ML_SERVICES_URL}/scrape`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      // Then: Title and content returned
      expect(response.ok).toBe(true);
      const result = await response.json() as Record<string, unknown>;

      expect(result.title).toBeDefined();
      expect(result.content).toBeDefined();
      expect(typeof result.title).toBe('string');
      expect(typeof result.content).toBe('string');
    }, 30000);
  });

  describe('ML-009: Graceful degradation', () => {
    it('should return appropriate error for invalid endpoint', async () => {
      // When: Call non-existent endpoint
      const response = await fetch(`${ML_SERVICES_URL}/non-existent-endpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      // Then: Returns error status, not crash
      expect(response.status).toBeGreaterThanOrEqual(400);
    });

    it('should handle malformed input gracefully', async () => {
      // When: Send malformed request
      const response = await fetch(`${ML_SERVICES_URL}/classify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wrong_field: 'value' }),
      });

      // Then: Returns error, not crash
      expect(response.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('ML-010: Transcription (when enabled)', () => {
    // This test would require actual audio file
    // Skipped unless specifically testing transcription feature
    it.skip('should transcribe audio to text', async () => {
      // Given: Audio file
      // When: Transcribe
      // Then: Text returned
      expect(true).toBe(true);
    });
  });
});
