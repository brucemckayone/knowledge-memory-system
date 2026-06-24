/**
 * Causal Agent — Tool Definitions (B05) + Agent Invocations
 *
 * GRAPH_TOOLS are exposed via the unified MCP server (graph-mcp.ts).
 * Each tool maps to an existing service function. The tool schema format
 * is MCP-compatible (JSON Schema inputSchema).
 *
 * Agent invocations (invokeGraphAgent, invokeReconciliationAgent, etc.) call the
 * corresponding ML service endpoints, which shell out to Claude Code with the
 * MCP config and the agent's system prompt. Causal reasoning is NOT done inline
 * by the per-chunk extraction agent (the CAUSE phase + create_causal_edge tool
 * were retired in E7, doc 41 §11). It runs as a separate post-promotion pass —
 * invokeCausalAgent (Phase 4, §8a.6) — which proposes edges into staging that
 * causal-promotion disposes.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync } from 'node:fs';
import { spawn } from 'child_process';
import { Agent } from 'undici';
import dotenv from 'dotenv';
import { getEntityFacts, createFact, expireFact, invalidateFact, updateFactConfidence, restoreFact, getFactSources } from './facts.js';
import { findConnectedEntities } from './graph.js';
import { findSimilarEntities, resolveEntity, linkMemoryToEntity, mergeEntities } from './entities.js';
import { searchMemoriesByUnit, getMemory } from './qdrant.js';
import { recallViaGraph, flatRetrievalFailed, type FlatHit } from './graph-fallback.js';
import { db } from '../db/index.js';
import { memoryEntities, facts as factsTable, entityMeta, entityAliases, entities as entitiesTable, sameAsLinks, extractionReports, entities, reasoningReports, stagingProposedEntities, stagingProposedFacts, arbiterVerdicts, causalEvents } from '../db/schema.js';
import { resolveExclusiveGroup } from './exclusive-groups.js';
import { eq, desc, sql, isNull, and, ilike, inArray } from 'drizzle-orm';
import { getEntityCausalHistory, expireCausalEdge, reviseCausalEdge, traceCauses, projectTrajectory, getCausalDelta, type SourceReference as CausalSourceRef } from './causal.js';
import { getFactHistory, getEdgeHistory, jsonbLiteral, unwrapRows, type Actor } from './audit.js';
import {
  getContradictions,
  resolveContradiction,
  createContradiction,
  type ContradictionType,
  type ContradictionSeverity,
  type ResolutionType,
  type AgentDetector,
} from './contradictions.js';
import {
  analyzeImpact,
  preflightBlastRadius,
  maybeWarnBlastRadius,
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
import { searchPredicates } from './predicate-resolve.js';
import { RESOLUTION_VALUES } from './enums.js';
import { capAndSanitize, delimitForPrompt } from './prompt-safety.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Query-side entity seeds gathered for the recall_via_graph tool (doc 38 §4.1.2). */
const MAX_QUERY_SEED_ENTITIES = 5;

// ============================================
// Tool Schemas (MCP-compatible)
// ============================================

/** MCP tool schema — compatible with @modelcontextprotocol/sdk Tool type */
export interface ToolDefinition {
  name: string;
  description: string;
  /**
   * Bead nmemo-2yv.113: per-tool flag declaring whether the tool mutates graph
   * state. Drives the dispatcher's write-serialisation queue (handleToolCall) and
   * any transport-level concurrency policy (e.g. Pi bridge executionMode).
   *
   * Every tool MUST set this explicitly — there is no default. A startup
   * assertion in pi-agent-bridge.ts (and a unit test in pi-agent-bridge.test.ts)
   * catches missing flags before the bridge serves traffic.
   */
  mutates: boolean;
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
    mutates: false,
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
    mutates: false,
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
    mutates: false,
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
    mutates: false,
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
    name: 'recall_via_graph',
    description:
      'Graph-anchored fallback retrieval (recall booster). Use this ONLY when search_memories came back thin — empty, or with a top score below ~0.5 — meaning flat vector search did not find the answer passage. Given the query and the weak flat hits, it anchors on entities the system already knows, walks the fact graph to their neighbours, fetches the UNIT-grained evidence behind those neighbours, and re-ranks it against the query. Returns ranked fallback evidence (unit text + provenance), or empty when nothing anchors. Surfaces answers that sit one reasoning hop away from the query — the shape flat search structurally misses.',
    mutates: false,
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'The question/query text — re-embedded and used both to seed anchors and to re-rank fetched evidence.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of ranked fallback units to return (default: 5).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_memory_text',
    description:
      'Retrieve the full source text of a specific memory by ID.',
    mutates: false,
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
    mutates: false,
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
    name: 'trace_causes',
    description:
      'Walk Graph C backwards from a fact to find its root causes. Returns the causal chain from root cause through to the starting event. Use to answer "why did this fact become true?". Cycles are detected and short-circuited.',
    mutates: false,
    inputSchema: {
      type: 'object' as const,
      properties: {
        fact_id: {
          type: 'string',
          description: 'UUID of the fact whose causal history should be traced backwards',
        },
        max_depth: {
          type: 'number',
          description: 'Maximum number of causal hops to walk (default: 10)',
        },
        min_strength: {
          type: 'number',
          description: 'Minimum edge strength (0.0-1.0) to follow when walking the chain (default: 0)',
        },
      },
      required: ['fact_id'],
    },
  },
  {
    name: 'project_trajectory',
    description:
      'Walk Graph C forward from a fact to its downstream effects. Returns the causal chain from the starting event through to leaf effects. Use to answer "what does this fact lead to?". Cycles are detected and short-circuited.',
    mutates: false,
    inputSchema: {
      type: 'object' as const,
      properties: {
        fact_id: {
          type: 'string',
          description: 'UUID of the fact whose downstream trajectory should be projected',
        },
        max_depth: {
          type: 'number',
          description: 'Maximum number of causal hops to walk (default: 10)',
        },
        min_strength: {
          type: 'number',
          description: 'Minimum edge strength (0.0-1.0) to follow when walking the chain (default: 0)',
        },
      },
      required: ['fact_id'],
    },
  },
  {
    name: 'get_causal_delta',
    description:
      'Get the causal events and edges created within a time window. Use to inspect what new causal activity has been recorded in a recent interval, optionally narrowed to a single entity. Returns events plus the edges created in the same window.',
    mutates: false,
    inputSchema: {
      type: 'object' as const,
      properties: {
        from: {
          type: 'string',
          description: 'Start of the time window (ISO 8601 timestamp, inclusive). Example: "2026-05-26T00:00:00Z".',
        },
        to: {
          type: 'string',
          description: 'End of the time window (ISO 8601 timestamp, inclusive). Example: "2026-05-26T23:59:59Z".',
        },
        entity_id: {
          type: 'string',
          description: 'Optional entity UUID to narrow events to those whose subject is this entity. Edges are not filtered by entity.',
        },
      },
      required: ['from', 'to'],
    },
  },
  // --- Extraction tools ---

  {
    name: 'resolve_entity',
    description:
      'Resolve a text mention to an existing entity or create a new one. Searches by embedding similarity and name matching. Returns the resolved entity with its canonical name and ID.',
    mutates: true,
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
    mutates: true,
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
      'Get the supporting memories for a specific fact. Returns the full `sources` array (one entry per corroborating memory with observation_count and observed_at), plus the legacy single source_memory_id/source_text/sourcePreview for backwards compatibility.',
    mutates: false,
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
    mutates: false,
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
    mutates: true,
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
    mutates: true,
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
    mutates: false,
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
    name: 'search_predicates',
    description:
      'Search the canonical predicate registry for existing relationship predicates similar to a relation you are about to propose, so you REUSE an existing canonical instead of inventing a near-duplicate (e.g. find that "is employed by" should be "works_at"). Returns ranked {predicate, description, similarity}. Use during RELATE before propose_fact whenever you are unsure which predicate label to use.',
    mutates: false,
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'The relationship phrase or candidate predicate to look up (e.g. "works for", "is employed by", "lives in").',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default 8).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'update_entity_summary',
    description:
      'Update the living summary for an entity. Call this after creating facts to keep the entity profile current. The summary should describe who/what the entity is, their current state, narrative role, known aliases/references, and any unresolved ambiguities. Keep summary under 2000 characters; inputs over 3000 characters are rejected. For race safety, pass the summary_updated_at value you observed in a prior read (query_entity_facts / search_entity_aliases / get_neighbourhood_profile) as expected_summary_updated_at — if a concurrent writer has updated the row since you read it, the handler returns {updated:false, reason:"stale_write", current_summary, current_summary_updated_at} so you can refetch and decide whether to merge or skip.',
    mutates: true,
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity_id: {
          type: 'string',
          description: 'UUID of the entity to update',
        },
        summary: {
          type: 'string',
          description: 'Natural language summary. Include: current state, narrative role, known references/aliases (e.g. "referred to as the stranger, he, my friend"), temporal context, and any ambiguities (e.g. "may be the same person as..."). Keep under 2000 characters; the handler rejects inputs over 3000 characters.',
        },
        expected_summary_updated_at: {
          type: ['string', 'null'],
          description: 'Optional ISO 8601 timestamp matching the summary_updated_at value you read prior to deciding on this update. The handler matches it against the row\'s current summary_updated_at; if they differ, the write is rejected with {updated:false, reason:"stale_write"}. Pass null for first-ever writes (row has no summary_updated_at yet). Omit entirely for back-compat unconditional write (logs a race-unsafe warning).',
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
    mutates: true,
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
    mutates: true,
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
    mutates: true,
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
    mutates: false,
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

  // --- Promotion-escalation arbiter verdict tools (E5, doc 41 §8a.5) ---
  // The arbiter DECIDES via these; promotion EXECUTES (execute_merge /
  // create_same_as_link / resolve_contradiction left the agent surface). Each
  // attaches a verdict to a pre-recorded escalation dossier (arbiter_verdicts),
  // keyed by the escalation_key promotion pushed — an agent can only dispose of an
  // escalation promotion actually raised, never invent one.
  {
    name: 'propose_identity_verdict',
    description:
      'Record your verdict on an IDENTITY escalation from the dossier: are the candidate canonical entities the same? ONE decision per call. decision="merge" (they are one — promotion destructively merges the other candidates into canonical_target), "same_as" (related identities kept as separate rows, linked to canonical_target), or "distinct" (genuinely different — promotion keeps the proposed cluster as a new entity). canonical_target is REQUIRED for merge/same_as and must be one of the candidate ids. Pass escalation_key from the dossier verbatim. You decide; promotion executes.',
    mutates: true,
    inputSchema: {
      type: 'object' as const,
      properties: {
        escalation_key: {
          type: 'string',
          description: 'The escalationKey from the dossier this verdict resolves (verbatim).',
        },
        decision: {
          type: 'string',
          enum: ['merge', 'same_as', 'distinct'],
          description: 'merge (destructive unify), same_as (link, keep rows), or distinct (different entities).',
        },
        canonical_target: {
          type: 'string',
          description: 'Survivor candidate id the cluster binds to. Required for merge/same_as; omit for distinct.',
        },
        members: {
          type: 'array',
          items: { type: 'string' },
          description: 'The candidate canonical ids this verdict covers (from the dossier).',
        },
        reasoning: {
          type: 'string',
          description: 'Why — grounded in the candidates’ facts, aliases, and sources.',
        },
      },
      required: ['escalation_key', 'decision', 'reasoning'],
    },
  },
  {
    name: 'propose_conflict_resolution',
    description:
      'Record your verdict on a CONFLICT escalation from the dossier: an exclusive-group collision valid_at ordering could not break (co-equal dates, different objects). Decide which fact(s) to expire via expire=[{factId, reason}] (the losers), OR set not_exclusive=true when the facts are NOT actually mutually exclusive (promotion keeps them all). Optionally correct a wrong date via corrected_valid_at={factId: ISO8601}. Pass escalation_key from the dossier verbatim. You decide; promotion executes the expiries.',
    mutates: true,
    inputSchema: {
      type: 'object' as const,
      properties: {
        escalation_key: {
          type: 'string',
          description: 'The escalationKey from the dossier this verdict resolves (verbatim).',
        },
        expire: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              factId: { type: 'string', description: 'Fact id to expire (a staged or prior fact id from the dossier).' },
              reason: { type: 'string', description: 'Why this fact loses.' },
            },
            required: ['factId', 'reason'],
          },
          description: 'The loser facts to expire, with reasons. Empty when not_exclusive=true.',
        },
        not_exclusive: {
          type: 'boolean',
          description: 'True when the facts are not actually mutually exclusive — promotion keeps every member active.',
        },
        corrected_valid_at: {
          type: 'object',
          description: 'Optional date corrections {factId: ISO8601} applied to surviving facts.',
        },
        reasoning: {
          type: 'string',
          description: 'Why this resolution — grounded in the facts and sources.',
        },
      },
      required: ['escalation_key', 'reasoning'],
    },
  },

  // --- Gardener tools ---

  {
    name: 'get_graph_topology',
    description:
      'Pre-analyzed graph structure overview. Returns: summary stats, top 10 hub nodes, disconnected islands, isolates, orphans (mentioned but zero facts), and SPARSE LEAVES — entities with only 1-2 connections dangling off a hub. Sparse leaves look like islands visually even though they are technically connected. They are the primary targets for cross-linking. Designed for large graphs.',
    mutates: false,
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
    mutates: true,
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
    mutates: true,
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
    mutates: false,
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
    mutates: false,
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
    mutates: false,
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
      'Save a reasoning report ONCE at the very end of a reasoning pass. Aggregate findings across all phases first, then save with all entities/facts/edges deduplicated. If invocation_id is supplied (the platform threads one through your system prompt for every /api/reason call), a second call within the same pass will UPSERT the existing row rather than insert a duplicate. Duplicate inserts (when no invocation_id is supplied) fragment provenance — fact_history and causal_edge_history rows written during the pass reference whichever save row was current at the time, leaving the second row orphaned — and pollute get_reasoning_history for subsequent patrols.',
    mutates: true,
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
        invocation_id: {
          type: 'string',
          description:
            'UUID identifying this /api/reason invocation. The platform threads this into your system prompt at the start of every pass — pass it through verbatim. Server-side idempotency key: a second call with the same value overwrites the existing row rather than inserting a duplicate.',
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
    mutates: false,
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
    mutates: false,
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
    mutates: true,
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
    mutates: true,
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
    mutates: true,
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
    mutates: true,
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
    mutates: false,
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
      'Apply a resolution to an open contradiction. Dispatches into expire/invalidate (when the resolution mutates a fact) and closes the contradiction record with full reasoning. Use after reading get_fact_history / get_edge_history for the involved nodes. Reasoning must be at least 20 characters. When resolution_type is "dismissed", dismissed_reason is REQUIRED (short kebab-case tag identifying the dismissal category, e.g. "predicate-semantics-permits-multi", "aliased-predicate") — the call will reject without it.',
    mutates: true,
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
          description: 'REQUIRED when resolution_type is "dismissed" — short kebab-case categorical tag (e.g. "predicate-semantics-permits-multi", "aliased-predicate"). Distinct from resolution_reasoning (narrative): this is the tag that powers audit queries like "how many false positives by category?". The service rejects dismissed resolutions that omit this field.',
        },
      },
      required: ['contradiction_id', 'resolution_type', 'resolution_reasoning'],
    },
  },
  {
    name: 'create_contradiction',
    description:
      'Surface an agent-detected contradiction. Use this when patrol investigation reveals a conflict the four SQL heuristics could not catch: (a) chain_conflict — two reasoning chains you investigated reach opposing conclusions about the same predicate-subject; (b) opposing facts that use ALIASED predicate strings (semantically same predicate, lexically different — the SQL heuristic only matches on exact predicate equality); (c) any contradiction whose detection requires semantic understanding rather than a lookup. Inserts into the contradictions table with detected_by=reasoning_agent (or user). detection_reasoning MUST cite the specific facts/edges/chains involved and explain why the SQL heuristics could not surface this case (must be at least 20 characters). Supply at least one of fact_a_id / fact_b_id / edge_a_id / edge_b_id / entity_id. When the same (type + node-refs) tuple already has an unresolved contradiction, the existing row’s id is returned (no duplicate is created).',
    mutates: true,
    inputSchema: {
      type: 'object' as const,
      properties: {
        contradiction_type: {
          type: 'string',
          enum: ['opposing_object', 'expired_but_cited', 'cyclic_causal', 'temporal_impossible', 'chain_conflict'],
          description: 'Type of contradiction. Use "chain_conflict" for two reasoning chains reaching opposing conclusions; use "opposing_object" for aliased-predicate cases the SQL heuristic missed.',
        },
        fact_a_id: { type: 'string', description: 'UUID of an involved fact (optional; at least one of fact_a/b_id, edge_a/b_id, entity_id required).' },
        fact_b_id: { type: 'string', description: 'UUID of a second involved fact (optional).' },
        edge_a_id: { type: 'string', description: 'UUID of an involved causal edge (optional).' },
        edge_b_id: { type: 'string', description: 'UUID of a second involved causal edge (optional).' },
        entity_id: { type: 'string', description: 'UUID of the involved entity, e.g. shared subject for an aliased-predicate opposing_object (optional).' },
        detection_reasoning: {
          type: 'string',
          description: 'Why this is a contradiction. Cite specific facts/edges/chains and explain why the SQL heuristics could not catch it. Must be at least 20 characters.',
          minLength: 20,
        },
        detection_context: {
          type: 'object',
          description: 'Optional structured metadata (e.g. {"chain_a_ids": [...], "chain_b_ids": [...], "aliased_predicates": ["lives_at","resides_at"]}).',
        },
        severity: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low'],
          description: 'Severity tier. Defaults to "medium" if omitted.',
        },
      },
      required: ['contradiction_type', 'detection_reasoning'],
    },
  },

  // --- Phase 4 blast radius tool ---

  {
    name: 'analyze_blast_radius',
    description:
      'Compute the impact tree for a fact, entity, or causal_event: direct dependents, transitive causal chains (bidirectional, cycle-safe), citation dependents (via Phase 3 edge_source_refs index), and pattern impact. Each node is severity-scored (critical/high/medium/low). Use BEFORE expire_fact / invalidate_fact: pass hypothetical=expire to preview the cascade severity tally without mutating state. Critical/high severity dependents must be acknowledged in the resolution reasoning.',
    mutates: false,
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
    mutates: false,
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
    mutates: false,
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
    mutates: false,
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

  // ── Epoch v2 propose tools (doc 41 §8a.4) ────────────────────────────────
  // The extraction proposer's WRITE surface. These write to staging only;
  // canonical never changes until promotion (E3). Available to the
  // `extraction_proposer` actor (and reads to all); the allow-list keeps them
  // off legacy agents' surfaces.
  {
    name: 'resolve_anchor',
    description:
      'Resolve a mention against the epoch-start canonical entity registry. Returns the matched canonical entity if the mention is a KNOWN entity (anchor it), or matched=false if it is new (propose it). One deterministic call — replaces the search_similar_entities + search_entity_aliases dance. Match order: exact canonical name, then alias, then high-confidence semantic similarity.',
    mutates: false,
    inputSchema: {
      type: 'object' as const,
      properties: {
        mention: {
          type: 'string',
          description: 'The entity mention text to resolve (e.g. "Dr. Elena Vasquez", "Helix").',
        },
        type: {
          type: 'string',
          description: 'Optional entity type filter (e.g. "person", "organization").',
        },
      },
      required: ['mention'],
    },
  },
  {
    name: 'propose_entity',
    description:
      'Propose a candidate entity into the epoch staging buffer. Returns a server-minted, epoch-local handle to reference in propose_fact. Use for BOTH new entities (omit anchorCanonicalId) and known entities you resolved via resolve_anchor (pass its canonicalId as anchorCanonicalId). Never invent id strings — always go through this tool so promotion gets one handle→canonical map.',
    mutates: true,
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'The entity name as it appears / its canonical form.' },
        type: { type: 'string', description: 'Entity type (e.g. "person", "organization", "location").' },
        summary: { type: 'string', description: 'Optional one-line description of the entity.' },
        anchorCanonicalId: {
          type: 'string',
          description: 'When this entity matched a known canonical entity (from resolve_anchor), its canonical UUID. Omit for a new entity.',
        },
        mentionText: { type: 'string', description: 'Optional exact mention text from the source.' },
      },
      required: ['name', 'type'],
    },
  },
  {
    name: 'propose_fact',
    description:
      'Propose a candidate fact into the epoch staging buffer, using entity HANDLES (from propose_entity) — not canonical ids. Returns the exclusive group this predicate belongs to and the prior-canonical active facts in that group (the disposal preview), so VERIFY can flag supersession. Provide an explicit validAt for time-sensitive facts, or set undated=true — never omit silently. In VERIFY, when this fact supersedes a prior-canonical fact in that group, pass that prior fact id as supersedesFactId as a hint to promotion.',
    mutates: true,
    inputSchema: {
      type: 'object' as const,
      properties: {
        subjectHandle: { type: 'string', description: 'Handle of the subject entity (from propose_entity).' },
        predicate: { type: 'string', description: 'The relationship/attribute predicate (e.g. "works_at", "job_title").' },
        objectHandle: { type: 'string', description: 'Handle of the object entity, when the object is an entity. Mutually exclusive with objectValue.' },
        objectValue: { type: 'string', description: 'Literal object value, when the object is a scalar (e.g. a title, a place name). Mutually exclusive with objectHandle.' },
        validAt: { type: 'string', description: 'ISO 8601 timestamp the fact became valid. Omit and set undated=true if the source gives no date.' },
        undated: { type: 'boolean', description: 'Set true when the fact has no date in the source. Required when validAt is omitted.' },
        confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Extraction confidence 0.0-1.0.' },
        reasoning: { type: 'string', description: 'Brief justification grounded in the source text.' },
        supersedesFactId: {
          type: 'string',
          description: 'Hint to promotion: id of a prior-canonical fact in this exclusive group (from your reads or a prior propose_fact preview) that this fact supersedes. Advisory; promotion still orders by valid_at.',
        },
      },
      required: ['subjectHandle', 'predicate'],
    },
  },
  {
    name: 'propose_causal_edge',
    description:
      'Propose a causal edge between two SETTLED causal events into the causal pass staging buffer. The events were minted by promotion (stable ids) — pass their UUIDs as causeEventId / effectEventId. You do NOT write canonical: a deterministic causal-promotion step disposes proposals (ref-resolve, self-loop drop, dedup, cited-fact branch). The return previews disposal: refsResolve (whether each event id resolves) and citedFactStatus (the live status of every FACT you cite as a source reference: active | superseded | invalidated) — a superseded or invalidated cited fact is a WARNING you are grounding on a shaky fact. Every edge MUST carry non-empty reasoning and at least one source reference (doc 01 invariant).',
    mutates: true,
    inputSchema: {
      type: 'object' as const,
      properties: {
        causeEventId: { type: 'string', description: 'UUID of the settled causal event that is the cause.' },
        effectEventId: { type: 'string', description: 'UUID of the settled causal event that is the effect.' },
        reasoning: { type: 'string', description: 'Detailed justification — WHY the cause led to the effect. Must be specific and non-empty.' },
        sourceReferences: {
          type: 'array',
          description: 'Every source that informed this conclusion. At least one required.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['memory', 'fact', 'entity'], description: 'Type of source reference.' },
              id: { type: 'string', description: 'UUID of the memory, fact, or entity.' },
              relevance: { type: 'string', description: 'How this source informed the causal conclusion.' },
            },
            required: ['type', 'id', 'relevance'],
          },
        },
      },
      required: ['causeEventId', 'effectEventId', 'reasoning', 'sourceReferences'],
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
 * Bead nmemo-2yv.113: derived at module load from the per-tool `mutates`
 * field on each GRAPH_TOOLS entry. The flag is declared inline next to the
 * tool definition so adding a new tool can't silently drift this set. A
 * startup assertion in pi-agent-bridge.ts checks every tool has the flag set
 * before serving traffic — converts a forgotten-field race into a startup error.
 */
const WRITE_TOOLS = new Set<string>(
  GRAPH_TOOLS.filter((t) => t.mutates).map((t) => t.name),
);

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
  /**
   * Epoch v2 (doc 41 §8a.4): the promotion-scope + narration-order metadata the
   * propose_* tools stamp onto staging rows. INJECTED BY THE HARNESS (env or
   * explicit context), never by the agent — the proposer cannot choose its own
   * epoch or chunk position. `epochId` is the promotion partition (one promotion
   * consumes one epoch's rows); `sourceId` carries the per-source boundary
   * (§12 #2); `chunkIndex` is the undated-fact ordering fallback (§5c).
   */
  epochId?: string | null;
  sourceId?: string | null;
  chunkIndex?: number | null;
}

/**
 * Valid MCP actors.
 *
 * Exported so the pi-agent-bridge `/run` boundary can reject untrusted
 * actor strings at the HTTP edge (bead nmemo-2yv.117) — without this the
 * cast at the bridge is TypeScript-only and any string would propagate
 * into audit columns.
 *
 * Seven of these mirror migration 009's audit-actor CHECK (graph_agent,
 * reasoning_agent, gardener_agent, reconciliation_agent, user, system_trigger,
 * cascade). `extraction_proposer` (epoch v2, doc 41 §8a.4) and `causal_agent`
 * (epoch v2 E6, doc 41 §8a.6) are staging-only MCP actors — valid for tool-scoping
 * but DELIBERATELY absent from the audit CHECK: they write staging, never canonical,
 * so they must never reach an audit column.
 */
export const VALID_ACTORS = new Set<Actor>([
  'graph_agent', 'reasoning_agent', 'gardener_agent',
  'reconciliation_agent', 'user', 'system_trigger', 'cascade',
  'extraction_proposer', 'causal_agent',
]);

/**
 * Per-actor tool allow-list (doc 41 §8a.2, §9.5) — the structural enforcement
 * of each actor's read/write posture. Built from the `mutates` flag so it can
 * never silently drift from the tool definitions.
 *
 * The propose/promote split (doc 41 §1) means the extraction proposer LOSES
 * every canonical-write tool (create_fact, resolve_entity, execute_merge,
 * expire_fact, invalidate_fact, create_same_as_link, update_entity_summary, …)
 * — those become promotion/disposal code. It keeps all reads plus the two
 * staging writes. Legacy agent actors keep the FULL surface (every tool), so the
 * serial/epoch/optimistic arms are completely unaffected until E3 points the new
 * path at `extraction_proposer`. Only `extraction_proposer` is restricted — the
 * one new actor — which is why transport-parity (default actor = graph_agent)
 * still advertises the full GRAPH_TOOLS set.
 *
 * Enforced server-side (graph-mcp.ts ListTools filter + handleToolCall reject),
 * NOT via Claude Code's `--allowedTools` — that flag is a wildcard
 * (`mcp__mnemo-graph__*`, ml-services/app/core/llm.py) and resolves to whatever
 * the per-actor server advertises.
 */
const READ_ONLY_TOOL_NAMES = new Set(
  GRAPH_TOOLS.filter((t) => !t.mutates).map((t) => t.name),
);

/** The two staging-write tools an extraction proposer may call (doc 41 §8a.4). */
const PROPOSER_STAGE_WRITES = ['propose_entity', 'propose_fact'] as const;

/**
 * The extraction proposer's surface: every read tool (incl. resolve_anchor,
 * which is read-only) + the two staging writes. Everything canonical-write is
 * absent — a structural property, not a prompt instruction.
 */
const PROPOSER_SURFACE = new Set<string>([
  ...READ_ONLY_TOOL_NAMES,
  ...PROPOSER_STAGE_WRITES,
]);

/**
 * Canonical-write tools RETIRED from every agent surface in E5 (doc 41 §8a.2,
 * §8a.5): "the arbiter decides, promotion executes." `execute_merge`,
 * `create_same_as_link`, and `resolve_contradiction` are now promotion code
 * (promotion.ts calls mergeEntities / inserts same_as / expires via the planner).
 * They remain defined in GRAPH_TOOLS (handlers retired in E7) but no actor — agent
 * OR promotion — may reach them via MCP. This is acceptance criterion (2): absent
 * from EVERY agent allow-list.
 */
const RETIRED_TO_PROMOTION = new Set<string>([
  'execute_merge',
  'create_same_as_link',
  'resolve_contradiction',
]);

/**
 * Legacy surface = every tool EXCEPT the E5-retired canonical-write tools and the
 * arbiter-only verdict tools. Legacy agents keep their other writes (the
 * serial/optimistic arms are otherwise unaffected) but can no longer merge/link/
 * resolve-contradiction directly — those moved to promotion.
 */
const ARBITER_VERDICT_TOOLS = ['propose_identity_verdict', 'propose_conflict_resolution'] as const;

const LEGACY_SURFACE = new Set<string>(
  GRAPH_TOOLS.map((t) => t.name).filter(
    (n) => !RETIRED_TO_PROMOTION.has(n) && !(ARBITER_VERDICT_TOOLS as readonly string[]).includes(n),
  ),
);

/**
 * The promotion-escalation arbiter surface (reconciliation_agent recast, doc 41
 * §8a.5): every read tool to "talk to the real graph" + the two verdict tools.
 * The pushed dossier subsumes `get_reconciliation_context` (the old pull-everything
 * entry point), so it is excluded. No canonical-write tools — the arbiter proposes
 * verdicts; promotion disposes.
 */
const ARBITER_SURFACE = new Set<string>([
  ...[...READ_ONLY_TOOL_NAMES].filter((n) => n !== 'get_reconciliation_context'),
  ...ARBITER_VERDICT_TOOLS,
]);

/**
 * The causal agent's surface (E6, doc 41 §8a.6): it READS the settled canonical
 * graph broadly (every read-only tool — `get_causal_delta` scopes the pass, the
 * rest gather source_references and check cited-fact status) and PROPOSES causal
 * edges into staging via `propose_causal_edge`. It holds NO canonical causal-write
 * tool: `create_causal_edge` was removed entirely in E7 (the per-chunk CAUSE path),
 * and `expire_causal_edge` / `revise_causal_edge` remain mutating tools (so absent
 * from the read set) reachable only by legacy/reasoning actors. Canonical causal
 * writes flow through causal-promotion code — the agent proposes, causal-promotion
 * disposes. §8a.6 names the expected causal read subset; granting the full read
 * surface is structurally safe (reads never touch canonical).
 */
const CAUSAL_AGENT_STAGE_WRITES = ['propose_causal_edge'] as const;
const CAUSAL_SURFACE = new Set<string>([
  ...READ_ONLY_TOOL_NAMES,
  ...CAUSAL_AGENT_STAGE_WRITES,
]);

export const ACTOR_TOOL_ALLOWLIST: Record<Actor, ReadonlySet<string>> = {
  extraction_proposer: PROPOSER_SURFACE,
  // Post-promotion causal pass (E6): reads + propose_causal_edge only (no canonical
  // causal-write tools — those are causal-promotion code).
  causal_agent: CAUSAL_SURFACE,
  graph_agent: LEGACY_SURFACE,
  reasoning_agent: LEGACY_SURFACE,
  gardener_agent: LEGACY_SURFACE,
  // Recast as the promotion-escalation arbiter (E5): reads + verdict tools only.
  reconciliation_agent: ARBITER_SURFACE,
  // Non-agent actors never spawn an MCP server; map them defensively to the
  // legacy surface so the record is total and a stray call is not silently denied.
  user: LEGACY_SURFACE,
  system_trigger: LEGACY_SURFACE,
  cascade: LEGACY_SURFACE,
  // Deterministic promotion code (doc 41 §5) — writes canonical via the service
  // layer, never via MCP, so it never spawns a server. Mapped defensively to the
  // legacy surface to keep the record total.
  promotion: LEGACY_SURFACE,
};

/**
 * The set of tools an actor is permitted to call. Falls back to the proposer
 * surface (most restrictive that still functions) for an unknown actor rather
 * than the full surface — deny-by-default on drift.
 */
export function allowlistFor(actor: Actor): ReadonlySet<string> {
  return ACTOR_TOOL_ALLOWLIST[actor] ?? PROPOSER_SURFACE;
}

/**
 * Resolve the MCP actor from the process env (the per-actor server reads
 * MNEMO_AGENT_ACTOR at startup). Mirrors resolveContext's actor logic for the
 * transport layer (graph-mcp.ts ListTools) which has no ToolCallContext.
 */
export function resolveActorFromEnv(): Actor {
  const envActor = process.env.MNEMO_AGENT_ACTOR as Actor | undefined;
  return envActor && VALID_ACTORS.has(envActor) ? envActor : 'graph_agent';
}

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
  // Epoch v2 harness-injected context (doc 41 §8a.4). The per-actor MCP server
  // process reads these from its env (set by the invoke* wrapper, E3); the MCP
  // transport calls handleToolCall without a context, so env is the carrier.
  const chunkIndexRaw = process.env.MNEMO_CHUNK_INDEX;
  const chunkIndex =
    chunkIndexRaw != null && chunkIndexRaw !== '' ? Number(chunkIndexRaw) : null;
  return {
    agent,
    reasoningReportId,
    epochId: process.env.MNEMO_EPOCH_ID || null,
    sourceId: process.env.MNEMO_SOURCE_ID || null,
    chunkIndex: Number.isFinite(chunkIndex) ? chunkIndex : null,
  };
}

export async function handleToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  context?: ToolCallContext,
): Promise<string> {
  toolCallCount++;
  const resolved = resolveContext(context);

  // Per-actor tool allow-list (doc 41 §8a.2, §9.5). Structural enforcement of
  // read/write posture: an off-list call fails here regardless of transport
  // (MCP or Pi bridge) and regardless of what --allowedTools the client sent.
  // This is what makes "the extraction proposer cannot write canonical" a
  // property of the tool set, not the prompt. Unknown tools fall through to the
  // dispatcher's own "Unknown tool" error.
  if (
    GRAPH_TOOLS.some((t) => t.name === toolName) &&
    !allowlistFor(resolved.agent).has(toolName)
  ) {
    throw new Error(
      `Tool "${toolName}" is not permitted for actor "${resolved.agent}". ` +
        `Permitted: ${[...allowlistFor(resolved.agent)].sort().join(', ')}.`,
    );
  }

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
        .select({ summary: entityMeta.summary, summaryUpdatedAt: entityMeta.summaryUpdatedAt })
        .from(entityMeta)
        .where(eq(entityMeta.entityId, entityId))
        .limit(1);
      const summary = metaRows[0]?.summary ?? null;
      // nmemo-2yv.55 — surface summary_updated_at so the agent can thread it
      // back through expected_summary_updated_at on a subsequent
      // update_entity_summary call (optimistic locking).
      const summaryUpdatedAt = metaRows[0]?.summaryUpdatedAt
        ? metaRows[0]!.summaryUpdatedAt!.toISOString()
        : null;
      const aliases = await db
        .select({ alias: entityAliases.alias, aliasType: entityAliases.aliasType })
        .from(entityAliases)
        .where(eq(entityAliases.entityId, entityId));
      // nmemo-2yv.62 — entity_meta.summary is agent-written and read back
      // into the next-turn prompt via this tool result. Wrap in a
      // delimited block so the agent treats it as data.
      return JSON.stringify({
        summary: delimitForPrompt(summary, { kind: 'summary', attrs: { entity_id: entityId } }),
        summary_updated_at: summaryUpdatedAt,
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
      // nmemo-1cp: memories-query embed uses the nomic `search_query: ` prefix
      // (stored passages use `search_document: ` at store() time). This is the
      // memories retrieval path; entity search (search_similar_entities above)
      // stays on ml.embed() raw — that similarity is symmetric.
      const embedResult = await ml.embedQuery(toolInput.query as string);
      // nmemo-yxj.3: unit-grained read path. store() (yxj.2) writes small
      // overlapping unit satellites (point_type=unit) carrying the undiluted
      // vectors alongside the diluted whole-window vector. searchMemoriesByUnit
      // ranks on the units (better needle recall), dedups hits by
      // parent_window_id, and returns the PARENT window content — never the raw
      // unit fragment, and a parent surfaces once even if several of its units
      // match. Pre-yxj.2 window-only data is handled by the function's fallback.
      const memories = await searchMemoriesByUnit(embedResult.vector, {
        limit: (toolInput.limit as number) ?? 5,
      });
      return JSON.stringify(memories.map((m) => ({
        id: m.id,
        score: m.score,
        content: m.payload?.content,
        metadata: m.payload?.metadata,
        createdAt: m.payload?.created_at,
      })));
    }

    case 'recall_via_graph': {
      // bead nmemo-0wq.3 — graph-anchored fallback retrieval (doc 38 §4/§5/§6.2.2).
      // The agent reaches for this when its own search_memories came back thin.
      // We re-run the flat search to (a) get the query embedding to re-rank with
      // and (b) compute the same FlatHit scores the trigger reads (§6.1) — so the
      // tool is self-contained: it decides failure, seeds anchors from the weak
      // flat hits + a query-side entity match (§4.1), expands, and re-ranks.
      const query = toolInput.query as string;
      const embedResult = await ml.embedQuery(query);
      const flat = await searchMemoriesByUnit(embedResult.vector, { limit: 5 });
      const flatHits: FlatHit[] = flat.map((m) => ({ id: m.id, score: m.score }));
      // Query-side entity seed (§4.1.2): search_similar_entities over the query.
      const seedEntities = await findSimilarEntities(
        (await ml.embed(query)).vector,
        { threshold: 0.5, limit: MAX_QUERY_SEED_ENTITIES },
      );
      const ranked = await recallViaGraph(embedResult.vector, flatHits, {
        seedEntityIds: seedEntities.map((e) => e.id),
        limit: (toolInput.limit as number) ?? 5,
      });
      return JSON.stringify({
        triggered: flatRetrievalFailed(flatHits),
        anchored: ranked.length > 0,
        units: ranked.map((r) => ({
          unitText: r.unitText,
          parentWindowId: r.parentWindowId,
          factId: r.factId,
          predicate: r.predicate,
          neighbourEntityId: r.neighbourEntityId,
          hop: r.hop,
          rerankScore: r.rerankScore,
          windowFallback: r.windowFallback,
          source: 'graph_fallback',
        })),
      });
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

    case 'trace_causes': {
      const chain = await traceCauses(toolInput.fact_id as string, {
        maxDepth: toolInput.max_depth as number | undefined,
        minStrength: toolInput.min_strength as number | undefined,
      });
      return JSON.stringify({
        chain: chain.map(node => ({
          event: {
            id: node.event.id,
            factId: node.event.factId,
            transitionType: node.event.transitionType,
            subjectEntityId: node.event.subjectEntityId,
            predicate: node.event.predicate,
            deltaConfidence: node.event.deltaConfidence,
            occurredAt: node.event.occurredAt,
            sourceText: node.event.sourceText,
          },
          edge: node.edge ? {
            id: node.edge.id,
            causeEventId: node.edge.causeEventId,
            effectEventId: node.edge.effectEventId,
            strength: node.edge.strength,
            reasoning: node.edge.reasoning,
            sourceReferences: node.edge.sourceReferences,
            extractionMethod: node.edge.extractionMethod,
          } : null,
        })),
      });
    }

    case 'project_trajectory': {
      const chain = await projectTrajectory(toolInput.fact_id as string, {
        maxDepth: toolInput.max_depth as number | undefined,
        minStrength: toolInput.min_strength as number | undefined,
      });
      return JSON.stringify({
        chain: chain.map(node => ({
          event: {
            id: node.event.id,
            factId: node.event.factId,
            transitionType: node.event.transitionType,
            subjectEntityId: node.event.subjectEntityId,
            predicate: node.event.predicate,
            deltaConfidence: node.event.deltaConfidence,
            occurredAt: node.event.occurredAt,
            sourceText: node.event.sourceText,
          },
          edge: node.edge ? {
            id: node.edge.id,
            causeEventId: node.edge.causeEventId,
            effectEventId: node.edge.effectEventId,
            strength: node.edge.strength,
            reasoning: node.edge.reasoning,
            sourceReferences: node.edge.sourceReferences,
            extractionMethod: node.edge.extractionMethod,
          } : null,
        })),
      });
    }

    case 'get_causal_delta': {
      const delta = await getCausalDelta(
        new Date(toolInput.from as string),
        new Date(toolInput.to as string),
        { entityId: toolInput.entity_id as string | undefined },
      );
      return JSON.stringify({
        events: delta.events.map(e => ({
          id: e.id,
          factId: e.factId,
          transitionType: e.transitionType,
          subjectEntityId: e.subjectEntityId,
          predicate: e.predicate,
          deltaConfidence: e.deltaConfidence,
          occurredAt: e.occurredAt,
          sourceText: e.sourceText,
        })),
        edges: delta.edges.map(e => ({
          id: e.id,
          causeEventId: e.causeEventId,
          effectEventId: e.effectEventId,
          strength: e.strength,
          reasoning: e.reasoning,
          sourceReferences: e.sourceReferences,
          extractionMethod: e.extractionMethod,
        })),
      });
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

      // Bead nmemo-2yv.32 — return the full fact_sources array alongside
      // the legacy singleton fields. Callers can adopt `sources` (the
      // authoritative one-to-many supporting-memory set) gradually before
      // the singleton facts.source_memory_id / facts.source_text columns
      // are dropped in a follow-up bead.
      const sources = await getFactSources(fact.id);

      return JSON.stringify({
        factId: fact.id,
        predicate: fact.predicate,
        subjectEntityId: fact.subjectEntityId,
        objectEntityId: fact.objectEntityId,
        objectValue: fact.objectValue,
        sourceText: fact.sourceText,
        sourceMemoryId: fact.sourceMemoryId,
        sourcePreview,
        sources: sources.map((s) => ({
          memoryId: s.memoryId,
          sourceText: s.sourceText,
          observedConfidence: s.observedConfidence,
          observedAt: s.observedAt,
          observationCount: s.observationCount,
        })),
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

    case 'search_predicates': {
      const query = toolInput.query as string;
      const limit = typeof toolInput.limit === 'number' ? toolInput.limit : 8;
      const matches = await searchPredicates(query, limit);
      return JSON.stringify({ predicates: matches });
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
      // nmemo-2yv.55 — also surface summary_updated_at so the agent can
      // thread it back through expected_summary_updated_at on a subsequent
      // update_entity_summary call.
      const summaryUpdatedAts: Record<string, string | null> = {};
      if (entityIds.length > 0) {
        const metaRows = await db
          .select({
            entityId: entityMeta.entityId,
            summary: entityMeta.summary,
            summaryUpdatedAt: entityMeta.summaryUpdatedAt,
          })
          .from(entityMeta)
          .where(inArray(entityMeta.entityId, entityIds));
        for (const row of metaRows) {
          summaries[row.entityId] = row.summary ?? null;
          summaryUpdatedAts[row.entityId] = row.summaryUpdatedAt
            ? row.summaryUpdatedAt.toISOString()
            : null;
        }
      }

      // nmemo-2yv.62 — wrap each persisted summary in a delimited block.
      return JSON.stringify(matches.map(m => ({
        entityId: m.entityId,
        canonicalName: m.canonicalName,
        entityType: m.entityType,
        matchedAlias: m.alias,
        aliasType: m.aliasType,
        summary: delimitForPrompt(summaries[m.entityId] ?? null, {
          kind: 'summary',
          attrs: { entity_id: m.entityId },
        }),
        summary_updated_at: summaryUpdatedAts[m.entityId] ?? null,
      })));
    }

    case 'update_entity_summary': {
      // nmemo-2yv.53 — write-side T8 hardening. Reject oversize inputs with a
      // structured error (so the agent sees the failure) and normalise
      // whitespace + control chars before persisting. Read-back wrapping is
      // applied at every read site via delimitForPrompt (see .62).
      const entityId = toolInput.entity_id as string;
      const rawSummary = toolInput.summary as string;
      if (typeof rawSummary === 'string' && rawSummary.length > 3000) {
        return JSON.stringify({
          error: 'summary exceeds 3000 character limit',
          length: rawSummary.length,
          limit: 3000,
        });
      }
      // Sanitise: CRLF/CR → LF, strip C0 controls except \n/\t, collapse 3+
      // newlines to 2, trim. capAndSanitize returns '' for null/undefined.
      const summary = capAndSanitize(rawSummary, { kind: 'summary' });
      const updatedAt = new Date();

      // nmemo-2yv.55 — optimistic locking via summary_updated_at precondition.
      // The agent reads summary (and its summary_updated_at) via
      // query_entity_facts / search_entity_aliases / get_neighbourhood_profile,
      // thinks, then writes. Without a precondition, two concurrent writers
      // both succeed and the later commit silently overwrites the earlier
      // one's content. We accept an optional expected_summary_updated_at and
      // match it against the row's current summary_updated_at as part of an
      // atomic conditional UPDATE; if they differ, no row is touched and we
      // return a structured stale_write response so the caller can refetch
      // and decide whether to merge or skip.
      //
      // The matching predicate is part of the UPDATE's WHERE clause (not a
      // separate SELECT-then-UPDATE) so two racers with the same expected
      // ts cannot both succeed — Postgres serialises the row writes and
      // only one matches `summary_updated_at = $expected` after the other
      // commits.
      //
      // Critical implementation note: drizzle's pg timestamp column drops
      // sub-second precision when serialising JS Date values, so two writes
      // within the same wall-clock second would otherwise produce equal
      // post-write timestamps and the precondition would fail to
      // distinguish them. We work around this by running the UPDATE in raw
      // SQL and computing the new summary_updated_at server-side as
      // `GREATEST(clock_timestamp(), summary_updated_at + interval '1
      // microsecond')` — strictly monotonic per row, sub-second precise.
      //
      // Back-compat: if expected_summary_updated_at is omitted entirely
      // (undefined), fall through to an unconditional UPSERT and log a
      // race-unsafe warning. After a stabilisation period a follow-up bead
      // will tighten this to required.
      //
      // First-ever write: a row may not exist yet (INSERT path) or may exist
      // with summary_updated_at IS NULL (legacy rows pre-.52). Both are
      // treated as the "no prior summary" case and accept any value of
      // expected_summary_updated_at (including null) — the precondition
      // only fires when the row already has a real prior timestamp.
      const hasExpected = 'expected_summary_updated_at' in toolInput;
      const expectedRaw = toolInput.expected_summary_updated_at as string | null | undefined;

      if (!hasExpected) {
        console.warn(
          `[update_entity_summary] called without expected_summary_updated_at — race-unsafe (entity_id=${entityId}). See bead nmemo-2yv.55.`,
        );
      }

      // nmemo-2yv.52 — set summary_updated_at alongside updated_at so the viz
      // panel's freshness indicator and any future staleness consumer see the
      // summary-specific timestamp (see doc 37 §8). entity_meta.updated_at is
      // multi-writer; summary_updated_at moves only when summary moves.

      if (!hasExpected) {
        // Back-compat: unconditional UPSERT. The warning above flags this
        // to operators; the contract is unchanged from the pre-.55 behaviour.
        await db
          .insert(entityMeta)
          .values({ entityId, summary, summaryUpdatedAt: updatedAt, updatedAt })
          .onConflictDoUpdate({
            target: entityMeta.entityId,
            set: { summary, summaryUpdatedAt: updatedAt, updatedAt },
          });
        return JSON.stringify({ updated: true });
      }

      // Race-safe path. Raw SQL conditional UPDATE: precondition + new
      // timestamp computation both happen server-side in one atomic
      // statement. ::timestamptz cast on the expected param so the
      // comparison works whether the caller sent ISO with or without ms.
      // The new summary_updated_at is GREATEST(clock_timestamp(), old + 1µs)
      // so it is strictly greater than the previous value for this row —
      // which is what makes the precondition self-distinguishing under
      // sub-second contention.
      const expectedSql = expectedRaw === null || expectedRaw === undefined ? null : expectedRaw;
      // The precondition: row's summary_updated_at must equal the caller's
      // expected value, OR both must be NULL (first-write case). Encoded
      // as: (expected IS NULL AND col IS NULL) OR col = expected. The
      // ::timestamptz cast lets PostgreSQL parse the ISO string with
      // whatever precision was sent (drizzle truncates Date → second on
      // write, but a caller may also pass through the raw read-side
      // value unchanged).
      const updateRes = await db.execute(
        sql`
          UPDATE public.entity_meta
             SET summary = ${summary},
                 summary_updated_at = GREATEST(
                   clock_timestamp(),
                   summary_updated_at + interval '1 microsecond'
                 ),
                 updated_at = clock_timestamp()
           WHERE entity_id = ${entityId}::uuid
             AND (
                  (${expectedSql}::timestamptz IS NULL AND summary_updated_at IS NULL)
               OR summary_updated_at = ${expectedSql}::timestamptz
             )
           RETURNING entity_id
        `,
      );
      // db.execute returns the underlying postgres-js result; rows live on
      // the array itself.
      const updatedRows = updateRes as unknown as Array<{ entity_id: string }>;

      if (updatedRows.length === 1) {
        return JSON.stringify({ updated: true });
      }

      // No row matched the precondition. Helper: refetch the row and
      // format the stale_write response. Used by all three lost-race
      // branches below.
      const staleWriteResponse = async (): Promise<string> => {
        const rows = await db
          .select({
            summary: entityMeta.summary,
            summaryUpdatedAt: entityMeta.summaryUpdatedAt,
          })
          .from(entityMeta)
          .where(eq(entityMeta.entityId, entityId))
          .limit(1);
        const r = rows[0];
        return JSON.stringify({
          updated: false,
          reason: 'stale_write',
          current_summary: r?.summary ?? null,
          current_summary_updated_at: r?.summaryUpdatedAt
            ? r.summaryUpdatedAt.toISOString()
            : null,
        });
      };

      // No row matched. Could be (i) row absent entirely → first-write path,
      // or (ii) row present with mismatched / non-NULL summary_updated_at →
      // stale_write. Fetch the current row to decide which.
      const currentRows = await db
        .select({ summaryUpdatedAt: entityMeta.summaryUpdatedAt })
        .from(entityMeta)
        .where(eq(entityMeta.entityId, entityId))
        .limit(1);
      const current = currentRows[0];

      if (!current) {
        // Row absent — first-ever write. Insert; if a concurrent insert
        // beat us to it, ON CONFLICT DO NOTHING leaves us with no
        // returned row, and we report stale_write so the caller refetches.
        const inserted = await db
          .insert(entityMeta)
          .values({ entityId, summary, summaryUpdatedAt: updatedAt, updatedAt })
          .onConflictDoNothing({ target: entityMeta.entityId })
          .returning({ entityId: entityMeta.entityId });
        if (inserted.length === 1) {
          return JSON.stringify({ updated: true });
        }
        return staleWriteResponse();
      }

      if (current.summaryUpdatedAt === null) {
        // Legacy row (summary_updated_at IS NULL). Accept any expected
        // value. Conditional UPDATE only fires while summary_updated_at
        // is still NULL — so a concurrent first-writer races to claim it.
        const legacyRes = await db.execute(
          sql`
            UPDATE public.entity_meta
               SET summary = ${summary},
                   summary_updated_at = clock_timestamp(),
                   updated_at = clock_timestamp()
             WHERE entity_id = ${entityId}::uuid
               AND summary_updated_at IS NULL
             RETURNING entity_id
          `,
        );
        const legacy = legacyRes as unknown as Array<{ entity_id: string }>;
        if (legacy.length === 1) {
          return JSON.stringify({ updated: true });
        }
        return staleWriteResponse();
      }

      // Row present with a real summary_updated_at that didn't match expected.
      return staleWriteResponse();
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

      // Bead nmemo-2yv.66: createdBy comes from the dispatcher's resolved
      // ToolCallContext (gardener_agent vs reconciliation_agent) — never the
      // hardcoded literal. Attribution drives audit + future training-label
      // disambiguation (doc 27 §2.2).
      const inserted = await db
        .insert(sameAsLinks)
        .values({
          entityAId: aId,
          entityBId: bId,
          reasoning: toolInput.reasoning as string,
          sourceEvidence: refs,
          confidence: toolInput.confidence as number,
          createdBy: context.agent,
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
        // Bead nmemo-2yv.30 — audited TS replacement for the PL/pgSQL
        // entity-merge function (dropped in mig 026). Every fact re-point
        // and duplicate-expiry now emits a fact_history row with
        // event_type='merged' inside a single transaction.
        // Bead nmemo-2yv.66: method + actor + resolved_by come from the
        // dispatcher's resolved ToolCallContext so audit rows attribute the
        // actual caller (gardener_agent vs reconciliation_agent), not a
        // hardcoded literal.
        const { survivorId } = await mergeEntities({
          sourceId,
          targetId,
          reason: mergeReason,
          method: context.agent,
          actor: context.agent,
        });

        // If a candidate ID was provided, resolve it
        if (toolInput.merge_candidate_id) {
          await db.execute(sql`
            UPDATE public.merge_candidates
            SET status = 'resolved', resolution = 'merge',
                resolution_reasoning = ${mergeReason},
                resolved_at = NOW(), resolved_by = ${context.agent}
            WHERE id = ${toolInput.merge_candidate_id as string}::uuid
          `);
        }

        // Bead nmemo-2yv.84 — successful merge invalidates topology + clustering
        // (the merge re-points facts/edges and merges clusters). Fire both
        // computes fire-and-forget; the lazy-imported helper has its own
        // try/catch and never throws out. We do not block the tool return
        // on the compute completing — the next viz refresh shows fresh data.
        void (async () => {
          try {
            const { triggerTopologyAndClusteringAfterMerge } = await import('./derived-freshness.js');
            await triggerTopologyAndClusteringAfterMerge(`merge:${sourceId}->${targetId}`);
          } catch (err) {
            console.warn('[execute_merge] post-merge auto-trigger failed:', err instanceof Error ? err.message : err);
          }
        })();

        return JSON.stringify({ merged: true, survivorId });
      } catch (err) {
        return JSON.stringify({ merged: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    case 'resolve_candidate': {
      // Bead nmemo-2yv.66: resolved_by comes from the dispatcher's resolved
      // ToolCallContext so non-merge resolutions (reject/defer) attribute the
      // actual caller rather than always 'reconciliation_agent'.
      await db.execute(sql`
        UPDATE public.merge_candidates
        SET status = 'resolved',
            resolution = ${toolInput.resolution as string},
            resolution_reasoning = ${toolInput.reasoning as string},
            resolved_at = NOW(),
            resolved_by = ${context.agent}
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

      // nmemo-2yv.62 — wrap agent-writable read-back fields (entity_meta.summary
      // via a_summary/b_summary; extraction_reports.report_text via reportText)
      // in delimited blocks. The agent's system prompt treats their contents
      // as data, not instructions.
      return JSON.stringify({
        candidates: candidates.map(c => ({
          ...c,
          a_summary: delimitForPrompt(c.a_summary as string | null, {
            kind: 'summary',
            attrs: { entity_id: c.entity_a_id as string },
          }),
          b_summary: delimitForPrompt(c.b_summary as string | null, {
            kind: 'summary',
            attrs: { entity_id: c.entity_b_id as string },
          }),
          a_aliases: aliasMap[c.entity_a_id as string] ?? [],
          b_aliases: aliasMap[c.entity_b_id as string] ?? [],
        })),
        reports: reports.map(r => ({
          id: r.id,
          memoryId: r.memoryId,
          createdAt: r.createdAt,
          reportText: delimitForPrompt(r.reportText, {
            kind: 'report',
            attrs: { id: r.id, memory_id: r.memoryId },
          }),
        })),
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
      // Bead nmemo-2yv.102 — service-side blast-radius preflight at the
      // policy boundary. Warn-only on critical>0; never blocks the mutation.
      const factId = toolInput.fact_id as string;
      const preflight = await preflightBlastRadius({ nodeType: 'fact', nodeId: factId });
      if (preflight) {
        maybeWarnBlastRadius({
          severity: preflight.severity,
          totalAffected: preflight.totalAffected,
          actor: context.agent,
          rootType: 'fact',
          rootId: factId,
        });
      }
      await expireFact({
        factId,
        reasoning: toolInput.reason as string,
        actor: context.agent,
        reasoningReportId: context.reasoningReportId ?? null,
        preExpireBlastRadius: preflight?.severity ?? null,
      });
      return JSON.stringify({ expired: true });
    }

    case 'invalidate_fact': {
      // Bead nmemo-2yv.102 — preflight with hypothetical='expire' (the only
      // mode impact.ts currently supports; invalidate-specific hypothetical
      // was removed in Review #11).
      const factId = toolInput.fact_id as string;
      const preflight = await preflightBlastRadius({ nodeType: 'fact', nodeId: factId });
      if (preflight) {
        maybeWarnBlastRadius({
          severity: preflight.severity,
          totalAffected: preflight.totalAffected,
          actor: context.agent,
          rootType: 'fact',
          rootId: factId,
        });
      }
      await invalidateFact({
        factId,
        invalidAt: toolInput.invalid_at ? new Date(toolInput.invalid_at as string) : undefined,
        reasoning: (toolInput.reason as string | undefined)
          ?? `Fact marked no longer true in reality by ${context.agent}`,
        actor: context.agent,
        reasoningReportId: context.reasoningReportId ?? null,
        preExpireBlastRadius: preflight?.severity ?? null,
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

      // nmemo-2yv.62 — wrap persisted summary in a delimited block.
      // nmemo-2yv.55 — surface summary_updated_at so the agent can thread it
      // back through expected_summary_updated_at on update_entity_summary.
      return JSON.stringify({
        entity: entity ? { id: entity.id, canonicalName: entity.canonicalName, entityType: entity.entityType } : null,
        summary: delimitForPrompt(meta?.summary ?? null, {
          kind: 'summary',
          attrs: { entity_id: entityId },
        }),
        summary_updated_at: meta?.summaryUpdatedAt ? meta.summaryUpdatedAt.toISOString() : null,
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

      // nmemo-2yv.62 Review #8 — reasoning_reports has two T8-exposed fields:
      //   .question — user-controlled via POST /api/reason/query body
      //   .report   — reasoning_agent-written markdown
      // Both flow back into the reasoning agent's prompt via this tool result;
      // wrap each in its own delimited block.
      return JSON.stringify(reports.map(r => ({
        id: r.id,
        mode: r.mode,
        question: delimitForPrompt(r.question, {
          kind: 'prior_question',
          attrs: { report_id: r.id },
        }),
        report: delimitForPrompt(r.report, {
          kind: 'reasoning_report',
          attrs: { report_id: r.id, mode: r.mode },
        }),
        actionsTaken: r.actionsTaken,
        createdAt: r.createdAt,
      })));
    }

    case 'save_reasoning_report': {
      const entityIds = (toolInput.entity_ids as string[]) ?? [];
      const factIds = (toolInput.fact_ids as string[]) ?? [];
      const causalEdgeIds = (toolInput.causal_edge_ids as string[]) ?? [];
      // Bead nmemo-2yv.77 — server-side idempotency. When the platform
      // supplies an invocation_id (one UUID per /api/reason call, threaded
      // through invokeReasoningAgent → ml-services → the agent's system
      // prompt), a second save call inside the same pass UPSERTs the
      // existing row instead of inserting a duplicate. Legacy callers (older
      // python clients, ad-hoc fixtures, direct handleToolCall consumers)
      // omit the field and keep the unconditional INSERT path.
      const invocationId = (toolInput.invocation_id as string | undefined) ?? null;
      const mode = toolInput.mode as string;
      const question = (toolInput.question as string | undefined) ?? null;
      const report = toolInput.report as string;
      const actionsTaken = (toolInput.actions_taken ?? {}) as object;

      let result: Array<{ id: string }>;
      if (invocationId) {
        // Raw SQL: drizzle 0.29 doesn't expose ON CONFLICT inference against
        // a partial unique index (the `WHERE invocation_id IS NOT NULL`
        // clause from migration 034 is needed in the conflict target to
        // disambiguate the arbiter index). Postgres requires the predicate
        // to match the index's WHERE clause exactly — see error 42P10.
        // UUID[] arrays use the Postgres literal `{uuid,uuid,...}` form (the
        // canonical pattern in this codebase — see causal-patterns.ts:639).
        // Empty arrays serialise to `{}` which is legal Postgres array
        // syntax, whereas `${[]}` flattens to nothing in drizzle's `sql`
        // template and produces a syntax error.
        const entityIdsLiteral = `{${entityIds.join(',')}}`;
        const factIdsLiteral = `{${factIds.join(',')}}`;
        const causalEdgeIdsLiteral = `{${causalEdgeIds.join(',')}}`;
        result = (await db.execute(sql`
          INSERT INTO public.reasoning_reports
            (mode, question, report, entity_ids, fact_ids, causal_edge_ids, actions_taken, invocation_id)
          VALUES (
            ${mode},
            ${question},
            ${report},
            ${entityIdsLiteral}::uuid[],
            ${factIdsLiteral}::uuid[],
            ${causalEdgeIdsLiteral}::uuid[],
            ${actionsTaken}::jsonb,
            ${invocationId}::uuid
          )
          ON CONFLICT (invocation_id) WHERE invocation_id IS NOT NULL
          DO UPDATE SET
            mode = EXCLUDED.mode,
            question = EXCLUDED.question,
            report = EXCLUDED.report,
            entity_ids = EXCLUDED.entity_ids,
            fact_ids = EXCLUDED.fact_ids,
            causal_edge_ids = EXCLUDED.causal_edge_ids,
            actions_taken = EXCLUDED.actions_taken
          RETURNING id
        `)) as unknown as Array<{ id: string }>;
      } else {
        result = await db
          .insert(reasoningReports)
          .values({
            mode,
            question: question ?? undefined,
            report,
            entityIds, factIds, causalEdgeIds,
            actionsTaken,
          })
          .returning({ id: reasoningReports.id });
      }

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
      // Bead nmemo-2yv.102 — root the preflight at the edge's cause_event:
      // "expiring an edge says 'this causal claim is wrong' and the cause is
      // the most natural anchor". The `expired_at IS NULL` filter matches
      // expireCausalEdge's own no-op guard (causal.ts) — an already-expired
      // edge yields no row, no preflight, no spurious critical-warn. A
      // missing cause_event_id (shouldn't happen — column is NOT NULL — but
      // defensive) yields no preflight.
      const edgeId = toolInput.edge_id as string;
      const edgeRows = await db.execute(sql`
        SELECT cause_event_id::text AS "causeEventId"
        FROM public.causal_edges
        WHERE id = ${edgeId}::uuid AND expired_at IS NULL
        LIMIT 1
      `) as unknown as Array<{ causeEventId: string | null }>;
      const causeEventId = edgeRows[0]?.causeEventId;
      const preflight = causeEventId
        ? await preflightBlastRadius({ nodeType: 'causal_event', nodeId: causeEventId })
        : null;
      if (preflight) {
        maybeWarnBlastRadius({
          severity: preflight.severity,
          totalAffected: preflight.totalAffected,
          actor: context.agent,
          rootType: 'causal_edge',
          rootId: edgeId,
        });
      }
      await expireCausalEdge({
        edgeId,
        reasoning: toolInput.reasoning as string,
        actor: context.agent,
        reasoningReportId: context.reasoningReportId ?? null,
        preExpireBlastRadius: preflight?.severity ?? null,
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

    case 'create_contradiction': {
      // detected_by mirrors the call context's agent — reasoning_agent during
      // patrol, user when invoked via support tooling. Any other actor (e.g.
      // graph_agent / gardener_agent) is rejected here: the contradictions
      // table's valid_detected_by CHECK only permits sql_heuristic /
      // reasoning_agent / user, and surfacing the rejection at the dispatcher
      // gives a clearer error than the DB constraint violation.
      if (context.agent !== 'reasoning_agent' && context.agent !== 'user') {
        throw new Error(
          `create_contradiction: actor ${context.agent} not permitted; use reasoning_agent or user`,
        );
      }
      const detectedBy: AgentDetector = context.agent;
      const result = await createContradiction({
        contradictionType: toolInput.contradiction_type as ContradictionType,
        factAId: toolInput.fact_a_id as string | undefined,
        factBId: toolInput.fact_b_id as string | undefined,
        edgeAId: toolInput.edge_a_id as string | undefined,
        edgeBId: toolInput.edge_b_id as string | undefined,
        entityId: toolInput.entity_id as string | undefined,
        detectedBy,
        detectionReasoning: toolInput.detection_reasoning as string,
        detectionContext: toolInput.detection_context as Record<string, unknown> | undefined,
        severity: toolInput.severity as ContradictionSeverity | undefined,
      });
      return JSON.stringify({ created: true, id: result.id });
    }

    case 'analyze_blast_radius': {
      const report = await analyzeImpact({
        nodeType: toolInput.node_type as ImpactRootNodeType,
        nodeId: toolInput.node_id as string,
        maxDepth: toolInput.max_depth as number | undefined,
        hypothetical: toolInput.hypothetical as HypotheticalAction | undefined,
        actor: context.agent,
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

    // ── Epoch v2 propose tools (doc 41 §8a.4) ──────────────────────────────
    case 'resolve_anchor': {
      const mention = ((toolInput.mention as string) ?? '').trim();
      const typeFilter = toolInput.type as string | undefined;
      if (!mention) return JSON.stringify({ matched: false });

      const aliasesFor = async (entityId: string): Promise<string[]> => {
        const rows = await db
          .select({ alias: entityAliases.alias })
          .from(entityAliases)
          .where(eq(entityAliases.entityId, entityId));
        return rows.map((r) => r.alias);
      };

      // 1. Exact canonical-name match (ilike with no wildcard = case-insensitive equality).
      const nameConds = [ilike(entitiesTable.canonicalName, mention)];
      if (typeFilter) nameConds.push(eq(entitiesTable.entityType, typeFilter));
      const exact = await db
        .select({ id: entitiesTable.id, name: entitiesTable.canonicalName, type: entitiesTable.entityType })
        .from(entitiesTable)
        .where(and(...nameConds))
        .limit(1);
      if (exact[0]) {
        return JSON.stringify({
          matched: true,
          canonicalId: exact[0].id,
          name: exact[0].name,
          type: exact[0].type,
          aliases: await aliasesFor(exact[0].id),
          confidence: 1.0,
        });
      }

      // 2. Alias match.
      const aliasHit = await db
        .select({ entityId: entityAliases.entityId })
        .from(entityAliases)
        .where(ilike(entityAliases.alias, mention))
        .limit(1);
      if (aliasHit[0]) {
        const ent = await db
          .select({ id: entitiesTable.id, name: entitiesTable.canonicalName, type: entitiesTable.entityType })
          .from(entitiesTable)
          .where(eq(entitiesTable.id, aliasHit[0].entityId))
          .limit(1);
        if (ent[0] && (!typeFilter || ent[0].type === typeFilter)) {
          return JSON.stringify({
            matched: true,
            canonicalId: ent[0].id,
            name: ent[0].name,
            type: ent[0].type,
            aliases: await aliasesFor(ent[0].id),
            confidence: 0.95,
          });
        }
      }

      // 3. High-confidence semantic-similarity fallback. Degrades to matched:false
      // if ML is unavailable — resolve_anchor stays usable on name/alias alone.
      try {
        const embedResult = await ml.embed(mention);
        const similar = await findSimilarEntities(embedResult.vector, {
          threshold: 0.85,
          limit: 1,
          type: typeFilter,
        });
        if (similar[0]) {
          return JSON.stringify({
            matched: true,
            canonicalId: similar[0].id,
            name: similar[0].canonicalName,
            type: similar[0].entityType,
            aliases: await aliasesFor(similar[0].id),
            confidence: similar[0].similarity,
          });
        }
      } catch (err) {
        console.error(`[resolve_anchor] semantic fallback skipped: ${err}`);
      }

      return JSON.stringify({ matched: false });
    }

    case 'propose_entity': {
      if (!context.epochId) {
        throw new Error('propose_entity requires an epoch context (MNEMO_EPOCH_ID) — injected by the harness.');
      }
      const inserted = await db
        .insert(stagingProposedEntities)
        .values({
          epochId: context.epochId,
          sourceId: context.sourceId ?? null,
          name: toolInput.name as string,
          entityType: toolInput.type as string,
          summary: (toolInput.summary as string) ?? null,
          anchorCanonicalId: (toolInput.anchorCanonicalId as string) ?? null,
          mentionText: (toolInput.mentionText as string) ?? null,
          proposedBy: context.agent,
        })
        .returning({ handle: stagingProposedEntities.handle });
      return JSON.stringify({ handle: inserted[0]!.handle });
    }

    case 'propose_fact': {
      if (!context.epochId) {
        throw new Error('propose_fact requires an epoch context (MNEMO_EPOCH_ID) — injected by the harness.');
      }
      const subjectHandle = toolInput.subjectHandle as string;
      const predicate = toolInput.predicate as string;
      const objectHandle = (toolInput.objectHandle as string) ?? null;
      const objectValue = (toolInput.objectValue as string) ?? null;
      // Exactly one of objectHandle / objectValue (mirrors the DB CHECK).
      if ((objectHandle == null) === (objectValue == null)) {
        throw new Error('propose_fact requires exactly one of objectHandle or objectValue.');
      }

      // valid_at is the source of truth (doc 41 §12 #7): a present date wins and
      // sets undated=false; its absence is an explicit undated fact. Satisfies
      // the staging biconditional CHECK (undated = valid_at IS NULL).
      const validAtRaw = toolInput.validAt as string | undefined;
      const hasDate = validAtRaw != null && validAtRaw !== '';
      const validAt = hasDate ? new Date(validAtRaw as string) : null;

      const exclusiveGroup = resolveExclusiveGroup(predicate);

      // Disposal preview — PRIOR CANONICAL ONLY, never peer in-flight proposals
      // (isolation, doc 41 §8a.4). Resolvable only when the subject anchored to a
      // known canonical entity and the predicate is in an exclusive group;
      // otherwise there is no prior canonical to preview.
      let priorCanonicalActiveInGroup: Array<Record<string, unknown>> = [];
      if (exclusiveGroup) {
        const subjRows = await db
          .select({ anchor: stagingProposedEntities.anchorCanonicalId })
          .from(stagingProposedEntities)
          .where(eq(stagingProposedEntities.handle, subjectHandle))
          .limit(1);
        const anchor = subjRows[0]?.anchor ?? null;
        if (anchor) {
          const active = await getEntityFacts(anchor, { asSubject: true, asObject: false });
          priorCanonicalActiveInGroup = active
            .filter((f) => resolveExclusiveGroup(f.predicate) === exclusiveGroup)
            .map((f) => ({
              factId: f.id,
              predicate: f.predicate,
              object: f.objectValue ?? f.objectEntityId,
              validAt: f.validAt,
              confidence: f.confidence,
            }));
        }
      }

      const inserted = await db
        .insert(stagingProposedFacts)
        .values({
          epochId: context.epochId,
          sourceId: context.sourceId ?? null,
          subjectHandle,
          predicate,
          objectHandle,
          objectValue,
          validAt,
          undated: !hasDate,
          chunkIndex: context.chunkIndex ?? null,
          confidence: (toolInput.confidence as number) ?? null,
          reasoning: (toolInput.reasoning as string) ?? null,
          exclusiveGroup,
          // VERIFY-phase supersession hint (E4, doc 41 §4). Stored raw — promotion
          // validates it against the actual prior-canonical actives (no FK; the
          // id is agent-supplied and may be stale).
          supersedesFactId: (toolInput.supersedesFactId as string) ?? null,
        })
        .returning({ stagedFactId: stagingProposedFacts.stagedFactId });

      return JSON.stringify({
        stagedFactId: inserted[0]!.stagedFactId,
        exclusiveGroup,
        priorCanonicalActiveInGroup,
      });
    }

    // --- Causal pass propose tool (E6, doc 41 §6, §8a.6) ---
    // The causal agent proposes edges between SETTLED canonical events (minted by
    // promotion) into staging_causal_edges; a deterministic causal-promotion step
    // disposes them. The return previews disposal: refsResolve (do the event ids
    // resolve) + citedFactStatus (live status of each cited fact) — both WARN the
    // agent BEFORE the cited-fact branch runs (superseded → keep, invalidated → stale).

    case 'propose_causal_edge': {
      if (!context.epochId) {
        throw new Error('propose_causal_edge requires an epoch context (MNEMO_EPOCH_ID) — injected by the harness (the causal pass partitions staging by the promotion epoch).');
      }
      const causeEventId = toolInput.causeEventId as string;
      const effectEventId = toolInput.effectEventId as string;
      const reasoning = (toolInput.reasoning as string) ?? '';
      const sourceReferences =
        (toolInput.sourceReferences as Array<{ type: string; id: string; relevance: string }>) ?? [];

      // doc-01 invariant enforced at the propose boundary (the 044 CHECKs back it
      // up): every causal edge carries non-empty reasoning + >=1 source reference.
      if (!causeEventId || !effectEventId) {
        throw new Error('propose_causal_edge requires causeEventId and effectEventId.');
      }
      if (!reasoning.trim()) {
        throw new Error('propose_causal_edge requires non-empty reasoning (doc 01 invariant).');
      }
      if (!Array.isArray(sourceReferences) || sourceReferences.length === 0) {
        throw new Error('propose_causal_edge requires a non-empty sourceReferences array (doc 01 invariant).');
      }

      // refsResolve — do the cited cause/effect EVENT ids resolve to settled
      // canonical events? A soft signal (causal-promotion DROPS an edge whose event
      // id does not resolve); surfacing it here lets the agent self-correct.
      const evRows = await db
        .select({ id: causalEvents.id })
        .from(causalEvents)
        .where(inArray(causalEvents.id, [causeEventId, effectEventId]));
      const evIds = new Set(evRows.map((r) => r.id));
      const refsResolve = { cause: evIds.has(causeEventId), effect: evIds.has(effectEventId) };

      // citedFactStatus — the live status of every FACT this edge cites as a source
      // reference (doc 41 §6): active | superseded (expired_at set, a newer value
      // landed) | invalidated (invalid_at set, it was wrong). Warns the agent it is
      // grounding on a shaky fact BEFORE causal-promotion's cited-fact branch runs.
      const citedFactIds = sourceReferences.filter((r) => r.type === 'fact' && r.id).map((r) => r.id);
      let citedFactStatus: Array<{ factId: string; status: 'active' | 'superseded' | 'invalidated' }> = [];
      if (citedFactIds.length > 0) {
        const factRows = await db
          .select({ id: factsTable.id, expiredAt: factsTable.expiredAt, invalidAt: factsTable.invalidAt })
          .from(factsTable)
          .where(inArray(factsTable.id, citedFactIds));
        citedFactStatus = factRows.map((f) => ({
          factId: f.id,
          status: f.invalidAt ? 'invalidated' : f.expiredAt ? 'superseded' : 'active',
        }));
      }

      // jsonb ARRAY values are stringified by drizzle `.values()` (Drizzle 0.29 +
      // postgres.js 3.4) — they then fail the 044 jsonb_typeof='array' CHECK. Insert
      // via a raw template with jsonbLiteral (JSON-encoded once, cast ::jsonb
      // server-side), the same workaround createCausalEdge uses for source_references.
      const inserted = await db.execute(sql`
        INSERT INTO public.staging_causal_edges
          (epoch_id, cause_event_id, effect_event_id, reasoning, source_references, proposed_by)
        VALUES (
          ${context.epochId}::uuid,
          ${causeEventId}::uuid,
          ${effectEventId}::uuid,
          ${reasoning},
          ${jsonbLiteral(sourceReferences)},
          ${context.agent}
        )
        RETURNING id
      `);
      const stagedEdgeId = unwrapRows<{ id: string }>(inserted)[0]!.id;

      return JSON.stringify({
        stagedEdgeId,
        refsResolve,
        citedFactStatus,
      });
    }

    // --- Promotion-escalation arbiter verdict tools (E5, doc 41 §8a.5) ---
    // The arbiter attaches its decision to a dossier promotion pre-recorded in
    // arbiter_verdicts (verdict null), keyed by (epoch_id, escalation_key, kind).
    // The decision JSONB holds only the decision fields — kind + escalation_key are
    // the row columns (promotion-arbiter.rowToVerdict reassembles the Verdict).

    case 'propose_identity_verdict': {
      if (!context.epochId) {
        throw new Error('propose_identity_verdict requires an epoch context (MNEMO_EPOCH_ID) — pushed by promotion.');
      }
      const escKey = toolInput.escalation_key as string;
      const decision = toolInput.decision as string;
      const canonicalTarget = (toolInput.canonical_target as string) ?? null;
      if ((decision === 'merge' || decision === 'same_as') && !canonicalTarget) {
        throw new Error(`propose_identity_verdict: decision="${decision}" requires canonical_target (a candidate id).`);
      }
      const verdict = {
        members: (toolInput.members as string[]) ?? [],
        decision,
        canonicalTarget,
        reasoning: toolInput.reasoning as string,
      };
      const updated = await db
        .update(arbiterVerdicts)
        .set({ verdict, decidedBy: context.agent, decidedAt: new Date() })
        .where(
          and(
            eq(arbiterVerdicts.epochId, context.epochId),
            eq(arbiterVerdicts.escalationKey, escKey),
            eq(arbiterVerdicts.kind, 'identity'),
          ),
        )
        .returning({ id: arbiterVerdicts.id });
      if (updated.length === 0) {
        return JSON.stringify({
          recorded: false,
          reason: `no pending identity escalation with key "${escKey}" for this epoch (check the dossier's escalation_key)`,
        });
      }
      return JSON.stringify({
        recorded: true,
        decision,
        willExecute:
          decision === 'merge'
            ? 'promotion merges the other candidates into canonical_target'
            : decision === 'same_as'
              ? 'promotion links the candidates same_as'
              : 'promotion keeps the proposed cluster distinct',
      });
    }

    case 'propose_conflict_resolution': {
      if (!context.epochId) {
        throw new Error('propose_conflict_resolution requires an epoch context (MNEMO_EPOCH_ID) — pushed by promotion.');
      }
      const escKey = toolInput.escalation_key as string;
      const verdict = {
        expire: (toolInput.expire as Array<{ factId: string; reason: string }>) ?? [],
        correctedValidAt: (toolInput.corrected_valid_at as Record<string, string> | null) ?? null,
        notExclusive: toolInput.not_exclusive === true,
        reasoning: toolInput.reasoning as string,
      };
      const updated = await db
        .update(arbiterVerdicts)
        .set({ verdict, decidedBy: context.agent, decidedAt: new Date() })
        .where(
          and(
            eq(arbiterVerdicts.epochId, context.epochId),
            eq(arbiterVerdicts.escalationKey, escKey),
            eq(arbiterVerdicts.kind, 'conflict'),
          ),
        )
        .returning({ id: arbiterVerdicts.id });
      if (updated.length === 0) {
        return JSON.stringify({
          recorded: false,
          reason: `no pending conflict escalation with key "${escKey}" for this epoch (check the dossier's escalation_key)`,
        });
      }
      return JSON.stringify({
        recorded: true,
        notExclusive: verdict.notExclusive,
        expireCount: verdict.expire.length,
      });
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

// ============================================
// Agent Invocation
// ============================================

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
/**
 * Build the env dict that the production MCP server subprocess needs.
 *
 * Single source of truth for env passed to the graph MCP server — both
 * `getMcpConfigPath` (which writes it into per-actor MCP configs that
 * Claude Code consumes) and `checkGraphMcpHealth` (which spawns the same
 * server directly) call this. Bead nmemo-2yv.126 — without the shared
 * builder, an env-list edit on one side silently drifts from the other
 * and the probe passes against an easier startup contract than production.
 *
 * Prefers `process.env` (set by test setup or runtime) over `.env` file.
 */
/**
 * Epoch v2 harness context (doc 41 §8a.4) threaded into a proposer's MCP server
 * env so its propose_* tools stamp the right epoch/source/chunk onto staging
 * rows. Supplied by E3's runEpochBatch when spawning an extraction_proposer;
 * omitted for every legacy invocation (the env keys are simply absent).
 */
export interface EpochContext {
  epochId?: string;
  sourceId?: string;
  chunkIndex?: number;
  /**
   * Total chunks in this source's batch (E4, doc 41 §4). Passed to the proposer
   * prompt as the "M" in "chunk N of M" so the agent knows its narration
   * position. Not stamped onto staging rows — purely a prompt input.
   */
  totalChunks?: number;
}

export function getMcpEnv(actor: Actor, epoch?: EpochContext): Record<string, string> {
  const platformRoot = path.resolve(__dirname, '..', '..');
  const envFile = dotenv.config({ path: path.resolve(platformRoot, '.env') });
  const env: Record<string, string> = { MNEMO_AGENT_ACTOR: actor };
  for (const key of ['DATABASE_URL', 'QDRANT_URL', 'QDRANT_COLLECTION', 'ML_SERVICES_URL', 'EMBED_MODEL', 'NODE_ENV']) {
    const val = process.env[key] || envFile.parsed?.[key];
    if (val) env[key] = val;
  }
  // Infra vars the MCP server needs to actually start — distinct from the app
  // config keys above. The server is launched via `npx tsx`, so PATH must be
  // present to resolve those binaries (and node itself); HOME lets npx/tsx
  // resolve their caches. When Claude Code launches the MCP server it inherits
  // these from its own process; when checkGraphMcpHealth spawns it directly with
  // this curated env (which REPLACES the environment), their absence means
  // `spawn npx` fails with ENOENT. Pass them through so both paths match.
  for (const key of ['PATH', 'HOME']) {
    const val = process.env[key];
    if (val) env[key] = val;
  }
  if (epoch?.epochId) env.MNEMO_EPOCH_ID = epoch.epochId;
  if (epoch?.sourceId) env.MNEMO_SOURCE_ID = epoch.sourceId;
  if (epoch?.chunkIndex != null) env.MNEMO_CHUNK_INDEX = String(epoch.chunkIndex);
  return env;
}

export function getMcpConfigPath(actor: Actor = 'graph_agent', epoch?: EpochContext): string {
  const platformRoot = path.resolve(__dirname, '..', '..');
  // One config file per actor so invoke* calls don't clobber each other's
  // MNEMO_AGENT_ACTOR when running concurrently (e.g., a patrol kicked off
  // while an extraction is still in flight). When an epoch context is supplied,
  // the chunk position further disambiguates the filename so PARALLEL proposers
  // (E3 — one per chunk) don't share a config and overwrite each other's
  // MNEMO_CHUNK_INDEX.
  const suffix =
    epoch?.epochId != null && epoch?.chunkIndex != null
      ? `.${epoch.epochId}.c${epoch.chunkIndex}`
      : '';
  const configPath = path.resolve(platformRoot, `.graph-mcp-config.${actor}${suffix}.json`);

  // Use absolute path to the MCP server script — Claude Code does not
  // respect the cwd field when spawning MCP servers, so the script path
  // must be resolvable from any working directory.
  const serverScript = getGraphMcpScriptPath();

  const mcpConfig = {
    mcpServers: {
      'mnemo-graph': {
        command: 'npx',
        args: ['tsx', serverScript],
        cwd: platformRoot,
        env: getMcpEnv(actor, epoch),
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2));
  return configPath;
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
 *  - 'conversational': prose extraction with a conversational addendum that
 *    anchors first-person to the resolved speaker (graph_agent 3f9.3). Plumbed
 *    end-to-end via nmemo-awi so the HTTP /ingest path reaches this branch.
 */
export type ContentType = 'prose' | 'code-ts' | 'code-sql' | 'conversational';

export interface ExtractionAgentParams {
  sourceText: string;
  memoryId: string;
  source?: string;
  contentType?: ContentType;
  /**
   * Previous extraction session's PHASE 6 report text. Threaded into the next
   * agent's prompt as continuity context — gives the agent the prior session's
   * difficulties, unresolved references, and unconfirmed aliases without
   * relying on graph state alone. Bead nmemo-upn.
   *
   * Optional — when omitted (first chunk, prior report missing), the prompt
   * builder skips the prior-report block entirely. Sanitisation happens at the
   * Python read-into-prompt boundary via `delimit_for_prompt(kind="report")`.
   */
  previousReport?: string | null;
  /**
   * Stream scope for speaker identity (nmemo-3f9.2). Threaded through so the
   * agent endpoint can scope query-time retrieval / logging. Optional —
   * absent means the implicit single stream.
   */
  streamId?: string;
  /**
   * Pre-resolved Participants block injected into the EXTRACTION CONTEXT
   * (nmemo-3f9.2). Built platform-side by resolveStreamParticipants; contains
   * the deterministically resolved speaker entity ids so the agent does NOT
   * fuzzy-resolve first-person references for the stream defaults. Optional —
   * absent means no pre-resolved speakers to announce.
   */
  participants?: string;
  /**
   * Epoch v2 (doc 41 §4, §8a.4; bead nmemo-vpz.3 / E3). When set the agent runs
   * as this actor instead of the default `graph_agent` — the propose→promote path
   * spawns it as `extraction_proposer`, whose server-side allow-list (E2) exposes
   * only reads + the staging `propose_*` writes. Omitted for every legacy
   * invocation (serial/optimistic), which keep the full canonical-write surface.
   */
  actor?: Actor;
  /**
   * Epoch v2 (E3). Per-chunk epoch context baked into the spawned MCP server's
   * env (via {@link getMcpConfigPath}) so the proposer's `propose_*` tools stamp
   * the right epoch/source/chunk onto staging rows and parallel proposers get
   * distinct config files.
   */
  epoch?: EpochContext;
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
// Promotion-escalation Arbiter Invocation (E5, doc 41 §8a.5)
// ============================================

export interface ArbiterAgentResult {
  result: string;
}

/**
 * Invoke the promotion-escalation arbiter (reconciliation_agent recast, Haiku).
 * Promotion PUSHES the dossiers; the agent reads them, optionally goes deeper via
 * its read tools, then records a verdict per escalation via propose_identity_verdict
 * / propose_conflict_resolution. The MCP server is spawned with this epoch's context
 * (MNEMO_EPOCH_ID) so those tools can locate the pre-recorded dossier rows.
 *
 * Bound lazily by promotion-arbiter.ts (dynamic import) to keep promotion free of a
 * static dependency on this module. `dossiers` are JSON-serialised verbatim into the
 * ml-services request — typed `unknown[]` here to avoid importing the dossier type
 * (and a static import cycle).
 */
export async function invokeArbiterAgent(
  epochId: string,
  dossiers: unknown[],
): Promise<ArbiterAgentResult> {
  const mcpConfigPath = getMcpConfigPath('reconciliation_agent', { epochId });

  const response = await fetch(`${config.ML_SERVICES_URL}/arbiter-agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      epoch_id: epochId,
      dossiers,
      mcp_config_path: mcpConfigPath,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`Arbiter agent failed (${response.status}): ${detail}`);
  }

  return response.json() as Promise<ArbiterAgentResult>;
}

// ============================================
// Causal-pass Agent Invocation (E6, doc 41 §6, §8a.6)
// ============================================

export interface CausalAgentResult {
  result: string;
}

/**
 * The seam causal-pass.ts injects (default = {@link invokeCausalAgent}). DB tests
 * supply a fake invoker that writes staging_causal_edges directly, exercising the
 * dispose side without an LLM (mirrors promotion-arbiter's ArbiterInvoker, E5).
 */
export type CausalAgentInvoker = (epochId: string, scope: unknown) => Promise<void>;

/**
 * Invoke the post-promotion causal agent (Haiku) for one epoch (doc 41 §6, §8a.6).
 * The causal pass PUSHES the settled delta scope (minted events + the touched
 * entities' causal neighbourhood); the agent reads it, goes deeper via its read tools
 * if needed, and records edges via propose_causal_edge into staging_causal_edges —
 * causal-promotion then disposes them. The MCP server is spawned with this epoch's
 * context (MNEMO_EPOCH_ID) so propose_causal_edge stamps the right epoch. Mirror of
 * {@link invokeArbiterAgent}; the /causal-agent endpoint is added in ml-services (E6 Step 7).
 */
export async function invokeCausalAgent(epochId: string, scope: unknown): Promise<CausalAgentResult> {
  const mcpConfigPath = getMcpConfigPath('causal_agent', { epochId });

  const response = await fetch(`${config.ML_SERVICES_URL}/causal-agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      epoch_id: epochId,
      scope,
      mcp_config_path: mcpConfigPath,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`Causal agent failed (${response.status}): ${detail}`);
  }

  return response.json() as Promise<CausalAgentResult>;
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
// Agent Invocation Timeout (bead nmemo-2yv.76)
// ============================================

/**
 * Distinguished error thrown when an agent-invocation fetch is aborted by the
 * timeout watchdog (AbortController.abort fired). Lets the HTTP handlers in
 * src/index.ts respond with a 504 instead of the generic 500 used for
 * upstream non-OK responses. Bead nmemo-2yv.76.
 */
export class AgentInvocationTimeoutError extends Error {
  constructor(
    public readonly agent: 'reasoning_agent' | 'graph_agent' | 'gardener_agent',
    public readonly timeoutMs: number,
  ) {
    super(`${agent} timed out after ${timeoutMs}ms`);
    this.name = 'AgentInvocationTimeoutError';
  }
}

/**
 * Fetch wrapper for the three Claude-Code-spawning ml-services agent endpoints.
 * Adds an AbortController + setTimeout watchdog so a hung subprocess (stuck
 * LLM call, network black-hole, frozen MCP server) cannot leak the platform-
 * side fetch indefinitely. Mirrors the canonical pattern from
 * src/services/ml-client.ts:96-104. Bead nmemo-2yv.76.
 *
 * On timeout: throws AgentInvocationTimeoutError so /api/reason can return 504.
 * On non-OK response: throws a generic Error (caller decides status mapping).
 * On other network errors: propagates the underlying error unchanged.
 *
 * Distinct from mlFetch (which retries 429/502/503/504 and uses a single
 * fixed timeout): agent invocations are long-running by design and not safe
 * to retry — each subprocess pass writes audit rows, increments counters, and
 * mutates the graph. A retry-on-timeout would compound the leak rather than
 * recover from it.
 */
/**
 * Build a per-request undici dispatcher whose header/body read timeouts are
 * widened to cover the full agent timeout budget. Without this, Node's global
 * fetch (undici) applies its DEFAULT headersTimeout (~300s) which fires
 * INDEPENDENTLY of the AbortController below. The /graph-agent endpoint runs
 * the whole Haiku tool-use agent synchronously before emitting response
 * headers, so a large chunk (~6000 chars) can take >5min and the fetch would
 * die with UND_ERR_HEADERS_TIMEOUT long before our AbortController fires.
 *
 * We pin undici to match Node's bundled version (process.versions.undici);
 * a mismatched major (e.g. standalone 8.x vs bundled 7.x) makes global fetch
 * reject the dispatcher with UND_ERR_INVALID_ARG. See bead nmemo-8w5 and
 * doc 33 implementation lessons.
 *
 * Memoized per timeoutMs so we reuse connection pools across agent calls
 * without constructing a fresh Agent each time. The AbortController remains the
 * authoritative hard timeout; these dispatcher timeouts are deliberately set
 * equal to it so undici never pre-empts the app-level deadline.
 */
const agentDispatchers = new Map<number, Agent>();
export function makeAgentDispatcher(timeoutMs: number): Agent {
  let dispatcher = agentDispatchers.get(timeoutMs);
  if (!dispatcher) {
    dispatcher = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
    agentDispatchers.set(timeoutMs, dispatcher);
  }
  return dispatcher;
}

export async function agentFetch<T>(opts: {
  agent: 'reasoning_agent' | 'graph_agent' | 'gardener_agent';
  url: string;
  body: unknown;
  timeoutMs: number;
}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const response = await fetch(opts.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts.body),
      signal: controller.signal,
      // Per-request dispatcher only — never setGlobalDispatcher (would also
      // widen timeouts on health checks, mlFetch, etc.). Cast: `dispatcher`
      // is a valid undici RequestInit field but absent from the DOM fetch lib types.
      dispatcher: makeAgentDispatcher(opts.timeoutMs),
    } as RequestInit & { dispatcher: Agent });

    if (!response.ok) {
      const detail = await response.text().catch(() => response.statusText);
      throw new Error(`${opts.agent} failed (${response.status}): ${detail}`);
    }

    return (await response.json()) as T;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new AgentInvocationTimeoutError(opts.agent, opts.timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
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
  console.log(`[gardener] POST ${url} trigger=${params.trigger} mcp=${mcpConfigPath} timeout=${config.GARDENER_AGENT_TIMEOUT_MS}ms`);

  try {
    const result = await agentFetch<GardenerAgentResult>({
      agent: 'gardener_agent',
      url,
      body: {
        mcp_config_path: mcpConfigPath,
        trigger: params.trigger,
        graph_agent_runs_since_last: params.graphAgentRunsSinceLast ?? 0,
      },
      timeoutMs: config.GARDENER_AGENT_TIMEOUT_MS,
    });
    console.log(`[gardener] ML service responded OK`);
    return result;
  } catch (err) {
    if (err instanceof AgentInvocationTimeoutError) {
      console.error(`[gardener] timed out after ${err.timeoutMs}ms`);
    } else if (err instanceof Error) {
      console.error(`[gardener] ML service error: ${err.message.slice(0, 200)}`);
    }
    throw err;
  }
}

export async function invokeGraphAgent(params: ExtractionAgentParams): Promise<GraphAgentResult> {
  const actor = params.actor ?? 'graph_agent';
  // The actor's identity (audit stamp + tool allow-list) rides the MCP config
  // env; agentFetch's `agent` is only a telemetry/timeout label, so the narrow
  // 'graph_agent' label is kept for the proposer (same endpoint + timeout).
  const mcpConfigPath = getMcpConfigPath(actor, params.epoch);

  return agentFetch<GraphAgentResult>({
    agent: 'graph_agent',
    url: `${config.ML_SERVICES_URL}/graph-agent`,
    body: {
      source_text: params.sourceText,
      memory_id: params.memoryId,
      mcp_config_path: mcpConfigPath,
      source_name: params.source,
      content_type: params.contentType ?? 'prose',
      // Bead nmemo-upn: thread the previous session's PHASE 6 report through
      // as continuity context. Null / undefined is sent as null so the Python
      // endpoint can branch on absence without a sentinel string.
      previous_report: params.previousReport ?? null,
      // nmemo-3f9.2: stream scope + pre-resolved Participants block. Null when
      // absent so the Python endpoint branches on absence without a sentinel.
      stream_id: params.streamId ?? null,
      participants: params.participants ?? null,
      // Epoch v2 E4 (doc 41 §4): the actor selects the proposer prompt branch;
      // chunk position becomes "chunk N of M" in narration order for that prompt.
      actor,
      chunk_index: params.epoch?.chunkIndex ?? null,
      total_chunks: params.epoch?.totalChunks ?? null,
    },
    timeoutMs: config.GRAPH_AGENT_TIMEOUT_MS,
  });
}

// ============================================
// Reasoning Agent Invocation
// ============================================
//
// The reasoning-agent invocation surface (invokeReasoningAgent, its parameter
// shapes) was extracted to src/services/reasoning-agent.ts under bead
// nmemo-2yv.80. Re-exported here so existing consumers
// (src/index.ts, src/test/services/causal-agent-timeout.test.ts) keep working
// without a separate import sweep. New code should import from
// './reasoning-agent.js' directly.
export {
  invokeReasoningAgent,
  type ReasoningAgentParams,
  type ReasoningAgentResult,
} from './reasoning-agent.js';

// ============================================
// MCP Health Check
// ============================================

export interface McpHealthResult {
  ok: boolean;
  tools?: string[];
  /** Server identity reported by the MCP server in its `initialize` response
   *  (`serverInfo.name`). Captured so callers (and the integration test) can
   *  verify the spawned subprocess identifies itself as the expected server
   *  — currently `'mnemo-graph'` for graph-mcp.ts. Added by bead nmemo-2yv.128
   *  so the test guards against server-identity drift at the MCP protocol layer.
   *  Undefined when the initialize response carries no `serverInfo.name`. */
  serverName?: string;
  /** True when the `get_graph_topology` round-trip (id=3) returned a structured
   *  response — either a tool result or a tool-level error envelope. False when
   *  the transport itself failed (timeout, JSON parse error, connection drop).
   *  `ok` requires BOTH `tools/list` AND this round-trip to succeed. Added by
   *  bead nmemo-2yv.126 so the probe exercises the MCP→DB path, not just
   *  the spawn+initialize handshake. */
  topologyOk?: boolean;
  /** Aggregated stderr output from the spawned MCP subprocess. Includes the
   *  startup banner (`Mnemo Graph MCP Server running on stdio` — graph-mcp.ts)
   *  and any tsx/dotenv/SDK warnings emitted before the probe resolved.
   *  Present unconditionally — success AND error paths — so `/api/mcp-health`
   *  surfaces environmental drift symmetrically (bead nmemo-2yv.129).
   *  Undefined when the subprocess wrote nothing to stderr. */
  stderr?: string;
  error?: string;
  durationMs: number;
}

/**
 * Spawn the production graph MCP server and verify it responds to BOTH a
 * `tools/list` request AND a `tools/call get_graph_topology` round-trip. Uses
 * the raw JSON-RPC protocol over stdio (no SDK client needed). Resolves the
 * script path + env through the shared resolvers (`getGraphMcpScriptPath`,
 * `getMcpEnv`) so the probe spawns the subprocess with the SAME contract
 * production agents see — no probe-vs-production env drift (bead .126).
 *
 * The `get_graph_topology` round-trip ensures "green" means "the agent can
 * actually do useful work" — a server that starts cleanly but cannot reach
 * Postgres returns ok=false here, where the old probe (which only sent
 * initialize + tools/list) would silently return ok=true.
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
      // Bead nmemo-2yv.126: pass the SAME env that production MCP configs
      // pass (via getMcpConfigPath). Without this, the probe would inherit
      // the platform process's full process.env and silently pass against
      // a richer startup contract than production.
      env: getMcpEnv('graph_agent'),
    });

    let stdout = '';
    let stderr = '';
    let resolved = false;
    let toolsList: string[] | undefined;
    // Bead nmemo-2yv.128: capture serverInfo.name from the initialize response
    // so the test (and other callers) can guard against server-identity drift.
    let serverName: string | undefined;
    // Bead nmemo-2yv.126: track which request stages we've already dispatched
    // so the stdout handler — which re-iterates ALL accumulated lines every
    // time data arrives — doesn't double-send subsequent requests. Without
    // this, three response chunks would cause three tools/list sends.
    let toolsListSent = false;
    let topologyCallSent = false;

    const finish = (result: McpHealthResult) => {
      if (resolved) return;
      resolved = true;
      proc.kill();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, tools: toolsList, serverName, stderr: stderr || undefined, error: 'MCP server timed out', durationMs: Date.now() - start });
    }, timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();

      // Look for tools/list response
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          // Response to initialize (id=1) → send tools/list (id=2) once.
          if (msg.id === 1 && msg.result && !toolsListSent) {
            toolsListSent = true;
            // Bead nmemo-2yv.128: capture serverInfo.name from initialize result.
            serverName = msg.result?.serverInfo?.name;
            const toolsReq = JSON.stringify({
              jsonrpc: '2.0',
              id: 2,
              method: 'tools/list',
              params: {},
            });
            proc.stdin.write(toolsReq + '\n');
          }
          // Response to tools/list (id=2) → send tools/call get_graph_topology (id=3) once.
          if (msg.id === 2 && msg.result?.tools && !topologyCallSent) {
            topologyCallSent = true;
            toolsList = msg.result.tools.map((t: { name: string }) => t.name);
            const callReq = JSON.stringify({
              jsonrpc: '2.0',
              id: 3,
              method: 'tools/call',
              params: { name: 'get_graph_topology', arguments: {} },
            });
            proc.stdin.write(callReq + '\n');
          }
          // Response to tools/call get_graph_topology (id=3). A `result` field
          // (with or without `isError:true`) is proof the MCP→DB path works —
          // the tool ran. A JSON-RPC `error` field means the protocol layer
          // itself rejected the call (e.g. method-not-found, schema mismatch);
          // that's a real probe failure → topologyOk=false. Transport-level
          // failures (id=3 never arrives, JSON parse error) surface via the
          // timeout / exit paths.
          if (msg.id === 3) {
            clearTimeout(timer);
            const topologyOk = msg.result !== undefined;
            finish({
              ok: toolsList !== undefined && topologyOk,
              tools: toolsList,
              serverName,
              topologyOk,
              stderr: stderr || undefined,
              error: topologyOk ? undefined : `tools/call get_graph_topology returned JSON-RPC error: ${JSON.stringify(msg.error)}`,
              durationMs: Date.now() - start,
            });
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
      finish({ ok: false, tools: toolsList, serverName, stderr: stderr || undefined, error: `Failed to spawn: ${err.message}`, durationMs: Date.now() - start });
    });

    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (!resolved) {
        // Bead nmemo-2yv.129: stderr lives in its own field; the `error` field
        // carries only the exit-code summary so success and error paths report
        // stderr through the same channel (symmetric observability).
        finish({ ok: false, tools: toolsList, serverName, stderr: stderr || undefined, error: `Server exited with code ${code}`, durationMs: Date.now() - start });
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
