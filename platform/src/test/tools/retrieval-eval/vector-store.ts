/**
 * retrieval-eval — vector source.
 *
 * The dal harnesses read every vector from the single frozen embed cache
 * (embed-cache.json). The arxiv harness reads query vectors from the frozen
 * cache first, then falls back to a SEPARATE writable cache into which it embeds
 * the arxiv entity-name texts (and any arxiv query docs not in the frozen cache)
 * via Ollama. This class unifies both. Resolution order depends on the KIND of text:
 *   - getQuery  (query-doc vectors): frozen-first, then writable — matches arxiv's
 *     `qcache[t] ?? nameCache[t]` and dal's `cache[t]`.
 *   - getEntity (entity name/desc vectors): writable-first, then frozen. A corpus
 *     that embedded its OWN entity vectors into the writable cache must read those,
 *     not a string-identical frozen vector left by another corpus/extraction — an
 *     arxiv entity name like "attention" collides with a dal cache key (~65% do),
 *     and reading the dal-era vector would silently break the independent-extraction
 *     premise if the embedder version ever moved. dal has an empty writable cache,
 *     so its entity reads still fall through to frozen unchanged.
 * `ensureEmbedded` fills the writable cache for misses, failing loud on an empty
 * embedding — never degrading to []. For entity texts pass `ignoreFrozen` so they
 * always land in the writable cache (a frozen collision must not skip them).
 *
 * bead nmemo-u8j.2
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { ml } from '../../../services/ml-client.js';
import { normalise } from './core.js';

export class VectorStore {
  private readonly frozen: Record<string, number[]>;
  private readonly writable: Record<string, number[]>;
  private readonly writablePath: string | null;

  private constructor(frozen: Record<string, number[]>, writable: Record<string, number[]>, writablePath: string | null) {
    this.frozen = frozen;
    this.writable = writable;
    this.writablePath = writablePath;
  }

  /** Load the frozen cache, and optionally a writable cache (created empty if absent). */
  static load(frozenPath: string, writablePath?: string): VectorStore {
    const frozen = JSON.parse(readFileSync(frozenPath, 'utf8')) as Record<string, number[]>;
    const writable: Record<string, number[]> = writablePath && existsSync(writablePath)
      ? JSON.parse(readFileSync(writablePath, 'utf8'))
      : {};
    return new VectorStore(frozen, writable, writablePath ?? null);
  }

  get frozenSize(): number { return Object.keys(this.frozen).length; }
  get writableSize(): number { return Object.keys(this.writable).length; }

  /** Query-doc vectors: frozen-first, then writable. Throws if absent. */
  getQuery(text: string): number[] {
    const v = this.frozen[text] ?? this.writable[text];
    if (!v) throw new Error(`vector-store query miss: ${text.slice(0, 80)}`);
    return v;
  }

  /** Entity name/desc vectors: writable-first, then frozen. Throws if absent. */
  getEntity(text: string): number[] {
    const v = this.writable[text] ?? this.frozen[text];
    if (!v) throw new Error(`vector-store entity miss: ${text.slice(0, 80)}`);
    return v;
  }

  /** True if a text can be resolved without embedding (either cache). */
  has(text: string): boolean {
    return this.frozen[text] !== undefined || this.writable[text] !== undefined;
  }

  /**
   * Embed every not-yet-resolvable text into the writable cache (L2-normalised),
   * persisting to disk periodically. Requires a writablePath. Fails loud on an empty
   * embedding rather than degrading to []. With `ignoreFrozen`, a text present ONLY
   * in the frozen cache is still embedded into the writable cache — required for
   * entity texts, whose reads are writable-first (a frozen collision must not leave
   * the entity resolvable only from another extraction's vector).
   */
  async ensureEmbedded(texts: Iterable<string>, ignoreFrozen = false): Promise<number> {
    if (this.writablePath === null) throw new Error('ensureEmbedded requires a writable cache path');
    const present = (t: string): boolean => (ignoreFrozen ? this.writable[t] !== undefined : this.has(t));
    const missing = [...new Set(texts)].filter((t) => !present(t));
    if (missing.length === 0) return 0;
    console.log(`embedding ${missing.length} texts (Ollama) -> ${this.writablePath}`);
    let done = 0;
    for (const t of missing) {
      const { vector } = await ml.embed(t);
      if (!vector || vector.length === 0) throw new Error(`empty embedding for: ${t.slice(0, 60)}`);
      this.writable[t] = normalise(vector);
      done += 1;
      if (done % 500 === 0) { this.flush(); console.log(`   ${done}/${missing.length}`); }
    }
    this.flush();
    return done;
  }

  private flush(): void {
    if (this.writablePath !== null) writeFileSync(this.writablePath, JSON.stringify(this.writable));
  }
}
