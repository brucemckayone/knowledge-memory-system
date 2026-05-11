/**
 * Tiny file-extension classifier for the demo seed pipeline.
 *
 * Maps a path or filename to one of the platform's content_type hints:
 *  - 'prose'   — natural-language docs (.md, .txt)
 *  - 'code-ts' — TypeScript / TSX source
 *  - 'code-sql' — SQL migrations / DDL
 *
 * Anything we don't recognise falls back to 'prose' so the existing free-
 * extraction path handles it. The classifier is intentionally dumb — extension
 * only, no content sniffing — because the seed script knows exactly what it's
 * feeding in and we want classification to be predictable for the demo run.
 */

export type ContentType = 'prose' | 'code-ts' | 'code-sql';

export function classifyByFilename(path: string): ContentType {
  const lower = path.toLowerCase();
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'code-ts';
  if (lower.endsWith('.sql')) return 'code-sql';
  if (lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.txt')) return 'prose';
  return 'prose';
}
