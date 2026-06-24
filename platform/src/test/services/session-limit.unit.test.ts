/**
 * Unit tests for session/usage-limit detection + reset-time parsing. Pure — no
 * DB / infra / real clock (parseResetAt takes `now`).
 */

import { describe, it, expect } from 'vitest';
import { isSessionLimitError, parseResetAt } from '../../services/session-limit.js';

describe('isSessionLimitError', () => {
  it('matches the Claude CLI session-limit wording', () => {
    expect(isSessionLimitError("You've hit your session limit · resets 1pm (Europe/London)")).toBe(true);
    expect(isSessionLimitError('Reached your usage limit')).toBe(true);
    expect(isSessionLimitError('upgrade at claude.ai/admin-settings/usage')).toBe(true);
  });

  it('matches when the limit text is buried in an agentFetch error body', () => {
    const msg =
      'graph_agent failed (500): {"detail":{"error":"Claude CLI failed (rc=1): ' +
      "You've hit your session limit, resets 1pm\",\"rc\":1}}";
    expect(isSessionLimitError(new Error(msg))).toBe(true);
  });

  it('does NOT match transient throttles or ordinary failures', () => {
    expect(isSessionLimitError(new Error('graph_agent failed (503): queue full'))).toBe(false);
    expect(isSessionLimitError(new Error('Claude CLI failed (rc=1): MCP config error'))).toBe(false);
    expect(isSessionLimitError(new Error('connect ECONNREFUSED 127.0.0.1:3000'))).toBe(false);
    expect(isSessionLimitError('')).toBe(false);
    expect(isSessionLimitError(null)).toBe(false);
  });
});

describe('parseResetAt', () => {
  it('parses a 12-hour clock time to the next future occurrence', () => {
    const now = new Date(2026, 5, 24, 10, 0, 0); // 10:00 local
    const at = parseResetAt('resets 1pm', now);
    expect(at).not.toBeNull();
    expect(at!.getHours()).toBe(13);
    expect(at!.getMinutes()).toBe(0);
    expect(at!.getDate()).toBe(24); // same day — 1pm is still ahead of 10am
  });

  it('rolls to the next day when the clock time already passed', () => {
    const now = new Date(2026, 5, 24, 14, 0, 0); // 14:00 local, past 1pm
    const at = parseResetAt('resets 1pm', now);
    expect(at!.getHours()).toBe(13);
    expect(at!.getDate()).toBe(25);
  });

  it('parses minutes and "at"', () => {
    const now = new Date(2026, 5, 24, 10, 0, 0);
    const at = parseResetAt('limit resets at 1:30pm', now);
    expect(at!.getHours()).toBe(13);
    expect(at!.getMinutes()).toBe(30);
  });

  it('parses 24-hour clock times', () => {
    const now = new Date(2026, 5, 24, 10, 0, 0);
    const at = parseResetAt('resets 13:00', now);
    expect(at!.getHours()).toBe(13);
  });

  it('parses relative durations', () => {
    const now = new Date(2026, 5, 24, 10, 0, 0);
    const at = parseResetAt('usage limit; resets in 2 hours', now);
    expect(at!.getTime()).toBe(now.getTime() + 2 * 3_600_000);
  });

  it('parses an ISO instant', () => {
    const now = new Date(2026, 5, 24, 10, 0, 0);
    const at = parseResetAt('resets 2026-06-24T13:00:00Z', now);
    expect(at!.toISOString()).toBe('2026-06-24T13:00:00.000Z');
  });

  it('returns null when there is no reset hint', () => {
    const now = new Date(2026, 5, 24, 10, 0, 0);
    expect(parseResetAt("you've hit your session limit", now)).toBeNull();
    expect(parseResetAt('', now)).toBeNull();
  });
});
