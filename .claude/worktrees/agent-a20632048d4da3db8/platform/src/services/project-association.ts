/**
 * Project Association Service (W45)
 *
 * Auto-detects and manages project groupings from entity clusters,
 * tag patterns, and source channel bindings.
 */

import { db } from '../db/index.js';
import {
  projectAssociations,
  sourceBindings,
  associationAmbiguities,
} from '../db/schema.js';
import { eq, isNull, desc } from 'drizzle-orm';
import { getActiveCommunities } from './communities.js';

/**
 * Get active projects.
 */
export async function getActiveProjects() {
  return db
    .select()
    .from(projectAssociations)
    .where(eq(projectAssociations.status, 'active'))
    .orderBy(desc(projectAssociations.updatedAt));
}

/**
 * Get a project by ID with its bindings.
 */
export async function getProjectById(projectId: string) {
  const project = await db
    .select()
    .from(projectAssociations)
    .where(eq(projectAssociations.id, projectId))
    .limit(1);

  if (!project[0]) return null;

  const bindings = await db
    .select()
    .from(sourceBindings)
    .where(eq(sourceBindings.projectId, projectId));

  return { ...project[0], bindings };
}

/**
 * Detect projects from community clusters.
 * Converts high-coherence communities into project associations.
 */
export async function detectProjects(
  options: { minCoherence?: number; minSize?: number } = {}
): Promise<number> {
  const { minCoherence = 0.3, minSize = 3 } = options;

  const communities = await getActiveCommunities();
  let created = 0;

  for (const community of communities) {
    if (community.size < minSize) continue;
    if ((community.coherenceScore || 0) < minCoherence) continue;

    // Check if a similar project already exists
    const existing = await db
      .select()
      .from(projectAssociations)
      .where(eq(projectAssociations.name, community.name || ''))
      .limit(1);

    if (existing.length > 0) continue;

    await db.insert(projectAssociations).values({
      name: community.name || `Project (${community.size} entities)`,
      description: community.description,
      entityIds: community.entityIds,
      autoDetected: true,
      confidence: community.coherenceScore || 0.5,
    });
    created++;
  }

  return created;
}

/**
 * Associate a memory with a project, or surface ambiguity.
 */
export async function associateMemory(
  memoryId: string,
  entityIds: string[],
  tags: string[],
): Promise<{ projectId: string | null; ambiguous: boolean }> {
  if (entityIds.length === 0 && tags.length === 0) {
    return { projectId: null, ambiguous: false };
  }

  // Find projects that share entities with this memory
  const projects = await getActiveProjects();
  const scores: Array<{ projectId: string; score: number }> = [];

  for (const project of projects) {
    const sharedEntities = project.entityIds.filter(id => entityIds.includes(id));
    const sharedTags = project.tagPatterns.filter(t => tags.includes(t));

    const entityScore = entityIds.length > 0 ? sharedEntities.length / entityIds.length : 0;
    const tagScore = tags.length > 0 ? sharedTags.length / tags.length : 0;
    const totalScore = entityScore * 0.7 + tagScore * 0.3;

    if (totalScore > 0.1) {
      scores.push({ projectId: project.id, score: totalScore });
    }
  }

  scores.sort((a, b) => b.score - a.score);

  if (scores.length === 0) {
    return { projectId: null, ambiguous: false };
  }

  if (scores.length === 1 || (scores[0]!.score - (scores[1]?.score || 0)) > 0.3) {
    // Clear winner
    return { projectId: scores[0]!.projectId, ambiguous: false };
  }

  // Ambiguous — surface for resolution
  await db.insert(associationAmbiguities).values({
    memoryId,
    candidateProjectIds: scores.slice(0, 5).map(s => s.projectId),
    scores: Object.fromEntries(scores.slice(0, 5).map(s => [s.projectId, s.score])),
  });

  return { projectId: scores[0]!.projectId, ambiguous: true };
}

/**
 * Get unresolved ambiguities.
 */
export async function getUnresolvedAmbiguities(limit = 20) {
  return db
    .select()
    .from(associationAmbiguities)
    .where(isNull(associationAmbiguities.resolvedAt))
    .orderBy(desc(associationAmbiguities.createdAt))
    .limit(limit);
}

/**
 * Resolve an ambiguity.
 */
export async function resolveAmbiguity(
  ambiguityId: string,
  projectId: string,
  resolvedBy = 'user',
): Promise<void> {
  await db
    .update(associationAmbiguities)
    .set({
      resolvedProjectId: projectId,
      resolvedAt: new Date(),
      resolvedBy,
    })
    .where(eq(associationAmbiguities.id, ambiguityId));
}
