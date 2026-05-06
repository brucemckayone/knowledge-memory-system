#!/usr/bin/env node
/**
 * Learning MCP Server
 *
 * Exposes learning-specific tools to Claude Code agents.
 * All graph operations go through the Nmemo platform HTTP API.
 *
 * Usage: npx tsx src/mcp/learning-mcp.ts
 */

import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  getGraphS, getLearnerFacts, getConcept, recordFact,
  queryReasoning, getContradictions, getActivePatterns, getImpact,
} from '../services/nmemo-client.js';

const NMEMO_URL = process.env.NMEMO_URL ?? 'http://localhost:3001';
// Override base URL for this process (MCP server is spawned with env from config)
const _origBase = NMEMO_URL; void _origBase; // used via nmemo-client which reads process.env

const TOOLS = [
  // ── Read tools ────────────────────────────────────────────────────────────
  {
    name: 'get_learner_understanding',
    description: 'Get what the learner currently understands about a concept. Returns confidence level (0-1), evidence, and when last updated. Use this before deciding what to teach or quiz next.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        concept: { type: 'string', description: 'Concept name to check understanding for' },
      },
      required: ['concept'],
    },
  },
  {
    name: 'get_learning_gaps',
    description: 'Find concepts that exist in the curriculum graph but the learner has not yet demonstrated understanding of. Returns the most important gaps ordered by their downstream impact.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        course_topic: { type: 'string', description: 'Optional topic to scope the gap search' },
      },
      required: [],
    },
  },
  {
    name: 'get_struggle_areas',
    description: 'Find concepts where the learner has low confidence or contradictory understanding. These are where targeted content will have the most impact.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_causal_learning_history',
    description: 'Trace why the learner is struggling with a concept. Uses Graph C causal chain to find root cause gaps. Essential before generating remedial content.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        concept: { type: 'string', description: 'Concept the learner is struggling with' },
      },
      required: ['concept'],
    },
  },
  {
    name: 'get_prerequisite_chain',
    description: 'Get the prerequisite chain for a concept — what must be understood first. Use this to sequence content and diagnose root cause gaps.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        concept: { type: 'string', description: 'Concept to get prerequisites for' },
      },
      required: ['concept'],
    },
  },
  {
    name: 'search_curriculum',
    description: 'Search for related concepts in the curriculum graph. Use this to find what concepts exist and how they relate before generating questions or content.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
      },
      required: ['query'],
    },
  },
  // ── Write tools ──────────────────────────────────────────────────────────
  {
    name: 'record_understanding',
    description: 'Record that the learner demonstrated understanding of a concept at a specific confidence level. Only call this when you have clear evidence from their answer or conversation. Do NOT call for ambiguous or partial responses.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        concept: { type: 'string', description: 'Concept the learner demonstrated understanding of' },
        confidence: { type: 'number', description: 'Understanding level 0-1 (0.8+ = strong, 0.5-0.8 = partial, <0.5 = weak)' },
        evidence: { type: 'string', description: 'What specifically they said or did that demonstrates this understanding level' },
      },
      required: ['concept', 'confidence', 'evidence'],
    },
  },
  {
    name: 'record_confusion',
    description: 'Record a specific misconception the learner showed. Only call when you have identified a concrete wrong belief, not just uncertainty. Include the exact misconception text.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        concept: { type: 'string', description: 'Concept the confusion is about' },
        misconception: { type: 'string', description: 'The specific wrong belief they expressed' },
        evidence: { type: 'string', description: 'What they said that shows this misconception' },
      },
      required: ['concept', 'misconception', 'evidence'],
    },
  },
  {
    name: 'record_quiz_result',
    description: 'Record the outcome of a quiz attempt. Updates the learner\'s understanding fact for this concept.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        concept: { type: 'string', description: 'Concept the question tested' },
        score: { type: 'number', description: 'Score 0-1 for this answer' },
        answer_summary: { type: 'string', description: 'Brief summary of what the learner demonstrated (not the full answer)' },
      },
      required: ['concept', 'score', 'answer_summary'],
    },
  },
  {
    name: 'flag_prerequisite_gap',
    description: 'Flag that the learner is missing a specific prerequisite. This creates a causal link in Graph C: missing_prereq CAUSED struggle_with_concept.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        concept: { type: 'string', description: 'Concept the learner is struggling with' },
        missing_prerequisite: { type: 'string', description: 'The prerequisite concept they are missing' },
        evidence: { type: 'string', description: 'What shows this prerequisite is missing' },
      },
      required: ['concept', 'missing_prerequisite', 'evidence'],
    },
  },
  {
    name: 'update_learning_trajectory',
    description: 'Record a recommendation for what the learner should study next, with reasoning.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        next_concept: { type: 'string', description: 'Concept recommended to study next' },
        reasoning: { type: 'string', description: 'Why this is the highest-value next step' },
      },
      required: ['next_concept', 'reasoning'],
    },
  },
] as const;

// ── Tool handlers ─────────────────────────────────────────────────────────

async function handleTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    switch (name) {
      case 'get_learner_understanding': {
        const concept = args.concept as string;
        const [graphS, learnerFacts] = await Promise.all([getGraphS(), getLearnerFacts()]);

        // Find concept entity
        const conceptNode = graphS.nodes.find(n =>
          n.label.toLowerCase() === concept.toLowerCase() ||
          n.label.toLowerCase().includes(concept.toLowerCase())
        );

        // Find learner understanding facts
        const understandingFacts = learnerFacts.facts.filter(f =>
          (f.predicate === 'understands' || f.predicate === 'confused_by' || f.predicate === 'practiced') &&
          (f.objectValue?.toLowerCase().includes(concept.toLowerCase()) ||
           (conceptNode && f.objectEntityId === conceptNode.id))
        );

        if (understandingFacts.length === 0) {
          return JSON.stringify({ concept, status: 'not_encountered', confidence: 0, facts: [] });
        }

        return JSON.stringify({ concept, entity: conceptNode ?? null, facts: understandingFacts });
      }

      case 'get_learning_gaps': {
        const topic = (args.course_topic as string | undefined) ?? '';
        const question = topic
          ? `What are the main gaps in the learner's understanding of ${topic}? Which concepts exist in the curriculum but the learner hasn't demonstrated understanding of?`
          : 'What are the most important gaps in the learner\'s current knowledge? Which concepts are low confidence or not yet encountered?';
        const result = await queryReasoning(question);
        return result.result || 'No reasoning result available';
      }

      case 'get_struggle_areas': {
        const [contradictions, learnerFacts] = await Promise.all([
          getContradictions(),
          getLearnerFacts(),
        ]);

        const weakFacts = learnerFacts.facts.filter(
          f => f.predicate === 'understands' && (f.confidence ?? 1) < 0.6
        );
        const confusionFacts = learnerFacts.facts.filter(f => f.predicate === 'confused_by');

        return JSON.stringify({
          weakAreas: weakFacts,
          confusions: confusionFacts,
          contradictions: contradictions.contradictions.slice(0, 10),
        });
      }

      case 'get_causal_learning_history': {
        const concept = args.concept as string;
        const question = `Trace why the learner is struggling with "${concept}". Walk back through Graph C causal chains. What root cause gaps are responsible? Be specific about the prerequisite chain.`;
        const result = await queryReasoning(question);
        return result.result || 'No causal history available';
      }

      case 'get_prerequisite_chain': {
        const concept = args.concept as string;
        const graphS = await getGraphS();

        // Find prerequisite_of and prerequisite_for links
        const prereqLinks = graphS.links.filter(l =>
          (l.predicate === 'prerequisite_of' || l.predicate === 'prerequisite_for' ||
           l.predicate === 'requires' || l.predicate === 'builds_on') &&
          (graphS.nodes.find(n => n.id === l.source)?.label?.toLowerCase().includes(concept.toLowerCase()) ||
           graphS.nodes.find(n => n.id === l.target)?.label?.toLowerCase().includes(concept.toLowerCase()))
        );

        const nodeMap = Object.fromEntries(graphS.nodes.map(n => [n.id, n.label]));
        const chain = prereqLinks.map(l => ({
          from: nodeMap[l.source] ?? l.source,
          predicate: l.predicate,
          to: nodeMap[l.target] ?? l.target,
        }));

        return JSON.stringify({ concept, prerequisiteChain: chain });
      }

      case 'search_curriculum': {
        const query = args.query as string;
        const question = `Search the knowledge graph for concepts related to: "${query}". What entities exist and how do they relate to each other?`;
        const result = await queryReasoning(question);
        return result.result || 'No results found';
      }

      case 'record_understanding': {
        const r = await recordFact({
          subjectName: 'Learner',
          subjectType: 'person',
          predicate: 'understands',
          objectName: args.concept as string,
          objectType: 'concept',
          confidence: args.confidence as number,
          sourceText: args.evidence as string,
        });
        return JSON.stringify({ recorded: true, factId: r.factId, concept: args.concept, confidence: args.confidence });
      }

      case 'record_confusion': {
        const r = await recordFact({
          subjectName: 'Learner',
          subjectType: 'person',
          predicate: 'confused_by',
          objectName: args.concept as string,
          objectType: 'concept',
          objectValue: args.misconception as string,
          confidence: 0.9,
          sourceText: args.evidence as string,
        });
        return JSON.stringify({ recorded: true, factId: r.factId, concept: args.concept, misconception: args.misconception });
      }

      case 'record_quiz_result': {
        const r = await recordFact({
          subjectName: 'Learner',
          subjectType: 'person',
          predicate: 'understands',
          objectName: args.concept as string,
          objectType: 'concept',
          confidence: args.score as number,
          sourceText: `Quiz result: ${args.answer_summary}`,
        });
        return JSON.stringify({ recorded: true, factId: r.factId, concept: args.concept, score: args.score });
      }

      case 'flag_prerequisite_gap': {
        // Record that learner is missing the prerequisite
        await recordFact({
          subjectName: 'Learner',
          subjectType: 'person',
          predicate: 'lacks_prerequisite',
          objectName: args.missing_prerequisite as string,
          objectType: 'concept',
          objectValue: `Needed for: ${args.concept}`,
          confidence: 0.85,
          sourceText: args.evidence as string,
        });
        // Record the struggle
        await recordFact({
          subjectName: 'Learner',
          subjectType: 'person',
          predicate: 'struggles_with',
          objectName: args.concept as string,
          objectType: 'concept',
          objectValue: `Due to missing: ${args.missing_prerequisite}`,
          confidence: 0.85,
          sourceText: args.evidence as string,
        });
        return JSON.stringify({ recorded: true, gap: args.missing_prerequisite, affects: args.concept });
      }

      case 'update_learning_trajectory': {
        const r = await recordFact({
          subjectName: 'Learner',
          subjectType: 'person',
          predicate: 'should_study_next',
          objectName: args.next_concept as string,
          objectType: 'concept',
          objectValue: args.reasoning as string,
          confidence: 0.8,
          sourceText: `Recommended because: ${args.reasoning}`,
        });
        return JSON.stringify({ recorded: true, factId: r.factId, nextConcept: args.next_concept });
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}

// ── MCP server wiring ─────────────────────────────────────────────────────

const server = new Server(
  { name: 'learn', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: { type: 'object' as const, properties: t.inputSchema.properties, required: t.inputSchema.required },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const result = await handleTool(name, (args ?? {}) as Record<string, unknown>);
  return { content: [{ type: 'text' as const, text: result }] };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Learning MCP server running on stdio');
}

main().catch(err => { console.error(err); process.exit(1); });
