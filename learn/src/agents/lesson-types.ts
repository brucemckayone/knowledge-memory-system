/**
 * Shared types for the lesson pipeline. Kept in its own module so the
 * outliner / prose writer / artifact generator can import these without
 * pulling in the orchestrator (which would create a cycle).
 */

/** A web source surfaced by a lesson agent. Attached to the LessonBlock that
 *  referenced it so downstream UI can render it as a citation, and so the
 *  composer can ingest the URL back into the Nmemo graph. */
export interface LessonCitation {
  url: string;
  title?: string;
  /** ISO timestamp the URL was fetched / cited. */
  accessedAt?: string;
}
