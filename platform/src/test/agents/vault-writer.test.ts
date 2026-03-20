/**
 * Vault Writer Agent Tests (W40)
 */

import { describe, it, expect } from 'vitest';
import { renderEntityNote, renderInsightNote, renderBriefingNote } from '../../services/obsidian/templates.js';

describe('Vault Writer Agent', () => {
  it('has correct name and tier', async () => {
    const { vaultWriterAgent } = await import('../../gardener/agents/vault-writer.agent.js');
    expect(vaultWriterAgent.name).toBe('vault-writer');
    expect(vaultWriterAgent.tier).toBe('periodic');
  });
});

describe('Obsidian Templates', () => {
  it('renders entity note with frontmatter', () => {
    const md = renderEntityNote({
      name: 'Alice',
      type: 'person',
      description: 'A software engineer.',
      facts: [{ predicate: 'works_at', object: 'Acme Corp' }],
      relatedEntities: [{ name: 'Bob', relationship: 'colleague' }],
      lastUpdated: '2026-03-19',
    });

    expect(md).toContain('title: "Alice"');
    expect(md).toContain('# Alice');
    expect(md).toContain('**works_at**: Acme Corp');
    expect(md).toContain('[[Bob]]');
  });

  it('renders insight note', () => {
    const md = renderInsightNote({
      title: 'Cross-team Collaboration',
      body: 'Alice and Bob frequently work on similar topics.',
      type: 'connection',
      entities: ['Alice', 'Bob'],
      confidence: 0.85,
      generatedAt: '2026-03-19T00:00:00Z',
    });

    expect(md).toContain('# Cross-team Collaboration');
    expect(md).toContain('[[Alice]]');
    expect(md).toContain('confidence: 0.85');
  });

  it('renders briefing note', () => {
    const md = renderBriefingNote({
      date: '2026-03-19',
      summary: 'You have 5 pending tasks.',
      sections: [{ title: 'Tasks', content: '- Fix bug\n- Review PR' }],
    });

    expect(md).toContain('# Morning Briefing');
    expect(md).toContain('## Tasks');
    expect(md).toContain('- Fix bug');
  });
});
