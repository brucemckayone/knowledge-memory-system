// Smoke test for lesson_overlays UNIQUE constraint + notes round-trip.
// Verifies the v0.2 Lesson Evolution storage layer (schema only, no handlers).

import { createClient } from '@libsql/client';
import { config } from '../src/config.js';

const SECTION_ID = `smoke-section-${Date.now()}`;
const LEARNER = 'smoke-learner';
const NOTE_ID = `smoke-note-${Date.now()}`;

async function main() {
  const client = createClient({ url: `file:${config.DB_PATH}` });

  // 1) (learner='a', section='s1', version=1) — succeeds
  await client.execute({
    sql: `INSERT INTO lesson_overlays (id, learner_id, section_id, blocks, version)
          VALUES (?, ?, ?, ?, ?)`,
    args: [`smoke-${SECTION_ID}-v1`, LEARNER, SECTION_ID, '[]', 1],
  });
  console.log('Step 1 ok: inserted version=1');

  // 2) Same learner+section, different version — succeeds
  await client.execute({
    sql: `INSERT INTO lesson_overlays (id, learner_id, section_id, blocks, version)
          VALUES (?, ?, ?, ?, ?)`,
    args: [`smoke-${SECTION_ID}-v2`, LEARNER, SECTION_ID, '[]', 2],
  });
  console.log('Step 2 ok: inserted version=2');

  // 3) Duplicate (learner, section, version) — must fail with UNIQUE error
  let uniqueErrorSeen = false;
  try {
    await client.execute({
      sql: `INSERT INTO lesson_overlays (id, learner_id, section_id, blocks, version)
            VALUES (?, ?, ?, ?, ?)`,
      args: [`smoke-${SECTION_ID}-v1-dup`, LEARNER, SECTION_ID, '[]', 1],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toUpperCase().includes('UNIQUE')) {
      uniqueErrorSeen = true;
      console.log(`Step 3 ok: UNIQUE constraint rejected duplicate (${msg})`);
    } else {
      throw new Error(`Step 3 failed: expected UNIQUE error, got: ${msg}`);
    }
  }
  if (!uniqueErrorSeen) throw new Error('Step 3 failed: duplicate insert was allowed');

  // 4) notes round-trip
  await client.execute({
    sql: `INSERT INTO notes (id, learner_id, section_id, anchor_text, content_md, promoted_to_graph, fact_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [NOTE_ID, LEARNER, SECTION_ID, 'highlighted excerpt', 'my note body', 0, null],
  });
  const noteRow = await client.execute({
    sql: `SELECT id, learner_id, section_id, anchor_text, content_md, promoted_to_graph, fact_id
          FROM notes WHERE id = ?`,
    args: [NOTE_ID],
  });
  if (noteRow.rows.length !== 1) throw new Error('Step 4 failed: note not found after insert');
  const note = noteRow.rows[0] as Record<string, unknown>;
  if (note.anchor_text !== 'highlighted excerpt' || note.content_md !== 'my note body') {
    throw new Error(`Step 4 failed: note round-trip mismatch: ${JSON.stringify(note)}`);
  }
  console.log(`Step 4 ok: notes round-trip (id=${note.id}, promoted_to_graph=${note.promoted_to_graph})`);

  // 5) Cleanup
  await client.execute({
    sql: `DELETE FROM lesson_overlays WHERE section_id = ?`,
    args: [SECTION_ID],
  });
  await client.execute({
    sql: `DELETE FROM notes WHERE id = ?`,
    args: [NOTE_ID],
  });
  console.log('Step 5 ok: cleanup complete');

  await client.close();
  console.log('SMOKE PASS');
}

main().catch(err => {
  console.error('SMOKE FAIL:', err);
  process.exit(1);
});
