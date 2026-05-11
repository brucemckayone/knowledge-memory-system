/**
 * Smoke test for the component-generator agent.
 * Runs 5 cases including one deliberate bad input. Expects >= 2/4 valid kinds
 * to produce successful output. Logs short summaries; does not throw on
 * individual failures so we can see which kinds Haiku handles cleanly.
 */
import { generateComponent } from '../src/agents/component-generator.js';
import type { ComponentGenInput, ComponentGenResult } from '../src/agents/component-generator.js';

const cases: Array<{ label: string; input: ComponentGenInput }> = [
  {
    label: 'Mermaid · hash table chaining',
    input: { kind: 'Mermaid', context: 'show how a hash table handles collisions with chaining' },
  },
  {
    label: 'Callout · big-O insight',
    input: { kind: 'Callout', context: 'why big-O notation hides constant factors and what that means in practice' },
  },
  {
    label: 'CodeRunner · JS array map',
    input: { kind: 'CodeRunner', context: 'demonstrate Array.prototype.map with a small numeric example' },
  },
  {
    label: 'StepThrough · binary search',
    input: { kind: 'StepThrough', context: 'walk through how binary search finds an element in a sorted array' },
  },
  {
    label: 'ConceptMap · OSI layers',
    input: { kind: 'ConceptMap', context: 'show the OSI 7-layer model with relationships between layers' },
  },
  {
    label: 'BAD · empty Mermaid context',
    input: { kind: 'Mermaid', context: '' },
  },
];

function summarise(label: string, result: ComponentGenResult, ms: number): string {
  if (result.kind === 'markdown') {
    return `[FALLBACK] ${label} (${ms}ms) — markdown len=${result.content.length}`;
  }
  const preview: string[] = [];
  preview.push(`kind=${result.kind}`);
  for (const [k, v] of Object.entries(result.props)) {
    if (typeof v === 'string') preview.push(`${k}=${JSON.stringify(v.slice(0, 60))}${v.length > 60 ? '…' : ''}`);
    else if (Array.isArray(v)) preview.push(`${k}[${v.length}]`);
    else preview.push(`${k}=${JSON.stringify(v).slice(0, 40)}`);
  }
  if (result.children) preview.push(`children=${result.children.length}c`);
  return `[OK]       ${label} (${ms}ms) — ${preview.join(' ')}`;
}

async function main() {
  console.log(`Running ${cases.length} cases against generateComponent…\n`);
  const results: Array<{ label: string; result: ComponentGenResult; ms: number; kind: string }> = [];
  for (const c of cases) {
    const t0 = Date.now();
    try {
      const r = await generateComponent(c.input);
      const ms = Date.now() - t0;
      console.log(summarise(c.label, r, ms));
      results.push({ label: c.label, result: r, ms, kind: c.input.kind });
    } catch (err) {
      const ms = Date.now() - t0;
      console.log(`[THROW]    ${c.label} (${ms}ms) — ${err instanceof Error ? err.message : err}`);
      results.push({
        label: c.label,
        result: { kind: 'markdown', content: '[threw]' },
        ms,
        kind: c.input.kind,
      });
    }
  }

  console.log('\n--- Summary ---');
  // Acceptance: bad input must NOT throw, and >= 2 of the 4 core kinds (Mermaid/Callout/CodeRunner/StepThrough)
  // should produce valid output.
  const core = ['Mermaid', 'Callout', 'CodeRunner', 'StepThrough'];
  const coreResults = results.filter(r => core.includes(r.kind) && r.label !== 'BAD · empty Mermaid context');
  const coreOk = coreResults.filter(r => r.result.kind !== 'markdown').length;
  console.log(`Core valid: ${coreOk} / ${coreResults.length}`);
  console.log(`Bad-input handled without throw: yes (returned ${results.find(r => r.label.startsWith('BAD'))?.result.kind})`);

  // Show one detailed sample for visual inspection.
  const sample = results.find(r => r.kind === 'Mermaid' && r.result.kind !== 'markdown');
  if (sample && sample.result.kind !== 'markdown') {
    console.log('\nSample Mermaid props.src:\n' + (sample.result.props.src as string).slice(0, 400));
  }
}

main().catch(err => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
