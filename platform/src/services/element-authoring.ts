/**
 * Element-description authoring — the LLM layer (bead nmemo-uhp.17.2, doc 13).
 *
 * The pure convention (facet schema + renderers) lives in element-description.ts;
 * this file is the intelligence that fills the facets: a Haiku call reads the code
 * (or the rule text) and returns structured facets, which the pure renderer turns
 * into the canonical dense description. Haiku-first — the default generator is
 * ml.generateJson (the /chat JSON path), and the generator is INJECTABLE so tests
 * run deterministically with a fake and never touch an LLM or the network.
 *
 * Blindness (doc 13 §4) is enforced by the PROMPT: the code author is shown only the
 * code + the generic "safety-critical C++" domain, never a rule set. We then run
 * detectRuleReferences over the rendered description as a VISIBILITY check — if the
 * model leaked a rule id anyway, the hit is surfaced on the result (never silently
 * scrubbed, which would hide leakage from the acceptance gate).
 */

import {
  composeFacetedDescription,
  composeRuleDescription,
  detectRuleReferences,
  type ElementFacets,
  type RuleDescriptionParts,
} from './element-description.js';

/**
 * The injectable JSON generator seam. Given a prompt, returns parsed JSON (the model
 * is instructed to emit a raw JSON object). Default = ml.generateJson (the Haiku
 * /chat JSON path); tests supply a deterministic fake. Mirrors the store-or-LLM
 * injector pattern used across the services (audit-pass.ts AuditAgentInvoker,
 * causal-pass.ts).
 */
export type FacetGenerator = (prompt: string) => Promise<unknown>;

/**
 * Bound lazily (dynamic import) rather than at module load: ml-client → config runs
 * env validation that process.exit()s when required env is absent, which would break
 * pure unit tests that inject a fake and never call the LLM. Same lazy-seam pattern
 * as audit-pass.ts's defaultInvokeAuditAgent.
 */
const defaultGenerator: FacetGenerator = async (prompt) => {
  const { ml } = await import('./ml-client.js');
  return ml.generateJson(prompt);
};

// ============================================
// Code element → faceted description
// ============================================

export interface CodeElementInput {
  /** The element's symbol/name (e.g. `TcpClient::TcpClient`, `parseNumber`). */
  name: string;
  /** The element's source text — the ONLY substantive input the author sees. */
  code: string;
}

export interface AuthoredDescription {
  /** The canonical dense description (composeFacetedDescription output). */
  description: string;
  /** The structured facets the model returned (after coercion). */
  facets: ElementFacets;
  /**
   * Rule ids / standard names detected in the rendered description. MUST be empty for
   * a blind author; a non-empty list is a blindness violation surfaced for the
   * acceptance gate, NOT scrubbed away.
   */
  leakedReferences: string[];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Coerce arbitrary model JSON to {@link ElementFacets}. Defensive: missing keys
 * become empty (the renderer skips them), non-string scalars become '', a
 * non-array `concepts` becomes []. Extra keys are ignored. Never throws.
 */
export function coerceFacets(raw: unknown): ElementFacets {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    operation: asString(o.operation),
    dataTypes: asString(o.dataTypes),
    memoryPointers: asString(o.memoryPointers),
    ownershipLifetime: asString(o.ownershipLifetime),
    sideEffects: asString(o.sideEffects),
    errorHandling: asString(o.errorHandling),
    concepts: asStringArray(o.concepts),
  };
}

/** Build the blind code-facet prompt (doc 13 §3-4). Pure; no LLM. */
export function buildCodeFacetPrompt(input: CodeElementInput): string {
  return [
    'You are building a semantic description of a C or C++ code element for a',
    'knowledge graph used in safety-critical software review. Describe ONLY what the',
    'code below does, using precise C/C++ vocabulary.',
    '',
    'STRICT RULES:',
    '- Base your answer solely on the code. Do NOT mention, name, cite, or paraphrase',
    '  any coding standard, guideline, or rule (no "MISRA", "CERT", "AUTOSAR", no rule',
    '  ids like "F.16" or "21.18"). You have not been shown any rule set.',
    '- Prefer concrete technical nouns (types, casts, ownership, lifetime, allocation,',
    '  aliasing, side effects, error handling) over narrative prose.',
    '',
    'Return a JSON object with these keys (each a short string; omit a key if it does',
    'not apply; "concepts" is an array of short keyword strings):',
    '  operation, dataTypes, memoryPointers, ownershipLifetime, sideEffects,',
    '  errorHandling, concepts',
    '',
    `Element name: ${input.name}`,
    'Code:',
    input.code,
  ].join('\n');
}

/**
 * Author a code element's faceted description via the (injectable) generator, blind
 * to the rule set. Returns the rendered description + facets + any leaked references.
 */
export async function authorElementDescription(
  input: CodeElementInput,
  opts: { generate?: FacetGenerator } = {},
): Promise<AuthoredDescription> {
  const generate = opts.generate ?? defaultGenerator;
  const raw = await generate(buildCodeFacetPrompt(input));
  const facets = coerceFacets(raw);
  const description = composeFacetedDescription(facets);
  const leakedReferences = detectRuleReferences(description);
  if (leakedReferences.length > 0) {
    console.warn(
      `[element-authoring] code element "${input.name}" leaked rule references ` +
        `(blindness violation, doc 13 §4): ${leakedReferences.join(', ')}`,
    );
  }
  return { description, facets, leakedReferences };
}

// ============================================
// Rule element → richer description
// ============================================

export interface RuleElementInput {
  /** The rule/guideline id (e.g. `C.12`). Fine to show — this IS the rule side. */
  ruleId: string;
  /** The guideline text — the ONLY substantive input the author sees (blind to code). */
  ruleText: string;
}

export interface AuthoredRuleDescription {
  description: string;
  parts: RuleDescriptionParts;
}

/** Coerce arbitrary model JSON to {@link RuleDescriptionParts}. Never throws. */
export function coerceRuleParts(raw: unknown): RuleDescriptionParts {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    rationale: asString(o.rationale),
    watchFor: asString(o.watchFor),
    concepts: asStringArray(o.concepts),
  };
}

/** Build the blind-to-code rule-description prompt (doc 13 §3-4). Pure; no LLM. */
export function buildRuleDescriptionPrompt(input: RuleElementInput): string {
  return [
    'You are describing a coding-standard guideline for a knowledge graph used in',
    'safety-critical software review. Expand the guideline below into a richer',
    'description.',
    '',
    'STRICT RULES:',
    '- Base your answer solely on the guideline text. Do NOT invent or reference other',
    '  rules or standards, and do NOT reference any specific source-code file.',
    "- Explain WHY the rule exists and WHAT typical code shapes trigger it, in the",
    "  guideline's own vocabulary.",
    '',
    'Return a JSON object with these keys:',
    '  rationale (string): why the rule exists / what it forbids or requires',
    '  watchFor (string): the typical code shapes that trigger or relate to the rule',
    '  concepts (array of short keyword strings)',
    '',
    `Guideline id: ${input.ruleId}`,
    `Guideline: ${input.ruleText}`,
  ].join('\n');
}

/** Author a rule element's richer description via the (injectable) generator, blind to code. */
export async function authorRuleDescription(
  input: RuleElementInput,
  opts: { generate?: FacetGenerator } = {},
): Promise<AuthoredRuleDescription> {
  const generate = opts.generate ?? defaultGenerator;
  const raw = await generate(buildRuleDescriptionPrompt(input));
  const parts = coerceRuleParts(raw);
  const description = composeRuleDescription(parts);
  return { description, parts };
}
