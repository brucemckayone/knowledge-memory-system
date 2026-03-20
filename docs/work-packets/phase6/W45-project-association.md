# Work Packet W45: Project Association Agent

**Status:** ❌ Not Started
**Dependencies:** W44 (Conversation Context Service)
**Estimated Time:** 4–5 hours
**Design Reference:** [Multi-Source Processing Architecture](../../architecture/multi-source-processing.md)

---

## Objective

Implement the Project Association Agent that organically discovers which memories, conversations, and sources relate to which projects. Produces a materialized `project_associations` view for efficient cross-source project querying. Surfaces ambiguous associations for user confirmation in the daily digest.

---

## Philosophy

Projects are amorphous. A Phoenix discussion might happen in `#phoenix-dev`, spill into `#engineering-general`, get followed up in email, and produce JIRA tickets. The system discovers associations organically through three signals — entity co-occurrence, vector proximity, and soft source bindings — rather than requiring explicit channel-to-project mapping.

Association is probabilistic: a memory can be 80% Phoenix and 40% Infrastructure. This reflects reality better than binary tagging.

---

## Implementation

### Database Schema

```sql
-- Migration: 015_project_associations.sql

-- Materialized project-memory associations
CREATE TABLE IF NOT EXISTS project_associations (
  memory_id    UUID NOT NULL,
  project_id   UUID NOT NULL REFERENCES entities(id),
  confidence   REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  sources      TEXT[] NOT NULL DEFAULT '{}',
  computed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (memory_id, project_id)
);

CREATE INDEX idx_project_assoc_project ON project_associations(project_id, confidence DESC);
CREATE INDEX idx_project_assoc_memory ON project_associations(memory_id);
CREATE INDEX idx_project_assoc_confidence ON project_associations(confidence DESC);

-- Soft source-to-project bindings (user hints)
CREATE TABLE IF NOT EXISTS source_bindings (
  channel_id   TEXT NOT NULL,
  project_id   UUID NOT NULL REFERENCES entities(id),
  binding_type TEXT NOT NULL DEFAULT 'user_hint',  -- 'user_hint' | 'auto_inferred'
  weight       REAL NOT NULL DEFAULT 0.5,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (channel_id, project_id)
);

-- Ambiguous items awaiting user confirmation
CREATE TABLE IF NOT EXISTS association_ambiguities (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id    UUID NOT NULL,
  candidates   JSONB NOT NULL,   -- [{projectId, confidence, reason}]
  content_preview TEXT NOT NULL,
  source_description TEXT,       -- "from #engineering-general" or "Meeting transcript"
  surfaced     BOOLEAN NOT NULL DEFAULT false,
  resolved     BOOLEAN NOT NULL DEFAULT false,
  resolution   UUID,             -- Confirmed project_id (null if unresolved)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at  TIMESTAMPTZ
);

CREATE INDEX idx_ambiguities_unresolved ON association_ambiguities(surfaced, resolved)
  WHERE resolved = false;
```

### Association Scoring

Create `platform/src/services/project-association.ts`:

```typescript
import { db } from '../db/index.js';
import { entities, facts, memoryEntities } from '../db/schema.js';
import { eq, sql, and, inArray } from 'drizzle-orm';
import { ml } from './ml-client.js';

const ENTITY_WEIGHT = 0.4;
const VECTOR_WEIGHT = 0.35;
const BINDING_WEIGHT = 0.25;
const ASSOCIATION_THRESHOLD = 0.3;
const AMBIGUITY_MARGIN = 0.15;  // If top two projects are within this margin, flag as ambiguous

interface AssociationScore {
  projectId: string;
  projectName: string;
  confidence: number;
  sources: string[];
}

/**
 * Compute project association scores for a memory.
 */
export async function computeAssociations(
  memoryId: string,
  memoryEmbedding: number[],
  conversationId?: string,
): Promise<AssociationScore[]> {
  // Get active projects
  const projects = await db
    .select({ id: entities.id, name: entities.canonicalName })
    .from(entities)
    .where(eq(entities.entityType, 'project'));

  if (projects.length === 0) return [];

  const scores: AssociationScore[] = [];

  // Get entities mentioned in this memory
  const memEntities = await db
    .select({ entityId: memoryEntities.entityId })
    .from(memoryEntities)
    .where(eq(memoryEntities.memoryId, memoryId));

  const memEntityIds = new Set(memEntities.map(e => e.entityId));

  for (const project of projects) {
    let confidence = 0;
    const sources: string[] = [];

    // Signal 1: Entity co-occurrence
    // How many entities in this memory are also connected to this project?
    const projectFacts = await db
      .select({ entityId: facts.objectEntityId })
      .from(facts)
      .where(and(
        eq(facts.subjectEntityId, project.id),
        sql`expired_at IS NULL`,
      ));

    const projectEntityIds = new Set(
      projectFacts.map(f => f.entityId).filter(Boolean) as string[]
    );

    // Also count the project entity itself
    projectEntityIds.add(project.id);

    const entityOverlap = [...memEntityIds].filter(id => projectEntityIds.has(id)).length;
    if (entityOverlap > 0) {
      confidence += (entityOverlap / Math.max(memEntityIds.size, 1)) * ENTITY_WEIGHT;
      sources.push('entity_overlap');
    }

    // Signal 2: Vector proximity
    // Cosine similarity between memory embedding and project entity embedding
    const projectEmbedding = await getEntityEmbedding(project.id);
    if (projectEmbedding && memoryEmbedding.length > 0) {
      const similarity = cosineSimilarity(memoryEmbedding, projectEmbedding);
      if (similarity > 0.5) {
        confidence += similarity * VECTOR_WEIGHT;
        sources.push('vector');
      }
    }

    // Signal 3: Source binding prior
    if (conversationId) {
      const binding = await db.execute(sql`
        SELECT weight FROM source_bindings
        WHERE channel_id = ${conversationId} AND project_id = ${project.id}::uuid
      `);
      if (binding.rows.length > 0) {
        confidence += (binding.rows[0] as { weight: number }).weight * BINDING_WEIGHT;
        sources.push('channel_binding');
      }
    }

    if (confidence >= ASSOCIATION_THRESHOLD) {
      scores.push({
        projectId: project.id,
        projectName: project.name,
        confidence: Math.min(1.0, confidence),
        sources,
      });
    }
  }

  return scores.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Check if associations are ambiguous (top candidates too close).
 */
export function isAmbiguous(scores: AssociationScore[]): boolean {
  if (scores.length < 2) return false;
  return (scores[0]!.confidence - scores[1]!.confidence) < AMBIGUITY_MARGIN;
}
```

### KARMA Agent: Project Associator

```typescript
import type { GardenerAgent, AgentContext, JobResult } from '../controller.js';
import { computeAssociations, isAmbiguous } from '../../services/project-association.js';

export const projectAssociationAgent: GardenerAgent = {
  name: 'associate-projects',
  tier: 'frequent',

  async execute(context: AgentContext): Promise<JobResult> {
    const { job, log } = context;
    const payload = job.data as {
      memoryId: string;
      embedding: number[];
      conversationId?: string;
    };

    const scores = await computeAssociations(
      payload.memoryId,
      payload.embedding,
      payload.conversationId,
    );

    let associated = 0;
    let flagged = 0;

    if (scores.length > 0) {
      // Check for ambiguity
      if (isAmbiguous(scores)) {
        await flagAmbiguity(payload.memoryId, scores);
        flagged++;
        log(`Ambiguous association for ${payload.memoryId.slice(0, 8)}: ${scores.map(s => `${s.projectName}(${s.confidence.toFixed(2)})`).join(' vs ')}`);
      }

      // Store all associations above threshold
      for (const score of scores) {
        await storeAssociation(payload.memoryId, score);
        associated++;
      }
    }

    return {
      success: true,
      outputs: { associated, flagged, topProject: scores[0]?.projectName },
      metrics: { confidence: scores[0]?.confidence ?? 0, itemsProcessed: 1 },
    };
  },
};
```

### Nightly Refresh Agent

```typescript
export const projectRefreshAgent: GardenerAgent = {
  name: 'refresh-project-associations',
  tier: 'periodic',

  async execute(context: AgentContext): Promise<JobResult> {
    const { log, checkpoint, restoreCheckpoint } = context;

    // Recompute associations for memories processed in the last 24 hours
    // This catches: updated entity profiles, new project entities, user confirmations
    const recentMemories = await getRecentUnassociatedMemories(24);

    log(`Refreshing associations for ${recentMemories.length} recent memories`);

    let updated = 0;
    for (const memory of recentMemories) {
      const scores = await computeAssociations(memory.id, memory.embedding, memory.conversationId);
      for (const score of scores) {
        await storeAssociation(memory.id, score);
        updated++;
      }

      if (updated % 50 === 0) {
        await checkpoint({ processed: updated, total: recentMemories.length });
      }
    }

    return {
      success: true,
      outputs: { memoriesChecked: recentMemories.length, associationsUpdated: updated },
      metrics: { confidence: 0.9, itemsProcessed: recentMemories.length },
    };
  },
};
```

### Ambiguity Surfacing (for W32 Morning Briefing)

```typescript
/**
 * Get unresolved ambiguities for the daily digest.
 * Called by the briefing service (W32).
 */
export async function getUnsurfacedAmbiguities(
  limit: number = 5,
): Promise<Array<{
  id: string;
  contentPreview: string;
  sourceDescription: string;
  candidates: Array<{ projectName: string; confidence: number }>;
}>> {
  const rows = await db.execute(sql`
    SELECT a.id, a.content_preview, a.source_description, a.candidates
    FROM association_ambiguities a
    WHERE a.resolved = false AND a.surfaced = false
    ORDER BY a.created_at DESC
    LIMIT ${limit}
  `);

  // Mark as surfaced so we don't show them again
  const ids = rows.rows.map((r: any) => r.id);
  if (ids.length > 0) {
    await db.execute(sql`
      UPDATE association_ambiguities SET surfaced = true
      WHERE id = ANY(${ids}::uuid[])
    `);
  }

  return rows.rows as any[];
}

/**
 * User confirms a project association (from daily digest interaction).
 */
export async function resolveAmbiguity(
  ambiguityId: string,
  confirmedProjectId: string,
): Promise<void> {
  // Get the ambiguity record
  const record = await db.execute(sql`
    SELECT memory_id FROM association_ambiguities WHERE id = ${ambiguityId}::uuid
  `);

  if (record.rows.length === 0) return;

  const memoryId = (record.rows[0] as { memory_id: string }).memory_id;

  // Store confirmed association with high confidence
  await db.execute(sql`
    INSERT INTO project_associations (memory_id, project_id, confidence, sources)
    VALUES (${memoryId}::uuid, ${confirmedProjectId}::uuid, 0.95, ARRAY['user_confirmed'])
    ON CONFLICT (memory_id, project_id) DO UPDATE SET
      confidence = 0.95,
      sources = ARRAY['user_confirmed'],
      computed_at = NOW()
  `);

  // Mark ambiguity as resolved
  await db.execute(sql`
    UPDATE association_ambiguities
    SET resolved = true, resolution = ${confirmedProjectId}::uuid, resolved_at = NOW()
    WHERE id = ${ambiguityId}::uuid
  `);

  // Strengthen the source binding for future messages from this channel
  // (retroactive learning from user confirmation)
  const memory = await db.execute(sql`
    SELECT conversation_id FROM processing_state WHERE trace_id = ${memoryId}::uuid
  `);

  if (memory.rows.length > 0) {
    const conversationId = (memory.rows[0] as { conversation_id: string }).conversation_id;
    if (conversationId) {
      await db.execute(sql`
        INSERT INTO source_bindings (channel_id, project_id, binding_type, weight)
        VALUES (${conversationId}, ${confirmedProjectId}::uuid, 'user_confirmed', 0.6)
        ON CONFLICT (channel_id, project_id) DO UPDATE SET
          weight = LEAST(0.9, source_bindings.weight + 0.1),
          binding_type = 'user_confirmed'
      `);
    }
  }
}
```

### Cross-Source Project Query

```typescript
/**
 * "Show me everything about Project X" — the cross-source query.
 */
export async function queryProject(projectId: string, options?: {
  minConfidence?: number;
  platform?: string;
  limit?: number;
}): Promise<{
  project: { id: string; name: string; description?: string };
  memories: Array<{ memoryId: string; confidence: number; sources: string[]; platform: string; content: string; createdAt: string }>;
  conversations: ConversationSummary[];
  relatedEntities: Array<{ id: string; name: string; type: string; relationship: string }>;
  openActionItems: Array<{ text: string; assignee?: string; dueDate?: string }>;
  decisions: Array<{ text: string; timestamp: string; source: string }>;
}> {
  const minConf = options?.minConfidence ?? 0.4;
  const limit = options?.limit ?? 50;

  // Get project entity
  const project = await getEntityById(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);

  // Get associated memories
  const assocRows = await db.execute(sql`
    SELECT pa.memory_id, pa.confidence, pa.sources
    FROM project_associations pa
    WHERE pa.project_id = ${projectId}::uuid
      AND pa.confidence >= ${minConf}
    ORDER BY pa.confidence DESC
    LIMIT ${limit}
  `);

  // Get conversation summaries mentioning this project
  const convRows = await db.execute(sql`
    SELECT * FROM conversation_summaries
    WHERE project_associations @> ${JSON.stringify([{ projectId }])}::jsonb
    ORDER BY last_updated DESC
    LIMIT 10
  `);

  // Get related entities via graph
  const relatedEntities = await findConnectedEntities(projectId, { maxDepth: 2 });

  // Aggregate action items and decisions from conversation summaries
  // ...

  return { project, memories, conversations, relatedEntities, openActionItems, decisions };
}
```

---

## Verification

### Automated Tests

```typescript
describe('Project Association', () => {
  it('should associate memory with project via entity overlap', async () => {
    // Given: Project Phoenix entity, memory mentioning Phoenix team member
    // When: computeAssociations()
    // Then: Score includes 'entity_overlap' source
  });

  it('should flag ambiguous associations', () => {
    const scores = [
      { projectId: 'a', projectName: 'Phoenix', confidence: 0.55, sources: ['entity_overlap'] },
      { projectId: 'b', projectName: 'Infra', confidence: 0.48, sources: ['vector'] },
    ];
    expect(isAmbiguous(scores)).toBe(true);
  });

  it('should not flag clear associations', () => {
    const scores = [
      { projectId: 'a', projectName: 'Phoenix', confidence: 0.85, sources: ['entity_overlap', 'vector'] },
      { projectId: 'b', projectName: 'Infra', confidence: 0.35, sources: ['vector'] },
    ];
    expect(isAmbiguous(scores)).toBe(false);
  });

  it('should strengthen source binding on user confirmation', async () => {
    // Given: Ambiguous association, user confirms Phoenix
    // When: resolveAmbiguity()
    // Then: source_bindings weight increased for that channel
  });
});
```

---

## Acceptance Criteria

- [ ] `computeAssociations()` scores projects using entity overlap + vector proximity + source binding
- [ ] `project_associations` table materializes scores for efficient querying
- [ ] `isAmbiguous()` detects when top candidates are too close
- [ ] Ambiguous items stored in `association_ambiguities` for daily digest
- [ ] `resolveAmbiguity()` records user confirmation and strengthens source binding
- [ ] `source_bindings` table stores soft channel-to-project hints
- [ ] Nightly refresh agent recomputes recent associations
- [ ] Real-time agent computes associations for new memories as they arrive
- [ ] `queryProject()` returns cross-source results (memories, conversations, entities, actions, decisions)
- [ ] Both agents registered with gardener controller

---

## Next Packet

- [W32: Morning Briefing](../phase5/W32-morning-briefing.md) — Consumes ambiguity digest
