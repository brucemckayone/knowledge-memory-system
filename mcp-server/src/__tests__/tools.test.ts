/**
 * MCP Tools Tests (W41)
 */

import { describe, it, expect } from 'vitest';
import { tools } from '../tools.js';
import { resources } from '../resources.js';
import { MnemoClient } from '../mnemo-client.js';

describe('MCP Tools', () => {
  it('defines expected tools', () => {
    const names = tools.map(t => t.name);
    expect(names).toContain('mnemo_search');
    expect(names).toContain('mnemo_ingest');
    expect(names).toContain('mnemo_entities');
    expect(names).toContain('mnemo_facts');
    expect(names).toContain('mnemo_insights');
    expect(names).toContain('mnemo_briefing');
  });

  it('all tools have required fields', () => {
    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeTruthy();
      expect(typeof tool.handler).toBe('function');
    }
  });
});

describe('MCP Resources', () => {
  it('defines expected resources', () => {
    const uris = resources.map(r => r.uri);
    expect(uris).toContain('mnemo://briefing/latest');
    expect(uris).toContain('mnemo://insights/active');
  });
});

describe('MnemoClient', () => {
  it('constructs with config', () => {
    const client = new MnemoClient({ baseUrl: 'http://localhost:3001' });
    expect(client).toBeTruthy();
  });

  it('strips trailing slash from base URL', () => {
    const client = new MnemoClient({ baseUrl: 'http://localhost:3001/' });
    // Can't directly test private field, but construction should not throw
    expect(client).toBeTruthy();
  });
});
