/**
 * Smoke test for the article-generator agent.
 *
 * Runs one case with a cluster of "things that hash" concepts spread across
 * fake courses. Expects ok=true, contentMd >= 200 chars, and a title.
 * Prints the article body for human inspection.
 */
import { generateArticle } from '../src/agents/article-generator.js';
import type { ArticleGenInput } from '../src/agents/article-generator.js';

const sample: ArticleGenInput = {
  concepts: [
    { entityId: 'e1', name: 'Hash table', courseTitle: 'Data Structures', relatedFactSummary: 'Reviewed last week; learner answered chaining question correctly.' },
    { entityId: 'e2', name: 'Dictionary', courseTitle: 'Python Foundations', relatedFactSummary: 'Used in week 2 examples on key-value lookups.' },
    { entityId: 'e3', name: 'Set', courseTitle: 'Discrete Math', relatedFactSummary: 'Defined as unordered unique-membership collection.' },
    { entityId: 'e4', name: 'Map', courseTitle: 'JavaScript', relatedFactSummary: 'Contrasted with plain objects for arbitrary keys.' },
    { entityId: 'e5', name: 'Bloom filter', courseTitle: 'Distributed Systems', relatedFactSummary: 'Probabilistic membership; covered last session.' },
    { entityId: 'e6', name: 'HashSet', courseTitle: 'Java Collections', relatedFactSummary: 'Backed by HashMap internally.' },
    { entityId: 'e7', name: 'HashMap', courseTitle: 'Java Collections', relatedFactSummary: 'Hash + bucket array; resize at load factor 0.75.' },
  ],
  hint: 'The learner has been touching collection abstractions across multiple language and systems courses.',
};

async function main() {
  console.log(`Running article-generator smoke with ${sample.concepts.length} concepts...\n`);
  const t0 = Date.now();
  const r = await generateArticle(sample);
  const ms = Date.now() - t0;

  console.log(`Took ${ms}ms`);
  console.log(`ok=${r.ok}`);
  console.log(`title=${JSON.stringify(r.title)}`);
  console.log(`contentMd length=${r.contentMd.length}`);
  console.log(`rationale=${r.rationale ?? '(none)'}`);
  console.log(`conceptEntityIds=${JSON.stringify(r.conceptEntityIds)}`);
  if (!r.ok) {
    console.log(`errorText=${r.errorText}`);
  } else {
    console.log('\n--- Article ---');
    console.log(`# ${r.title}\n`);
    console.log(r.contentMd);
    console.log('--- /Article ---');
  }

  // Acceptance assertions
  const failures: string[] = [];
  if (!r.ok) failures.push(`ok=false (errorText: ${r.errorText})`);
  if (!r.title) failures.push('title empty');
  if (r.contentMd.length < 200) failures.push(`contentMd too short (${r.contentMd.length} chars)`);
  if (r.conceptEntityIds.length !== sample.concepts.length) failures.push('conceptEntityIds count mismatch');

  if (failures.length === 0) {
    console.log('\n[PASS] All acceptance checks passed.');
  } else {
    console.log('\n[FAIL] ' + failures.join('; '));
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Smoke crashed:', err);
  process.exit(1);
});
