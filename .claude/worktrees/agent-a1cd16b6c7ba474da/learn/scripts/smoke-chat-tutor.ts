/**
 * Smoke test for chat-tutor parsing + chat-routes context composition.
 *
 * No live services are touched. We exercise:
 *   1. parseStructuredBlocks accepts the new nmemoUpdates field and returns it.
 *   2. parseStructuredBlocks fallback path (no nmemoUpdates field) yields [].
 *   3. validateNmemoUpdate filters out reads / malformed entries.
 *   4. composeLearnerContextBlock returns an empty block on cold-start.
 *   5. composeLearnerContextBlock surfaces concepts + gaps + overlaps when present.
 *
 * Run: pnpm tsx scripts/smoke-chat-tutor.ts
 */

import { __test as tutorTest } from '../src/agents/chat-tutor.js';
import { __test as routesTest } from '../src/routes/chat.js';

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}`, detail ?? '');
  }
}

console.log('1. parseStructuredBlocks · accepts nmemoUpdates field');
{
  const raw = JSON.stringify({
    blocks: [{ type: 'markdown', content: 'closures retain scope' }],
    nmemoUpdates: [
      { tool: 'record_understanding', concept: 'closures', confidence: 0.8, evidence: 'explained scope retention' },
      { tool: 'flag_prerequisite_gap', concept: 'higher-order functions', evidence: 'unclear on first-class functions' },
    ],
  });
  const parsed = tutorTest.parseStructuredBlocks(raw);
  check('parsed is non-null', parsed !== null);
  check('blocks survived', parsed?.blocks.length === 1);
  check('nmemoUpdates length === 2', parsed?.nmemoUpdates.length === 2, parsed?.nmemoUpdates);
  check('first update tool preserved', parsed?.nmemoUpdates[0]?.tool === 'record_understanding');
  check('first update confidence preserved', parsed?.nmemoUpdates[0]?.confidence === 0.8);
}

console.log('2. parseStructuredBlocks · missing nmemoUpdates → empty array');
{
  const raw = JSON.stringify({ blocks: [{ type: 'markdown', content: 'hi' }] });
  const parsed = tutorTest.parseStructuredBlocks(raw);
  check('parsed is non-null', parsed !== null);
  check('nmemoUpdates is empty array (not undefined)', Array.isArray(parsed?.nmemoUpdates) && parsed?.nmemoUpdates.length === 0);
}

console.log('3. validateNmemoUpdate · filters reads + malformed');
{
  const reads = tutorTest.validateNmemoUpdate({ tool: 'get_learner_understanding', concept: 'x' });
  check('read tool stripped', reads === null);

  const noTool = tutorTest.validateNmemoUpdate({ concept: 'x' });
  check('no tool stripped', noTool === null);

  const arrayBad = tutorTest.validateNmemoUpdate(['record_understanding']);
  check('non-object stripped', arrayBad === null);

  const good = tutorTest.validateNmemoUpdate({
    tool: 'record_understanding',
    concept: 'closures',
    confidence: 0.7,
    evidence: 'explained inner state',
    factId: 'fact_abc',
  });
  check('valid write preserved', good !== null && good.tool === 'record_understanding');
  check('factId preserved', good?.factId === 'fact_abc');
}

console.log('4. composeLearnerContextBlock · cold start → empty block');
{
  const r = routesTest.composeLearnerContextBlock({
    conceptConfidences: [],
    struggle: { weakAreas: [], confusions: [] },
    overlaps: [],
    sectionConceptNames: [],
  });
  check('empty block on cold start', r.block === '', JSON.stringify(r));
  check('conceptCount is 0', r.conceptCount === 0);
  check('hasGaps is false', r.hasGaps === false);
  check('hasOverlaps is false', r.hasOverlaps === false);
}

console.log('5. composeLearnerContextBlock · surfaces concepts + gaps + overlaps');
{
  const r = routesTest.composeLearnerContextBlock({
    conceptConfidences: [
      { conceptName: 'closures', confidence: 0.6, predicate: 'understands', evidence: 'partial' },
    ],
    struggle: {
      weakAreas: [
        { entityId: 'e1', predicate: 'understands', confidence: 0.4, objectValue: 'recursion', sourceText: null, createdAt: '' },
      ],
      confusions: [
        { entityId: 'e2', predicate: 'confused_by', confidence: 0.9, objectValue: 'tail call', sourceText: null, createdAt: '' },
      ],
    },
    overlaps: [
      {
        id: 'l1', entity_a_id: 'a', entity_b_id: 'b',
        a_name: 'closures', b_name: 'move closures',
        reasoning: 'Both capture environment',
        confidence: 0.85, created_at: '',
      },
    ],
    sectionConceptNames: ['closures'],
  });
  check('block contains concept name', r.block.includes('closures'));
  check('block contains gap label', r.block.includes('weak') || r.block.includes('Recent gaps'));
  check('block contains cross-course overlap', r.block.includes('move closures'));
  check('hasGaps is true', r.hasGaps === true);
  check('conceptCount is 1', r.conceptCount === 1);
}

console.log('6. parseStructuredBlocks · invalid nmemoUpdates entries silently dropped');
{
  const raw = JSON.stringify({
    blocks: [{ type: 'markdown', content: 'x' }],
    nmemoUpdates: [
      { tool: 'get_learner_understanding', concept: 'x' }, // read — drop
      { tool: 'record_understanding', concept: 'closures', confidence: 0.8 }, // keep
      'bogus',                                              // non-object — drop
      { concept: 'no-tool' },                               // missing tool — drop
    ],
  });
  const parsed = tutorTest.parseStructuredBlocks(raw);
  check('only valid write survives', parsed?.nmemoUpdates.length === 1, parsed?.nmemoUpdates);
  check('survivor is record_understanding', parsed?.nmemoUpdates[0]?.tool === 'record_understanding');
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll assertions passed.');
