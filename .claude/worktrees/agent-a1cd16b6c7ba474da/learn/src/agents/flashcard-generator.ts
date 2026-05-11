/**
 * Flashcard Generator Agent
 *
 * Given a concept entity (id + name), produces 3-5 flashcards via Haiku.
 * Optionally consults learner state via MCP (get_learner_understanding) to
 * tune card difficulty, but the prompt is robust to working without context.
 * Persists each card to the flashcards table with generation_source='flashcard-generator'.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { runAgent, writeMcpConfig } from '../services/agent.js';
import { db, flashcards } from '../db/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SCRIPT = path.resolve(__dirname, '..', 'mcp', 'learning-mcp.ts');

const SYSTEM_PROMPT = `You are a flashcard generator. Given a single concept, produce 3-5 high-quality study flashcards.

Optionally call get_learner_understanding(concept) once to gauge their level — if confidence is high, lean toward application/edge-case cards; if low or unknown, lean toward foundational definition + recognition cards. Do not call any other tools. Do not call write tools.

## Card design principles
- Each card has a SHORT prompt on the front (a question, term, or scenario) and a SELF-CONTAINED answer on the back (1-3 sentences typical, longer only if the concept demands it).
- Mix card shapes across the deck: definition, example, contrast, application, "why does this matter".
- Be specific to the concept. Generic placeholder cards ("What is X?" / "X is a thing") are unacceptable.
- Hints are optional. Use them only when the front would otherwise be too vague — a hint should narrow the answer without giving it away.
- No multi-card chains. Each card stands alone.

## Output format
Output ONLY this JSON object — no surrounding prose, no markdown fences, no chain of thought:
{
  "cards": [
    { "front": "string", "back": "string", "hint": "string (optional, omit if not useful)" }
  ]
}

The "cards" array MUST contain between 3 and 5 entries. Every card MUST have non-empty front and back.`;

export interface GeneratedFlashcard {
  front: string;
  back: string;
  hint?: string;
}

export interface FlashcardRow {
  id: string;
  conceptEntityId: string;
  courseId: string | null;
  frontText: string;
  backText: string;
  hintText: string | null;
  generatedAt: string;
  generationSource: string;
}

export interface FlashcardGenOptions {
  conceptEntityId: string;
  conceptName: string;
  courseId?: string;
  count?: number;
}

function tryParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

function extractCards(raw: string): GeneratedFlashcard[] {
  const candidates: unknown[] = [];
  const direct = tryParse(raw.trim());
  if (direct) candidates.push(direct);

  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) {
    const fenced = tryParse(fence[1].trim());
    if (fenced) candidates.push(fenced);
  }

  const obj = raw.match(/\{[\s\S]*\}/);
  if (obj) {
    const parsed = tryParse(obj[0]);
    if (parsed) candidates.push(parsed);
  }

  for (const c of candidates) {
    const cards = (c as { cards?: unknown })?.cards;
    if (!Array.isArray(cards)) continue;
    const valid: GeneratedFlashcard[] = [];
    for (const card of cards) {
      if (!card || typeof card !== 'object') continue;
      const o = card as Record<string, unknown>;
      if (typeof o.front !== 'string' || !o.front.trim()) continue;
      if (typeof o.back !== 'string' || !o.back.trim()) continue;
      const out: GeneratedFlashcard = { front: o.front.trim(), back: o.back.trim() };
      if (typeof o.hint === 'string' && o.hint.trim()) out.hint = o.hint.trim();
      valid.push(out);
    }
    if (valid.length > 0) return valid;
  }

  throw new Error(`Flashcard generator produced invalid JSON. First 300 chars: ${raw.slice(0, 300)}`);
}

export async function generateFlashcards(opts: FlashcardGenOptions): Promise<FlashcardRow[]> {
  const target = opts.count ?? 4;
  const mcpConfigPath = writeMcpConfig('learn', MCP_SCRIPT, {
    NMEMO_URL: config.NMEMO_URL,
    NODE_ENV: config.NODE_ENV,
  });

  const prompt = `Generate ${target} flashcards (between 3 and 5) for the concept: "${opts.conceptName}".

Optionally call get_learner_understanding once to tune difficulty, then output the JSON object only.`;

  const result = await runAgent(prompt, {
    model: 'haiku',
    effort: 'low',
    systemPrompt: SYSTEM_PROMPT,
    mcpConfigPath,
    mcpServerName: 'learn',
    maxTurns: 6,
    timeoutMs: 60_000,
  });

  const cards = extractCards(result.result);
  if (cards.length < 3 || cards.length > 5) {
    console.warn(`[flashcard-generator] expected 3-5 cards, got ${cards.length} for concept "${opts.conceptName}"`);
  }

  const rows: FlashcardRow[] = cards.map(c => ({
    id: randomUUID(),
    conceptEntityId: opts.conceptEntityId,
    courseId: opts.courseId ?? null,
    frontText: c.front,
    backText: c.back,
    hintText: c.hint ?? null,
    generatedAt: new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''),
    generationSource: 'flashcard-generator',
  }));

  if (rows.length > 0) {
    await db.insert(flashcards).values(rows.map(r => ({
      id: r.id,
      conceptEntityId: r.conceptEntityId,
      courseId: r.courseId,
      frontText: r.frontText,
      backText: r.backText,
      hintText: r.hintText,
      generationSource: r.generationSource,
    })));
  }

  return rows;
}
