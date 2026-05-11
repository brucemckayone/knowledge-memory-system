/**
 * Obsidian Read Adapter Tests (W39)
 *
 * Tests vault file listing and content hashing using temporary directories.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { listVaultFiles, hashContent, create } from '../../services/obsidian/cli.js';

describe('Obsidian Read Adapter', () => {
  it('exports syncVault function', async () => {
    const mod = await import('../../services/ingest/adapters/obsidian-read.js');
    expect(typeof mod.syncVault).toBe('function');
  });
});

describe('Obsidian CLI', () => {
  it('computes deterministic content hashes', () => {
    const h1 = hashContent('hello world');
    const h2 = hashContent('hello world');
    const h3 = hashContent('different');
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });
});

describe('listVaultFiles', () => {
  let tmpDir: string;

  afterAll(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('discovers .md files in a temp vault', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mnemo-vault-test-'));

    // Create vault structure
    await writeFile(join(tmpDir, 'note1.md'), '# Note 1\nHello world');
    await mkdir(join(tmpDir, 'subdir'), { recursive: true });
    await writeFile(join(tmpDir, 'subdir', 'note2.md'), '# Note 2\nNested note');
    await writeFile(join(tmpDir, 'ignored.txt'), 'Not markdown');

    const files = await listVaultFiles(tmpDir);

    expect(files.length).toBe(2);

    const paths = files.map(f => f.relativePath).sort();
    expect(paths).toContain('note1.md');
    expect(paths).toContain('subdir/note2.md');

    // Each file should have content and hash
    const note1 = files.find(f => f.relativePath === 'note1.md')!;
    expect(note1.content).toContain('Hello world');
    expect(note1.contentHash).toBeTruthy();
    expect(note1.size).toBeGreaterThan(0);
  });

  it('skips dotfiles and dotdirs', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mnemo-vault-dot-'));

    await writeFile(join(tmpDir, 'visible.md'), 'Visible');
    await writeFile(join(tmpDir, '.hidden.md'), 'Hidden');
    await mkdir(join(tmpDir, '.obsidian'), { recursive: true });
    await writeFile(join(tmpDir, '.obsidian', 'config.md'), 'Config');

    const files = await listVaultFiles(tmpDir);
    const paths = files.map(f => f.relativePath);

    expect(paths).toContain('visible.md');
    expect(paths).not.toContain('.hidden.md');
    expect(paths).not.toContain('.obsidian/config.md');
  });
});

describe('create', () => {
  let tmpDir: string;

  afterAll(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('creates a file with nested directories', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mnemo-vault-create-'));

    const fullPath = await create(tmpDir, 'insights/2026/test-insight.md', '# Test Insight\nGenerated content');

    expect(fullPath).toContain('test-insight.md');

    const files = await listVaultFiles(tmpDir);
    const found = files.find(f => f.relativePath.includes('test-insight.md'));
    expect(found).toBeDefined();
    expect(found!.content).toContain('Generated content');
  });
});
