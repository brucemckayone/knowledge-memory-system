/**
 * smoke-7si-e2e.ts — opt-in end-to-end smoke for nmemo-7si AC #14.
 *
 * Verifies that `generateLessonAuto` produces a *visibly different* lesson
 * for the same section depending on whether the learner has confused_by /
 * lacks_prerequisite facts seeded for one of the section's concepts.
 *
 * USAGE
 *   LIVE=1 pnpm tsx scripts/smoke-7si-e2e.ts
 *
 * Without LIVE=1 the script prints a skip notice and exits 0 — safe to
 * import (no top-level platform calls, no top-level await).
 *
 * REQUIRES (when LIVE=1)
 *   - Nmemo platform reachable at NMEMO_URL (default http://localhost:3001)
 *   - Claude CLI on PATH (used by the lesson agent pipeline)
 *   - learn.db migrated locally (script writes a temp section row)
 *
 * SCOPE
 *   1. Seeds an in-memory section + 2 concept entities in the Nmemo graph
 *      (course generator-equivalent, but only the minimum needed).
 *   2. Cold-start run: generateLessonAuto with no learner facts → capture blocks.
 *   3. Personalised run: seed `confused_by` + `lacks_prerequisite` against
 *      one concept, re-run generateLessonAuto → capture blocks.
 *   4. Asserts:
 *        a. cold-start lesson has >=3 blocks (sanity: not collapsed)
 *        b. personalised lesson contains the seeded concept name in some prose
 *        c. personalised lesson has >=1 block whose text is plausibly remedial
 *           (matches /remediation|review|prerequisite|recap| <conceptName>/i)
 *   5. Best-effort cleanup: drops the temp section row. Seeded facts in the
 *      Nmemo graph remain (no platform delete endpoint) — we use a marker
 *      sourceText so they're identifiable later.
 *
 * NOTES
 *   - HAIKU model defaults are used (already the agent default — no override).
 *   - Wall-clock per run is 4-12 min on a quiet machine. Two runs ≈ 8-24 min.
 *   - On any seed/cleanup failure the script logs and continues; exit code
 *     reflects only the assertion outcomes.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, sections, courses } from '../src/db/index.js';
import { config } from '../src/config.js';
import { recordFact, getConcept } from '../src/services/nmemo-client.js';
import { generateLessonAuto, type LessonBlock } from '../src/agents/lesson-generator.js';

const log = (...a: unknown[]): void => console.log('[smoke-7si]', ...a);
const warn = (...a: unknown[]): void => console.warn('[smoke-7si]', ...a);

// Seed concept identities. Two concepts on the section, one of which gets
// the confused_by + lacks_prerequisite facts seeded against it.
const COURSE_TITLE = 'Smoke7si: Algorithmic foundations';
const SECTION_TITLE = 'Smoke7si: Recursion and base cases';
const PRIMARY_CONCEPT = 'Smoke7siRecursion';   // the seeded gap concept
const PREREQ_CONCEPT = 'Smoke7siInductionPrinciple'; // the missing prereq
const SECONDARY_CONCEPT = 'Smoke7siBaseCase';
const FACT_MARKER = 'smoke-7si-e2e-marker';

interface AssertResult { name: string; ok: boolean; detail?: string }

function assert(name: string, ok: boolean, detail?: string): AssertResult {
  const tag = ok ? 'OK  ' : 'FAIL';
  log(tag, name, detail ? `— ${detail}` : '');
  return { name, ok, detail };
}

function blockText(b: LessonBlock): string {
  if (b.type === 'markdown') return b.content;
  // component block — children + props with string values are inspectable text
  const parts: string[] = [];
  if (b.children) parts.push(b.children);
  for (const v of Object.values(b.props ?? {})) {
    if (typeof v === 'string') parts.push(v);
  }
  return parts.join('\n');
}

function joinedLessonText(blocks: LessonBlock[]): string {
  return blocks.map(blockText).join('\n\n');
}

async function ensureCourse(): Promise<string> {
  const existing = await db.select().from(courses).where(eq(courses.title, COURSE_TITLE));
  if (existing.length > 0) return existing[0]!.id;
  const id = randomUUID();
  await db.insert(courses).values({
    id,
    title: COURSE_TITLE,
    description: 'Smoke fixture for nmemo-7si end-to-end personalisation diff',
    topic: 'algorithms',
    sourceType: 'generated',
    status: 'ready',
  });
  return id;
}

async function seedConceptEntity(name: string): Promise<string> {
  // recordFact resolves entities by name and returns the *subject* id, so we
  // record a no-op fact about the concept (subject=concept) just to mint it,
  // then re-fetch via getConcept so we can grab the id reliably.
  await recordFact({
    subjectName: name,
    subjectType: 'concept',
    predicate: 'is_a',
    objectValue: 'topic',
    confidence: 0.5,
    sourceText: `${FACT_MARKER}: seed concept ${name}`,
  });
  const c = await getConcept(name);
  if (!c.entity) throw new Error(`Failed to mint concept ${name} — getConcept returned no entity`);
  return c.entity.id;
}

async function seedSection(courseId: string, conceptIds: string[]): Promise<string> {
  const id = randomUUID();
  await db.insert(sections).values({
    id,
    courseId,
    title: SECTION_TITLE,
    description: 'Recursion: how a function defined in terms of itself terminates via base cases.',
    learningObjectives: JSON.stringify([
      'Identify the base case of a recursive function',
      'Trace recursive calls on simple inputs',
      'Recognise when recursion is preferable to iteration',
    ]),
    conceptEntityIds: JSON.stringify(conceptIds),
    orderIndex: 0,
  });
  return id;
}

async function seedPersonalisationFacts(primaryConceptName: string, prereqConceptName: string): Promise<void> {
  // confused_by: Learner -> primary concept
  await recordFact({
    subjectName: 'Learner',
    subjectType: 'person',
    predicate: 'confused_by',
    objectName: primaryConceptName,
    objectType: 'concept',
    objectValue: 'thinks recursion always loops forever without a base case',
    confidence: 0.9,
    sourceText: `${FACT_MARKER}: confusion seed for ${primaryConceptName}`,
  });
  // lacks_prerequisite: primary concept -> prereq concept
  // (see learner-lesson-context.ts: subject is the studied concept, object is the missing prereq)
  await recordFact({
    subjectName: primaryConceptName,
    subjectType: 'concept',
    predicate: 'lacks_prerequisite',
    objectName: prereqConceptName,
    objectType: 'concept',
    objectValue: `Needed for: ${primaryConceptName}`,
    confidence: 0.85,
    sourceText: `${FACT_MARKER}: prereq gap seed (${prereqConceptName} → ${primaryConceptName})`,
  });
}

async function cleanupSection(sectionId: string): Promise<void> {
  try {
    await db.delete(sections).where(eq(sections.id, sectionId));
  } catch (err) {
    warn('cleanup: failed to delete section row:', err);
  }
}

function printSkipNoticeAndExit(): void {
  log('skipped: set LIVE=1 to run');
  log('  Requires: Nmemo platform on NMEMO_URL, Claude CLI on PATH, learn.db migrated.');
  log('  Example:  LIVE=1 pnpm tsx scripts/smoke-7si-e2e.ts');
  process.exit(0);
}

async function main(): Promise<void> {
  const isLive = process.env.LIVE === '1' || process.env.LIVE === 'true';
  if (!isLive) {
    printSkipNoticeAndExit();
    return;
  }

  log('LIVE mode — running end-to-end personalised vs cold-start diff smoke');
  log(`  NMEMO_URL = ${config.NMEMO_URL}`);
  log(`  DB_PATH   = ${config.DB_PATH}`);

  // Phase 1 — seed graph + section
  log('phase 1: seed concepts + section');
  const courseId = await ensureCourse();
  const primaryId = await seedConceptEntity(PRIMARY_CONCEPT);
  const secondaryId = await seedConceptEntity(SECONDARY_CONCEPT);
  // Prereq concept is referenced by lacks_prerequisite; mint it but don't put
  // it on the section (it's the missing piece behind the section's concept).
  await seedConceptEntity(PREREQ_CONCEPT);
  const sectionId = await seedSection(courseId, [primaryId, secondaryId]);
  log(`  section ${sectionId} seeded (concepts: ${PRIMARY_CONCEPT}, ${SECONDARY_CONCEPT})`);

  const results: AssertResult[] = [];

  try {
    // Phase 2 — cold-start lesson
    log('phase 2: cold-start lesson generation (no learner facts pre-seeded for this section)');
    const coldT0 = Date.now();
    const cold = await generateLessonAuto(sectionId);
    const coldMs = Date.now() - coldT0;
    if (cold.format !== 'structured') {
      results.push(assert('cold-start returns structured lesson', false, `format=${cold.format}`));
      throw new Error('cold-start returned non-structured lesson — cannot continue diff');
    }
    log(`  cold-start lesson generated in ${coldMs}ms — ${cold.blocks.length} blocks`);
    results.push(assert(
      'cold-start lesson has >=3 blocks (sanity)',
      cold.blocks.length >= 3,
      `${cold.blocks.length} blocks`,
    ));

    // Phase 3 — seed learner facts and re-run
    log('phase 3: seeding personalisation facts (confused_by + lacks_prerequisite)');
    await seedPersonalisationFacts(PRIMARY_CONCEPT, PREREQ_CONCEPT);

    log('phase 4: personalised lesson generation');
    const persT0 = Date.now();
    const pers = await generateLessonAuto(sectionId);
    const persMs = Date.now() - persT0;
    if (pers.format !== 'structured') {
      results.push(assert('personalised returns structured lesson', false, `format=${pers.format}`));
      throw new Error('personalised returned non-structured lesson — cannot continue diff');
    }
    log(`  personalised lesson generated in ${persMs}ms — ${pers.blocks.length} blocks`);

    // Assertions on personalised lesson
    const persText = joinedLessonText(pers.blocks);
    const conceptRe = new RegExp(PRIMARY_CONCEPT, 'i');
    const conceptMentioned = conceptRe.test(persText);
    results.push(assert(
      `personalised lesson mentions seeded concept "${PRIMARY_CONCEPT}"`,
      conceptMentioned,
    ));

    const remedialRe = new RegExp(`remediation|review|prerequisite|recap|${PRIMARY_CONCEPT}`, 'i');
    const remedialBlock = pers.blocks.find((b) => remedialRe.test(blockText(b)));
    results.push(assert(
      'personalised lesson has >=1 plausibly remedial block',
      Boolean(remedialBlock),
      remedialBlock ? `block.type=${remedialBlock.type}` : 'no match',
    ));

    // Diff sanity — blocks should not be byte-identical (probabilistic but extremely unlikely to match by chance)
    const coldText = joinedLessonText(cold.blocks);
    results.push(assert(
      'personalised lesson differs from cold-start (text not identical)',
      coldText !== persText,
    ));
  } finally {
    log('cleanup: dropping section row (seeded graph entities/facts intentionally retained)');
    await cleanupSection(sectionId);
  }

  const failed = results.filter((r) => !r.ok);
  log(`results: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    for (const f of failed) warn('  FAIL', f.name, f.detail ?? '');
    process.exit(1);
  }
  log('all assertions passed');
  process.exit(0);
}

// Only run when invoked directly (not when imported by another module).
// import.meta.url comparison handles tsx + node entry-point detection on
// Windows + POSIX. Without this guard, a stray import would trigger the
// LIVE=… check and call process.exit() in the importing process.
const invokedDirectly = (() => {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    const here = new URL(import.meta.url).pathname.replace(/^\/+([A-Za-z]:)/, '$1');
    const there = argv1.replace(/\\/g, '/');
    return here.toLowerCase().endsWith(there.toLowerCase()) || there.toLowerCase().endsWith(here.toLowerCase());
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error('[smoke-7si] fatal:', err);
    process.exit(1);
  });
}

export { main };
