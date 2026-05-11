#!/usr/bin/env tsx
/**
 * CLI harness for the sparse truth graph pipeline.
 *
 * Usage:
 *   pnpm tsx src/harness.ts "Some text to ingest"
 *   pnpm tsx src/harness.ts --store "Just embed and store, no extraction"
 *   pnpm tsx src/harness.ts --extract <memoryId>
 */

import { store, extract, ingest } from './pipeline.js';

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage:');
    console.error('  pnpm tsx src/harness.ts "text to ingest"');
    console.error('  pnpm tsx src/harness.ts --store "text to store only"');
    console.error('  pnpm tsx src/harness.ts --extract <memoryId>');
    process.exit(1);
  }

  const start = Date.now();

  if (args[0] === '--store') {
    const text = args.slice(1).join(' ');
    if (!text) {
      console.error('Error: --store requires text argument');
      process.exit(1);
    }
    const memoryId = await store(text);
    console.log(JSON.stringify({ memoryId, ms: Date.now() - start }, null, 2));
  } else if (args[0] === '--extract') {
    const memoryId = args[1];
    if (!memoryId) {
      console.error('Error: --extract requires a memoryId argument');
      process.exit(1);
    }
    const result = await extract(memoryId);
    console.log(JSON.stringify(result, null, 2));
  } else {
    const text = args.join(' ');
    const result = await ingest(text);
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
