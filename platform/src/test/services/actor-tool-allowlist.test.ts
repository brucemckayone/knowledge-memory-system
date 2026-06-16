/**
 * Allow-list audit (E7, nmemo-vpz.7 criterion 4; doc 41 §8a). Asserts that each
 * epoch-v2 actor's MCP tool surface matches the §8a tables EXACTLY on its
 * propose/verdict (non-read) tools, with reads permitted as a structurally-safe
 * superset (reads never touch canonical — §8a.6). This is the structural backstop
 * behind "agents propose, deterministic code disposes": a proposer / arbiter /
 * causal agent literally cannot hold a canonical-write tool, regardless of prompt.
 *
 * The assertions are pure (static GRAPH_TOOLS + the ACTOR_TOOL_ALLOWLIST map, no
 * DB queries), but it runs under the default harness because importing
 * causal-agent.ts pulls in config.ts, which requires DATABASE_URL at load.
 */
import { describe, it, expect } from 'vitest';
import { GRAPH_TOOLS, allowlistFor } from '../../services/causal-agent.js';
import { type Actor } from '../../services/audit.js';

/** Read-only tools = the tools NOT flagged mutates (the serialisation/write set). */
const READ_ONLY = new Set(GRAPH_TOOLS.filter((t) => !t.mutates).map((t) => t.name));

/**
 * The propose/verdict (non-read) tools each §8a-tabled actor is permitted — the
 * EXACT surface beyond reads. Gardener (§8a.7) has no table ("unchanged") and is
 * asserted separately. graph_agent/reasoning_agent are the legacy benchmark-arm
 * actors, intentionally outside the §8a model.
 */
const EXPECTED_NON_READ: Partial<Record<Actor, string[]>> = {
  extraction_proposer: ['propose_entity', 'propose_fact'], // §8a.4
  reconciliation_agent: ['propose_conflict_resolution', 'propose_identity_verdict'], // §8a.5
  causal_agent: ['propose_causal_edge'], // §8a.6
};

/** The non-read (mutating / staging-write) tools an actor actually holds, sorted. */
function nonReadTools(actor: Actor): string[] {
  return [...allowlistFor(actor)].filter((t) => !READ_ONLY.has(t)).sort();
}

describe('actor tool allow-lists match the §8a tables (E7, doc 41 §8a)', () => {
  for (const [actor, expected] of Object.entries(EXPECTED_NON_READ) as Array<[Actor, string[]]>) {
    it(`${actor}: non-read surface is EXACTLY {${expected.join(', ')}} — no canonical writes`, () => {
      // Writes match the table exactly; the partition is what guarantees no
      // canonical-write tool leaked in (any extra mutating tool fails this).
      expect(nonReadTools(actor)).toEqual([...expected].sort());
      // Every other tool the actor holds is a known read-only tool (safe superset).
      for (const t of allowlistFor(actor)) {
        if (!expected.includes(t)) expect(READ_ONLY.has(t)).toBe(true);
      }
    });
  }

  it('extraction_proposer keeps resolve_anchor as a read (the §8a.4 anchoring entry point)', () => {
    expect(allowlistFor('extraction_proposer').has('resolve_anchor')).toBe(true);
    expect(READ_ONLY.has('resolve_anchor')).toBe(true);
  });

  it('arbiter drops get_reconciliation_context — subsumed by the promotion-pushed dossier (§8a.5)', () => {
    expect(allowlistFor('reconciliation_agent').has('get_reconciliation_context')).toBe(false);
  });

  it('create_causal_edge is retired from GRAPH_TOOLS entirely (E7) — no actor can hold it', () => {
    expect(GRAPH_TOOLS.map((t) => t.name)).not.toContain('create_causal_edge');
    const actors: Actor[] = [
      'extraction_proposer', 'reconciliation_agent', 'causal_agent', 'gardener_agent', 'graph_agent',
    ];
    for (const a of actors) expect(allowlistFor(a).has('create_causal_edge')).toBe(false);
  });

  it('no §8a propose/verdict actor holds ANY canonical-write tool', () => {
    const canonicalWrites = [
      'create_fact', 'resolve_entity', 'execute_merge', 'create_same_as_link',
      'expire_fact', 'invalidate_fact', 'resolve_contradiction', 'update_entity_summary',
      'update_fact_confidence', 'restore_fact', 'resolve_candidate', 'add_entity_alias',
      'link_entity_to_memory', 'expire_causal_edge', 'revise_causal_edge', 'save_reasoning_report',
    ];
    const actors: Actor[] = ['extraction_proposer', 'reconciliation_agent', 'causal_agent'];
    for (const a of actors) {
      const surface = allowlistFor(a);
      for (const w of canonicalWrites) {
        expect(surface.has(w), `${a} must NOT hold canonical-write ${w}`).toBe(false);
      }
    }
  });

  it('gardener (§8a.7) is unchanged — retains its canonical-write surface, not narrowed to propose-only', () => {
    const gardener = allowlistFor('gardener_agent');
    // Representative structural/profile writes the gardener keeps (doc 36; §8a.7 "unchanged").
    expect(gardener.has('update_entity_summary')).toBe(true);
    expect(gardener.has('add_entity_alias')).toBe(true);
    // Strictly broader than the propose-only proposer surface.
    expect(gardener.size).toBeGreaterThan(allowlistFor('extraction_proposer').size);
  });
});
