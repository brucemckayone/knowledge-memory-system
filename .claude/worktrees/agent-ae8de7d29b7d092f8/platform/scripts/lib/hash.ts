/**
 * SHA-256 file hashing for snapshot integrity checks.
 *
 * The manifest stores `expected_hashes` per file (doc 28 §2.3). `snapshot:verify`
 * compares file hashes against the manifest; `snapshot:ensure` uses a mismatch
 * as a regeneration signal (doc 28 §2.4).
 */

import { createHash } from 'crypto';
import { createReadStream, existsSync } from 'fs';

export async function sha256File(absPath: string): Promise<string> {
  if (!existsSync(absPath)) {
    throw new Error(`hash target missing: ${absPath}`);
  }
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(absPath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(`sha256:${hash.digest('hex')}`));
  });
}
