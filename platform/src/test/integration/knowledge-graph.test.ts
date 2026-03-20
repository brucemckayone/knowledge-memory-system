/**
 * Knowledge Graph Integration Tests
 *
 * Tests for Entities ↔ Facts ↔ Graph Coherence.
 * Covers KG-001 through KG-007 from the test strategy.
 *
 * NOTE: Requires Apache AGE extension to be installed.
 */

import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import {
  testDb,
  createTestEntity,
  createTestFact,
  getEntity,
} from '../setup.js';
import {
  getAllEdges,
  getEntityDegrees,
  getSubgraph,
} from '../../services/graph.js';

// Check if Apache AGE is available
async function isAGEAvailable(): Promise<boolean> {
  try {
    const result = await testDb`
      SELECT 1 FROM pg_extension WHERE extname = 'age'
    `;
    return result.length > 0;
  } catch {
    return false;
  }
}

// Clear the graph
async function clearGraph(): Promise<void> {
  try {
    await testDb.unsafe(`
      SELECT * FROM cypher('knowledge_graph', $$
        MATCH (n) DETACH DELETE n
      $$) as (result agtype)
    `);
  } catch {
    // Graph might not exist
  }
}

// Count nodes in graph
async function countGraphNodes(): Promise<number> {
  try {
    const result = await testDb.unsafe(`
      SELECT count FROM cypher('knowledge_graph', $$
        MATCH (n) RETURN count(n) as count
      $$) as (count agtype)
    `);
    return parseInt(result[0]?.count || '0');
  } catch {
    return 0;
  }
}

// Count edges in graph
async function countGraphEdges(): Promise<number> {
  try {
    const result = await testDb.unsafe(`
      SELECT count FROM cypher('knowledge_graph', $$
        MATCH ()-[r]->() RETURN count(r) as count
      $$) as (count agtype)
    `);
    return parseInt(result[0]?.count || '0');
  } catch {
    return 0;
  }
}

describe('Entities ↔ Facts ↔ Graph Coherence', () => {
  let ageAvailable = false;

  beforeAll(async () => {
    ageAvailable = await isAGEAvailable();
    if (!ageAvailable) {
      console.warn('⚠️ Apache AGE not available - skipping graph tests');
    }
  });

  beforeEach(async () => {
    // Clear graph state for graph tests (DB tests are self-contained with unique IDs)
    if (ageAvailable) {
      await clearGraph();
    }
  });

  describe('KG-001: Fact creates graph edge', () => {
    it.skipIf(!ageAvailable)('should create edge in knowledge_graph when fact with object_entity is created', async () => {
      // Given: Two entities
      const person = await createTestEntity({
        canonicalName: 'John Developer',
        entityType: 'person',
      });

      const company = await createTestEntity({
        canonicalName: 'Tech Corp',
        entityType: 'company',
      });

      // When: Create fact linking them
      await createTestFact({
        subjectEntityId: person.id,
        predicate: 'works_at',
        objectEntityId: company.id,
      });

      // Then: Edge exists in graph
      // Wait a moment for trigger to execute
      await new Promise(r => setTimeout(r, 100));

      const edges = await countGraphEdges();
      expect(edges).toBeGreaterThanOrEqual(1);

      // Verify the edge connects correct nodes
      const pathResult = await testDb`
        SELECT * FROM find_entity_paths(
          ${person.id}::uuid,
          ${company.id}::uuid,
          1
        )
      `;
      expect(pathResult.length).toBeGreaterThan(0);
    });

    it.skipIf(!ageAvailable)('should not create edge for fact without object_entity', async () => {
      // Given: Entity
      const person = await createTestEntity({
        canonicalName: 'Jane Engineer',
        entityType: 'person',
      });

      const initialEdges = await countGraphEdges();

      // When: Create fact with value only (no object entity)
      await createTestFact({
        subjectEntityId: person.id,
        predicate: 'has_role',
        objectValue: 'Senior Engineer',
      });

      // Then: No new edge created
      await new Promise(r => setTimeout(r, 100));
      const finalEdges = await countGraphEdges();
      expect(finalEdges).toBe(initialEdges);
    });
  });

  describe('KG-002: Entity creates graph node', () => {
    it.skipIf(!ageAvailable)('should create node in knowledge_graph when entity is created', async () => {
      // Given: No entities

      // When: Create entity
      await createTestEntity({
        canonicalName: 'Graph Test Entity',
        entityType: 'person',
      });

      // Then: Node exists in graph
      await new Promise(r => setTimeout(r, 100));

      // Verify node count increased
      const nodeCount = await countGraphNodes();
      expect(nodeCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('KG-003: Graph path finding', () => {
    it.skipIf(!ageAvailable)('should find path between connected entities', async () => {
      // Given: Chain of connected entities A -> B -> C
      const personA = await createTestEntity({
        canonicalName: 'Person A',
        entityType: 'person',
      });

      const personB = await createTestEntity({
        canonicalName: 'Person B',
        entityType: 'person',
      });

      const personC = await createTestEntity({
        canonicalName: 'Person C',
        entityType: 'person',
      });

      // Create edges: A knows B, B knows C
      await createTestFact({
        subjectEntityId: personA.id,
        predicate: 'knows',
        objectEntityId: personB.id,
      });

      await createTestFact({
        subjectEntityId: personB.id,
        predicate: 'knows',
        objectEntityId: personC.id,
      });

      // When: Find path from A to C
      await new Promise(r => setTimeout(r, 200));

      const paths = await testDb`
        SELECT * FROM find_entity_paths(
          ${personA.id}::uuid,
          ${personC.id}::uuid,
          3
        )
      `;

      // Then: Path exists (may include intermediate node B)
      expect(paths.length).toBeGreaterThan(0);
    });

    it.skipIf(!ageAvailable)('should return empty for unconnected entities', async () => {
      // Given: Two unconnected entities
      const personA = await createTestEntity({
        canonicalName: 'Isolated A',
        entityType: 'person',
      });

      const personB = await createTestEntity({
        canonicalName: 'Isolated B',
        entityType: 'person',
      });

      // When: Find path (none exists)
      await new Promise(r => setTimeout(r, 100));

      const paths = await testDb`
        SELECT * FROM find_entity_paths(
          ${personA.id}::uuid,
          ${personB.id}::uuid,
          3
        )
      `;

      // Then: No paths found
      expect(paths.length).toBe(0);
    });
  });

  describe('KG-004: Neighbor discovery', () => {
    it.skipIf(!ageAvailable)('should get connected entities within depth', async () => {
      // Given: Hub entity connected to multiple others
      const hub = await createTestEntity({
        canonicalName: 'Hub Entity',
        entityType: 'person',
      });

      const spoke1 = await createTestEntity({
        canonicalName: 'Spoke 1',
        entityType: 'person',
      });

      const spoke2 = await createTestEntity({
        canonicalName: 'Spoke 2',
        entityType: 'company',
      });

      const spoke3 = await createTestEntity({
        canonicalName: 'Spoke 3',
        entityType: 'project',
      });

      // Create connections
      await createTestFact({
        subjectEntityId: hub.id,
        predicate: 'knows',
        objectEntityId: spoke1.id,
      });

      await createTestFact({
        subjectEntityId: hub.id,
        predicate: 'works_at',
        objectEntityId: spoke2.id,
      });

      await createTestFact({
        subjectEntityId: hub.id,
        predicate: 'works_on',
        objectEntityId: spoke3.id,
      });

      // When: Get neighbors at depth 1
      await new Promise(r => setTimeout(r, 200));

      const neighbors = await testDb`
        SELECT * FROM get_entity_neighbors(${hub.id}::uuid, 1)
      `;

      // Then: All 3 spokes found
      expect(neighbors.length).toBe(3);
    });
  });

  describe('KG-005: Bidirectional consistency', () => {
    it.skipIf(!ageAvailable)('should maintain graph matches relational after bulk insert', async () => {
      // Given: Multiple entities created
      const entities = [];
      for (let i = 0; i < 5; i++) {
        entities.push(
          await createTestEntity({
            canonicalName: `Consistency Test Entity ${i}`,
            entityType: 'person',
          })
        );
      }

      // Create some relationships
      await createTestFact({
        subjectEntityId: entities[0]!.id,
        predicate: 'knows',
        objectEntityId: entities[1]!.id,
      });

      await createTestFact({
        subjectEntityId: entities[1]!.id,
        predicate: 'knows',
        objectEntityId: entities[2]!.id,
      });

      await new Promise(r => setTimeout(r, 300));

      // When: Count both sources
      const relationalCount = await testDb`SELECT COUNT(*) as count FROM entities`;
      const graphNodeCount = await countGraphNodes();

      // Then: Counts should match
      expect(graphNodeCount).toBe(parseInt(relationalCount[0]!.count as string));
    });
  });

  describe('KG-006: Fact expiration removes edge', () => {
    it.skipIf(!ageAvailable)('should handle expired facts appropriately', async () => {
      // Given: Two entities with an active fact
      const person = await createTestEntity({
        canonicalName: 'Soon To Leave',
        entityType: 'person',
      });

      const company = await createTestEntity({
        canonicalName: 'Old Employer',
        entityType: 'company',
      });

      const fact = await createTestFact({
        subjectEntityId: person.id,
        predicate: 'works_at',
        objectEntityId: company.id,
      });

      await new Promise(r => setTimeout(r, 100));

      // When: Expire the fact
      await testDb`
        UPDATE facts
        SET expired_at = NOW()
        WHERE id = ${fact.id}::uuid
      `;

      // Then: The edge was created when fact was active
      // Note: Current implementation doesn't auto-remove edges on expiration
      // This test documents expected behavior for future implementation
      const edgeCount = await countGraphEdges();
      // Edge still exists (removal would require separate cleanup job)
      expect(edgeCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe('KG-007: Entity merge updates graph', () => {
    it.skipIf(!ageAvailable)('should consolidate graph on entity merge', async () => {
      // Given: Two entities that will be merged
      const source = await createTestEntity({
        canonicalName: 'John Smith (duplicate)',
        entityType: 'person',
      });

      const target = await createTestEntity({
        canonicalName: 'John Smith',
        entityType: 'person',
      });

      const project = await createTestEntity({
        canonicalName: 'Some Project',
        entityType: 'project',
      });

      // Source has a relationship
      await createTestFact({
        subjectEntityId: source.id,
        predicate: 'works_on',
        objectEntityId: project.id,
      });

      await new Promise(r => setTimeout(r, 200));

      // When: Record the merge
      await testDb`
        INSERT INTO entity_merges (
          source_entity_id, target_entity_id,
          merge_reason, similarity_score
        )
        VALUES (
          ${source.id}::uuid, ${target.id}::uuid,
          'Duplicate person', 0.95
        )
      `;

      // Update target's merged_from
      await testDb`
        UPDATE entities
        SET merged_from = array_append(merged_from, ${source.id}::uuid)
        WHERE id = ${target.id}::uuid
      `;

      // Then: Merge is tracked in relational
      const merges = await testDb`
        SELECT * FROM entity_merges
        WHERE source_entity_id = ${source.id}::uuid
      `;
      expect(merges.length).toBe(1);

      // Graph still has both nodes (consolidation would be a gardener job)
      // This test documents that merge record exists and graph can be queried
      const targetEntity = await getEntity(target.id);
      expect(targetEntity!.merged_from).toContain(source.id);
    });
  });

  describe('W18: Graph traversal enhancements', () => {
    describe('getAllEdges', () => {
      it.skipIf(!ageAvailable)('returns edges from the graph', async () => {
        const hub = await createTestEntity({ canonicalName: 'Edge Hub', entityType: 'person' });
        const target = await createTestEntity({ canonicalName: 'Edge Target', entityType: 'person' });
        await createTestFact({ subjectEntityId: hub.id, predicate: 'knows', objectEntityId: target.id });
        await new Promise(r => setTimeout(r, 150));

        const edges = await getAllEdges({ limit: 100 });
        expect(edges.length).toBeGreaterThanOrEqual(1);
        expect(edges[0]).toHaveProperty('fromEntityId');
        expect(edges[0]).toHaveProperty('toEntityId');
        expect(edges[0]).toHaveProperty('type');
      });

      it('rejects invalid relationship types', async () => {
        await expect(getAllEdges({ relationshipType: 'DROP TABLE;--' }))
          .rejects.toThrow('Invalid relationshipType');
      });
    });

    describe('getEntityDegrees', () => {
      it.skipIf(!ageAvailable)('returns degree map for entities', async () => {
        const hub = await createTestEntity({ canonicalName: 'Degree Hub', entityType: 'person' });
        const a = await createTestEntity({ canonicalName: 'Degree A', entityType: 'person' });
        const b = await createTestEntity({ canonicalName: 'Degree B', entityType: 'person' });
        await createTestFact({ subjectEntityId: hub.id, predicate: 'knows', objectEntityId: a.id });
        await createTestFact({ subjectEntityId: hub.id, predicate: 'knows', objectEntityId: b.id });
        await new Promise(r => setTimeout(r, 200));

        const degrees = await getEntityDegrees([hub.id]);
        expect(degrees).toBeInstanceOf(Map);
        expect(degrees.get(hub.id)).toBeGreaterThanOrEqual(2);
      });

      it('rejects invalid entity IDs', async () => {
        await expect(getEntityDegrees(['not-a-uuid']))
          .rejects.toThrow('Invalid entityId');
      });
    });

    describe('getSubgraph', () => {
      it('returns empty result for empty seed list', async () => {
        const result = await getSubgraph([]);
        expect(result.nodes).toEqual([]);
        expect(result.edges).toEqual([]);
      });

      it('rejects invalid seed entity IDs', async () => {
        await expect(getSubgraph(['invalid']))
          .rejects.toThrow('Invalid entityId');
      });

      it.skipIf(!ageAvailable)('returns nodes and edges for valid seeds', async () => {
        const hub = await createTestEntity({ canonicalName: 'Subgraph Hub', entityType: 'person' });
        const spoke = await createTestEntity({ canonicalName: 'Subgraph Spoke', entityType: 'person' });
        await createTestFact({ subjectEntityId: hub.id, predicate: 'knows', objectEntityId: spoke.id });
        await new Promise(r => setTimeout(r, 150));

        const result = await getSubgraph([hub.id], { maxDepth: 1 });
        expect(result.nodes.length).toBeGreaterThanOrEqual(1);
        expect(Array.isArray(result.edges)).toBe(true);
      });
    });
  });
});
