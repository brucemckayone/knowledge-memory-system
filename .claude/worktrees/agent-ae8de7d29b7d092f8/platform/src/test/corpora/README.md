# Test Corpora

Source-text inputs for the LLM-pipeline snapshot generator (doc 28 §3.4 / nmemo-j77.3).

Contents:

- `frankenstein-ch1-10.txt` — Chapters 1-10 of Mary Shelley's *Frankenstein* (Project Gutenberg eBook #84, https://www.gutenberg.org/ebooks/84). Public domain in the United States and most jurisdictions. Extracted from the canonical UTF-8 plain-text edition (`https://www.gutenberg.org/cache/epub/84/pg84.txt`) and trimmed to chapters 1-10. ~144 KB. LF line endings enforced via `.gitattributes`. Used as the canonical narrative cluster-bridging fixture per doc 28 §2.2.

To re-derive `frankenstein-ch1-10.txt`:

```bash
curl -s -o /tmp/pg84.txt https://www.gutenberg.org/cache/epub/84/pg84.txt
sed -n '652,3129p' /tmp/pg84.txt | tr -d '\r' > frankenstein-ch1-10.txt
```

The line range tracks the `Chapter 1` / `Chapter 11` markers in the current edition; if the source file is updated upstream, re-derive against the new chapter offsets and update the manifest's `expected_hashes.cognitive.dump` (the LLM ingest output will drift).

These corpora are committed to the repo per doc 28 §2.4: small enough to commit, permissive license, and the regeneration recipe stays executable on a fresh clone without external dependencies beyond `curl`.
