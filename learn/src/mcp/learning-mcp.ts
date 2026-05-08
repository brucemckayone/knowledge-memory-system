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
import { createHash, randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  getGraphS, getLearnerFacts, getConcept, recordFact,
  queryReasoning, getContradictions, getActivePatterns, getImpact,
  getDecayCandidates, getSameAsConcepts, getConceptClusters,
} from '../services/nmemo-client.js';
import { db, insights, sections } from '../db/index.js';
import { eq } from 'drizzle-orm';
import type { ComponentKindName, ComponentGenInput } from '../agents/component-generator.js';
import { applyEditOp, buildEditOp, OverlayError } from '../services/lesson-overlay.js';
import {
  hybridImportance, clamp, decideInsert,
} from '../services/insight-lifecycle.js';

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
  // ── Patrol read tools ────────────────────────────────────────────────────
  {
    name: 'get_decay_candidates',
    description: 'Find concept entities whose facts have not been touched in over threshold_days days but had peak confidence >= 0.7. Heuristic — surfaces concepts the learner once knew but appears to be forgetting. Returns at most 50 candidates ordered oldest-first.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        threshold_days: { type: 'number', description: 'Minimum days of inactivity (1..365). Typical: 14.' },
      },
      required: ['threshold_days'],
    },
  },
  {
    name: 'find_cross_course_overlaps',
    description: 'Find concept entities that appear in 2+ courses (via section.conceptEntityIds), or are linked by a same_as relation across courses. Returns each shared concept with the courses it touches. Used for cross-course intelligence.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'find_dense_clusters',
    description: 'Find connected components of concept entities densely linked by recent (last 30 days) facts. Returns clusters of size >= min_size ranked by edge count. Heuristic — uses BFS on undirected fact-edge graph; not graph-theoretic density.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        min_size: { type: 'number', description: 'Minimum cluster size (2..50). Typical: 3.' },
      },
      required: ['min_size'],
    },
  },
  {
    name: 'find_contradictions',
    description: 'Find unresolved contradictions in the graph (pairs of facts that cannot both be true). Returns each contradiction with severity (0..1) and supporting evidence. Use deterministic_importance=severity when emitting contradiction_detected insights.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        min_severity: { type: 'number', description: 'Minimum severity 0..1. Default 0.5.' },
      },
      required: [],
    },
  },
  {
    name: 'find_active_patterns',
    description: 'Find active patterns the platform has detected (canonical or provisional). Returns each with confidence (0..1). Use deterministic_importance=confidence when emitting pattern_emerging insights.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status_filter: {
          type: 'string',
          description: 'Optional status filter: "canonical" | "provisional". Omit for both.',
          enum: ['canonical', 'provisional'],
        },
      },
      required: [],
    },
  },
  {
    name: 'write_insight',
    description: 'Append-only insight record. IDEMPOTENT on (type, sorted(related_entity_ids)) — for the same key: if the existing row is dismissed (forever) it blocks re-emit; if it is currently snoozed it blocks until the snooze expires; if the snooze has expired or it was auto_expired, a new row is inserted. Pass deterministic_importance + judgement_multiplier for hybrid scoring; final stored importance = clamp(det * judged, 0, 1).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', description: 'Open-vocabulary type tag (e.g. "decay_warning", "cross_course_link", "contradiction_detected")' },
        title: { type: 'string', description: 'Short headline (one line)' },
        content_md: { type: 'string', description: 'Markdown body explaining the insight' },
        related_entity_ids: { type: 'array', items: { type: 'string' }, description: 'Nmemo entity IDs (used in idempotency key)' },
        related_course_ids: { type: 'array', items: { type: 'string' }, description: 'Optional course IDs' },
        related_fact_ids: { type: 'array', items: { type: 'string' }, description: 'Optional Nmemo fact IDs' },
        related_section_ids: { type: 'array', items: { type: 'string' }, description: 'Optional learn section IDs' },
        importance: { type: 'number', description: '0..1 priority (default 0.5). Used as the deterministic baseline if deterministic_importance is not given (back-compat).' },
        deterministic_importance: { type: 'number', description: '0..1 baseline importance computed by the detection tool. If omitted, falls back to "importance".' },
        judgement_multiplier: { type: 'number', description: 'Agent judgment 0.5..1.5. Default 1.0. Final stored importance = clamp(deterministic_importance * judgement_multiplier, 0, 1).' },
        actionable_url: { type: 'string', description: 'Optional URL the learner can click' },
      },
      required: ['type', 'title', 'content_md', 'related_entity_ids'],
    },
  },
  // ── Component generation ────────────────────────────────────────────────
  // ── Lesson overlay edits ────────────────────────────────────────────────
  {
    name: 'edit_lesson_section',
    description: 'Apply an edit operation to a lesson section. Writes to a per-learner overlay only — canonical course content is never mutated. Each call increments the version. Use to clarify, expand, or correct lessons in response to learner questions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        section_id: { type: 'string', description: 'Section to edit.' },
        op_kind: {
          type: 'string',
          enum: ['insert_block', 'replace_block', 'append_clarification', 'add_example'],
          description: 'Edit operation kind.',
        },
        after_index: { type: 'number', description: 'For insert_block — block index after which to insert (-1 = start).' },
        index: { type: 'number', description: 'For replace_block — block index to replace.' },
        block: { type: 'object', description: 'For insert_block / replace_block / add_example — a LessonBlock { type: "markdown", content } or { type: "component", kind, props, children? }.' },
        markdown: { type: 'string', description: 'For append_clarification, or add_example as a markdown shorthand.' },
        learner_id: { type: 'string', description: 'Optional learner id (defaults to "default").' },
      },
      required: ['section_id', 'op_kind'],
    },
  },
  {
    name: 'generate_component',
    description: 'Generate a ready-to-render component spec (Mermaid diagram, Callout, CodeRunner, StepThrough, FlashcardDeck, ConceptMap, or SvgFigure) for a given concept/context. Use this when an interactive visual would help the learner. Returns either a component spec or a markdown fallback if generation fails.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        kind: {
          type: 'string',
          enum: ['Callout', 'Mermaid', 'SvgFigure', 'CodeRunner', 'StepThrough', 'FlashcardDeck', 'ConceptMap'],
          description: 'The component kind to generate.',
        },
        context: {
          type: 'string',
          description: 'Free-text describing what the learner is asking about / what concept this is for.',
        },
        learner_state: {
          type: 'object',
          properties: {
            confidence: { type: 'number', description: '0..1' },
            courseId: { type: 'string' },
            sectionId: { type: 'string' },
            conceptName: { type: 'string' },
          },
          description: 'Optional learner context to tailor the generation.',
        },
      },
      required: ['kind', 'context'],
    },
  },
  {
    name: 'generate_artifact',
    description: 'Generate a fully custom interactive widget (HTML+JS rendered in a sandboxed iframe with one of: d3, mermaid, mathjax, katex, plotly, p5, three). Use this when none of the fixed component kinds fits — algorithm animations, parameterised equation graphers, recursion trees, custom interactive teaching widgets. Slower and more expensive than generate_component (Opus 4.7), but produces bespoke artifacts tailored to the concept. Returns { ok, spec: { title, html, libraries, height } } on success, or { ok: false, errorText } on failure.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        intent: {
          type: 'string',
          enum: ['diagram', 'animate', 'plot', 'walkthrough', 'free'],
          description: 'What kind of widget the learner asked for. Use "free" when the agent picks freely.',
        },
        context: {
          type: 'string',
          description: 'The concept or selected text the artifact should illustrate.',
        },
        lesson_context: {
          type: 'string',
          description: 'Optional surrounding lesson text for grounding (the agent will not paraphrase it; will design a complementary widget).',
        },
        learner_state: {
          type: 'object',
          properties: {
            confidence: { type: 'number', description: '0..1' },
            courseId: { type: 'string' },
            sectionId: { type: 'string' },
            conceptName: { type: 'string' },
          },
          description: 'Optional learner context to tailor the artifact complexity.',
        },
      },
      required: ['intent', 'context'],
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

      case 'get_decay_candidates': {
        const thresholdDays = args.threshold_days as number;
        const r = await getDecayCandidates(thresholdDays);
        return JSON.stringify(r);
      }

      case 'find_cross_course_overlaps': {
        // Combine learn-side section.conceptEntityIds (concepts shared across courses)
        // with platform same-as links between concept entities.
        const [secs, sameAs] = await Promise.all([
          db.select({
            id: sections.id,
            courseId: sections.courseId,
            conceptEntityIds: sections.conceptEntityIds,
          }).from(sections),
          getSameAsConcepts(),
        ]);

        const entityToCourses: Record<string, Set<string>> = {};
        for (const s of secs) {
          let ids: string[] = [];
          try { ids = JSON.parse(s.conceptEntityIds) as string[]; } catch { /* skip */ }
          for (const eid of ids) {
            if (!entityToCourses[eid]) entityToCourses[eid] = new Set();
            entityToCourses[eid].add(s.courseId);
          }
        }
        const directOverlaps = Object.entries(entityToCourses)
          .filter(([, courses]) => courses.size >= 2)
          .map(([entityId, courses]) => ({
            entityId,
            courseIds: [...courses],
            kind: 'direct' as const,
          }));

        const sameAsOverlaps = sameAs.links.map(l => ({
          entityAId: l.entity_a_id,
          entityBId: l.entity_b_id,
          aName: l.a_name,
          bName: l.b_name,
          courseIdsA: [...(entityToCourses[l.entity_a_id] ?? [])],
          courseIdsB: [...(entityToCourses[l.entity_b_id] ?? [])],
          confidence: l.confidence,
          reasoning: l.reasoning,
          kind: 'same_as' as const,
        })).filter(o => o.courseIdsA.length > 0 || o.courseIdsB.length > 0);

        return JSON.stringify({ directOverlaps, sameAsOverlaps });
      }

      case 'find_dense_clusters': {
        const minSize = args.min_size as number;
        const r = await getConceptClusters(minSize, 30);
        return JSON.stringify(r);
      }

      case 'find_contradictions': {
        const minSeverity = typeof args.min_severity === 'number' ? args.min_severity : 0.5;
        const r = await getContradictions();
        // Best-effort severity filter; the platform's contradiction shape is
        // open vocabulary, so we read severity defensively.
        const all = Array.isArray(r.contradictions) ? r.contradictions : [];
        const filtered = all.filter((c: unknown) => {
          if (typeof c !== 'object' || c === null) return false;
          const sev = (c as { severity?: unknown }).severity;
          if (typeof sev !== 'number') return true; // keep if severity unknown
          return sev >= minSeverity;
        });
        // Annotate each with deterministic_importance for downstream use.
        const enriched = filtered.map((c: unknown) => {
          const sev = (c as { severity?: number }).severity;
          const det = typeof sev === 'number' ? clamp(sev, 0, 1) : 0.5;
          return { ...(c as object), deterministic_importance: det };
        });
        return JSON.stringify({ contradictions: enriched });
      }

      case 'find_active_patterns': {
        const statusFilter = typeof args.status_filter === 'string' ? args.status_filter : undefined;
        const r = await getActivePatterns();
        const all = Array.isArray(r.patterns) ? r.patterns : [];
        const filtered = statusFilter
          ? all.filter((p: unknown) => {
              if (typeof p !== 'object' || p === null) return false;
              const status = (p as { status?: unknown }).status;
              return status === statusFilter;
            })
          : all;
        const enriched = filtered.map((p: unknown) => {
          const conf = (p as { confidence?: number }).confidence;
          const det = typeof conf === 'number' ? clamp(conf, 0, 1) : 0.5;
          return { ...(p as object), deterministic_importance: det };
        });
        return JSON.stringify({ patterns: enriched });
      }

      case 'write_insight': {
        const type = args.type as string;
        const title = args.title as string;
        const contentMd = args.content_md as string;
        const relatedEntityIds = (args.related_entity_ids as string[] | undefined) ?? [];
        const relatedCourseIds = (args.related_course_ids as string[] | undefined) ?? [];
        const relatedFactIds = (args.related_fact_ids as string[] | undefined) ?? [];
        const relatedSectionIds = (args.related_section_ids as string[] | undefined) ?? [];
        const actionableUrl = (args.actionable_url as string | undefined) ?? null;

        // Hybrid importance: deterministic baseline * agent judgement multiplier.
        // Back-compat: if deterministic_importance is absent, treat the legacy
        // "importance" arg as the deterministic baseline (multiplier defaults
        // to 1.0, so behavior is unchanged when neither new field is set).
        const legacyImportance = typeof args.importance === 'number' ? args.importance : 0.5;
        const deterministicArg = typeof args.deterministic_importance === 'number'
          ? args.deterministic_importance
          : legacyImportance;
        const judgementArg = typeof args.judgement_multiplier === 'number'
          ? args.judgement_multiplier
          : 1.0;
        const deterministicImportance = clamp(deterministicArg, 0, 1);
        const importance = hybridImportance(deterministicArg, judgementArg);

        const sortedIds = [...relatedEntityIds].sort();
        const idempotencyKey = createHash('sha256')
          .update(`${type}|${sortedIds.join(',')}`)
          .digest('hex');

        // Lookup logic:
        //   dismissalKind='dismissed'                  → block forever.
        //   dismissalKind='snoozed' AND snoozedUntil>now → block until snooze expires.
        //   dismissalKind='snoozed' (expired)          → allow re-emit (insert new row).
        //   dismissalKind='auto_expired'               → allow re-emit.
        //   dismissalKind=null and not auto-expired by TTL → existing active row, treat as dup.
        const existingRows = await db.select()
          .from(insights)
          .where(eq(insights.idempotencyKey, idempotencyKey));

        const now = new Date();
        const existing = existingRows.length > 0
          ? [...existingRows].sort((a, b) =>
              (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0]!
          : null;
        const decision = decideInsert(existing, now);

        if (decision === 'block_dismissed') {
          return JSON.stringify({
            inserted: false,
            id: existing!.id,
            idempotencyKey,
            reason: 'dismissed_forever',
          });
        }
        if (decision === 'block_snoozed') {
          return JSON.stringify({
            inserted: false,
            id: existing!.id,
            idempotencyKey,
            reason: 'snoozed',
            snoozedUntil: existing!.snoozedUntil,
          });
        }
        if (decision === 'block_duplicate') {
          return JSON.stringify({
            inserted: false,
            id: existing!.id,
            idempotencyKey,
            reason: 'duplicate',
          });
        }
        // Reinsert paths: free up the unique index by moving the old row's
        // idempotency_key aside, and (for the TTL path) mark it auto_expired.
        if (existing && decision !== 'insert') {
          const newKindForOld = decision === 'reinsert_after_ttl'
            ? 'auto_expired'
            : existing.dismissalKind;  // preserve 'snoozed' / 'auto_expired'
          await db.update(insights)
            .set({
              idempotencyKey: `${idempotencyKey}#superseded-${existing.id}`,
              dismissalKind: newKindForOld,
            })
            .where(eq(insights.id, existing.id));
        }

        const id = randomUUID();
        try {
          await db.insert(insights).values({
            id,
            type,
            title,
            contentMd,
            importance,
            deterministicImportance,
            relatedEntityIds: JSON.stringify(relatedEntityIds),
            relatedCourseIds: JSON.stringify(relatedCourseIds),
            relatedFactIds: JSON.stringify(relatedFactIds),
            relatedSectionIds: JSON.stringify(relatedSectionIds),
            actionableUrl,
            idempotencyKey,
          });
          return JSON.stringify({
            inserted: true,
            id,
            idempotencyKey,
            importance,
            deterministicImportance,
          });
        } catch (err) {
          // Race: another writer beat us between SELECT and INSERT. Re-read.
          const row = await db.select({ id: insights.id })
            .from(insights)
            .where(eq(insights.idempotencyKey, idempotencyKey))
            .limit(1);
          if (row[0]) {
            return JSON.stringify({ inserted: false, id: row[0].id, idempotencyKey, reason: 'race' });
          }
          throw err;
        }
      }

      case 'edit_lesson_section': {
        const sectionId = args.section_id as string;
        if (!sectionId) {
          return JSON.stringify({ error: 'section_id is required' });
        }
        const learnerId = (args.learner_id as string | undefined) ?? 'default';
        try {
          const op = buildEditOp({
            op_kind: args.op_kind,
            after_index: args.after_index,
            index: args.index,
            block: args.block,
            markdown: args.markdown,
          });
          const overlay = await applyEditOp(sectionId, op, learnerId);
          return JSON.stringify({
            ok: true,
            overlay: {
              id: overlay.id,
              version: overlay.version,
              sectionId: overlay.sectionId,
              learnerId: overlay.learnerId,
              blockCount: overlay.blocks.length,
              createdAt: overlay.createdAt,
            },
          });
        } catch (err) {
          if (err instanceof OverlayError) {
            return JSON.stringify({ error: err.message, status: err.status });
          }
          return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
        }
      }

      case 'generate_component': {
        const { generateComponent } = await import('../agents/component-generator.js');
        const result = await generateComponent({
          kind: args.kind as ComponentKindName,
          context: args.context as string,
          learnerState: args.learner_state as ComponentGenInput['learnerState'],
        });
        return JSON.stringify(result);
      }

      case 'generate_artifact': {
        const { generateArtifact } = await import('../agents/artifact-generator.js');
        const result = await generateArtifact({
          intent: args.intent as 'diagram' | 'animate' | 'plot' | 'walkthrough' | 'free',
          context: args.context as string,
          lessonContext: typeof args.lesson_context === 'string' ? args.lesson_context : undefined,
          learnerState: args.learner_state as { confidence?: number; courseId?: string; sectionId?: string; conceptName?: string } | undefined,
        });
        // Strip raw output from MCP response — it's only useful in server logs.
        if (result.ok) {
          return JSON.stringify({ ok: true, spec: result.spec });
        }
        return JSON.stringify({ ok: false, errorText: result.errorText });
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
