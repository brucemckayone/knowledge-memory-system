/**
 * Presentation-mode helpers.
 *
 * When a course is flagged `presentation_mode = 1` it is part of a live demo.
 * Every agent that produces user-visible prose (course generator, lesson
 * outliner / prose / orchestrator, chat tutor, gap analyzer, answer evaluator)
 * appends a single addendum to its system prompt that biases output toward an
 * explanatory, audience-aware register with light meta self-reference where
 * the system is describing its own mechanism.
 *
 * The flag is resolved at agent boundary — usually by reading
 * `courses.presentation_mode` for the relevant course id. Agents accept it as
 * an explicit boolean rather than each one re-querying the DB, so the seed
 * script (which already knows the value) can pass it directly.
 */

import { eq } from 'drizzle-orm';
import { db, courses, sections, chatSessions } from '../db/index.js';

export const PRESENTATION_MODE_ADDENDUM = `

=== PRESENTATION MODE ===

This course is part of a live demo of the underlying knowledge graph system. The audience watching is technically literate — engineers, researchers, designers — and is here to understand HOW the system reasons, not just what the surface content says.

Register guidance — applies to the CONTENT of your output (prose strings, descriptions, takeaways, lesson body, chat replies), NOT to its STRUCTURE:
- Favor an explanatory register: short clear sentences, named mechanisms, concrete examples drawn from the actual graph state where you have it.
- Where it lands naturally, allow light meta self-reference — acknowledge that the system is describing its own mechanism. Do not force this; only use it where it clarifies.
- Avoid filler, marketing register, and over-hedging. Prefer "the graph stores X as Y" over "the graph can sometimes store X in various ways".
- Pace for an audience that is reading along: front-load the load-bearing idea of each paragraph; one idea per block.
- When the topic is itself a graph mechanism (audit trail, blast radius, contradiction detection, causal chain), be specific about how the mechanism works rather than abstracting.

Output format is UNCHANGED. If your task requires strict JSON output, you MUST still emit valid JSON exactly as specified above — no narrative wrapper, no markdown fences, no extra prose. If your task requires a fully populated structured object (sections, items, blocks, follow-up questions, etc.), you MUST populate every required field at the same level of completeness as a non-presentation-mode run. Presentation mode adjusts the WORDING inside those fields, never the schema, never the count of items, never whether to include them.`;

/**
 * Append the presentation-mode addendum to a base system prompt iff the flag
 * is set. Returns the original prompt unchanged when the flag is false / undef.
 */
export function withPresentationMode(systemPrompt: string, on: boolean | undefined): string {
  return on ? systemPrompt + PRESENTATION_MODE_ADDENDUM : systemPrompt;
}

/** Look up presentation_mode for a course id. Returns false on miss. */
export async function getPresentationModeForCourse(courseId: string | null | undefined): Promise<boolean> {
  if (!courseId) return false;
  const [row] = await db
    .select({ presentationMode: courses.presentationMode })
    .from(courses)
    .where(eq(courses.id, courseId));
  return Boolean(row?.presentationMode);
}

/** Look up presentation_mode for a section id (joins through courses). */
export async function getPresentationModeForSection(sectionId: string | null | undefined): Promise<boolean> {
  if (!sectionId) return false;
  const [row] = await db
    .select({ presentationMode: courses.presentationMode })
    .from(sections)
    .innerJoin(courses, eq(courses.id, sections.courseId))
    .where(eq(sections.id, sectionId));
  return Boolean(row?.presentationMode);
}

/** Look up presentation_mode for a chat session — sessions may reference a course or a section. */
export async function getPresentationModeForChatSession(sessionId: string | null | undefined): Promise<boolean> {
  if (!sessionId) return false;
  const [session] = await db
    .select({ courseId: chatSessions.courseId, sectionId: chatSessions.sectionId })
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId));
  if (!session) return false;
  if (session.sectionId) return getPresentationModeForSection(session.sectionId);
  if (session.courseId) return getPresentationModeForCourse(session.courseId);
  return false;
}
