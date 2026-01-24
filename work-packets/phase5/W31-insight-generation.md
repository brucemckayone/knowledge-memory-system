# Work Packet W31: Insight Generation

**Status:** Ready to Implement  
**Dependencies:** W30 (Community Detection)  
**Estimated Time:** 3-4 hours

---

## Objective

Implement insight generation that analyzes communities, patterns, and knowledge graph structure to surface interesting connections and observations.

---

## Research Reference

From [GARDENER_RESEARCH.md](../GARDENER_RESEARCH.md) lines 427-449:
- Pattern detection across memories
- Cross-community insight generation
- Surfacing non-obvious connections

---

## Implementation

### Insight Types

```typescript
export type InsightType = 
  | 'connection'      // Non-obvious connection between entities
  | 'trend'           // Temporal pattern in knowledge
  | 'gap'             // Missing information detected
  | 'contradiction'   // Conflicting facts
  | 'milestone'       // Important event/achievement
  | 'recommendation'; // Actionable suggestion
```

### Insight Service

Create `platform/src/services/insights.ts`:

```typescript
import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';
import { config } from '../config.js';

export interface Insight {
  id: string;
  type: InsightType;
  title: string;
  description: string;
  entities: string[];
  confidence: number;
  evidence: string[];
  createdAt: Date;
  expiresAt?: Date;
  dismissed: boolean;
}

/**
 * Generate insights from communities and patterns
 */
export async function generateInsights(): Promise<Insight[]> {
  const insights: Insight[] = [];
  
  // 1. Cross-community connections
  const connectionInsights = await findCrossConnections();
  insights.push(...connectionInsights);
  
  // 2. Temporal trends
  const trendInsights = await detectTrends();
  insights.push(...trendInsights);
  
  // 3. Knowledge gaps
  const gapInsights = await findKnowledgeGaps();
  insights.push(...gapInsights);
  
  // Store insights
  for (const insight of insights) {
    await storeInsight(insight);
  }
  
  return insights;
}

/**
 * Find cross-community connections
 */
async function findCrossConnections(): Promise<Insight[]> {
  const result = await db.execute(sql`
    WITH community_edges AS (
      SELECT 
        c1.id as comm1,
        c2.id as comm2,
        c1.name as comm1_name,
        c2.name as comm2_name,
        COUNT(*) as edge_count
      FROM communities c1, communities c2, facts f
      WHERE c1.id != c2.id
        AND f.subject_entity_id = ANY(SELECT jsonb_array_elements_text(c1.entity_ids))
        AND f.object_entity_id = ANY(SELECT jsonb_array_elements_text(c2.entity_ids))
        AND f.expired_at IS NULL
      GROUP BY c1.id, c2.id, c1.name, c2.name
      HAVING COUNT(*) >= 2
    )
    SELECT * FROM community_edges ORDER BY edge_count DESC LIMIT 10
  `);
  
  return result.rows.map((row: any) => ({
    id: `insight-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: 'connection' as const,
    title: `Bridge between ${row.comm1_name} and ${row.comm2_name}`,
    description: `Found ${row.edge_count} connections linking these knowledge areas.`,
    entities: [row.comm1, row.comm2],
    confidence: Math.min(0.9, row.edge_count / 10),
    evidence: [],
    createdAt: new Date(),
    dismissed: false,
  }));
}

/**
 * Detect temporal trends
 */
async function detectTrends(): Promise<Insight[]> {
  // Find entities with increasing activity
  const result = await db.execute(sql`
    WITH recent_activity AS (
      SELECT 
        subject_entity_id,
        COUNT(*) as fact_count,
        MAX(created_at) as last_activity
      FROM facts
      WHERE created_at > NOW() - INTERVAL '7 days'
        AND expired_at IS NULL
      GROUP BY subject_entity_id
      HAVING COUNT(*) >= 3
    ),
    entity_info AS (
      SELECT e.id, e.canonical_name, r.fact_count, r.last_activity
      FROM entities e
      JOIN recent_activity r ON e.id = r.subject_entity_id
    )
    SELECT * FROM entity_info ORDER BY fact_count DESC LIMIT 5
  `);
  
  return result.rows.map((row: any) => ({
    id: `insight-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: 'trend' as const,
    title: `Increasing activity: ${row.canonical_name}`,
    description: `${row.fact_count} new facts recorded in the last week.`,
    entities: [row.id],
    confidence: 0.7,
    evidence: [],
    createdAt: new Date(),
    dismissed: false,
  }));
}

/**
 * Find knowledge gaps
 */
async function findKnowledgeGaps(): Promise<Insight[]> {
  // Find entities with few connections
  const result = await db.execute(sql`
    WITH entity_degrees AS (
      SELECT 
        e.id,
        e.canonical_name,
        e.entity_type,
        COUNT(DISTINCT f.id) as fact_count
      FROM entities e
      LEFT JOIN facts f ON (
        f.subject_entity_id = e.id OR f.object_entity_id = e.id
      )
      WHERE e.created_at > NOW() - INTERVAL '30 days'
      GROUP BY e.id, e.canonical_name, e.entity_type
      HAVING COUNT(DISTINCT f.id) < 2
    )
    SELECT * FROM entity_degrees
    WHERE entity_type IN ('person', 'project', 'company')
    ORDER BY fact_count ASC
    LIMIT 5
  `);
  
  return result.rows.map((row: any) => ({
    id: `insight-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: 'gap' as const,
    title: `Limited information: ${row.canonical_name}`,
    description: `Only ${row.fact_count} facts known about this ${row.entity_type}.`,
    entities: [row.id],
    confidence: 0.6,
    evidence: [],
    createdAt: new Date(),
    dismissed: false,
  }));
}

/**
 * Store insight
 */
async function storeInsight(insight: Insight): Promise<void> {
  await db.execute(sql`
    INSERT INTO insights (id, type, title, description, entities, confidence, evidence, created_at, dismissed)
    VALUES (
      ${insight.id},
      ${insight.type},
      ${insight.title},
      ${insight.description},
      ${JSON.stringify(insight.entities)},
      ${insight.confidence},
      ${JSON.stringify(insight.evidence)},
      ${insight.createdAt},
      ${insight.dismissed}
    )
  `);
}

/**
 * Get pending insights for user
 */
export async function getPendingInsights(limit: number = 10): Promise<Insight[]> {
  const result = await db.execute(sql`
    SELECT * FROM insights
    WHERE dismissed = false
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY confidence DESC, created_at DESC
    LIMIT ${limit}
  `);
  
  return result.rows.map(rowToInsight);
}

/**
 * Dismiss insight
 */
export async function dismissInsight(insightId: string): Promise<void> {
  await db.execute(sql`
    UPDATE insights SET dismissed = true WHERE id = ${insightId}
  `);
}

function rowToInsight(row: any): Insight {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    description: row.description,
    entities: JSON.parse(row.entities),
    confidence: row.confidence,
    evidence: JSON.parse(row.evidence || '[]'),
    createdAt: new Date(row.created_at),
    expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
    dismissed: row.dismissed,
  };
}
```

### Schema Addition

Create `platform/src/db/migrations/010_insights.sql`:

```sql
CREATE TABLE IF NOT EXISTS insights (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  entities JSONB NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0.5,
  evidence JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP WITH TIME ZONE,
  dismissed BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_insights_type ON insights(type);
CREATE INDEX idx_insights_dismissed ON insights(dismissed);
CREATE INDEX idx_insights_confidence ON insights(confidence DESC);
```

### Agent Registration

Create `platform/src/gardener/agents/insight-agent.ts`:

```typescript
import { GardenerAgent, AgentContext, AgentResult } from './types.js';
import { generateInsights } from '../../services/insights.js';

export const insightAgent: GardenerAgent<{}, { insightsGenerated: number }> = {
  name: 'insight-generation',
  tier: 'background',
  
  async process(
    job: {},
    context: AgentContext
  ): Promise<AgentResult<{ insightsGenerated: number }>> {
    const startTime = Date.now();
    
    try {
      const insights = await generateInsights();
      
      context.logger.info(`Generated ${insights.length} insights`);
      
      return {
        success: true,
        data: { insightsGenerated: insights.length },
        metrics: {
          durationMs: Date.now() - startTime,
          insights: insights.length,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        metrics: { durationMs: Date.now() - startTime },
      };
    }
  },
};
```

---

## Testing

```bash
# Generate insights manually
curl -X POST http://localhost:3001/api/gardener/queue \
  -H "Content-Type: application/json" \
  -d '{"agent": "insight-generation", "job": {}}'

# View insights
curl http://localhost:3001/api/insights
```

---

## Acceptance Criteria

- [ ] Cross-community connections detected
- [ ] Temporal trends identified
- [ ] Knowledge gaps found
- [ ] Insights stored in database
- [ ] API endpoint returns insights
- [ ] Dismiss functionality works

---

## Next Packet

- [W32: Morning Briefing](./W32-morning-briefing.md) - Compile daily briefing
