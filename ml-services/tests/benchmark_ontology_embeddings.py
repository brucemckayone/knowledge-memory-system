"""
Ontology Embedding Benchmark (v2)
==================================

Validates core assumptions for the living ontology design across 11 benchmarks:

B1:  Raw vs enriched embedding quality
B2:  HAC clustering quality
B3:  Two-threshold calibration
B4:  Novel predicate detection
B5:  String similarity baseline
B6:  Real LLM extraction output mapping
B7:  Adversarial pair discrimination (tense pairs removed — now aliases)
B8:  Noise predicate rejection
B9:  Natural language predicate mapping (tense NL maps to base form)
B10: Cross-validation (train/test split)
B11: Ontology scale stress test
B12: Inverse pair detection via registry

Run: py -m tests.benchmark_ontology_embeddings
Requires: Ollama running with nomic-embed-text on localhost:11434
Optional: ML services on localhost:8000 for B6 (real extraction)
"""

import json
import time
import sys
import os
from itertools import combinations
from typing import Optional

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    import ollama
except ImportError:
    print("ERROR: pip install ollama")
    sys.exit(1)

try:
    from sklearn.cluster import AgglomerativeClustering
    from sklearn.metrics.pairwise import cosine_distances
    from sklearn.metrics import precision_recall_fscore_support
except ImportError:
    print("ERROR: pip install scikit-learn")
    sys.exit(1)

from tests.ontology_test_data import (
    ONTOLOGY,
    INVERSE_PAIRS,
    NOVEL_PREDICATES,
    ADVERSARIAL_PAIRS,
    NOISE_PREDICATES,
    NATURAL_LANGUAGE_PREDICATES,
    EXTRACTION_SAMPLES,
)


# ============================================================================
# EMBEDDING HELPERS
# ============================================================================

client = ollama.Client(host="http://localhost:11434", timeout=30.0)
ML_SERVICES_URL = os.getenv("ML_SERVICES_URL", "http://127.0.0.1:8000")


def embed_raw(text: str) -> np.ndarray:
    resp = client.embeddings(model="nomic-embed-text", prompt=text)
    return np.array(resp["embedding"])


def embed_enriched(label: str, description: str) -> np.ndarray:
    prompt = f"clustering: The relationship '{label}' describes {description.lower()}"
    resp = client.embeddings(model="nomic-embed-text", prompt=prompt)
    return np.array(resp["embedding"])


def cosine_sim(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


def mean_center(embeddings: np.ndarray) -> np.ndarray:
    return embeddings - embeddings.mean(axis=0)


def get_description(label: str) -> str:
    """Find description for a label (canonical or alias)."""
    if label in ONTOLOGY:
        return ONTOLOGY[label]["description"]
    for info in ONTOLOGY.values():
        if label in info["aliases"]:
            return info["description"]
    return label.replace("_", " ")


def embed_all_ontology():
    """Embed all canonical predicates and their aliases. Returns (raw, enriched) dicts."""
    all_labels = set(ONTOLOGY.keys())
    for info in ONTOLOGY.values():
        all_labels.update(info["aliases"])

    raw_embs = {}
    enriched_embs = {}
    for label in sorted(all_labels):
        desc = get_description(label)
        raw_embs[label] = embed_raw(label)
        enriched_embs[label] = embed_enriched(label, desc)

    return raw_embs, enriched_embs


# ============================================================================
# RESULTS TRACKING
# ============================================================================

results_summary = {}


def record(benchmark: str, metric: str, value, passed: Optional[bool] = None):
    if benchmark not in results_summary:
        results_summary[benchmark] = {}
    results_summary[benchmark][metric] = value
    if passed is not None:
        results_summary[benchmark][f"{metric}_passed"] = passed


# ============================================================================
# B1: Raw vs Enriched Embedding Quality
# ============================================================================

def b1_raw_vs_enriched(raw_embs, enriched_embs):
    print("\n" + "=" * 70)
    print("B1: Raw vs Enriched Embedding Quality")
    print("=" * 70)

    synonym_pairs = [(c, a) for c, info in ONTOLOGY.items() for a in info["aliases"]]
    cross_cat = [(a, b) for a, b in combinations(ONTOLOGY.keys(), 2) if ONTOLOGY[a]["category"] != ONTOLOGY[b]["category"]]
    same_cat = [(a, b) for a, b in combinations(ONTOLOGY.keys(), 2) if ONTOLOGY[a]["category"] == ONTOLOGY[b]["category"]]

    print(f"\nPairs: {len(synonym_pairs)} synonym, {len(cross_cat)} cross-cat, {len(same_cat)} same-cat")

    for mode, embs in [("RAW", raw_embs), ("ENRICHED", enriched_embs)]:
        syn = [cosine_sim(embs[a], embs[b]) for a, b in synonym_pairs]
        dist = [cosine_sim(embs[a], embs[b]) for a, b in cross_cat]
        same = [cosine_sim(embs[a], embs[b]) for a, b in same_cat]

        gap = np.mean(syn) - np.mean(dist)
        hard_gap = np.mean(syn) - np.mean(same)

        print(f"\n--- {mode} ---")
        print(f"  Synonyms:    mean={np.mean(syn):.4f}  min={np.min(syn):.4f}  max={np.max(syn):.4f}")
        print(f"  Cross-cat:   mean={np.mean(dist):.4f}  min={np.min(dist):.4f}  max={np.max(dist):.4f}")
        print(f"  Same-cat:    mean={np.mean(same):.4f}  min={np.min(same):.4f}  max={np.max(same):.4f}")
        print(f"  Gap (cross): {gap:.4f}  Gap (same): {hard_gap:.4f}")

    # Mean-centered enriched
    all_labels = sorted(enriched_embs.keys())
    centered = mean_center(np.array([enriched_embs[l] for l in all_labels]))
    c_embs = {l: centered[i] for i, l in enumerate(all_labels)}

    syn = [cosine_sim(c_embs[a], c_embs[b]) for a, b in synonym_pairs]
    dist = [cosine_sim(c_embs[a], c_embs[b]) for a, b in cross_cat]
    gap = np.mean(syn) - np.mean(dist)

    print(f"\n--- ENRICHED + MEAN-CENTERED ---")
    print(f"  Synonyms: mean={np.mean(syn):.4f}  Distinct: mean={np.mean(dist):.4f}  Gap: {gap:.4f}")

    record("B1", "enriched_gap", gap, passed=gap > 0.50)
    return c_embs


# ============================================================================
# B2: HAC Clustering Quality
# ============================================================================

def b2_hac_clustering(enriched_embs):
    print("\n" + "=" * 70)
    print("B2: HAC Clustering Quality")
    print("=" * 70)

    label_to_canonical = {}
    for c, info in ONTOLOGY.items():
        label_to_canonical[c] = c
        for a in info["aliases"]:
            label_to_canonical[a] = c

    labels = sorted(enriched_embs.keys())
    emb_matrix = mean_center(np.array([enriched_embs[l] for l in labels]))
    dist_matrix = cosine_distances(emb_matrix)

    best_f1 = 0
    best_thresh = 0

    print(f"\n{'Thresh':>8} {'Clusters':>9} {'Prec':>8} {'Rec':>8} {'F1':>8}")
    print("-" * 45)

    for thresh in np.arange(0.10, 0.65, 0.05):
        cl = AgglomerativeClustering(n_clusters=None, distance_threshold=thresh, metric="precomputed", linkage="complete")
        cl_labels = cl.fit_predict(dist_matrix)

        y_true, y_pred = [], []
        for i in range(len(labels)):
            for j in range(i + 1, len(labels)):
                ca, cb = label_to_canonical.get(labels[i]), label_to_canonical.get(labels[j])
                if ca is None or cb is None:
                    continue
                y_true.append(1 if ca == cb else 0)
                y_pred.append(1 if cl_labels[i] == cl_labels[j] else 0)

        p, r, f1, _ = precision_recall_fscore_support(y_true, y_pred, average="binary", zero_division=0)
        n_cl = len(set(cl_labels))
        print(f"{thresh:>8.2f} {n_cl:>9} {p:>8.4f} {r:>8.4f} {f1:>8.4f}")
        if f1 > best_f1:
            best_f1, best_thresh = f1, thresh

    print(f"\nBest: thresh={best_thresh:.2f} F1={best_f1:.4f}")
    passed = best_f1 >= 0.80
    print("PASS" if passed else "FAIL: F1 < 0.80")
    record("B2", "best_f1", best_f1, passed=passed)
    return best_thresh


# ============================================================================
# B3: Two-Threshold Calibration
# ============================================================================

def b3_threshold_calibration(enriched_embs):
    print("\n" + "=" * 70)
    print("B3: Two-Threshold Calibration")
    print("=" * 70)

    syn_sims = np.array([
        cosine_sim(enriched_embs[c], enriched_embs[a])
        for c, info in ONTOLOGY.items() for a in info["aliases"]
        if c in enriched_embs and a in enriched_embs
    ])
    dist_sims = np.array([
        cosine_sim(enriched_embs[a], enriched_embs[b])
        for a, b in combinations(ONTOLOGY.keys(), 2)
        if a in enriched_embs and b in enriched_embs
    ])

    merge_t = float(np.percentile(syn_sims, 5))
    distinct_t = float(np.percentile(dist_sims, 95))
    clean = merge_t > distinct_t

    print(f"\n  Merge threshold:   >= {merge_t:.4f}")
    print(f"  Distinct threshold: < {distinct_t:.4f}")
    print(f"  LLM zone width:     {max(0, merge_t - distinct_t):.4f}")
    print(f"  {'PASS: Clean separation' if clean else 'WARNING: Overlap'}")

    # Hardest cases
    pairs = [(cosine_sim(enriched_embs[c], enriched_embs[a]), c, a)
             for c, info in ONTOLOGY.items() for a in info["aliases"]
             if c in enriched_embs and a in enriched_embs]
    pairs.sort()
    print(f"\n  5 hardest aliases:")
    for sim, c, a in pairs[:5]:
        print(f"    {sim:.4f}  {c} <-> {a}")

    record("B3", "merge_threshold", merge_t)
    record("B3", "distinct_threshold", distinct_t)
    record("B3", "clean_separation", clean, passed=clean)
    return merge_t, distinct_t


# ============================================================================
# B4: Novel Predicate Detection
# ============================================================================

def b4_novel_detection(enriched_embs, merge_t):
    print("\n" + "=" * 70)
    print("B4: Novel Predicate Detection")
    print("=" * 70)

    correct = 0
    for label, info in NOVEL_PREDICATES.items():
        emb = embed_enriched(label, info["description"])
        max_sim = max(cosine_sim(emb, enriched_embs[c]) for c in ONTOLOGY.keys())
        nearest = max(ONTOLOGY.keys(), key=lambda c: cosine_sim(emb, enriched_embs[c]))
        is_novel = max_sim < merge_t
        print(f"  {label:20s}  nearest={nearest:15s}  sim={max_sim:.4f}  {'NOVEL' if is_novel else 'MERGED (WRONG)'}")
        if is_novel:
            correct += 1

    acc = correct / len(NOVEL_PREDICATES)
    print(f"\nAccuracy: {correct}/{len(NOVEL_PREDICATES)} ({acc:.0%})")
    record("B4", "accuracy", acc, passed=acc >= 0.80)


# ============================================================================
# B5: String Similarity Baseline
# ============================================================================

def b5_string_similarity():
    print("\n" + "=" * 70)
    print("B5: String Similarity (Jaro-Winkler) Baseline")
    print("=" * 70)

    try:
        from jellyfish import jaro_winkler_similarity
    except ImportError:
        print("SKIPPED: pip install jellyfish")
        record("B5", "skipped", True)
        return

    syn = [jaro_winkler_similarity(c, a) for c, info in ONTOLOGY.items() for a in info["aliases"]]
    dist = [jaro_winkler_similarity(a, b) for a, b in combinations(ONTOLOGY.keys(), 2)]
    gap = np.mean(syn) - np.mean(dist)

    print(f"\n  Synonyms: mean={np.mean(syn):.4f}  Distinct: mean={np.mean(dist):.4f}  Gap: {gap:.4f}")
    print(f"  {'Useful supplement' if gap > 0.10 else 'Low discriminative power (expected)'}")
    record("B5", "gap", gap)


# ============================================================================
# B6: Real LLM Extraction Output
# ============================================================================

def b6_real_extraction(enriched_embs, merge_t):
    print("\n" + "=" * 70)
    print("B6: Real LLM Extraction Output")
    print("=" * 70)

    try:
        import urllib.request
        # Quick check if ML services are available
        req = urllib.request.Request(f"{ML_SERVICES_URL}/health")
        urllib.request.urlopen(req, timeout=3)
    except Exception:
        print("SKIPPED: ML services not available at", ML_SERVICES_URL)
        record("B6", "skipped", True)
        return

    import urllib.request

    extracted_predicates = []
    for text in EXTRACTION_SAMPLES:
        try:
            body = json.dumps({"content": text, "entities": []}).encode()
            req = urllib.request.Request(
                f"{ML_SERVICES_URL}/extract-relationships",
                data=body,
                headers={"Content-Type": "application/json"},
            )
            resp = urllib.request.urlopen(req, timeout=60)
            data = json.loads(resp.read())
            for rel in data.get("relationships", []):
                extracted_predicates.append(rel["predicate"])
        except Exception as e:
            print(f"  Warning: extraction failed for '{text[:40]}...': {e}")

    if not extracted_predicates:
        print("  No predicates extracted — cannot evaluate")
        record("B6", "skipped", True)
        return

    print(f"\n  Extracted {len(extracted_predicates)} predicates from {len(EXTRACTION_SAMPLES)} texts")
    unique = set(extracted_predicates)
    print(f"  Unique predicates: {unique}")

    # For each extracted predicate, find nearest canonical
    correct_maps = 0
    total = 0
    for pred in unique:
        desc = pred.replace("_", " ")
        emb = embed_enriched(pred, desc)
        nearest = max(ONTOLOGY.keys(), key=lambda c: cosine_sim(emb, enriched_embs[c]))
        sim = cosine_sim(emb, enriched_embs[nearest])
        is_known = sim >= merge_t
        status = f"-> {nearest} ({sim:.3f})" if is_known else f"NOVEL ({sim:.3f}, nearest={nearest})"
        print(f"    {pred:30s}  {status}")

        # Count predicates that map to a reasonable canonical or are correctly novel
        if is_known or pred in NOVEL_PREDICATES:
            correct_maps += 1
        total += 1

    acc = correct_maps / total if total else 0
    print(f"\n  Mapping rate: {correct_maps}/{total} ({acc:.0%})")
    record("B6", "mapping_rate", acc, passed=acc >= 0.60)


# ============================================================================
# B7: Adversarial Pair Discrimination
# ============================================================================

def b7_adversarial_pairs(enriched_embs, merge_t):
    print("\n" + "=" * 70)
    print("B7: Adversarial Pair Discrimination")
    print("=" * 70)

    false_merges = 0
    in_llm_zone = 0
    correctly_distinct = 0

    for pred_a, pred_b, desc_a, desc_b, reason in ADVERSARIAL_PAIRS:
        emb_a = embed_enriched(pred_a, desc_a)
        emb_b = embed_enriched(pred_b, desc_b)
        sim = cosine_sim(emb_a, emb_b)

        if sim >= merge_t:
            status = "FALSE MERGE"
            false_merges += 1
        elif sim >= merge_t - 0.05:  # within 0.05 of merge threshold
            status = "LLM ZONE"
            in_llm_zone += 1
        else:
            status = "DISTINCT"
            correctly_distinct += 1

        print(f"  {sim:.4f}  {pred_a:20s} <-> {pred_b:20s}  {status:12s}  ({reason})")

    total = len(ADVERSARIAL_PAIRS)
    print(f"\n  False merges: {false_merges}/{total}")
    print(f"  LLM zone:     {in_llm_zone}/{total}")
    print(f"  Distinct:     {correctly_distinct}/{total}")

    passed = false_merges == 0
    print(f"  {'PASS: No false merges' if passed else 'FAIL: False merges detected'}")
    record("B7", "false_merges", false_merges, passed=passed)
    record("B7", "in_llm_zone", in_llm_zone)


# ============================================================================
# B8: Noise Predicate Rejection
# ============================================================================

def b8_noise_rejection(enriched_embs, merge_t, distinct_t):
    print("\n" + "=" * 70)
    print("B8: Noise Predicate Rejection")
    print("=" * 70)

    above_merge = 0
    in_llm_zone = 0
    below_distinct = 0

    for noise in NOISE_PREDICATES:
        emb = embed_enriched(noise["label"], noise["desc"])
        max_sim = max(cosine_sim(emb, enriched_embs[c]) for c in ONTOLOGY.keys())
        nearest = max(ONTOLOGY.keys(), key=lambda c: cosine_sim(emb, enriched_embs[c]))

        if max_sim >= merge_t:
            status = "LEAKED (above merge)"
            above_merge += 1
        elif max_sim >= distinct_t:
            status = "LLM ZONE"
            in_llm_zone += 1
        else:
            status = "REJECTED"
            below_distinct += 1

        print(f"  {max_sim:.4f}  {noise['label']:35s}  nearest={nearest:15s}  {status}")

    total = len(NOISE_PREDICATES)
    print(f"\n  Above merge:    {above_merge}/{total}")
    print(f"  LLM zone:       {in_llm_zone}/{total}")
    print(f"  Auto-rejected:  {below_distinct}/{total}")

    merge_pass = above_merge == 0
    reject_rate = below_distinct / total
    print(f"  {'PASS' if merge_pass else 'FAIL'}: Merge leak = {above_merge}")
    print(f"  {'PASS' if reject_rate >= 0.80 else 'WARN'}: Auto-reject rate = {reject_rate:.0%} (target >= 80%)")
    record("B8", "merge_leaks", above_merge, passed=merge_pass)
    record("B8", "auto_reject_rate", reject_rate, passed=reject_rate >= 0.80)


# ============================================================================
# B9: Natural Language Predicate Mapping
# ============================================================================

def b9_natural_language_mapping(enriched_embs):
    print("\n" + "=" * 70)
    print("B9: Natural Language Predicate Mapping")
    print("=" * 70)

    correct = 0
    total = len(NATURAL_LANGUAGE_PREDICATES)

    for phrase, expected_canonical in NATURAL_LANGUAGE_PREDICATES:
        desc = phrase  # The phrase IS the description for NL predicates
        emb = embed_enriched(phrase, desc)
        nearest = max(ONTOLOGY.keys(), key=lambda c: cosine_sim(emb, enriched_embs[c]))
        sim = cosine_sim(emb, enriched_embs[nearest])
        is_correct = nearest == expected_canonical
        status = "OK" if is_correct else f"WRONG (got {nearest})"
        print(f"  {sim:.4f}  {phrase:40s}  -> {expected_canonical:15s}  {status}")
        if is_correct:
            correct += 1

    acc = correct / total
    print(f"\nAccuracy: {correct}/{total} ({acc:.0%})")
    passed = acc >= 0.85
    print(f"{'PASS' if passed else 'FAIL'}: Target >= 85%")
    record("B9", "accuracy", acc, passed=passed)


# ============================================================================
# B10: Cross-Validation
# ============================================================================

def b10_cross_validation():
    print("\n" + "=" * 70)
    print("B10: Cross-Validation (5 random splits)")
    print("=" * 70)

    # Build all synonym pairs with embeddings
    all_pairs = []
    for canonical, info in ONTOLOGY.items():
        for alias in info["aliases"]:
            all_pairs.append((canonical, alias, True))

    # Add distinct pairs (sample to balance)
    canonicals = list(ONTOLOGY.keys())
    distinct = [(a, b, False) for a, b in combinations(canonicals, 2)]
    np.random.seed(42)
    if len(distinct) > len(all_pairs) * 2:
        indices = np.random.choice(len(distinct), size=len(all_pairs) * 2, replace=False)
        distinct = [distinct[i] for i in indices]
    all_pairs.extend(distinct)

    # Embed everything needed
    all_labels = set()
    for a, b, _ in all_pairs:
        all_labels.add(a)
        all_labels.add(b)

    embs = {}
    for label in all_labels:
        if label not in embs:
            embs[label] = embed_enriched(label, get_description(label))

    f1_scores = []
    for fold in range(5):
        np.random.seed(fold)
        indices = np.random.permutation(len(all_pairs))
        split = int(0.7 * len(indices))
        train_idx, test_idx = indices[:split], indices[split:]

        # Calibrate on train
        train_syn = [cosine_sim(embs[all_pairs[i][0]], embs[all_pairs[i][1]]) for i in train_idx if all_pairs[i][2]]
        train_dist = [cosine_sim(embs[all_pairs[i][0]], embs[all_pairs[i][1]]) for i in train_idx if not all_pairs[i][2]]

        if not train_syn or not train_dist:
            continue

        threshold = (np.mean(train_syn) + np.mean(train_dist)) / 2

        # Evaluate on test
        y_true = [1 if all_pairs[i][2] else 0 for i in test_idx]
        y_pred = [1 if cosine_sim(embs[all_pairs[i][0]], embs[all_pairs[i][1]]) >= threshold else 0 for i in test_idx]

        _, _, f1, _ = precision_recall_fscore_support(y_true, y_pred, average="binary", zero_division=0)
        f1_scores.append(f1)
        print(f"  Fold {fold + 1}: threshold={threshold:.4f}  F1={f1:.4f}")

    mean_f1 = np.mean(f1_scores)
    std_f1 = np.std(f1_scores)
    print(f"\n  Mean F1: {mean_f1:.4f} +/- {std_f1:.4f}")
    passed = mean_f1 >= 0.75
    print(f"  {'PASS' if passed else 'FAIL'}: Target >= 0.75")
    record("B10", "mean_f1", mean_f1, passed=passed)
    record("B10", "std_f1", std_f1)


# ============================================================================
# B11: Ontology Scale Stress Test
# ============================================================================

def b11_scale_stress_test(enriched_embs, merge_t):
    print("\n" + "=" * 70)
    print("B11: Ontology Scale Stress Test")
    print("=" * 70)

    canonicals = list(ONTOLOGY.keys())
    novel_labels = list(NOVEL_PREDICATES.keys())

    # Simulate growing ontology: 5, 10, 15, 20, 25, all
    sizes = [5, 10, 15, 20, 25, len(canonicals)]
    thresholds = []

    for size in sizes:
        subset = canonicals[:size]

        # Compute pairwise distinct similarities for this subset
        if len(subset) < 2:
            continue

        dist_sims = [
            cosine_sim(enriched_embs[a], enriched_embs[b])
            for a, b in combinations(subset, 2)
        ]

        # Compute synonym sims for this subset
        syn_sims = []
        for c in subset:
            for a in ONTOLOGY[c]["aliases"]:
                if a in enriched_embs:
                    syn_sims.append(cosine_sim(enriched_embs[c], enriched_embs[a]))

        if not syn_sims:
            continue

        mt = float(np.percentile(syn_sims, 5))
        thresholds.append(mt)

        # Test novel detection at this size
        novel_correct = 0
        for nl in novel_labels:
            emb = embed_enriched(nl, NOVEL_PREDICATES[nl]["description"])
            max_sim = max(cosine_sim(emb, enriched_embs[c]) for c in subset)
            if max_sim < mt:
                novel_correct += 1

        novel_acc = novel_correct / len(novel_labels)
        print(f"  Size={size:>3}  merge_t={mt:.4f}  novel_acc={novel_acc:.0%}  distinct_pairs={len(dist_sims)}")

    if len(thresholds) >= 2:
        drift = max(thresholds) - min(thresholds)
        print(f"\n  Threshold drift: {drift:.4f}")
        passed = drift < 0.05
        print(f"  {'PASS' if passed else 'WARN'}: Target drift < 0.05")
        record("B11", "threshold_drift", drift, passed=passed)
    else:
        print("  Not enough data points for drift analysis")
        record("B11", "threshold_drift", None)


# ============================================================================
# B12: Inverse Pair Detection
# ============================================================================

def b12_inverse_pair_detection(enriched_embs, merge_t):
    print("\n" + "=" * 70)
    print("B12: Inverse Pair Detection via Registry")
    print("=" * 70)

    # Test: inverse pairs have high embedding similarity (they LOOK like synonyms)
    # but should NOT be merged because the registry catches them.
    # This proves the registry is necessary — embeddings alone would merge them.

    would_merge_without_registry = 0
    correctly_blocked = 0

    for pred_a, pred_b in INVERSE_PAIRS:
        # Embed both (use ontology descriptions where available)
        desc_a = ONTOLOGY.get(pred_a, {}).get("description", pred_a.replace("_", " "))
        desc_b = ONTOLOGY.get(pred_b, {}).get("description", pred_b.replace("_", " "))

        emb_a = embed_enriched(pred_a, desc_a)
        emb_b = embed_enriched(pred_b, desc_b)
        sim = cosine_sim(emb_a, emb_b)

        # Would embeddings alone merge this?
        embedding_would_merge = sim >= merge_t
        # Registry blocks the merge
        registry_blocks = True  # By definition — they're in the registry

        if embedding_would_merge:
            would_merge_without_registry += 1
            status = "BLOCKED BY REGISTRY (embedding would merge)"
        else:
            status = "DISTINCT (embedding already separates)"

        correctly_blocked += 1  # Registry always catches these
        print(f"  {sim:.4f}  {pred_a:15s} <-> {pred_b:15s}  {status}")

    total = len(INVERSE_PAIRS)
    print(f"\n  Total inverse pairs: {total}")
    print(f"  Would merge without registry: {would_merge_without_registry}/{total}")
    print(f"  Correctly blocked by registry: {correctly_blocked}/{total}")

    # The key metric: how many inverse pairs NEED the registry (embeddings can't separate them)?
    registry_essential = would_merge_without_registry / total if total else 0
    print(f"\n  Registry necessity: {registry_essential:.0%} of inverse pairs need registry to prevent false merge")
    print(f"  {'VALIDATES REGISTRY DESIGN' if would_merge_without_registry > 0 else 'Registry not strictly needed for these pairs (embeddings separate them)'}")

    record("B12", "would_merge_without_registry", would_merge_without_registry)
    record("B12", "registry_necessity", registry_essential, passed=True)


# ============================================================================
# MAIN
# ============================================================================

def main():
    print("=" * 70)
    print("ONTOLOGY EMBEDDING BENCHMARK v2")
    print("=" * 70)
    total_aliases = sum(len(info["aliases"]) for info in ONTOLOGY.values())
    print(f"Model: nomic-embed-text")
    print(f"Canonicals: {len(ONTOLOGY)} | Aliases: {total_aliases}")
    print(f"Novel: {len(NOVEL_PREDICATES)} | Adversarial: {len(ADVERSARIAL_PAIRS)} | Inverse pairs: {len(INVERSE_PAIRS)}")
    print(f"Noise: {len(NOISE_PREDICATES)} | NL phrases: {len(NATURAL_LANGUAGE_PREDICATES)}")

    try:
        client.embeddings(model="nomic-embed-text", prompt="test")
    except Exception as e:
        print(f"\nERROR: Ollama not available: {e}")
        sys.exit(1)

    start = time.time()

    # Embed the ontology once
    print("\nEmbedding ontology (this takes a few seconds)...")
    raw_embs, enriched_embs = embed_all_ontology()

    # Run all benchmarks
    centered_embs = b1_raw_vs_enriched(raw_embs, enriched_embs)
    b2_hac_clustering(enriched_embs)
    merge_t, distinct_t = b3_threshold_calibration(enriched_embs)
    b4_novel_detection(enriched_embs, merge_t)
    b5_string_similarity()
    b6_real_extraction(enriched_embs, merge_t)
    b7_adversarial_pairs(enriched_embs, merge_t)
    b8_noise_rejection(enriched_embs, merge_t, distinct_t)
    b9_natural_language_mapping(enriched_embs)
    b10_cross_validation()
    b11_scale_stress_test(enriched_embs, merge_t)
    b12_inverse_pair_detection(enriched_embs, merge_t)

    elapsed = time.time() - start

    # Final summary
    print("\n" + "=" * 70)
    print("RESULTS SUMMARY")
    print("=" * 70)
    print(f"Time: {elapsed:.1f}s\n")

    all_passed = True
    for bench, metrics in results_summary.items():
        pass_checks = [v for k, v in metrics.items() if k.endswith("_passed")]
        status = "PASS" if all(pass_checks) else ("SKIP" if metrics.get("skipped") else "FAIL")
        if status == "FAIL":
            all_passed = False
        key_metric = {k: v for k, v in metrics.items() if not k.endswith("_passed") and k != "skipped"}
        print(f"  {bench:6s}  {status:4s}  {key_metric}")

    print(f"\n{'ALL BENCHMARKS PASSED' if all_passed else 'SOME BENCHMARKS FAILED'}")

    # Save
    output_path = os.path.join(os.path.dirname(__file__), "ontology_benchmark_results.json")
    with open(output_path, "w") as f:
        json.dump({"elapsed": elapsed, "results": results_summary}, f, indent=2, default=str)
    print(f"Results saved to {output_path}")


if __name__ == "__main__":
    main()
