/**
 * Unit tests for actionable MCP error mapping (doc 38 P2). Pure — no infra.
 */

import { describe, it, expect } from 'vitest';
import { toActionableMcpError } from '../../services/mcp-errors.js';

function pgErr(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('toActionableMcpError', () => {
  it('tags unique violations as duplicate / do-not-retry', () => {
    const out = toActionableMcpError(pgErr('23505', 'duplicate key value violates uniq_facts_active_triple'));
    expect(out).toContain('[duplicate]');
    expect(out).toContain('do NOT retry');
  });

  it('tags FK violations as entity_missing / re-resolve', () => {
    const out = toActionableMcpError(pgErr('23503', 'insert or update on table "facts" violates foreign key'));
    expect(out).toContain('[entity_missing]');
    expect(out).toContain('resolve_entity');
  });

  it('tags check violations as invalid_input', () => {
    expect(toActionableMcpError(pgErr('23514', 'value too long'))).toContain('[invalid_input]');
  });

  it('tags serialization/deadlock as conflict_retry', () => {
    expect(toActionableMcpError(pgErr('40001', 'could not serialize'))).toContain('[conflict_retry]');
    expect(toActionableMcpError(pgErr('40P01', 'deadlock detected'))).toContain('[conflict_retry]');
  });

  it('falls back to a plain message for unknown errors', () => {
    expect(toActionableMcpError(new Error('something else'))).toBe('Error: something else');
    expect(toActionableMcpError('a string')).toBe('Error: a string');
  });
});
