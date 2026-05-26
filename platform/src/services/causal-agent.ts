/**
 * Causal Agent — Tool Definitions (B05) + Invocation (B06)
 *
 * GRAPH_TOOLS are exposed via the unified MCP server (graph-mcp.ts).
 * Each tool maps to an existing service function. The tool schema format
 * is MCP-compatible (JSON Schema inputSchema).
 *
 * The invokeCausalAgent() function calls the ML service's /causal-reason endpoint,
 * which shells out to Claude Code with the MCP config and system prompt.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync } from 'node:fs';
import { spawn } from 'child_process';
import dotenv from 'dotenv';
import { getEntityFacts, createFact, expireFact, invalidateFact, updateFactConfidence, restoreFact } from './facts.js';
import { findConnectedEntities } from './graph.js';
import { findSimilarEntities, resolveEntity, linkMemoryToEntity } from './entities.js';
import { searchMemories, getMemory } from './qdrant.js';
import { db } from '../db/index.js';
import { memoryEntities, facts as factsTable, entityMeta, entityAliases, entities as entitiesTable, sameAsLinks, extractionReports, entities, reasoningReports } from '../db/schema.js';
import { eq, desc, sql, isNull, and, ilike, inArray } from 'drizzle-orm';
import { getEntityCausalHistory, createCausalEdge, expireCausalEdge, reviseCausalEdge, type SourceReference as CausalSourceRef } from './causal.js';
import { getFactHistory, getEdgeHistory, type Actor } from './audit.js';
import {
  getContradictions,
  resolveContradiction,
  type ContradictionType,
  type ContradictionSeverity,
  type ResolutionType,
} from './contradictions.js';
import {
  analyzeImpact,
  type RootNodeType as ImpactRootNodeType,
  type HypotheticalAction,
} from './impact.js';
import {
  activePatterns,
  findCausalGhosts,
  type PatternStatus,
} from './causal-patterns.js';
import { ml } from './ml-client.js';
import { config } from '../config.js';
import { normalizePredicate } from './predicates.js';
import { RESOLUTION_VALUES } from './enums.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================
// Tool Schemas (MCP-compatible)
// ============================================

/** MCP tool schema — compatible with @modelcontextprotocol/sdk Tool type */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

export const GRAPH_TOOLS: ToolDefinition[] = [
  {
    name: 'query_entity_facts',
    description:
      'Get all active bi-temporal facts for a given entity. Returns facts where the entity is the subject.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity_id: {
          type: 'string',
          description: 'UUID of the entity to query facts for',
        },
      },
      required: ['entity_id'],
    },
  },
  {
    name: 'query_entity_neighbours',
    description:
      'Traverse the knowledge graph to find entities connected to a given entity, optionally filtered by relationship type and depth.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity_id: {
          type: 'string',
          description: 'UUID of the entity to find neighbours for',
        },
        relationship_type: {
          type: 'string',
          description: 'Optional relationship type filter (e.g. "works_at", "knows")',
        },
        max_depth: {
          type: 'number',
          description: 'Maximum traversal depth (default: 1)',
        },
      },
      required: ['entity_id'],
    },
  },
  {
    name: 'search_similar_entities',
    description:
      'Semantic similarity search over all entities using pgvector. Find entities whose names/descriptions are semantically close to a query text.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Text to search for semantically similar entities',
        },
        threshold: {
          type: 'number',
          description: 'Minimum similarity threshold 0.0-1.0 (default: 0.5)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 10)',
        },
        entity_type: {
          type: 'string',
          description: 'Optional entity type filter (e.g. "person", "organization")',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_memories',
    description:
      'Semantic search over source texts in the vector store. Find past inputs that are semantically related to a query.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Text to search for semantically similar memories',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 5)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_memory_text',
    description:
      'Retrieve the full source text of a specific memory by ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        memory_id: {
          type: 'string',
          description: 'UUID of the memory to retrieve',
        },
      },
      required: ['memory_id'],
    },
  },
  {
    name: 'get_causal_history',
    description:
      'Get existing causal chains involving a given entity. Returns causal events and edges from Graph C with reasoning, strength, and source references.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity_id: {
          type: 'string',
          description: 'UUID of the entity to get causal history for',
        },
      },
      required: ['entity_id'],
    },
  },
  {
    name: 'create_causal_edge',
    description:
      'Assert a causal link between two causal events with detailed reasoning and source references. Every edge must be auditable — provide thorough reasoning and list all sources that informed the conclusion.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        cause_event_id: {
          type: 'string',
          description: 'UUID of the causal event that is the cause',
        },
        effect_event_id: {
          type: 'string',
          description: 'UUID of the causal event that is the effect',
        },
        strength: {
          type: 'number',
          description: 'Confidence in the causal link, 0.0-1.0. Use 0.3-0.6 for inferred causality, 0.7-1.0 for explicitly stated.',
        },
        reasoning: {
          type: 'string',
          description: 'Detailed justification for this causal assertion. Must explain WHY the cause led to the effect.',
        },
        source_references: {
          type: 'array',
          description: 'Every source that informed this conclusion',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['memory', 'fact', 'entity'],
                description: 'Type of source reference',
              },
              id: {
                type: 'string',
                description: 'UUID of the memory, fact, or entity',
              },
              relevance: {
                type: 'string',
                description: 'How this source informed the causal conclusion',
              },
            },
            required: ['type', 'id', 'relevance'],
          },
        },
        temporal_span: {
          type: 'string',
          description: 'Optional estimated delay between cause and effect (ISO 8601 duration, e.g. "P7D" for 7 days)',
        },
      },
      required: ['cause_event_id', 'effect_event_id', 'strength', 'reasoning', 'source_references'],
    },
  },

  // --- Extraction tools ---

  {
    name: 'resolve_entity',
    description:
      'Resolve a text mention to an existing entity or create a new one. Searches by embedding similarity and name matching. Returns the resolved entity with its canonical name and ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mention: {
          type: 'string',
          description: 'The entity mention as it appears in the source text',
        },
        entity_type: {
          type: 'string',
          description: 'Entity type: person, place, company, project, concept, event, other',
        },
        context: {
          type: 'string',
          description: 'Surrounding text context (50-200 chars around the mention) to help disambiguation',
        },
      },
      required: ['mention', 'entity_type', 'context'],
    },
  },
  {
    name: 'create_fact',
    description:
      'Create a relationship (fact) between two entities. Handles deduplication automatically — if the exact fact already exists, it returns the existing ID. For exclusive predicates (e.g. lives_in), supersedes the old value.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        subject_entity_id: {
          type: 'string',
          description: 'UUID of the subject entity',
        },
        predicate: {
          type: 'string',
          description: 'Relationship type in base form (e.g. works_at, lives_in, sibling_of, visited, writes_to, knows, near)',
        },
        object_entity_id: {
          type: 'string',
          description: 'UUID of the object entity (for entity-to-entity relationships)',
        },
        object_value: {
          type: 'string',
          description: 'String value (for entity-to-value relationships, e.g. a date or description)',
        },
        confidence: {
          type: 'number',
          description: '0.0-1.0 confidence score. 0.9+ for explicit, 0.7-0.9 for clear implication, 0.5-0.7 for inference.',
        },
        source_text: {
          type: 'string',
          description: 'Exact quote from the source text that supports this fact',
        },
        source_memory_id: {
          type: 'string',
          description: 'UUID of the source memory this fact was extracted from. Use the memory_id provided in the extraction context.',
        },
        valid_at: {
          type: 'string',
          description: 'ISO 8601 date when this fact became true in reality. Use temporal reasoning from the text.',
        },
        invalid_at: {
          type: 'string',
          description: 'ISO 8601 date when this fact ceased to be true (if known).',
        },
        temporal_hint: {
          type: 'string',
          description: '"current", "past", or "future" — relative to the document time',
        },
      },
      required: ['subject_entity_id', 'predicate', 'confidence', 'source_text'],
    },
  },
  {
    name: 'get_fact_source',
    description:
      'Get the source memory and text for a specific fact. Returns the source_text quote, the source memory ID, and a preview of the full source document.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        fact_id: {
          type: 'string',
          description: 'UUID of the fact to trace back to source',
        },
      },
      required: ['fact_id'],
    },
  },
  {
    name: 'get_entity_sources',
    description:
      'Get all source memories that mention a given entity. Returns the memory IDs, mention texts, and context snippets. Use this to trace an entity back to its original source material.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity_id: {
          type: 'string',
          description: 'UUID of the entity to find sources for',
        },
      },
      required: ['entity_id'],
    },
  },
  {
    name: 'link_entity_to_memory',
    description:
      'Record that a specific entity was mentioned in a source memory. Creates the provenance link between the entity and the document it was found in.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity_id: {
          type: 'string',
          description: 'UUID of the entity',
        },
        memory_id: {
          type: 'string',
          description: 'UUID of the source memory',
        },
        mention_text: {
          type: 'string',
          description: 'The exact mention text as it appears in the source',
        },
        mention_context: {
          type: 'string',
          description: 'Surrounding text context (50-200 chars around the mention) to aid disambiguation and cross-entity inference',
        },
      },
      required: ['entity_id', 'memory_id', 'mention_text'],
    },
  },
  {
    name: 'add_entity_alias',
    description:
      'Register a discovered reference or alternative name for an entity. Use this when you find that an entity is referred to by a different name, title, pronoun pattern, or role in the text.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity_id: {
          type: 'string',
          description: 'UUID of the entity this alias belongs to',
        },
        alias: {
          type: 'string',
          description: 'The alternative reference text (e.g. "the captain", "R. Walton", "I (narrator of letters)")',
        },
        alias_type: {
          type: 'string',
          description: 'Type of alias: "name" (proper name variant), "role" (title/position), "reference" (narrative reference like "the stranger"), "pronoun" (pronoun mapping like "I"), "unconfirmed" (suspected but not proven identity link)',
        },
      },
      required: ['entity_id', 'alias', 'alias_type'],
    },
  },
  {
    name: 'search_entity_aliases',
    description:
      'Search across all entity aliases for a text match. Use this during ORIENT to resolve references like "the stranger", "I", "the captain" to known entities. Returns matching entities with their canonical name, aliases, and summary.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'The reference text to search for (e.g. "the stranger", "captain", "narrator")',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'update_entity_summary',
    description:
      'Update the living summary for an entity. Call this after creating facts to keep the entity profile current. The summary should describe who/what the entity is, their current state, narrative role, known aliases/references, and any unresolved ambiguities.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity_id: {
          type: 'string',
          description: 'UUID of the entity to update',
        },
        summary: {
          type: 'string',
          description: 'Natural language summary. Include: current state, narrative role, known references/aliases (e.g. "referred to as the stranger, he, my friend"), temporal context, and any ambiguities (e.g. "may be the same person as...").',
        },
      },
      required: ['entity_id', 'summary'],
    },
  },

  // --- Reconciliation tools ---

  {
    name: 'create_same_as_link',
    description:
      'Create a same_as identity link between two entities that represent the same real-world referent but serve different narrative roles. Both entities and ALL their facts are preserved — this is NOT a merge. Use this when entities should remain distinct nodes (e.g. "the stranger" described by Walton vs "Victor Frankenstein" who narrates his own story). Prefer this over execute_merge whenever the entities carry different narrative meaning.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity_a_id: {
          type: 'string',
          description: 'UUID of the first entity',
        },
        entity_b_id: {
          type: 'string',
          description: 'UUID of the second entity',
        },
        reasoning: {
          type: 'string',
          description: 'Detailed explanation of why these entities are the same real-world identity',
        },
        source_evidence: {
          type: 'array',
          description: 'Every source that supports this identity conclusion',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['memory', 'fact', 'entity', 'alias', 'report'],
                description: 'Type of evidence source',
              },
              id: {
                type: 'string',
                description: 'UUID or identifier of the evidence source',
              },
              relevance: {
                type: 'string',
                description: 'How this source supports the identity conclusion',
              },
            },
            required: ['type', 'id', 'relevance'],
          },
        },
        confidence: {
          type: 'number',
          description: '0.0-1.0 confidence in the identity link. Use 0.7+ for same_as.',
        },
        merge_candidate_id: {
          type: 'string',
          description: 'UUID of the merge candidate that prompted this resolution (if any)',
        },
      },
      required: ['entity_a_id', 'entity_b_id', 'reasoning', 'source_evidence', 'confidence'],
    },
  },

  {
    name: 'execute_merge',
    description:
      'Destructively merge two entities into one. The source entity is DELETED and all its facts, aliases, memory links, and causal events are re-pointed to the target. Use this ONLY when both entities have the exact same meaning and keeping them separate adds no value (e.g. "R. Walton" and "Robert Walton" with identical facts). Prefer create_same_as_link when entities serve different narrative roles.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        source_entity_id: {
          type: 'string',
          description: 'UUID of the entity to be absorbed (this entity will be deleted)',
        },
        target_entity_id: {
          type: 'string',
          description: 'UUID of the entity to keep (this entity survives with all merged data)',
        },
        reasoning: {
          type: 'string',
          description: 'Why these should be destructively merged rather than linked with same_as',
        },
        merge_candidate_id: {
          type: 'string',
          description: 'UUID of the merge candidate that prompted this merge (if any)',
        },
      },
      required: ['source_entity_id', 'target_entity_id', 'reasoning'],
    },
  },

  {
    name: 'resolve_candidate',
    description:
      'Mark a merge candidate as resolved with a decision and reasoning. Call this AFTER executing a merge, creating a same_as link, or determining the entities are distinct. This closes the candidate so it is not re-evaluated.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        candidate_id: {
          type: 'string',
          description: 'UUID of the merge_candidates record to resolve',
        },
        resolution: {
          type: 'string',
          // SSOT: src/services/enums.ts:RESOLUTION_VALUES (bead nmemo-2yv.130).
          // Mutable copy via spread because Claude's tool-schema type expects
          // string[]; the readonly tuple narrows the type at the call site.
          enum: [...RESOLUTION_VALUES],
          description: 'Resolution type: merge (destructive), same_as (non-destructive identity link), link (softer association), distinct (confirmed different entities)',
        },
        reasoning: {
          type: 'string',
          description: 'Explanation of why this resolution was chosen',
        },
      },
      required: ['candidate_id', 'resolution', 'reasoning'],
    },
  },

  {
    name: 'get_reconciliation_context',
    description:
      'Get all context needed for reconciliation decisions in one call. Returns: unresolved merge candidates (with entity summaries + aliases), recent extraction reports, unconfirmed aliases, and orphan entities (zero facts). Call this at the start of a reconciliation session to understand what needs resolution.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        include_reports: {
          type: 'boolean',
          description: 'Include recent extraction reports (default: true)',
        },
        max_reports: {
          type: 'number',
          description: 'Maximum number of recent reports to include (default: 10)',
        },
      },
      required: [],
    },
  },

  // --- Gardener tools ---

  {
    name: 'get_graph_topology',
    description:
      'Pre-analyzed graph structure overview. Returns: summary stats, top 10 hub nodes, disconnected islands, isolates, orphans (mentioned but zero facts), and SPARSE LEAVES — entities with only 1-2 connections dangling off a hub. Sparse leaves look like islands visually even though they are technically connected. They are the primary targets for cross-linking. Designed for large graphs.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },

  // --- Reasoning agent tools ---

  {
    name: 'expire_fact',
    description:
      'Expire a fact (mark as incorrect or superseded in our records). Creates a causal event recording the expiry. Use when a fact is redundant, contradicted by newer evidence, or no longer valid.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        fact_id: {
          type: 'string',
          description: 'UUID of the fact to expire',
        },
        reason: {
          type: 'string',
          description: 'Why this fact is being expired',
        },
      },
      required: ['fact_id', 'reason'],
    },
  },
  {
    name: 'invalidate_fact',
    description:
      'Invalidate a fact (mark as no longer true in reality, though it was once true). Creates a causal event.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        fact_id: {
          type: 'string',
          description: 'UUID of the fact to invalidate',
        },
        invalid_at: {
          type: 'string',
          description: 'ISO timestamp when the fact stopped being true (default: now)',
        },
      },
      required: ['fact_id'],
    },
  },
  {
    name: 'get_neighbourhood_profile',
    description:
      'Get a comprehensive profile of an entity and its neighbourhood in a single call. Returns: entity details + summary, all active facts (as subject and object), direct neighbours, causal history, source memory count, and entity meta statistics.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity_id: {
          type: 'string',
          description: 'UUID of the central entity',
        },
      },
      required: ['entity_id'],
    },
  },
  {
    name: 'get_reasoning_targets',
    description:
      'Get a ranked list of entities/neighbourhoods that need reasoning attention. Scores based on: fact density, causal event density, node degree, time since last reasoning pass.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of targets to return (default: 10)',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_reasoning_history',
    description:
      'Get prior reasoning reports that touched a given entity. Returns the most recent reports with their findings, actions taken, and timestamps.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity_id: {
          type: 'string',
          description: 'UUID of the entity to get reasoning history for',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of reports to return (default: 5)',
        },
      },
      required: ['entity_id'],
    },
  },
  {
    name: 'save_reasoning_report',
    description:
      'Save a reasoning report ONCE at the very end of a reasoning pass. Call this exactly one time per /api/reason invocation — multiple calls create duplicate rows and break patrol cooldown. Aggregate findings across all phases first, then save with all entities/facts/edges deduplicated.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mode: {
          type: 'string',
          enum: ['patrol', 'query'],
          description: 'Operating mode of this reasoning pass',
        },
        question: {
          type: 'string',
          description: 'The user question (query mode only)',
        },
        report: {
          type: 'string',
          description: 'Structured markdown report',
        },
        entity_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'UUIDs of all entities this report touched',
        },
        fact_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'UUIDs of all facts examined, expired, or created',
        },
        causal_edge_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'UUIDs of all causal edges examined or created',
        },
        actions_taken: {
          type: 'object',
          description: 'Structured log of actions',
        },
      },
      required: ['mode', 'report', 'entity_ids'],
    },
  },

  // --- Phase 1 audit tools (read) ---

  {
    name: 'get_fact_history',
    description:
      'Get the full mutation history for a fact. Returns events in reverse chronological order (newest first). Call this BEFORE modifying or expiring a fact — understanding how something became what it is prevents unwinding recent, justified changes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        fact_id: {
          type: 'string',
          description: 'UUID of the fact',
        },
        limit: {
          type: 'number',
          description: 'Maximum history rows to return (default 100, max 500)',
        },
      },
      required: ['fact_id'],
    },
  },
  {
    name: 'get_edge_history',
    description:
      'Get the full mutation history for a causal edge. Returns events in reverse chronological order. Call this to understand how an edge was formed, corroborated, and revised before acting on it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        edge_id: {
          type: 'string',
          description: 'UUID of the causal edge',
        },
        limit: {
          type: 'number',
          description: 'Maximum history rows to return (default 100, max 500)',
        },
      },
      required: ['edge_id'],
    },
  },

  // --- Phase 1 audit tools (write) ---

  {
    name: 'update_fact_confidence',
    description:
      'Change a fact\'s confidence score. Writes a confidence_raised or confidence_lowered event to fact_history with your reasoning. Use when new evidence strengthens or weakens an existing fact without superseding it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        fact_id: { type: 'string', description: 'UUID of the fact' },
        new_confidence: { type: 'number', description: 'New confidence in [0, 1]' },
        reasoning: { type: 'string', description: 'Why the confidence is changing' },
      },
      required: ['fact_id', 'new_confidence', 'reasoning'],
    },
  },
  {
    name: 'restore_fact',
    description:
      'Restore a previously expired or invalidated fact. Clears expired_at and invalid_at and writes a restored event to fact_history. Use after reviewing history and determining the earlier expiry was premature.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        fact_id: { type: 'string', description: 'UUID of the fact to restore' },
        reasoning: { type: 'string', description: 'Why the fact is being restored' },
      },
      required: ['fact_id', 'reasoning'],
    },
  },
  {
    name: 'expire_causal_edge',
    description:
      'Expire a causal edge (soft-delete). Writes an expired event to causal_edge_history. Use when evidence no longer supports the causal link or an upstream fact was retracted.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        edge_id: { type: 'string', description: 'UUID of the edge to expire' },
        reasoning: { type: 'string', description: 'Why the edge is being expired' },
      },
      required: ['edge_id', 'reasoning'],
    },
  },
  {
    name: 'revise_causal_edge',
    description:
      'Revise a causal edge — update strength and/or on-edge reasoning, optionally append source references. Writes a revised event preserving the previous values. Use when new evidence refines an existing causal conclusion without invalidating it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        edge_id: { type: 'string', description: 'UUID of the edge to revise' },
        new_strength: { type: 'number', description: 'Updated strength in [0, 1] (optional)' },
        new_reasoning: { type: 'string', description: 'Updated on-edge reasoning (optional)' },
        added_source_refs: {
          type: 'array',
          description: 'Source references to append (optional)',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['memory', 'fact', 'entity'] },
              id: { type: 'string' },
              relevance: { type: 'string' },
            },
            required: ['type', 'id', 'relevance'],
          },
        },
        reasoning: { type: 'string', description: 'Why this revision is justified' },
      },
      required: ['edge_id', 'reasoning'],
    },
  },

  // --- Phase 5 contradiction tools ---

  {
    name: 'get_contradictions',
    description:
      'Fetch contradictions detected by the SQL heuristics. Returns rows with full provenance (detection_reasoning, detection_context, severity). Defaults to unresolved only. Call this during PHASE 1.5 of the reasoning patrol to surface unresolved conflicts before deciding which neighbourhoods to investigate.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Maximum rows (default 50)' },
        unresolved_only: { type: 'boolean', description: 'When true (default), excludes resolved contradictions.' },
        contradiction_type: {
          type: 'string',
          enum: ['opposing_object', 'expired_but_cited', 'cyclic_causal', 'temporal_impossible', 'chain_conflict'],
          description: 'Filter to a specific contradiction type.',
        },
        severity: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low'],
          description: 'Filter to a specific severity tier.',
        },
      },
      required: [],
    },
  },
  {
    name: 'resolve_contradiction',
    description:
      'Apply a resolution to an open contradiction. Dispatches into expire/invalidate (when the resolution mutates a fact) and closes the contradiction record with full reasoning. Use after reading get_fact_history / get_edge_history for the involved nodes. Reasoning must be at least 20 characters.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        contradiction_id: { type: 'string', description: 'UUID of the contradiction to resolve' },
        resolution_type: {
          type: 'string',
          enum: ['expire_a', 'expire_b', 'expire_both', 'invalidate_a', 'invalidate_b', 'expire_edge_a', 'expire_edge_b', 'expire_both_edges', 'reconcile', 'both_valid', 'dismissed'],
          description: 'How to resolve. expire_*/invalidate_* mutate the underlying fact; expire_edge_*/expire_both_edges mutate the underlying causal edge (use for cyclic_causal / temporal_impossible / expired_but_cited where the conflict lives on the edge, not the fact); reconcile/both_valid/dismissed close without mutation.',
        },
        resolution_reasoning: {
          type: 'string',
          description: 'Why this resolution was chosen. Must be at least 20 characters.',
          minLength: 20,
        },
        dismissed_reason: {
          type: 'string',
          description: 'Required when resolution_type is "dismissed" — captures the dismissal rationale to dismissed_reason.',
        },
      },
      required: ['contradiction_id', 'resolution_type', 'resolution_reasoning'],
    },
  },

  // --- Phase 4 blast radius tool ---

  {
    name: 'analyze_blast_radius',
    description:
      'Compute the impact tree for a fact, entity, or causal_event: direct dependents, transitive causal chains (bidirectional, cycle-safe), citation dependents (via Phase 3 edge_source_refs index), and pattern impact. Each node is severity-scored (critical/high/medium/low). Use BEFORE expire_fact / invalidate_fact: pass hypothetical=expire to preview the cascade severity tally without mutating state. Critical/high severity dependents must be acknowledged in the resolution reasoning.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        node_type: {
          type: 'string',
          enum: ['fact', 'entity', 'causal_event'],
          description: 'Root node type for the impact analysis.',
        },
        node_id: {
          type: 'string',
          description: 'UUID of the root node.',
        },
        max_depth: {
          type: 'number',
          minimum: 1,
          maximum: 10,
          description: 'Cap on the recursive walk through causal_edges. Default 3.',
        },
        hypothetical: {
          type: 'string',
          enum: ['expire'],
          description: 'Re-score severity as if the root were expired. Makes ZERO database writes. Use to preview cascade impact before destructive actions.',
        },
      },
      required: ['node_type', 'node_id'],
    },
  },

  // --- Phase 6 pattern lifecycle tools ---

  {
    name: 'get_active_patterns',
    description:
      'List active causal patterns. Defaults to status=[provisional, canonical] — these are the patterns the system has validated as repeatable causal structures. Optional entity_id filter restricts to patterns the entity participates in (joins through causal_edges.pattern_id). Use during query mode to ground answers about processes/mechanisms in stable patterns.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity_id: {
          type: 'string',
          format: 'uuid',
          description: 'Optional UUID — only return patterns the entity participates in.',
        },
        status: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['staging', 'candidate', 'provisional', 'canonical', 'rejected'],
          },
          description: 'Override the default status filter [provisional, canonical].',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          description: 'Maximum number of patterns to return. Default 20.',
        },
      },
      required: [],
    },
  },

  {
    name: 'find_causal_ghosts',
    description:
      'Find expected-but-missing causal links for an entity, based on canonical pattern templates. A "ghost" is the missing position when an entity covers N-1 of N edge positions in a known pattern. During patrol, call this for the central entity of the neighbourhood: for each high-confidence ghost, search source memories for evidence the missing link should exist before creating the edge.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity_id: {
          type: 'string',
          format: 'uuid',
          description: 'UUID of the entity to scan for ghost links.',
        },
      },
      required: ['entity_id'],
    },
  },

  {
    name: 'get_pattern_instances',
    description:
      'Get the concrete causal edges that instantiate a given pattern. Useful for audit: "which actual chains in the graph make this pattern canonical?". Returns up to `limit` edges ordered by pattern_position then created_at.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        pattern_id: {
          type: 'string',
          format: 'uuid',
          description: 'UUID of the pattern.',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          description: 'Maximum number of instances to return. Default 10.',
        },
      },
      required: ['pattern_id'],
    },
  },
];

/**
 * Tools that mutate the graph. Serialised in `handleToolCall` — the dispatcher
 * is the single source of truth for write ordering across BOTH transports
 * (Pi bridge + MCP). Bead nmemo-2yv.127 — without this, the MCP transport
 * (graph-mcp.ts) would dispatch concurrent `tools/call` messages with no
 * mutex on writes, racing on entity resolution / merge / expiry.
 *
 * Hand-maintained because the alternative (a `mutates: boolean` field on
 * ToolDefinition) spreads the policy across 33 tool defs and makes the
 * "which tools mutate?" answer harder to grep, not easier. One central set,
 * one grep, one source of truth.
 */
const WRITE_TOOLS = new Set<string>([
  'create_causal_edge', 'create_fact', 'resolve_entity', 'link_entity_to_memory',
  'add_entity_alias', 'update_entity_summary', 'create_same_as_link', 'execute_merge',
  'resolve_candidate', 'expire_fact', 'invalidate_fact', 'restore_fact',
  'update_fact_confidence', 'expire_causal_edge', 'revise_causal_edge',
  'resolve_contradiction', 'save_reasoning_report',
]);

/**
 * Per-process serialisation queue for write tools. Reads run freely; writes
 * chain through the queue so two simultaneous `tool_use` blocks from one
 * Claude message run in order, regardless of transport.
 *
 * Queue fails OPEN — a prior write's failure does NOT block subsequent
 * writes. Operationally this matters: a transient DB write failure during a
 * patrol cycle would otherwise convert into a denial-of-service on every
 * downstream write in the same process. The `.catch(() => undefined)` below
 * absorbs the prior failure so the next write runs regardless.
 */
let writeQueue: Promise<unknown> = Promise.resolve();

// ============================================
// Tool Handlers
// ============================================

/**
 * Dispatch a tool call from the Haiku agent to the appropriate service function.
 * Returns a string result suitable for the Anthropic tool_result content block.
 */
let toolCallCount = 0;

/**
 * Invocation context for MCP tool dispatch.
 *
 * The MCP server process reads `MNEMO_AGENT_ACTOR` from its env at startup
 * (set by whichever invoke* wrapper spawned it) and passes it through as
 * `context.agent`. Audit writes use this value as the `actor` on every
 * fact_history / causal_edge_history row they emit.
 */
export interface ToolCallContext {
  agent: Actor;
  reasoningReportId?: string | null;
}

/** Seven-actor allow-list mirrors the DB CHECK in migration 009. */
const VALID_ACTORS = new Set<Actor>([
  'graph_agent', 'reasoning_agent', 'gardener_agent',
  'reconciliation_agent', 'user', 'system_trigger', 'cascade',
]);

/**
 * Resolve the agent actor for an MCP tool call. Priority:
 *   1. explicit context passed by the caller
 *   2. MNEMO_AGENT_ACTOR env var (set by invoke* wrappers)
 *   3. 'graph_agent' as the extraction-path default
 *
 * Invalid env values fall back to the default rather than crashing the
 * MCP loop — the DB CHECK constraint will catch any actor drift anyway.
 */
function resolveContext(ctx?: ToolCallContext): ToolCallContext {
  if (ctx) return ctx;
  const envActor = process.env.MNEMO_AGENT_ACTOR as Actor | undefined;
  const agent = envActor && VALID_ACTORS.has(envActor) ? envActor : 'graph_agent';
  const reasoningReportId = process.env.MNEMO_REASONING_REPORT_ID || null;
  return { agent, reasoningReportId };
}

export async function handleToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  context?: ToolCallContext,
): Promise<string> {
  toolCallCount++;
  const resolved = resolveContext(context);
  const inputSummary = Object.entries(toolInput)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 40) : v}`)
    .join(', ');
  console.error(`[mcp:${toolCallCount}:${resolved.agent}] ${toolName}(${inputSummary})`);
  const startTime = Date.now();

  const run = async (): Promise<string> => {
    try {
      const result = await _handleToolCallInner(toolName, toolInput, resolved);
      console.error(`[mcp:${toolCallCount}:${resolved.agent}] ${toolName} OK +${Date.now() - startTime}ms (${result.length} chars)`);
      return result;
    } catch (err) {
      console.error(`[mcp:${toolCallCount}:${resolved.agent}] ${toolName} ERROR +${Date.now() - startTime}ms: ${err}`);
      throw err;
    }
  };

  // Bead nmemo-2yv.127: serialise write tools through writeQueue so both
  // transports (Pi + MCP) inherit consistent write ordering. Reads run freely.
  // Queue fails open — a prior failure does not block subsequent writes.
  if (WRITE_TOOLS.has(toolName)) {
    const prev = writeQueue.catch(() => undefined);
    const next = prev.then(run);
    writeQueue = next;
    return next;
  }
  return run();
}

async function _handleToolCallInner(
  toolName: string,
  toolInput: Record<string, unknown>,
  context: ToolCallContext,
): Promise<string> {
  switch (toolName) {
    case 'query_entity_facts': {
      const entityId = toolInput.entity_id as string;
      const facts = await getEntityFacts(entityId);
      // Include entity summary and aliases
      const metaRows = await db
        .select({ summary: entityMeta.summary })
        .from(entityMeta)
        .where(eq(entityMeta.entityId, entityId))
        .limit(1);
      const summary = metaRows[0]?.summary ?? null;
      const aliases = await db
        .select({ alias: entityAliases.alias, aliasType: entityAliases.aliasType })
        .from(entityAliases)
        .where(eq(entityAliases.entityId, entityId));
      return JSON.stringify({
        summary,
        aliases: aliases.map(a => ({ alias: a.alias, type: a.aliasType })),
        facts: facts.map(f => ({
          id: f.id,
          subjectEntityId: f.subjectEntityId,
          predicate: f.predicate,
          objectEntityId: f.objectEntityId,
          objectValue: f.objectValue,
          confidence: f.confidence,
          validAt: f.validAt,
          invalidAt: f.invalidAt,
          sourceText: f.sourceText,
        })),
      });
    }

    case 'query_entity_neighbours': {
      const neighbours = await findConnectedEntities(
        toolInput.entity_id as string,
        {
          relationshipType: toolInput.relationship_type as string | undefined,
          maxDepth: toolInput.max_depth as number | undefined,
        },
      );
      return JSON.stringify(neighbours);
    }

    case 'search_similar_entities': {
      const embedResult = await ml.embed(toolInput.query as string);
      const similar = await findSimilarEntities(embedResult.vector, {
        threshold: (toolInput.threshold as number) ?? 0.5,
        limit: (toolInput.limit as number) ?? 10,
        type: toolInput.entity_type as string | undefined,
      });
      return JSON.stringify(similar.map(e => ({
        id: e.id,
        canonicalName: e.canonicalName,
        entityType: e.entityType,
        similarity: e.similarity,
      })));
    }

    case 'search_memories': {
      const embedResult = await ml.embed(toolInput.query as string);
      const memories = await searchMemories(embedResult.vector, {
        limit: (toolInput.limit as number) ?? 5,
      });
      return JSON.stringify(memories.map((m: any) => ({
        id: m.id,
        score: m.score,
        content: m.payload?.content,
        metadata: m.payload?.metadata,
        createdAt: m.payload?.created_at,
      })));
    }

    case 'get_memory_text': {
      const memory = await getMemory(toolInput.memory_id as string);
      if (!memory) {
        return JSON.stringify({ error: 'Memory not found' });
      }
      return JSON.stringify({
        id: memory.id,
        content: (memory.payload as any)?.content,
        metadata: (memory.payload as any)?.metadata,
        createdAt: (memory.payload as any)?.created_at,
      });
    }

    case 'get_causal_history': {
      const history = await getEntityCausalHistory(toolInput.entity_id as string);
      return JSON.stringify({
        events: history.events.map(e => ({
          id: e.id,
          factId: e.factId,
          transitionType: e.transitionType,
          subjectEntityId: e.subjectEntityId,
          predicate: e.predicate,
          deltaConfidence: e.deltaConfidence,
          occurredAt: e.occurredAt,
          sourceText: e.sourceText,
        })),
        edges: history.edges.map(e => ({
          id: e.id,
          causeEventId: e.causeEventId,
          effectEventId: e.effectEventId,
          strength: e.strength,
          reasoning: e.reasoning,
          sourceReferences: e.sourceReferences,
          extractionMethod: e.extractionMethod,
          corroborationCount: e.corroborationCount,
          lastCorroborated: e.lastCorroborated,
          initialStrength: e.initialStrength,
          decayApplied: e.decayApplied,
        })),
      });
    }

    case 'create_causal_edge': {
      const refs = toolInput.source_references as Array<{
        type: 'memory' | 'fact' | 'entity';
        id: string;
        relevance: string;
      }>;
      const edgeId = await createCausalEdge({
        causeEventId: toolInput.cause_event_id as string,
        effectEventId: toolInput.effect_event_id as string,
        strength: toolInput.strength as number,
        reasoning: toolInput.reasoning as string,
        sourceReferences: refs,
        temporalSpan: toolInput.temporal_span as string | undefined,
        actor: context.agent,
        reasoningReportId: context.reasoningReportId ?? null,
      });
      return JSON.stringify({ edgeId });
    }

    // --- Extraction tool handlers ---

    case 'resolve_entity': {
      const resolved = await resolveEntity(
        toolInput.mention as string,
        toolInput.context as string,
        toolInput.entity_type as string,
      );
      return JSON.stringify({
        id: resolved.id,
        canonicalName: resolved.canonicalName,
        entityType: resolved.entityType,
        isNew: resolved.isNew,
        confidence: resolved.confidence,
      });
    }

    case 'create_fact': {
      const predicate = normalizePredicate(toolInput.predicate as string);
      const factId = await createFact({
        subjectEntityId: toolInput.subject_entity_id as string,
        predicate,
        objectEntityId: toolInput.object_entity_id as string | undefined,
        objectValue: toolInput.object_value as string | undefined,
        confidence: toolInput.confidence as number,
        sourceText: toolInput.source_text as string,
        sourceMemoryId: toolInput.source_memory_id as string | undefined,
        validAt: toolInput.valid_at ? new Date(toolInput.valid_at as string) : undefined,
        invalidAt: toolInput.invalid_at ? new Date(toolInput.invalid_at as string) : undefined,
        actor: context.agent,
        reasoningReportId: context.reasoningReportId ?? null,
      });
      return JSON.stringify({ factId, predicate });
    }

    case 'get_fact_source': {
      const factRows = await db
        .select({
          id: factsTable.id,
          sourceMemoryId: factsTable.sourceMemoryId,
          sourceText: factsTable.sourceText,
          predicate: factsTable.predicate,
          subjectEntityId: factsTable.subjectEntityId,
          objectEntityId: factsTable.objectEntityId,
          objectValue: factsTable.objectValue,
        })
        .from(factsTable)
        .where(eq(factsTable.id, toolInput.fact_id as string))
        .limit(1);

      if (factRows.length === 0) {
        return JSON.stringify({ error: 'Fact not found' });
      }

      const fact = factRows[0]!;
      let sourcePreview: string | null = null;
      if (fact.sourceMemoryId) {
        const mem = await getMemory(fact.sourceMemoryId);
        if (mem?.payload) {
          sourcePreview = (mem.payload.content as string)?.slice(0, 500) ?? null;
        }
      }

      return JSON.stringify({
        factId: fact.id,
        predicate: fact.predicate,
        subjectEntityId: fact.subjectEntityId,
        objectEntityId: fact.objectEntityId,
        objectValue: fact.objectValue,
        sourceText: fact.sourceText,
        sourceMemoryId: fact.sourceMemoryId,
        sourcePreview,
      });
    }

    case 'get_entity_sources': {
      const mentions = await db
        .select({
          memoryId: memoryEntities.memoryId,
          mentionText: memoryEntities.mentionText,
          mentionContext: memoryEntities.mentionContext,
          confidence: memoryEntities.confidence,
        })
        .from(memoryEntities)
        .where(eq(memoryEntities.entityId, toolInput.entity_id as string));

      const memoryIds = [...new Set(mentions.map(m => m.memoryId))].slice(0, 10);
      const fetched = await Promise.all(memoryIds.map(getMemory));
      const previews: Record<string, string> = {};
      memoryIds.forEach((mid, i) => {
        const content = fetched[i]?.payload?.content as string | undefined;
        if (content) previews[mid] = content.slice(0, 300);
      });

      return JSON.stringify(mentions.map(m => ({
        memoryId: m.memoryId,
        mentionText: m.mentionText,
        context: m.mentionContext,
        confidence: m.confidence,
        sourcePreview: previews[m.memoryId] ?? null,
      })));
    }

    case 'link_entity_to_memory': {
      await linkMemoryToEntity(
        toolInput.memory_id as string,
        toolInput.entity_id as string,
        {
          text: toolInput.mention_text as string,
          context: toolInput.mention_context as string | undefined,
        },
      );
      return JSON.stringify({ linked: true });
    }

    case 'add_entity_alias': {
      await db
        .insert(entityAliases)
        .values({
          entityId: toolInput.entity_id as string,
          alias: toolInput.alias as string,
          aliasType: toolInput.alias_type as string,
          source: 'agent',
        })
        .onConflictDoNothing();
      return JSON.stringify({ added: true });
    }

    case 'search_entity_aliases': {
      const query = toolInput.query as string;
      // Search aliases by ILIKE pattern match
      const matches = await db
        .select({
          entityId: entityAliases.entityId,
          alias: entityAliases.alias,
          aliasType: entityAliases.aliasType,
          canonicalName: entitiesTable.canonicalName,
          entityType: entitiesTable.entityType,
        })
        .from(entityAliases)
        .innerJoin(entitiesTable, eq(entityAliases.entityId, entitiesTable.id))
        .where(ilike(entityAliases.alias, `%${query}%`))
        .limit(10);

      const entityIds = [...new Set(matches.map(m => m.entityId))];
      const summaries: Record<string, string | null> = {};
      if (entityIds.length > 0) {
        const metaRows = await db
          .select({ entityId: entityMeta.entityId, summary: entityMeta.summary })
          .from(entityMeta)
          .where(inArray(entityMeta.entityId, entityIds));
        for (const row of metaRows) summaries[row.entityId] = row.summary ?? null;
      }

      return JSON.stringify(matches.map(m => ({
        entityId: m.entityId,
        canonicalName: m.canonicalName,
        entityType: m.entityType,
        matchedAlias: m.alias,
        aliasType: m.aliasType,
        summary: summaries[m.entityId] ?? null,
      })));
    }

    case 'update_entity_summary': {
      const entityId = toolInput.entity_id as string;
      const summary = toolInput.summary as string;
      const updatedAt = new Date();
      await db
        .insert(entityMeta)
        .values({ entityId, summary, updatedAt })
        .onConflictDoUpdate({
          target: entityMeta.entityId,
          set: { summary, updatedAt },
        });
      return JSON.stringify({ updated: true });
    }

    // --- Reconciliation tool handlers ---

    case 'create_same_as_link': {
      let aId = toolInput.entity_a_id as string;
      let bId = toolInput.entity_b_id as string;
      // Enforce canonical ordering (a < b)
      if (aId > bId) [aId, bId] = [bId, aId];

      const refs = (toolInput.source_evidence as Array<{
        type: string; id: string; relevance: string;
      }>) ?? [];

      const inserted = await db
        .insert(sameAsLinks)
        .values({
          entityAId: aId,
          entityBId: bId,
          reasoning: toolInput.reasoning as string,
          sourceEvidence: refs,
          confidence: toolInput.confidence as number,
          createdBy: 'reconciliation_agent',
          mergeCandidateId: toolInput.merge_candidate_id as string | undefined,
        })
        .onConflictDoNothing()
        .returning({ id: sameAsLinks.id });

      if (inserted.length === 0) {
        return JSON.stringify({ created: false, reason: 'same_as link already exists between these entities' });
      }
      return JSON.stringify({ created: true, linkId: inserted[0]!.id });
    }

    case 'execute_merge': {
      const sourceId = toolInput.source_entity_id as string;
      const targetId = toolInput.target_entity_id as string;
      const mergeReason = toolInput.reasoning as string;

      // Doc 23.3 §3.4 — structural-impact warning: if either side of the
      // merge is currently flagged as an articulation point, deleting the
      // source (or rerouting through the survivor) is likely to fragment
      // a component. Non-blocking; surface and proceed.
      try {
        const apRows = (await db.execute(sql`
          SELECT entity_id::text AS entity_id, is_articulation_point
          FROM public.entity_topology
          WHERE entity_id = ANY(ARRAY[${sourceId}::uuid, ${targetId}::uuid])
            AND is_articulation_point = TRUE
        `)) as unknown as Array<{ entity_id: string; is_articulation_point: boolean }>;
        if (apRows.length > 0) {
          const flagged = apRows.map((r) => r.entity_id).join(', ');
          console.warn(
            `[topology] execute_merge: ARTICULATION POINT involved in merge ` +
              `(source=${sourceId}, target=${targetId}); flagged entities: ${flagged}; ` +
              `merge will likely fragment a component. Reason: ${mergeReason}`,
          );
        }
      } catch (err) {
        // Topology schema may be absent — never block.
        if (process.env.NODE_ENV !== 'test') {
          console.warn(
            '[topology] execute_merge: articulation check failed (non-fatal):',
            err instanceof Error ? err.message : err,
          );
        }
      }

      try {
        const result = await db.execute(
          sql`SELECT public.merge_entities(${sourceId}::uuid, ${targetId}::uuid, ${mergeReason}, 'reconciliation_agent')`
        ) as unknown as Array<{ merge_entities: string }>;
        const survivorId = result[0]?.merge_entities ?? targetId;

        // If a candidate ID was provided, resolve it
        if (toolInput.merge_candidate_id) {
          await db.execute(sql`
            UPDATE public.merge_candidates
            SET status = 'resolved', resolution = 'merge',
                resolution_reasoning = ${mergeReason},
                resolved_at = NOW(), resolved_by = 'reconciliation_agent'
            WHERE id = ${toolInput.merge_candidate_id as string}::uuid
          `);
        }

        return JSON.stringify({ merged: true, survivorId });
      } catch (err) {
        return JSON.stringify({ merged: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    case 'resolve_candidate': {
      await db.execute(sql`
        UPDATE public.merge_candidates
        SET status = 'resolved',
            resolution = ${toolInput.resolution as string},
            resolution_reasoning = ${toolInput.reasoning as string},
            resolved_at = NOW(),
            resolved_by = 'reconciliation_agent'
        WHERE id = ${toolInput.candidate_id as string}::uuid
      `);
      return JSON.stringify({ resolved: true });
    }

    case 'get_reconciliation_context': {
      const includeReports = toolInput.include_reports !== false;
      const maxReports = (toolInput.max_reports as number) ?? 10;

      // Unresolved merge candidates
      const candidates = await db.execute(sql`
        SELECT
          mc.id, mc.entity_a_id, mc.entity_b_id,
          mc.centroid_similarity, mc.memory_overlap, mc.structural_similarity,
          mc.combined_score, mc.status, mc.detection_count,
          a.canonical_name as a_name, a.entity_type as a_type,
          b.canonical_name as b_name, b.entity_type as b_type,
          ma.summary as a_summary, mb.summary as b_summary
        FROM public.merge_candidates mc
        JOIN public.entities a ON mc.entity_a_id = a.id
        JOIN public.entities b ON mc.entity_b_id = b.id
        LEFT JOIN public.entity_meta ma ON ma.entity_id = mc.entity_a_id
        LEFT JOIN public.entity_meta mb ON mb.entity_id = mc.entity_b_id
        WHERE mc.status != 'resolved'
        ORDER BY mc.combined_score DESC
        LIMIT 20
      `) as unknown as Array<Record<string, unknown>>;

      // Aliases for each candidate entity pair
      const candidateEntityIds = candidates.flatMap(c => [c.entity_a_id as string, c.entity_b_id as string]);
      const aliasMap: Record<string, Array<{ alias: string; type: string }>> = {};
      if (candidateEntityIds.length > 0) {
        const aliases = await db
          .select({ entityId: entityAliases.entityId, alias: entityAliases.alias, aliasType: entityAliases.aliasType })
          .from(entityAliases)
          .where(sql`entity_id = ANY(${candidateEntityIds}::uuid[])`);
        for (const a of aliases) {
          if (!aliasMap[a.entityId]) aliasMap[a.entityId] = [];
          aliasMap[a.entityId]!.push({ alias: a.alias, type: a.aliasType ?? 'name' });
        }
      }

      // Recent extraction reports
      let reports: Array<{ id: string; memoryId: string; reportText: string; createdAt: Date }> = [];
      if (includeReports) {
        reports = await db
          .select({ id: extractionReports.id, memoryId: extractionReports.memoryId, reportText: extractionReports.reportText, createdAt: extractionReports.createdAt })
          .from(extractionReports)
          .orderBy(sql`created_at DESC`)
          .limit(maxReports);
      }

      // Unconfirmed aliases
      const unconfirmed = await db
        .select({
          entityId: entityAliases.entityId,
          alias: entityAliases.alias,
        })
        .from(entityAliases)
        .where(eq(entityAliases.aliasType, 'unconfirmed'))
        .limit(50);

      // Orphan entities (zero active facts)
      const orphans = await db.execute(sql`
        SELECT e.id, e.canonical_name, e.entity_type, em.mention_count
        FROM public.entities e
        LEFT JOIN public.entity_meta em ON em.entity_id = e.id
        WHERE em.fact_count = 0 AND em.mention_count > 0
        ORDER BY em.mention_count DESC
        LIMIT 20
      `) as unknown as Array<Record<string, unknown>>;

      return JSON.stringify({
        candidates: candidates.map(c => ({
          ...c,
          a_aliases: aliasMap[c.entity_a_id as string] ?? [],
          b_aliases: aliasMap[c.entity_b_id as string] ?? [],
        })),
        reports: reports.map(r => ({ id: r.id, memoryId: r.memoryId, createdAt: r.createdAt, reportText: r.reportText })),
        unconfirmedAliases: unconfirmed,
        orphans,
      });
    }

    // --- Gardener tool handlers ---

    case 'get_graph_topology': {
      // Pre-analyzed topology — returns actionable findings, not raw data.
      // Designed to work at scale (100s-1000s of entities).

      // 1. Get all entities (compact — no summaries in the overview)
      const allEntities = await db.execute(sql`
        SELECT e.id, e.canonical_name, e.entity_type,
               COALESCE(em.fact_count, 0)::int as fact_count,
               COALESCE(em.mention_count, 0)::int as mention_count
        FROM public.entities e
        LEFT JOIN public.entity_meta em ON em.entity_id = e.id
      `) as unknown as Array<{
        id: string; canonical_name: string; entity_type: string;
        fact_count: number; mention_count: number;
      }>;

      // 2. Get all active fact edges (entity-to-entity)
      const factEdges = await db.execute(sql`
        SELECT subject_entity_id, object_entity_id
        FROM public.facts
        WHERE object_entity_id IS NOT NULL AND expired_at IS NULL
      `) as unknown as Array<{ subject_entity_id: string; object_entity_id: string }>;

      // 3. Get same_as links
      const sameAsEdges = await db.execute(sql`
        SELECT entity_a_id, entity_b_id FROM public.same_as_links
      `) as unknown as Array<{ entity_a_id: string; entity_b_id: string }>;

      // 4. Union-find for connected components
      const parent: Record<string, string> = {};
      function find(x: string): string {
        if (!parent[x]) parent[x] = x;
        while (parent[x] !== x) { parent[x] = parent[parent[x]!]!; x = parent[x]!; }
        return x;
      }
      function union(a: string, b: string) {
        const ra = find(a), rb = find(b);
        if (ra !== rb) parent[ra] = rb;
      }
      for (const e of allEntities) parent[e.id] = e.id;
      for (const edge of factEdges) union(edge.subject_entity_id, edge.object_entity_id);
      for (const edge of sameAsEdges) union(edge.entity_a_id, edge.entity_b_id);

      // 5. Group into components
      const componentMap: Record<string, typeof allEntities> = {};
      for (const e of allEntities) {
        const root = find(e.id);
        if (!componentMap[root]) componentMap[root] = [];
        componentMap[root]!.push(e);
      }
      const sorted = Object.values(componentMap).sort((a, b) => b.length - a.length);

      // 6. Compute node degrees for hub detection
      const degree: Record<string, number> = {};
      for (const e of allEntities) degree[e.id] = 0;
      for (const edge of factEdges) {
        degree[edge.subject_entity_id] = (degree[edge.subject_entity_id] ?? 0) + 1;
        degree[edge.object_entity_id] = (degree[edge.object_entity_id] ?? 0) + 1;
      }

      // 7. Identify the main cluster vs islands
      const mainCluster = sorted[0] ?? [];
      const islands = sorted.slice(1).filter(c => c.length >= 2); // multi-entity disconnected groups
      const isolates = sorted.slice(1).filter(c => c.length === 1); // single disconnected entities

      // 8. Find hubs (top connected nodes in main cluster)
      const hubs = mainCluster
        .map(e => ({ ...e, degree: degree[e.id] ?? 0 }))
        .sort((a, b) => b.degree - a.degree)
        .slice(0, 10);

      // 9. Find orphans (entities with mentions but zero facts)
      const orphans = allEntities
        .filter(e => e.fact_count === 0 && e.mention_count > 0)
        .slice(0, 20);

      // 10. Sparse leaves — entities in the main cluster with only 1-2 edges,
      //     dangling off a hub. Prime targets for cross-linking.
      const sparseLeaves = allEntities
        .filter(e => {
          const d = degree[e.id] ?? 0;
          return d === 1 || d === 2;
        })
        .map(e => ({
          id: e.id, name: e.canonical_name, type: e.entity_type,
          degree: degree[e.id] ?? 0, factCount: e.fact_count,
        }))
        .sort((a, b) => a.degree - b.degree);

      return JSON.stringify({
        summary: {
          totalEntities: allEntities.length,
          totalFactEdges: factEdges.length,
          totalSameAsLinks: sameAsEdges.length,
          totalComponents: sorted.length,
          mainClusterSize: mainCluster.length,
          islandCount: islands.length,
          isolateCount: isolates.length,
          orphanCount: orphans.length,
        },
        // Top 10 most-connected nodes — the graph's backbone
        hubs: hubs.map(e => ({
          id: e.id, name: e.canonical_name, type: e.entity_type,
          degree: e.degree, factCount: e.fact_count,
        })),
        // Multi-entity disconnected groups — investigate for missed connections
        islands: islands.map(island => ({
          size: island.length,
          totalFacts: island.reduce((s, e) => s + e.fact_count, 0),
          entities: island.map(e => ({
            id: e.id, name: e.canonical_name, type: e.entity_type,
            factCount: e.fact_count, degree: degree[e.id] ?? 0,
          })),
        })),
        // Single disconnected entities — potential duplicates or missed links
        isolates: isolates.map(([e]) => ({
          id: e!.id, name: e!.canonical_name, type: e!.entity_type,
          factCount: e!.fact_count, mentionCount: e!.mention_count,
        })),
        // Entities with mentions but zero facts — need investigation
        orphans: orphans.map(e => ({
          id: e.id, name: e.canonical_name, type: e.entity_type,
          mentionCount: e.mention_count,
        })),
        sparseLeaves: { count: sparseLeaves.length, entities: sparseLeaves.slice(0, 30) },
      });
    }

    // --- Reasoning agent tool handlers ---

    case 'expire_fact': {
      await expireFact({
        factId: toolInput.fact_id as string,
        reasoning: toolInput.reason as string,
        actor: context.agent,
        reasoningReportId: context.reasoningReportId ?? null,
      });
      return JSON.stringify({ expired: true });
    }

    case 'invalidate_fact': {
      await invalidateFact({
        factId: toolInput.fact_id as string,
        invalidAt: toolInput.invalid_at ? new Date(toolInput.invalid_at as string) : undefined,
        reasoning: (toolInput.reason as string | undefined)
          ?? `Fact marked no longer true in reality by ${context.agent}`,
        actor: context.agent,
        reasoningReportId: context.reasoningReportId ?? null,
      });
      return JSON.stringify({ invalidated: true });
    }

    case 'get_neighbourhood_profile': {
      const entityId = toolInput.entity_id as string;

      const [entityRows, metaRows, subjectFacts, objectFacts, neighbours, causalHistory, mentions] = await Promise.all([
        db.select().from(entities).where(eq(entities.id, entityId)).limit(1),
        db.select().from(entityMeta).where(eq(entityMeta.entityId, entityId)).limit(1),
        getEntityFacts(entityId),
        db.select({
          id: factsTable.id,
          subjectEntityId: factsTable.subjectEntityId,
          predicate: factsTable.predicate,
          objectValue: factsTable.objectValue,
          confidence: factsTable.confidence,
          sourceText: factsTable.sourceText,
        }).from(factsTable).where(and(eq(factsTable.objectEntityId, entityId), isNull(factsTable.expiredAt))),
        findConnectedEntities(entityId, { maxDepth: 1 }),
        getEntityCausalHistory(entityId),
        db.select({ memoryId: memoryEntities.memoryId }).from(memoryEntities).where(eq(memoryEntities.entityId, entityId)),
      ]);

      const entity = entityRows[0];
      const meta = metaRows[0];

      return JSON.stringify({
        entity: entity ? { id: entity.id, canonicalName: entity.canonicalName, entityType: entity.entityType } : null,
        summary: meta?.summary ?? null,
        meta: meta ? {
          mentionCount: meta.mentionCount, sourceMemoryCount: meta.sourceMemoryCount,
          factCount: meta.factCount, spread: meta.spread,
          firstMentionedAt: meta.firstMentionedAt, lastMentionedAt: meta.lastMentionedAt,
          lastReasonedAt: meta.lastReasonedAt,
        } : null,
        factsAsSubject: subjectFacts.map(f => ({
          id: f.id, predicate: f.predicate, objectEntityId: f.objectEntityId,
          objectValue: f.objectValue, confidence: f.confidence, sourceText: f.sourceText,
        })),
        factsAsObject: objectFacts.map(f => ({
          id: f.id, subjectEntityId: f.subjectEntityId, predicate: f.predicate,
          objectValue: f.objectValue, confidence: f.confidence, sourceText: f.sourceText,
        })),
        neighbours: neighbours.map((n: any) => ({
          id: n.id ?? n.entity_id, canonicalName: n.canonicalName ?? n.canonical_name,
          entityType: n.entityType ?? n.entity_type,
        })),
        causalEvents: causalHistory.events.length,
        causalEdges: causalHistory.edges.length,
        sourceMemoryCount: mentions.length,
      });
    }

    case 'get_reasoning_targets': {
      const limit = (toolInput.limit as number) ?? 10;

      const targets = await db.execute(sql`
        WITH entity_scores AS (
          SELECT
            e.id, e.canonical_name, e.entity_type,
            COALESCE(em.fact_count, 0) AS fact_count,
            COALESCE(em.mention_count, 0) AS mention_count,
            (SELECT COUNT(*) FROM public.causal_events ce WHERE ce.subject_entity_id = e.id) AS causal_event_count,
            em.last_reasoned_at, em.last_mentioned_at,
            (
              COALESCE(em.fact_count, 0) * 2.0 +
              (SELECT COUNT(*) FROM public.causal_events ce WHERE ce.subject_entity_id = e.id) * 1.5 +
              COALESCE(em.mention_count, 0) * 0.5 +
              CASE WHEN em.last_reasoned_at IS NULL THEN 20
                   WHEN em.last_mentioned_at > em.last_reasoned_at THEN 10
                   ELSE 0 END
            ) AS reasoning_score
          FROM public.entities e
          LEFT JOIN public.entity_meta em ON em.entity_id = e.id
          WHERE COALESCE(em.fact_count, 0) > 0
        )
        SELECT * FROM entity_scores ORDER BY reasoning_score DESC LIMIT ${limit}
      `);

      return JSON.stringify(((targets as unknown as { rows?: unknown[] }).rows ?? targets as unknown as unknown[]).map((r: any) => ({
        entityId: r.id, canonicalName: r.canonical_name, entityType: r.entity_type,
        factCount: Number(r.fact_count), causalEventCount: Number(r.causal_event_count),
        mentionCount: Number(r.mention_count), lastReasonedAt: r.last_reasoned_at,
        lastMentionedAt: r.last_mentioned_at, reasoningScore: Number(r.reasoning_score),
      })));
    }

    case 'get_reasoning_history': {
      const entityId = toolInput.entity_id as string;
      const limit = (toolInput.limit as number) ?? 5;

      const reports = await db
        .select()
        .from(reasoningReports)
        .where(sql`${entityId}::uuid = ANY(${reasoningReports.entityIds})`)
        .orderBy(desc(reasoningReports.createdAt))
        .limit(limit);

      return JSON.stringify(reports.map(r => ({
        id: r.id, mode: r.mode, question: r.question,
        report: r.report, actionsTaken: r.actionsTaken, createdAt: r.createdAt,
      })));
    }

    case 'save_reasoning_report': {
      const entityIds = (toolInput.entity_ids as string[]) ?? [];
      const factIds = (toolInput.fact_ids as string[]) ?? [];
      const causalEdgeIds = (toolInput.causal_edge_ids as string[]) ?? [];

      const result = await db
        .insert(reasoningReports)
        .values({
          mode: toolInput.mode as string,
          question: toolInput.question as string | undefined,
          report: toolInput.report as string,
          entityIds, factIds, causalEdgeIds,
          actionsTaken: toolInput.actions_taken ?? {},
        })
        .returning({ id: reasoningReports.id });

      if (entityIds.length > 0) {
        const updated = await db
          .update(entityMeta)
          .set({ lastReasonedAt: new Date() })
          .where(inArray(entityMeta.entityId, entityIds))
          .returning({ entityId: entityMeta.entityId });
        if (updated.length === 0) {
          console.warn(`[save_reasoning_report] UPDATE matched 0 entity_meta rows for ${entityIds.length} entity ids`);
        }
      }

      return JSON.stringify({ reportId: result[0]?.id });
    }

    // --- Phase 1 audit tools ---

    case 'get_fact_history': {
      const factId = toolInput.fact_id as string;
      const limit = (toolInput.limit as number | undefined) ?? 100;
      const rows = await getFactHistory(factId, limit);
      return JSON.stringify(rows);
    }

    case 'get_edge_history': {
      const edgeId = toolInput.edge_id as string;
      const limit = (toolInput.limit as number | undefined) ?? 100;
      const rows = await getEdgeHistory(edgeId, limit);
      return JSON.stringify(rows);
    }

    case 'update_fact_confidence': {
      await updateFactConfidence({
        factId: toolInput.fact_id as string,
        newConfidence: toolInput.new_confidence as number,
        reasoning: toolInput.reasoning as string,
        actor: context.agent,
        reasoningReportId: context.reasoningReportId ?? null,
      });
      return JSON.stringify({ updated: true });
    }

    case 'restore_fact': {
      await restoreFact({
        factId: toolInput.fact_id as string,
        reasoning: toolInput.reasoning as string,
        actor: context.agent,
        reasoningReportId: context.reasoningReportId ?? null,
      });
      return JSON.stringify({ restored: true });
    }

    case 'expire_causal_edge': {
      await expireCausalEdge({
        edgeId: toolInput.edge_id as string,
        reasoning: toolInput.reasoning as string,
        actor: context.agent,
        reasoningReportId: context.reasoningReportId ?? null,
      });
      return JSON.stringify({ expired: true });
    }

    case 'revise_causal_edge': {
      const addedRefs = toolInput.added_source_refs as CausalSourceRef[] | undefined;
      await reviseCausalEdge({
        edgeId: toolInput.edge_id as string,
        newStrength: toolInput.new_strength as number | undefined,
        newReasoning: toolInput.new_reasoning as string | undefined,
        addedSourceRefs: addedRefs,
        reasoning: toolInput.reasoning as string,
        actor: context.agent,
        reasoningReportId: context.reasoningReportId ?? null,
      });
      return JSON.stringify({ revised: true });
    }

    case 'get_contradictions': {
      const rows = await getContradictions({
        limit: toolInput.limit as number | undefined,
        unresolvedOnly: toolInput.unresolved_only as boolean | undefined,
        contradictionType: toolInput.contradiction_type as ContradictionType | undefined,
        severity: toolInput.severity as ContradictionSeverity | undefined,
      });
      return JSON.stringify({ contradictions: rows });
    }

    case 'resolve_contradiction': {
      await resolveContradiction({
        contradictionId: toolInput.contradiction_id as string,
        resolutionType: toolInput.resolution_type as ResolutionType,
        resolutionReasoning: toolInput.resolution_reasoning as string,
        actor: context.agent,
        reasoningReportId: context.reasoningReportId ?? null,
        dismissedReason: toolInput.dismissed_reason as string | undefined,
      });
      return JSON.stringify({ resolved: true });
    }

    case 'analyze_blast_radius': {
      const report = await analyzeImpact({
        nodeType: toolInput.node_type as ImpactRootNodeType,
        nodeId: toolInput.node_id as string,
        maxDepth: toolInput.max_depth as number | undefined,
        hypothetical: toolInput.hypothetical as HypotheticalAction | undefined,
      });
      return JSON.stringify(report);
    }

    case 'get_active_patterns': {
      const patterns = await activePatterns({
        entityId: toolInput.entity_id as string | undefined,
        status: toolInput.status as PatternStatus[] | undefined,
        limit: toolInput.limit as number | undefined,
      });
      return JSON.stringify({ patterns });
    }

    case 'find_causal_ghosts': {
      const ghosts = await findCausalGhosts(toolInput.entity_id as string);
      return JSON.stringify({ ghosts });
    }

    case 'get_pattern_instances': {
      const patternId = toolInput.pattern_id as string;
      const limit = (toolInput.limit as number | undefined) ?? 10;
      const rows = await db.execute(sql`
        SELECT id, cause_event_id, effect_event_id, strength, reasoning,
               pattern_position, created_at
        FROM public.causal_edges
        WHERE pattern_id = ${patternId}::uuid
          AND expired_at IS NULL
        ORDER BY pattern_position, created_at
        LIMIT ${limit}::int
      `);
      return JSON.stringify({ instances: rows });
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

// ============================================
// Agent Invocation (B06)
// ============================================

export interface CausalDelta {
  sourceText: string;
  memoryId?: string;
  newEntities: Array<Record<string, unknown>>;
  newFacts: Array<Record<string, unknown>>;
  modifiedFacts: Array<Record<string, unknown>>;
  causalEvents: Array<{
    id: string;
    factId?: string;
    transitionType: string;
    subjectEntityId?: string;
    predicate?: string;
    sourceText?: string;
  }>;
}

export interface CausalAgentResult {
  result: string;
  cost?: Record<string, unknown>;
}

/**
 * Resolve the absolute filesystem path to the production graph MCP server
 * script. Single source of truth — both `getMcpConfigPath` (which tells
 * Claude Code where to spawn the server) and `checkGraphMcpHealth` (which
 * probes the same server for `/api/mcp-health`) must read through here so
 * they cannot drift apart.
 */
export function getGraphMcpScriptPath(): string {
  const platformRoot = path.resolve(__dirname, '..', '..');
  return path.resolve(platformRoot, 'src', 'services', 'graph-mcp.ts');
}

/**
 * Generate a temporary MCP config JSON with resolved absolute paths.
 * Claude Code reads this file to know how to spawn the graph MCP server.
 */
export function getMcpConfigPath(actor: Actor = 'graph_agent'): string {
  const platformRoot = path.resolve(__dirname, '..', '..');
  // One config file per actor so invoke* calls don't clobber each other's
  // MNEMO_AGENT_ACTOR when running concurrently (e.g., a patrol kicked off
  // while an extraction is still in flight).
  const configPath = path.resolve(platformRoot, `.graph-mcp-config.${actor}.json`);

  // Use absolute path to the MCP server script — Claude Code does not
  // respect the cwd field when spawning MCP servers, so the script path
  // must be resolvable from any working directory.
  const serverScript = getGraphMcpScriptPath();

  // The MCP server process inherits a minimal env from Claude Code.
  // Pass through the required env vars so config.ts validation passes, plus
  // MNEMO_AGENT_ACTOR so audit writes attribute to the correct agent.
  // Prefer process.env (set by test setup or runtime) over .env file.
  const envFile = dotenv.config({ path: path.resolve(platformRoot, '.env') });
  const env: Record<string, string> = { MNEMO_AGENT_ACTOR: actor };
  for (const key of ['DATABASE_URL', 'QDRANT_URL', 'ML_SERVICES_URL', 'EMBED_MODEL', 'NODE_ENV']) {
    const val = process.env[key] || envFile.parsed?.[key];
    if (val) env[key] = val;
  }

  const mcpConfig = {
    mcpServers: {
      'mnemo-graph': {
        command: 'npx',
        args: ['tsx', serverScript],
        cwd: platformRoot,
        env,
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2));
  return configPath;
}

/**
 * Invoke the causal reasoning agent via the ML service.
 *
 * The ML service calls Claude Code with:
 * - The causal system prompt
 * - MCP config pointing to the graph-mcp.ts server (the unified MCP)
 * - max_turns=20 for agentic tool-use loop
 *
 * Claude Code spawns the MCP server, uses the tools to query Graph S/C
 * and Qdrant, then asserts causal edges via create_causal_edge.
 */
export async function invokeCausalAgent(delta: CausalDelta): Promise<CausalAgentResult> {
  const mcpConfigPath = getMcpConfigPath('graph_agent');

  const response = await fetch(`${config.ML_SERVICES_URL}/causal-reason`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source_text: delta.sourceText,
      memory_id: delta.memoryId,
      new_entities: delta.newEntities,
      new_facts: delta.newFacts,
      modified_facts: delta.modifiedFacts,
      causal_events: delta.causalEvents.map(e => ({
        id: e.id,
        fact_id: e.factId,
        transition_type: e.transitionType,
        subject_entity_id: e.subjectEntityId,
        predicate: e.predicate,
        source_text: e.sourceText,
      })),
      mcp_config_path: mcpConfigPath,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`Causal reasoning failed (${response.status}): ${detail}`);
  }

  return response.json() as Promise<CausalAgentResult>;
}

// ============================================
// Extraction Agent Invocation
// ============================================

/**
 * Content-type hint passed through to the graph agent. Branches the agent's
 * system prompt and predicate vocabulary:
 *  - 'prose' (default): free-predicate extraction over natural-language text.
 *  - 'code-ts': constrained predicate set for TypeScript source — defines,
 *    imports, calls, references, implements, depends_on.
 *  - 'code-sql': constrained predicate set for SQL migrations — defines_table,
 *    defines_column, references_table, creates_index.
 */
export type ContentType = 'prose' | 'code-ts' | 'code-sql';

export interface ExtractionAgentParams {
  sourceText: string;
  memoryId: string;
  source?: string;
  contentType?: ContentType;
}

export interface ExtractionAgentResult {
  result: string;
}

/**
 * Invoke the agentic extraction agent via the ML service.
 *
 * The agent gets MCP tools to search the graph, read sources,
 * resolve entities, and create facts — all interactively.
 */
export async function invokeExtractionAgent(params: ExtractionAgentParams): Promise<ExtractionAgentResult> {
  const mcpConfigPath = getMcpConfigPath('graph_agent');

  const response = await fetch(`${config.ML_SERVICES_URL}/extract-agentic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source_text: params.sourceText,
      memory_id: params.memoryId,
      mcp_config_path: mcpConfigPath,
      source_name: params.source,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`Agentic extraction failed (${response.status}): ${detail}`);
  }

  return response.json() as Promise<ExtractionAgentResult>;
}

// ============================================
// Unified Graph Agent Invocation
// ============================================

export interface GraphAgentResult {
  result: string;
}

/**
 * Invoke the unified graph agent via the ML service.
 *
 * Single invocation that handles all five phases:
 * ORIENT → EXTRACT → RELATE → CAUSE → VERIFY
 */
export interface ReconciliationAgentResult {
  result: string;
}

export async function invokeReconciliationAgent(params: {
  candidates: Array<Record<string, unknown>>;
  recentReports?: string[];
}): Promise<ReconciliationAgentResult> {
  const mcpConfigPath = getMcpConfigPath('reconciliation_agent');

  const response = await fetch(`${config.ML_SERVICES_URL}/reconciliation-agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      candidates: params.candidates,
      mcp_config_path: mcpConfigPath,
      recent_reports: params.recentReports ?? [],
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`Reconciliation agent failed (${response.status}): ${detail}`);
  }

  return response.json() as Promise<ReconciliationAgentResult>;
}

// ============================================
// Reconciliation-drift Agent Invocation (bead nmemo-2yv.83)
// ============================================
// Sibling to invokeReconciliationAgent — targets the
// /reconciliation-agent/drift endpoint with a single-entity drift payload.
// Returns a structured { status, result?, error? } so the platform-side
// caller (triggerReconciliationDriftAfterCompute) can classify
// transient vs permanent failures without parsing exception messages.
// Network failures (ECONNREFUSED / timeouts) surface as status === 0.

export interface ReconciliationDriftAgentParams {
  entity_id: string;
  drift_magnitude: number;
  centroid_snapshot: number[];
  centroid_current: number[];
  source_cluster_id: number | null;
  target_cluster_id: number | null;
}

export interface ReconciliationDriftAgentResponse {
  status: number;
  result?: string;
  error?: string;
}

export type ReconciliationDriftInvoker = (
  params: ReconciliationDriftAgentParams,
) => Promise<ReconciliationDriftAgentResponse>;

export async function invokeReconciliationDriftAgent(
  params: ReconciliationDriftAgentParams,
): Promise<ReconciliationDriftAgentResponse> {
  const mcpConfigPath = getMcpConfigPath('reconciliation_agent');
  try {
    const response = await fetch(`${config.ML_SERVICES_URL}/reconciliation-agent/drift`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity_id: params.entity_id,
        drift_magnitude: params.drift_magnitude,
        centroid_snapshot: params.centroid_snapshot,
        centroid_current: params.centroid_current,
        source_cluster_id: params.source_cluster_id,
        target_cluster_id: params.target_cluster_id,
        mcp_config_path: mcpConfigPath,
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => response.statusText);
      return { status: response.status, error: detail };
    }
    // Defensive parse: a malformed/truncated 200 body (or an upstream proxy
    // returning HTML with a 200) shouldn't cascade into the caller's outer
    // try/catch as status=0 (which would be misclassified as a network
    // error). Treat parse failures as 502 — transient (the helper retries)
    // but distinct from "no body at all".
    const body = (await response.json().catch(() => null)) as { result?: unknown } | null;
    if (!body || typeof body.result !== 'string') {
      return { status: 502, error: 'malformed agent response body' };
    }
    return { status: response.status, result: body.result };
  } catch (err) {
    // ECONNREFUSED / DNS failure / aborted fetch — surface as status=0 so
    // the caller can classify alongside HTTP 5xx (transient).
    return { status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

// ============================================
// Gardener Agent Invocation
// ============================================

export interface GardenerAgentResult {
  result: string;
}

/**
 * Invoke the graph gardener agent via the ML service.
 *
 * The gardener explores the graph topology, finds islands and duplicates,
 * and consolidates entities using MCP tools. Unlike the reconciliation agent,
 * it drives its own investigation rather than responding to scored candidates.
 */
export async function invokeGardenerAgent(params: {
  trigger: 'manual' | 'auto';
  graphAgentRunsSinceLast?: number;
}): Promise<GardenerAgentResult> {
  const mcpConfigPath = getMcpConfigPath('gardener_agent');
  const url = `${config.ML_SERVICES_URL}/gardener-agent`;
  console.log(`[gardener] POST ${url} trigger=${params.trigger} mcp=${mcpConfigPath}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mcp_config_path: mcpConfigPath,
      trigger: params.trigger,
      graph_agent_runs_since_last: params.graphAgentRunsSinceLast ?? 0,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    console.error(`[gardener] ML service responded ${response.status}: ${detail.slice(0, 200)}`);
    throw new Error(`Gardener agent failed (${response.status}): ${detail}`);
  }

  console.log(`[gardener] ML service responded OK`);
  return response.json() as Promise<GardenerAgentResult>;
}

export async function invokeGraphAgent(params: ExtractionAgentParams): Promise<GraphAgentResult> {
  const mcpConfigPath = getMcpConfigPath('graph_agent');

  const response = await fetch(`${config.ML_SERVICES_URL}/graph-agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source_text: params.sourceText,
      memory_id: params.memoryId,
      mcp_config_path: mcpConfigPath,
      source_name: params.source,
      content_type: params.contentType ?? 'prose',
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`Graph agent failed (${response.status}): ${detail}`);
  }

  return response.json() as Promise<GraphAgentResult>;
}

// ============================================
// Reasoning Agent Invocation
// ============================================

export interface ReasoningAgentParams {
  mode: 'patrol' | 'query';
  question?: string;
}

export interface ReasoningAgentResult {
  result: string;
}

export async function invokeReasoningAgent(params: ReasoningAgentParams): Promise<ReasoningAgentResult> {
  const mcpConfigPath = getMcpConfigPath('reasoning_agent');

  const response = await fetch(`${config.ML_SERVICES_URL}/reasoning-agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: params.mode,
      question: params.question,
      mcp_config_path: mcpConfigPath,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`Reasoning agent failed (${response.status}): ${detail}`);
  }

  const result = (await response.json()) as ReasoningAgentResult;

  // Phase 6 (nmemo-d9v.13): bump the pattern-detection counter on patrol
  // success. Every PATTERN_DETECTION_INTERVAL patrols runs detectCausalPatterns
  // + promotePatterns. Wrapped in try/catch inside incrementPatrolCount —
  // any failure logs but never surfaces.
  //
  // Phase 1 cluster-bridging (nmemo-a7f.1.1, doc 22 §3.3): bump the
  // graph-stats counter on the same patrol-success edge. Independent counter
  // and interval — both run sequentially; neither blocks the other.
  if (params.mode === 'patrol') {
    const { incrementPatrolCount, incrementGraphStatsCount } = await import('../pipeline.js');
    await incrementPatrolCount();
    await incrementGraphStatsCount();
  }

  return result;
}

// ============================================
// MCP Health Check
// ============================================

export interface McpHealthResult {
  ok: boolean;
  tools?: string[];
  error?: string;
  durationMs: number;
}

/**
 * Spawn the production graph MCP server and verify it responds to a
 * tools/list request. Uses the raw JSON-RPC protocol over stdio (no SDK
 * client needed). Resolves the script path through `getGraphMcpScriptPath`
 * so the probe target stays locked to whatever `getMcpConfigPath` writes
 * into the per-actor MCP configs that production agents consume.
 */
export async function checkGraphMcpHealth(timeoutMs = 15_000): Promise<McpHealthResult> {
  const start = Date.now();
  const platformRoot = path.resolve(__dirname, '..', '..');
  const serverScript = getGraphMcpScriptPath();

  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', serverScript], {
      cwd: platformRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    let stdout = '';
    let stderr = '';
    let resolved = false;

    const finish = (result: McpHealthResult) => {
      if (resolved) return;
      resolved = true;
      proc.kill();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: 'MCP server timed out', durationMs: Date.now() - start });
    }, timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();

      // Look for tools/list response
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          // Response to initialize
          if (msg.id === 1 && msg.result) {
            // Send tools/list
            const toolsReq = JSON.stringify({
              jsonrpc: '2.0',
              id: 2,
              method: 'tools/list',
              params: {},
            });
            proc.stdin.write(toolsReq + '\n');
          }
          // Response to tools/list
          if (msg.id === 2 && msg.result?.tools) {
            clearTimeout(timer);
            const tools = msg.result.tools.map((t: { name: string }) => t.name);
            finish({ ok: true, tools, durationMs: Date.now() - start });
          }
        } catch {
          // Not JSON yet, keep accumulating
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: `Failed to spawn: ${err.message}`, durationMs: Date.now() - start });
    });

    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (!resolved) {
        finish({ ok: false, error: `Server exited with code ${code}: ${stderr}`, durationMs: Date.now() - start });
      }
    });

    // Send MCP initialize request
    const initReq = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'health-check', version: '1.0.0' },
      },
    });
    proc.stdin.write(initReq + '\n');
  });
}
