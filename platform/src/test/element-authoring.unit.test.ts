/**
 * Unit tests for the element-description authoring layer (bead nmemo-uhp.17.2).
 * The generator is INJECTED with a deterministic fake, so this suite hits no LLM,
 * network, or DB — it pins the coercion (defensive against ragged model JSON), the
 * prompt's blindness instructions, the leak-surfacing contract (never scrubbed), and
 * the render composition.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  authorElementDescription,
  authorRuleDescription,
  buildCodeFacetPrompt,
  buildRuleDescriptionPrompt,
  coerceFacets,
  coerceRuleParts,
  type FacetGenerator,
} from '../services/element-authoring.js';
import { composeFacetedDescription, composeRuleDescription } from '../services/element-description.js';

/** A generator that ignores the prompt and returns a fixed JSON object. */
const fixed = (json: unknown): FacetGenerator => () => Promise.resolve(json);

describe('coerceFacets', () => {
  it('keeps string facets and a string[] concepts', () => {
    expect(
      coerceFacets({
        operation: 'copies a buffer',
        dataTypes: 'void*, size_t',
        concepts: ['memcpy', 'bounds'],
      }),
    ).toEqual({
      operation: 'copies a buffer',
      dataTypes: 'void*, size_t',
      memoryPointers: '',
      ownershipLifetime: '',
      sideEffects: '',
      errorHandling: '',
      concepts: ['memcpy', 'bounds'],
    });
  });

  it('is defensive against ragged JSON (non-strings, non-array concepts, null, extras)', () => {
    expect(coerceFacets(null).operation).toBe('');
    expect(coerceFacets('nope').concepts).toEqual([]);
    const c = coerceFacets({
      operation: 42,
      concepts: 'not-an-array',
      unexpected: 'ignored',
    });
    expect(c.operation).toBe('');
    expect(c.concepts).toEqual([]);
    const mixed = coerceFacets({ concepts: ['ok', 7, null, 'fine'] });
    expect(mixed.concepts).toEqual(['ok', 'fine']);
  });
});

describe('buildCodeFacetPrompt', () => {
  it('embeds the name + code and the blind-to-rules instruction', () => {
    const prompt = buildCodeFacetPrompt({ name: 'parseNumber', code: 'template<class T> bool f();' });
    expect(prompt).toContain('parseNumber');
    expect(prompt).toContain('template<class T> bool f();');
    expect(prompt).toContain('Do NOT mention, name, cite, or paraphrase');
    expect(prompt).toContain('You have not been shown any rule set.');
  });
});

describe('authorElementDescription', () => {
  it('renders the facets the generator returns and reports no leak on blind output', async () => {
    const facets = {
      operation: 'reinterprets a sockaddr_in pointer as a generic sockaddr pointer',
      memoryPointers: 'reinterpret_cast type-puns between two socket-address structs',
      concepts: ['reinterpret_cast', 'pointer aliasing'],
    };
    const result = await authorElementDescription(
      { name: 'toSockaddr', code: 'sockaddr* f(sockaddr_in* a){...}' },
      { generate: fixed(facets) },
    );
    expect(result.description).toBe(composeFacetedDescription(coerceFacets(facets)));
    expect(result.leakedReferences).toEqual([]);
  });

  it('passes the built prompt to the generator', async () => {
    const spy = vi.fn().mockResolvedValue({ operation: 'x' });
    await authorElementDescription({ name: 'g', code: 'int g();' }, { generate: spy });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toContain('int g();');
  });

  it('SURFACES a leaked rule reference (blindness violation) without scrubbing it', async () => {
    const result = await authorElementDescription(
      { name: 'leaky', code: 'void h();' },
      { generate: fixed({ operation: 'does a copy; this is what F.16 forbids' }) },
    );
    // The reference is reported...
    expect(result.leakedReferences).toContain('F.16');
    // ...and the text is preserved verbatim (never silently stripped — the acceptance
    // gate must be able to see the leakage).
    expect(result.description).toContain('F.16');
  });
});

describe('coerceRuleParts + authorRuleDescription', () => {
  it('coerces ragged rule JSON', () => {
    expect(coerceRuleParts({ rationale: 'why', watchFor: 3, concepts: ['a', 2] })).toEqual({
      rationale: 'why',
      watchFor: '',
      concepts: ['a'],
    });
  });

  it('renders a rule description from the generator output', async () => {
    const parts = {
      rationale: 'A const data member deletes copy/move assignment.',
      watchFor: 'Watch for const int id_ in a value type.',
      concepts: ['const member', 'value semantics'],
    };
    const result = await authorRuleDescription(
      { ruleId: 'C.12', ruleText: 'Do not make data members const in a copyable type.' },
      { generate: fixed(parts) },
    );
    expect(result.description).toBe(composeRuleDescription(coerceRuleParts(parts)));
  });

  it('rule prompt embeds the guideline id + text', () => {
    const prompt = buildRuleDescriptionPrompt({ ruleId: 'C.12', ruleText: 'Do not make data members const.' });
    expect(prompt).toContain('C.12');
    expect(prompt).toContain('Do not make data members const.');
    expect(prompt).toContain('Base your answer solely on the guideline text');
  });
});
