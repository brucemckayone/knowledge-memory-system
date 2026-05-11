/**
 * Meeting Processor Tests (W38)
 */

import { describe, it, expect } from 'vitest';

describe('Meeting Processor', () => {
  it('exports processMeeting function', async () => {
    const mod = await import('../../workers/meeting-processor.js');
    expect(typeof mod.processMeeting).toBe('function');
  });
});
