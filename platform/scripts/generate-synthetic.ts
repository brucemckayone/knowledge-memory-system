#!/usr/bin/env tsx
/**
 * snapshot:synthetic <name> — synthetic-snapshot generator stub.
 *
 * Full implementation lands under bead nmemo-j77.2: deterministic generator
 * with bridge-pair injection per doc 28 §3.3. The skeleton ships only the
 * entrypoint + ensure() wiring so manifest entries with `kind: "synthetic"`
 * fail loudly if anyone tries to ensure them before j77.2 closes.
 */

import { loadManifest, findEntry } from './lib/manifest.js';

export async function generateSynthetic(name: string): Promise<never> {
  const manifest = loadManifest();
  const entry = findEntry(manifest, name);
  if (entry.kind !== 'synthetic') {
    throw new Error(`generate-synthetic requires kind="synthetic"; "${name}" is "${entry.kind}".`);
  }
  throw new Error(
    `Synthetic generator not yet implemented (entry: ${name}). ` +
    `Tracked under nmemo-j77.2. The skeleton only supports the "empty" LLM baseline.`
  );
}

const invokedDirectly = process.argv[1]?.endsWith('generate-synthetic.ts')
  || process.argv[1]?.endsWith('generate-synthetic.js');

if (invokedDirectly) {
  const name = process.argv[2];
  if (!name) {
    console.error('Usage: pnpm snapshot:synthetic <name>');
    process.exit(2);
  }
  generateSynthetic(name).catch((err) => {
    console.error(`generate-synthetic stub: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
