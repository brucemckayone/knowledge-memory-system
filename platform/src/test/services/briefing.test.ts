/**
 * Briefing Service Tests (W32)
 *
 * Tests briefing persistence, retrieval, and date-based lookup.
 * generateBriefing() depends on ML and is not tested here.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { testDb, deleteFromTables } from '../setup.js';
import {
  persistBriefing,
  getLatestBriefing,
  getBriefingByDate,
  type GeneratedBriefing,
} from '../../services/briefing.js';

describe('Briefing Service', () => {
  it('exports expected functions', async () => {
    const mod = await import('../../services/briefing.js');
    expect(typeof mod.generateBriefing).toBe('function');
    expect(typeof mod.persistBriefing).toBe('function');
    expect(typeof mod.getLatestBriefing).toBe('function');
    expect(typeof mod.getBriefingByDate).toBe('function');
  });
});

describe('Briefing Agent', () => {
  it('has correct name and tier', async () => {
    const { briefingAgent } = await import('../../gardener/agents/briefing.agent.js');
    expect(briefingAgent.name).toBe('briefing');
    expect(briefingAgent.tier).toBe('periodic');
  });
});

describe('Briefing persistence', () => {
  beforeEach(async () => {
    await deleteFromTables('briefings');
  });

  function makeBriefing(overrides: Partial<GeneratedBriefing> = {}): GeneratedBriefing {
    return {
      summary: 'Good morning! You have 3 tasks and 2 insights.',
      sections: [
        { title: 'Summary', content: 'Test summary', type: 'summary' },
        { title: 'Tasks', content: '- Task 1\n- Task 2', type: 'tasks' },
      ],
      insightCount: 2,
      taskCount: 3,
      memoryCount: 0,
      ...overrides,
    };
  }

  it('persistBriefing writes and getLatestBriefing reads back', async () => {
    const briefing = makeBriefing();
    const id = await persistBriefing(briefing);
    expect(id).toBeDefined();

    const latest = await getLatestBriefing();
    expect(latest).not.toBeNull();
    expect(latest!.summary).toBe(briefing.summary);
    expect(latest!.taskCount).toBe(3);
    expect(latest!.insightCount).toBe(2);
    expect(latest!.sections).toHaveLength(2);
  });

  it('getBriefingByDate returns briefing for today', async () => {
    await persistBriefing(makeBriefing());

    const today = new Date();
    const found = await getBriefingByDate(today);
    expect(found).not.toBeNull();
    expect(found!.summary).toContain('Good morning');
  });

  it('getBriefingByDate returns null for date without briefing', async () => {
    const farFuture = new Date('2099-01-01');
    const found = await getBriefingByDate(farFuture);
    expect(found).toBeNull();
  });

  it('persistBriefing upserts on same date', async () => {
    await persistBriefing(makeBriefing({ summary: 'First version' }));
    await persistBriefing(makeBriefing({ summary: 'Updated version' }));

    const latest = await getLatestBriefing();
    expect(latest!.summary).toBe('Updated version');

    // Should be one row for today, not two
    const rows = await testDb`SELECT * FROM briefings`;
    const todayRows = rows.filter(r => {
      const d = new Date(r.briefing_date);
      const now = new Date();
      return d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate();
    });
    expect(todayRows.length).toBe(1);
  });
});
