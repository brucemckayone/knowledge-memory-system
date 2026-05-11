/**
 * Project Association Tests (W45)
 *
 * Tests project detection from communities, memory association,
 * ambiguity surfacing, and resolution.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { testDb, createTestEntity, deleteFromTables, randomUUID } from '../setup.js';
import {
  getActiveProjects,
  getProjectById,
  detectProjects,
  associateMemory,
  getUnresolvedAmbiguities,
  resolveAmbiguity,
} from '../../services/project-association.js';

describe('Project Association Service', () => {
  it('exports expected functions', () => {
    expect(typeof getActiveProjects).toBe('function');
    expect(typeof getProjectById).toBe('function');
    expect(typeof detectProjects).toBe('function');
    expect(typeof associateMemory).toBe('function');
    expect(typeof getUnresolvedAmbiguities).toBe('function');
    expect(typeof resolveAmbiguity).toBe('function');
  });
});

describe('Project Association Agent', () => {
  it('has correct name and tier', async () => {
    const { projectAssociationAgent } = await import('../../gardener/agents/project-association.agent.js');
    expect(projectAssociationAgent.name).toBe('project-association');
    expect(projectAssociationAgent.tier).toBe('realtime');
  });
});

describe('Project Refresh Agent', () => {
  it('has correct name and tier', async () => {
    const { projectRefreshAgent } = await import('../../gardener/agents/project-refresh.agent.js');
    expect(projectRefreshAgent.name).toBe('project-refresh');
    expect(projectRefreshAgent.tier).toBe('periodic');
  });
});

describe('Project detection and association', () => {
  beforeEach(async () => {
    await deleteFromTables(
      'association_ambiguities', 'source_bindings', 'project_associations',
      'insights', 'communities', 'entities',
    );
  });

  async function seedCommunity(name: string, size: number, coherence: number): Promise<{ communityId: string; entityIds: string[] }> {
    const entityIds: string[] = [];
    for (let i = 0; i < size; i++) {
      const e = await createTestEntity({ canonicalName: `${name}-member-${i}`, entityType: 'person' });
      entityIds.push(e.id);
    }
    const communityId = randomUUID();
    await testDb`
      INSERT INTO communities (id, name, entity_ids, coherence_score, size)
      VALUES (${communityId}::uuid, ${name}, ${testDb.array(entityIds)}::uuid[], ${coherence}, ${size})
    `;
    return { communityId, entityIds };
  }

  it('detectProjects creates projects from qualifying communities', async () => {
    await seedCommunity('Big Project', 5, 0.8);
    await seedCommunity('Small Cluster', 2, 0.1); // Below minSize=3 AND minCoherence=0.3

    const created = await detectProjects();
    expect(created).toBe(1);

    const projects = await getActiveProjects();
    expect(projects.length).toBe(1);
    expect(projects[0]!.name).toBe('Big Project');
  });

  it('detectProjects skips already-existing projects', async () => {
    await seedCommunity('Existing', 4, 0.5);

    const first = await detectProjects();
    expect(first).toBe(1);

    const second = await detectProjects();
    expect(second).toBe(0); // Already exists
  });

  it('getProjectById returns project with bindings', async () => {
    await seedCommunity('Test Project', 3, 0.6);
    await detectProjects();

    const projects = await getActiveProjects();
    const project = await getProjectById(projects[0]!.id);
    expect(project).not.toBeNull();
    expect(project!.name).toBe('Test Project');
    expect(project!.bindings).toBeDefined();
  });

  it('associateMemory finds matching project', async () => {
    const { entityIds } = await seedCommunity('Match Project', 3, 0.6);
    await detectProjects();

    // Associate a memory sharing entities with the project
    const result = await associateMemory(randomUUID(), entityIds.slice(0, 2), []);
    expect(result.projectId).not.toBeNull();
    expect(result.ambiguous).toBe(false);
  });

  it('associateMemory returns null for unrelated entities', async () => {
    await seedCommunity('Unrelated', 3, 0.6);
    await detectProjects();

    // Memory with completely different entities
    const result = await associateMemory(randomUUID(), [randomUUID()], []);
    expect(result.projectId).toBeNull();
  });

  it('associateMemory surfaces ambiguity when scores are close', async () => {
    // Create two projects with overlapping entities
    const e1 = await createTestEntity({ canonicalName: 'Shared', entityType: 'person' });
    const e2 = await createTestEntity({ canonicalName: 'ProjectA-only', entityType: 'person' });
    const e3 = await createTestEntity({ canonicalName: 'ProjectB-only', entityType: 'person' });

    // Create two projects that both contain the shared entity
    await testDb`
      INSERT INTO project_associations (name, entity_ids, status, confidence)
      VALUES ('Project A', ARRAY[${e1.id}::uuid, ${e2.id}::uuid], 'active', 0.8)
    `;
    await testDb`
      INSERT INTO project_associations (name, entity_ids, status, confidence)
      VALUES ('Project B', ARRAY[${e1.id}::uuid, ${e3.id}::uuid], 'active', 0.8)
    `;

    // Memory shares the shared entity — should be ambiguous
    const result = await associateMemory(randomUUID(), [e1.id], []);
    expect(result.ambiguous).toBe(true);

    const ambiguities = await getUnresolvedAmbiguities();
    expect(ambiguities.length).toBeGreaterThanOrEqual(1);
  });

  it('resolveAmbiguity marks ambiguity as resolved', async () => {
    const memoryId = randomUUID();
    const projectId = randomUUID();
    await testDb`
      INSERT INTO project_associations (id, name, entity_ids, status, confidence)
      VALUES (${projectId}::uuid, 'Target', '{}', 'active', 0.5)
    `;
    await testDb`
      INSERT INTO association_ambiguities (memory_id, candidate_project_ids, scores)
      VALUES (${memoryId}::uuid, ARRAY[${projectId}::uuid], '{}')
    `;

    const ambiguities = await getUnresolvedAmbiguities();
    expect(ambiguities.length).toBeGreaterThanOrEqual(1);

    await resolveAmbiguity(ambiguities[0]!.id, projectId, 'user');

    const after = await getUnresolvedAmbiguities();
    const stillOpen = after.filter(a => a.memoryId === memoryId);
    expect(stillOpen.length).toBe(0);
  });
});
