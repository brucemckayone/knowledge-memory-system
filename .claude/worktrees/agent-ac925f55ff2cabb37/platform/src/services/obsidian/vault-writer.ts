/**
 * Obsidian Vault Writer (W40)
 *
 * Writes Mnemo content back into an Obsidian vault as markdown files.
 * Uses templates to generate properly formatted notes.
 */

import { create } from './cli.js';
import { renderEntityNote, renderInsightNote, renderBriefingNote } from './templates.js';
import type { EntityTemplateData, InsightTemplateData, BriefingTemplateData } from './templates.js';
import { config } from '../../config.js';

const OUTPUT_DIR = 'mnemo-output';

/**
 * Write an entity note to the vault.
 */
export async function writeEntityNote(data: EntityTemplateData): Promise<string | null> {
  const vaultPath = config.OBSIDIAN_VAULT_PATH;
  if (!vaultPath) return null;

  const content = renderEntityNote(data);
  const safeName = data.name.replace(/[/\\?%*:|"<>]/g, '-');
  const relativePath = `${OUTPUT_DIR}/entities/${safeName}.md`;

  return create(vaultPath, relativePath, content);
}

/**
 * Write an insight note to the vault.
 */
export async function writeInsightNote(data: InsightTemplateData): Promise<string | null> {
  const vaultPath = config.OBSIDIAN_VAULT_PATH;
  if (!vaultPath) return null;

  const content = renderInsightNote(data);
  const safeName = data.title.replace(/[/\\?%*:|"<>]/g, '-').slice(0, 100);
  const relativePath = `${OUTPUT_DIR}/insights/${safeName}.md`;

  return create(vaultPath, relativePath, content);
}

/**
 * Write a briefing note to the vault.
 */
export async function writeBriefingNote(data: BriefingTemplateData): Promise<string | null> {
  const vaultPath = config.OBSIDIAN_VAULT_PATH;
  if (!vaultPath) return null;

  const content = renderBriefingNote(data);
  const relativePath = `${OUTPUT_DIR}/briefings/${data.date}.md`;

  return create(vaultPath, relativePath, content);
}
