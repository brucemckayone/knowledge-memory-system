/**
 * Course Generator Agent
 *
 * Two modes:
 *   - generated: builds curriculum from the model's knowledge of a topic
 *   - paste:     builds curriculum from already-ingested content (reads Nmemo curriculum graph)
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { runAgent, writeMcpConfig } from '../services/agent.js';
import { ingestContent, getGraphS } from '../services/nmemo-client.js';
import { db, courses, sections, questions } from '../db/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SCRIPT = path.resolve(__dirname, '..', 'mcp', 'learning-mcp.ts');

const SYSTEM_PROMPT = `You are an expert curriculum designer and educator. Your job is to create well-structured, adaptive learning courses.

You have access to MCP tools to interact with the Nmemo knowledge graph:
- search_curriculum: find what concepts already exist in the graph
- get_prerequisite_chain: understand concept dependencies
- record_understanding: create concept entities in the graph (use with confidence=0 to mark as "curriculum concept, not yet learned")

## Your Task

Build a complete course structure and output it as JSON. The JSON must match this exact schema:

{
  "title": "string",
  "description": "string — 2-3 sentences explaining what the learner will achieve",
  "sections": [
    {
      "title": "string",
      "description": "string",
      "learningObjectives": ["string", "..."],
      "concepts": [
        {
          "name": "string — concept name as it should appear in the knowledge graph",
          "prerequisiteOf": ["string", "..."] — concepts this one is a prerequisite for (empty array if none)
        }
      ],
      "questions": [
        {
          "questionText": "string",
          "expectedAnswer": "string — key points the answer should cover",
          "explanation": "string — shown after the learner answers",
          "difficulty": 1-5,
          "conceptName": "string — which concept this tests"
        }
      ]
    }
  ]
}

## Rules
1. Sections must be sequenced — later sections build on earlier ones
2. Each section should have 3-6 concepts and 2-4 questions
3. Questions must be open-ended (not multiple choice) — they probe understanding
4. Use record_understanding to register each concept in the knowledge graph (confidence=0 = "curriculum concept not yet learned by learner")
5. For generated courses: use your knowledge to create an accurate, well-structured curriculum
6. For paste-based courses: use search_curriculum to find extracted concepts, then structure them logically
7. Output ONLY the JSON — no surrounding text`;

export interface GeneratedCourse {
  title: string;
  description: string;
  sections: Array<{
    title: string;
    description: string;
    learningObjectives: string[];
    concepts: Array<{ name: string; prerequisiteOf: string[] }>;
    questions: Array<{
      questionText: string;
      expectedAnswer: string;
      explanation: string;
      difficulty: number;
      conceptName: string;
    }>;
  }>;
}

export async function generateCourse(params: {
  courseId: string;          // pre-allocated by the caller (route creates placeholder row first)
  topic: string;
  sourceType: 'generated' | 'paste';
  sourceText?: string;
  nmemoMemoryId?: string;
}): Promise<string> {
  const { courseId } = params;

  // For paste mode, ingest the source text first
  let memoryId = params.nmemoMemoryId;
  if (params.sourceType === 'paste' && params.sourceText && !memoryId) {
    console.log('[course-gen] ingesting source content into Nmemo...');
    const result = await ingestContent(params.sourceText, 'course-content');
    memoryId = result.memoryId;
  }

  const mcpConfigPath = writeMcpConfig('learn', MCP_SCRIPT, {
    NMEMO_URL: config.NMEMO_URL,
    NODE_ENV: config.NODE_ENV,
  });

  const prompt = params.sourceType === 'paste'
    ? `Create a course for the following content. The content has already been processed into the knowledge graph (memory ID: ${memoryId}). Use search_curriculum to discover the extracted concepts, then structure them into a logical course.\n\nContent summary (first 500 chars): ${(params.sourceText ?? '').slice(0, 500)}\n\nOutput the course as JSON.`
    : `Create a comprehensive course on the topic: "${params.topic}"\n\nUse your knowledge to design a well-structured curriculum. Register each concept in the knowledge graph as you define it. Output the course as JSON.`;

  const result = await runAgent(prompt, {
    model: 'sonnet',
    effort: 'medium',
    systemPrompt: SYSTEM_PROMPT,
    mcpConfigPath,
    mcpServerName: 'learn',
    maxTurns: 30,
    timeoutMs: 900_000, // 15 min — course gen makes many MCP calls
  });

  // Parse the JSON from agent output
  let courseData: GeneratedCourse;
  try {
    const jsonMatch = result.result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in agent output');
    courseData = JSON.parse(jsonMatch[0]) as GeneratedCourse;
  } catch (err) {
    throw new Error(`Course generator produced invalid JSON: ${err instanceof Error ? err.message : err}`);
  }

  // Update the placeholder row with the generated course details
  await db.update(courses).set({
    title: courseData.title,
    description: courseData.description,
    nmemoMemoryId: memoryId,
    status: 'ready',
    updatedAt: new Date().toISOString(),
  }).where(eq(courses.id, courseId));

  for (let si = 0; si < courseData.sections.length; si++) {
    const sec = courseData.sections[si]!;
    const sectionId = randomUUID();

    const conceptEntityIds: string[] = [];
    // We stored concepts in Nmemo graph via MCP — collect their IDs from a quick graph query
    const graphS = await getGraphS();
    for (const c of sec.concepts) {
      const node = graphS.nodes.find(n => n.label.toLowerCase() === c.name.toLowerCase());
      if (node) conceptEntityIds.push(node.id);
    }

    await db.insert(sections).values({
      id: sectionId,
      courseId,
      title: sec.title,
      description: sec.description,
      learningObjectives: JSON.stringify(sec.learningObjectives),
      conceptEntityIds: JSON.stringify(conceptEntityIds),
      orderIndex: si,
    });

    for (const q of sec.questions) {
      const conceptNode = graphS.nodes.find(n =>
        n.label.toLowerCase() === q.conceptName.toLowerCase()
      );
      await db.insert(questions).values({
        id: randomUUID(),
        sectionId,
        questionText: q.questionText,
        expectedAnswer: q.expectedAnswer,
        explanation: q.explanation,
        difficulty: q.difficulty,
        questionType: 'static',
        conceptEntityId: conceptNode?.id ?? null,
      });
    }
  }

  return courseId;
}
