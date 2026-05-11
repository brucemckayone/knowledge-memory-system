/**
 * Tiny persist helper for synthesis articles produced by the article-generator
 * agent. Lives in services/ so the agent module stays a pure generator and the
 * eventual patrol-side wiring is a one-line call.
 */
import { randomUUID } from 'node:crypto';
import { db, articles } from '../db/index.js';

export interface PersistArticleInput {
  type: 'synthesis' | 'cross_course_summary';
  title: string;
  contentMd: string;
  relatedEntityIds?: string[];
  relatedCourseIds?: string[];
}

/**
 * Insert one article row. Returns the generated id. generated_at + viewed_at
 * are set by table defaults (now / null respectively).
 */
export async function persistArticle(input: PersistArticleInput): Promise<{ id: string }> {
  const id = randomUUID();
  await db.insert(articles).values({
    id,
    type: input.type,
    title: input.title,
    contentMd: input.contentMd,
    relatedEntityIds: JSON.stringify(input.relatedEntityIds ?? []),
    relatedCourseIds: JSON.stringify(input.relatedCourseIds ?? []),
  });
  return { id };
}
