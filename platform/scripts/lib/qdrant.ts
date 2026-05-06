/**
 * Qdrant collection helpers used by snapshot tooling.
 *
 * Doc 28 §3.5 step 6: "Drops the target Qdrant collection unconditionally."
 * For the empty/skeleton entry, no Qdrant snapshot file is recorded and
 * Qdrant interactions are skipped. These helpers exist for the j77.2/.3 work
 * that adds full Qdrant snapshotting; the skeleton uses only deleteCollection
 * for the load-snapshot path.
 */

const QDRANT_URL = process.env.QDRANT_URL || 'http://127.0.0.1:6335';

export async function deleteCollection(collection: string): Promise<void> {
  const url = `${QDRANT_URL}/collections/${encodeURIComponent(collection)}`;
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => '<no body>');
    throw new Error(`DELETE ${url} → ${res.status}: ${body}`);
  }
}

export async function collectionExists(collection: string): Promise<boolean> {
  const url = `${QDRANT_URL}/collections/${encodeURIComponent(collection)}`;
  const res = await fetch(url);
  return res.ok;
}
