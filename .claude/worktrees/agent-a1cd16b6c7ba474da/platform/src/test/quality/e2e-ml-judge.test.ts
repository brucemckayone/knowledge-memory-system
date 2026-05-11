/**
 * Layer 4: End-to-End with ML-as-Judge
 *
 * Full loop: seed knowledge → ask question → verify answer is factually consistent.
 * Uses the LLM itself as a judge (separate system prompt).
 *
 * Requires: PostgreSQL + ML service + Qdrant
 * Speed: ~5-8 min
 * Skips: when services unavailable
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  deleteFromTables,
  isMLServiceAvailable,
  isQdrantAvailable,
  ML_SERVICES_URL,
  QDRANT_URL,
} from '../setup.js';
import { JUDGE_SCENARIOS } from './golden-scenarios.js';
import { seedFacts, seedQdrantMemory, mlJudge } from './helpers.js';

describe('Layer 4: End-to-End ML-as-Judge', () => {
  let mlAvailable = false;
  let qdrantAvailable = false;

  beforeAll(async () => {
    [mlAvailable, qdrantAvailable] = await Promise.all([
      isMLServiceAvailable(),
      isQdrantAvailable(),
    ]);

    if (!mlAvailable) {
      console.warn('⚠️  ML Services not available — skipping e2e ML judge tests');
    }
    if (!qdrantAvailable) {
      console.warn('⚠️  Qdrant not available — skipping e2e ML judge tests');
    }
  });

  const canRun = () => mlAvailable && qdrantAvailable;

  beforeEach(async () => {
    if (!canRun()) return;

    await deleteFromTables({
      tables: [
        'memory_entities', 'entity_aliases', 'entity_merges',
        'contradiction_reviews', 'facts', 'entities',
      ],
      acknowledgeGlobal: true,
    });

    // Reset Qdrant
    try {
      await fetch(`${QDRANT_URL}/collections/memories`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(5000),
      });
      await fetch(`${QDRANT_URL}/collections/memories`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vectors: { size: 768, distance: 'Cosine' },
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* collection might not exist */ }
  });

  // J1: Simple fact query
  it('J1: simple fact query — answer reflects known facts', async (ctx) => {
    if (!canRun()) { ctx.skip(); return; }
    const scenario = JUDGE_SCENARIOS.find(s => s.id === 'J1')!;

    // Seed facts
    const entityCache = await seedFacts(scenario.seededFacts);

    // Seed memories into Qdrant for retrieval
    for (const factDesc of scenario.knownFactsDescription) {
      const entityIds = Array.from(entityCache.values()).slice(0, 2);
      await seedQdrantMemory(factDesc, entityIds);
    }
    await new Promise(r => setTimeout(r, 1000));

    // Ask the question
    const answer = await askQuestion(scenario.question, scenario.knownFactsDescription);

    // Judge the answer
    const { judgement, explanation } = await mlJudge(
      scenario.knownFactsDescription,
      scenario.question,
      answer,
    );

    console.log(`J1: Question: "${scenario.question}"`);
    console.log(`    Answer: "${answer.substring(0, 100)}..."`);
    console.log(`    Judge: ${judgement} — ${explanation}`);

    expect(judgement).toBe(scenario.expectedJudgement);
  }, 120000);

  // J2: Temporal query
  it('J2: temporal query — answer reflects correct time period', async (ctx) => {
    if (!canRun()) { ctx.skip(); return; }
    const scenario = JUDGE_SCENARIOS.find(s => s.id === 'J2')!;

    const entityCache = await seedFacts(scenario.seededFacts);

    for (const factDesc of scenario.knownFactsDescription) {
      const entityIds = Array.from(entityCache.values()).slice(0, 2);
      await seedQdrantMemory(factDesc, entityIds);
    }
    await new Promise(r => setTimeout(r, 1000));

    const answer = await askQuestion(scenario.question, scenario.knownFactsDescription);

    const { judgement, explanation } = await mlJudge(
      scenario.knownFactsDescription,
      scenario.question,
      answer,
    );

    console.log(`J2: Question: "${scenario.question}"`);
    console.log(`    Answer: "${answer.substring(0, 100)}..."`);
    console.log(`    Judge: ${judgement} — ${explanation}`);

    expect(judgement).toBe(scenario.expectedJudgement);
  }, 120000);

  // J3: Contradiction awareness
  it('J3: answer reflects current state, not expired facts', async (ctx) => {
    if (!canRun()) { ctx.skip(); return; }
    const scenario = JUDGE_SCENARIOS.find(s => s.id === 'J3')!;

    const entityCache = await seedFacts(scenario.seededFacts);

    for (const factDesc of scenario.knownFactsDescription) {
      const entityIds = Array.from(entityCache.values()).slice(0, 2);
      await seedQdrantMemory(factDesc, entityIds);
    }
    await new Promise(r => setTimeout(r, 1000));

    const answer = await askQuestion(scenario.question, scenario.knownFactsDescription);

    const { judgement, explanation } = await mlJudge(
      scenario.knownFactsDescription,
      scenario.question,
      answer,
    );

    console.log(`J3: Question: "${scenario.question}"`);
    console.log(`    Answer: "${answer.substring(0, 100)}..."`);
    console.log(`    Judge: ${judgement} — ${explanation}`);

    expect(judgement).toBe(scenario.expectedJudgement);
  }, 120000);

  // J4: Multi-fact synthesis
  it('J4: answer incorporates multiple facts correctly', async (ctx) => {
    if (!canRun()) { ctx.skip(); return; }
    const scenario = JUDGE_SCENARIOS.find(s => s.id === 'J4')!;

    const entityCache = await seedFacts(scenario.seededFacts);

    for (const factDesc of scenario.knownFactsDescription) {
      const entityIds = Array.from(entityCache.values()).slice(0, 3);
      await seedQdrantMemory(factDesc, entityIds);
    }
    await new Promise(r => setTimeout(r, 1000));

    const answer = await askQuestion(scenario.question, scenario.knownFactsDescription);

    const { judgement, explanation } = await mlJudge(
      scenario.knownFactsDescription,
      scenario.question,
      answer,
    );

    console.log(`J4: Question: "${scenario.question}"`);
    console.log(`    Answer: "${answer.substring(0, 100)}..."`);
    console.log(`    Judge: ${judgement} — ${explanation}`);

    expect(judgement).toBe(scenario.expectedJudgement);
  }, 120000);

  // J5: Knowledge boundary
  it('J5: answer expresses uncertainty for unknown entities', async (ctx) => {
    if (!canRun()) { ctx.skip(); return; }
    const scenario = JUDGE_SCENARIOS.find(s => s.id === 'J5')!;

    const entityCache = await seedFacts(scenario.seededFacts);

    for (const factDesc of scenario.knownFactsDescription) {
      const entityIds = Array.from(entityCache.values()).slice(0, 1);
      await seedQdrantMemory(factDesc, entityIds);
    }
    await new Promise(r => setTimeout(r, 1000));

    const answer = await askQuestion(scenario.question, scenario.knownFactsDescription);

    const { judgement, explanation } = await mlJudge(
      scenario.knownFactsDescription,
      scenario.question,
      answer,
    );

    console.log(`J5: Question: "${scenario.question}"`);
    console.log(`    Answer: "${answer.substring(0, 100)}..."`);
    console.log(`    Judge: ${judgement} — ${explanation}`);

    // For knowledge boundary, we accept both UNCERTAIN and CONSISTENT
    // (CONSISTENT if the model says "I don't know" and the judge agrees that's correct)
    expect(['UNCERTAIN', 'CONSISTENT']).toContain(judgement);
  }, 120000);
});

// --- Helpers ---

const ANSWER_SYSTEM_PROMPT = `You are a personal knowledge assistant. You will be given context (numbered facts) and a question.

RULES:
- Answer ONLY using information from the provided context.
- If the context does not contain enough information, respond with: "I don't have enough information to answer that."
- Do NOT invent or assume facts not present in the context.
- Keep your answer concise — 1-3 sentences maximum.`;

/**
 * Ask a question using the LLM with provided context.
 */
async function askQuestion(
  question: string,
  context: string[],
): Promise<string> {
  const contextStr = context.map((c, i) => `${i + 1}. ${c}`).join('\n');

  const message = `Context:\n${contextStr}\n\nQuestion: ${question}`;

  const response = await fetch(`${ML_SERVICES_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      system_prompt: ANSWER_SYSTEM_PROMPT,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`Chat call failed: ${response.status}`);
  }

  const data = await response.json() as { response: string };
  return data.response;
}
