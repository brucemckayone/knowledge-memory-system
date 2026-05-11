/**
 * Obsidian Vault CLI Utilities (W39)
 *
 * Filesystem operations for reading Obsidian vault contents.
 * Handles .md file discovery, frontmatter parsing, and change detection.
 */

import { readFile, readdir, stat, writeFile, mkdir } from 'fs/promises';
import { createHash } from 'crypto';
import { join, dirname, relative, extname } from 'path';

export interface VaultFile {
  path: string;
  relativePath: string;
  contentHash: string;
  content: string;
  modifiedAt: Date;
  size: number;
}

/**
 * List all markdown files in a vault directory.
 */
export async function listVaultFiles(vaultPath: string): Promise<VaultFile[]> {
  const files: VaultFile[] = [];
  await walkDirectory(vaultPath, vaultPath, files);
  return files;
}

async function walkDirectory(dir: string, root: string, files: VaultFile[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    // Skip dotfiles/dirs and common ignored directories
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

    if (entry.isDirectory()) {
      await walkDirectory(fullPath, root, files);
    } else if (entry.isFile() && extname(entry.name) === '.md') {
      try {
        const content = await readFile(fullPath, 'utf-8');
        const fileStat = await stat(fullPath);
        const hash = createHash('sha256').update(content).digest('hex');

        files.push({
          path: fullPath,
          relativePath: relative(root, fullPath).replace(/\\/g, '/'),
          contentHash: hash,
          content,
          modifiedAt: fileStat.mtime,
          size: fileStat.size,
        });
      } catch (error) {
        console.warn(`⚠️ Failed to read vault file ${fullPath}:`, error);
      }
    }
  }
}

/**
 * Compute content hash for a string.
 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Create a file in the vault (for write-back).
 */
export async function create(
  vaultPath: string,
  relativePath: string,
  content: string,
): Promise<string> {
  const fullPath = join(vaultPath, relativePath);
  const dir = dirname(fullPath);

  await mkdir(dir, { recursive: true });
  await writeFile(fullPath, content, 'utf-8');

  return fullPath;
}
