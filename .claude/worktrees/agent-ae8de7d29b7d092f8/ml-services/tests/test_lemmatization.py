"""
Lemmatization Accuracy Test (Gate S4)
======================================

Validates that a lemmatizer achieves >= 95% accuracy on predicate-relevant verbs.
The living ontology pipeline needs to lemmatize inflected predicate verbs
(e.g., mentoring -> mentor, supervised -> supervise) before canonicalization.

Strategy:
  - Try spaCy (en_core_web_sm) if available.
  - Fall back to a rule-based lemmatizer covering common English verb inflections.

Run: py -m tests.test_lemmatization
"""

from __future__ import annotations

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


# ============================================================================
# TEST DATA — inflected predicate verbs grouped by inflection category
# ============================================================================

LEMMA_TESTS_ING: list[tuple[str, str]] = [
    ("mentoring", "mentor"),
    ("managing", "manage"),
    ("supervising", "supervise"),
    ("teaching", "teach"),
    ("coaching", "coach"),
    ("working", "work"),
    ("living", "live"),
    ("knowing", "know"),
    ("organizing", "organize"),
    ("attending", "attend"),
    ("creating", "create"),
    ("building", "build"),
    ("studying", "study"),
    ("investing", "invest"),
    ("competing", "compete"),
]

LEMMA_TESTS_ED: list[tuple[str, str]] = [
    ("managed", "manage"),
    ("supervised", "supervise"),
    ("employed", "employ"),
    ("organized", "organize"),
    ("attended", "attend"),
    ("created", "create"),
    ("founded", "found"),
    ("visited", "visit"),
    ("married", "marry"),
    ("studied", "study"),
]

LEMMA_TESTS_S: list[tuple[str, str]] = [
    ("manages", "manage"),
    ("works", "work"),
    ("lives", "live"),
    ("knows", "know"),
    ("owns", "own"),
    ("teaches", "teach"),
    ("runs", "run"),
]

LEMMA_TESTS_IRREGULAR: list[tuple[str, str]] = [
    ("led", "lead"),
    ("built", "build"),
    ("met", "meet"),
    ("spoke", "speak"),
]

ALL_TESTS: list[tuple[str, str, str]] = (
    [(w, l, "-ing") for w, l in LEMMA_TESTS_ING]
    + [(w, l, "-ed") for w, l in LEMMA_TESTS_ED]
    + [(w, l, "-s") for w, l in LEMMA_TESTS_S]
    + [(w, l, "irregular") for w, l in LEMMA_TESTS_IRREGULAR]
)


# ============================================================================
# IRREGULAR VERB TABLE (for rule-based fallback)
# ============================================================================

_IRREGULAR_PAST: dict[str, str] = {
    "led": "lead",
    "built": "build",
    "met": "meet",
    "spoke": "speak",
    "ran": "run",
    "wrote": "write",
    "drove": "drive",
    "gave": "give",
    "took": "take",
    "made": "make",
    "said": "say",
    "went": "go",
    "came": "come",
    "knew": "know",
    "grew": "grow",
    "threw": "throw",
    "drew": "draw",
    "flew": "fly",
    "chose": "choose",
    "broke": "break",
    "woke": "wake",
    "wore": "wear",
    "bore": "bore",
    "swore": "swear",
    "tore": "tear",
    "froze": "freeze",
    "rose": "rise",
    "shone": "shine",
    "got": "get",
    "sat": "sit",
    "held": "hold",
    "told": "tell",
    "sold": "sell",
    "found": "find",
    "kept": "keep",
    "left": "leave",
    "felt": "feel",
    "lost": "lose",
    "spent": "spend",
    "sent": "send",
    "lent": "lend",
    "bent": "bend",
    "dealt": "deal",
    "meant": "mean",
    "brought": "bring",
    "bought": "buy",
    "caught": "catch",
    "taught": "teach",
    "thought": "think",
    "fought": "fight",
    "sought": "seek",
    "stood": "stand",
    "understood": "understand",
    "began": "begin",
    "drank": "drink",
    "sang": "sing",
    "swam": "swim",
    "rang": "ring",
}

# Past participles that differ from simple past
_IRREGULAR_PARTICIPLE: dict[str, str] = {
    "spoken": "speak",
    "written": "write",
    "driven": "drive",
    "given": "give",
    "taken": "take",
    "known": "know",
    "grown": "grow",
    "thrown": "throw",
    "drawn": "draw",
    "flown": "fly",
    "chosen": "choose",
    "broken": "break",
    "woken": "wake",
    "worn": "wear",
    "sworn": "swear",
    "torn": "tear",
    "frozen": "freeze",
    "risen": "rise",
    "gotten": "get",
    "begun": "begin",
    "drunk": "drink",
    "sung": "sing",
    "swum": "swim",
    "rung": "ring",
}


# ============================================================================
# RULE-BASED LEMMATIZER
# ============================================================================

def _rule_based_lemmatize(verb: str) -> str:
    """
    Rule-based English verb lemmatizer for common inflection patterns.

    Handles:
      - Irregular verbs (lookup table)
      - -ing forms (with consonant-doubling reversal, silent-e restoration)
      - -ed forms (with consonant-doubling reversal, silent-e restoration, y->ied)
      - -s/-es/-ies forms
    """
    word = verb.lower().strip()

    # 1. Irregular lookup (past tense + participles)
    if word in _IRREGULAR_PAST:
        return _IRREGULAR_PAST[word]
    if word in _IRREGULAR_PARTICIPLE:
        return _IRREGULAR_PARTICIPLE[word]

    # 2. -ing forms
    if word.endswith("ing") and len(word) > 4:
        stem = word[:-3]

        # "dying" -> "die", "lying" -> "lie", "tying" -> "tie"
        # Only applies to short stems (2 chars) where the pattern is C+ying
        if stem.endswith("y") and len(stem) == 2:
            return stem[:-1] + "ie"

        # "studying" -> stem "study", "playing" -> stem "play" — return as-is
        if stem.endswith("y"):
            return stem

        # Double consonant: "running" -> stem "runn" -> "run"
        if len(stem) >= 2 and stem[-1] == stem[-2] and stem[-1] not in "aeiou":
            return stem[:-1]

        # Silent-e restoration: when the original word was base+e and the e
        # was dropped before adding -ing (e.g., manage -> managing).
        #
        # Restore "e" when the stem ends in:
        #   - Consonants that virtually always need a trailing e in verb
        #     bases: v, z, c (soft), g (soft), s (some), t (after a)
        #   - The CVC pattern where the vowel is a digraph or the word is
        #     long enough that doubling was not applied
        #
        # Do NOT restore "e" for short CVC stems already handled by the
        # double-consonant rule above (those are non-doubled single-
        # consonant stems like "work", "build", "know").
        if stem[-1] not in "aeiou":
            # These consonants almost always indicate a silent-e base in
            # English verbs: compete, organize, supervise, create, live, etc.
            if stem[-1] in "vtczgs" and len(stem) >= 3 and stem[-2] in "aeiou":
                return stem + "e"

        return stem

    # 3. -ed forms
    if word.endswith("ed") and len(word) > 3:
        # -ied -> -y: "studied" -> "study", "married" -> "marry"
        if word.endswith("ied") and len(word) > 4:
            return word[:-3] + "y"

        stem_no_ed = word[:-2]
        stem_no_d = word[:-1]

        # Double consonant: "stopped" -> stem "stopp" -> "stop"
        if (
            len(stem_no_ed) >= 2
            and stem_no_ed[-1] == stem_no_ed[-2]
            and stem_no_ed[-1] not in "aeiou"
        ):
            return stem_no_ed[:-1]

        # Silent-e restoration: "managed" -> "manage", "created" -> "create"
        # When the base word ends in silent "e", English adds just "-d".
        # So stripping "-d" yields the correct base.
        #
        # Approach: check if stem_no_d (= word minus "d") ends in a
        # recognized silent-e verb suffix. These are the common patterns
        # where English verb bases end in consonant+"e".
        _SILENT_E_ENDINGS = (
            "ate", "ize", "ise", "ase", "ose", "use",  # create, organize
            "ive", "ave", "ove",                        # live, save, move
            "ure", "ire", "ore", "are",                 # secure, fire, adore
            "age", "uge", "ige",                        # manage, refuge
            "ude", "ide", "ade",                        # include, guide, trade
            "ete", "ite", "ute",                        # compete, invite, compute
            "ise", "ose", "ine",                        # supervise, close, define
            "ace", "ice",                               # place, notice
            "ple", "ble", "tle",                        # triple, enable, settle
            "rce", "nce", "lve",                        # force, dance, solve
            "rse", "nse",                               # nurse, rinse
        )
        if stem_no_d.endswith(_SILENT_E_ENDINGS):
            return stem_no_d

        # Default: remove "ed"
        return stem_no_ed

    # 4. -s forms
    if word.endswith("s") and len(word) > 2 and not word.endswith("ss"):
        # -ies -> -y: "studies" -> "study"
        if word.endswith("ies") and len(word) > 4:
            return word[:-3] + "y"

        # -es: "teaches" -> "teach", "manages" -> "manage"
        if word.endswith("es") and len(word) > 3:
            stem_no_es = word[:-2]
            stem_no_s = word[:-1]

            # Words ending in -ches, -shes, -sses, -xes, -zes: strip -es
            if stem_no_es.endswith(("ch", "sh", "ss", "x", "z")):
                return stem_no_es

            # Words ending in -ses where base ends in -se: "manages" -> stem
            # "manage" (strip -s)
            if stem_no_s.endswith("e"):
                return stem_no_s

            # Default for -es: strip -s (e.g., "lives" -> "live")
            return stem_no_s

        # Plain -s: "works" -> "work"
        return word[:-1]

    # 5. No recognized inflection — return as-is
    return word


# ============================================================================
# SPACY-BASED LEMMATIZER (optional)
# ============================================================================

_spacy_nlp = None
_spacy_available: bool | None = None


def _try_load_spacy():
    """Attempt to load spaCy en_core_web_sm. Returns True if successful."""
    global _spacy_nlp, _spacy_available
    if _spacy_available is not None:
        return _spacy_available
    try:
        import spacy
        _spacy_nlp = spacy.load("en_core_web_sm")
        _spacy_available = True
    except (ImportError, OSError):
        _spacy_available = False
    return _spacy_available


def _spacy_lemmatize(verb: str) -> str:
    """Lemmatize a single verb using spaCy."""
    doc = _spacy_nlp(verb)
    if doc and len(doc) > 0:
        return doc[0].lemma_
    return verb


# ============================================================================
# PUBLIC API
# ============================================================================

def lemmatize_predicate(verb: str) -> str:
    """
    Lemmatize an inflected predicate verb to its base form.

    Tries spaCy (en_core_web_sm) first for high accuracy. Falls back to a
    rule-based lemmatizer if spaCy is unavailable.

    Args:
        verb: An inflected English verb (e.g., "mentoring", "supervised").

    Returns:
        The base (infinitive) form of the verb (e.g., "mentor", "supervise").
    """
    if _try_load_spacy():
        return _spacy_lemmatize(verb)
    return _rule_based_lemmatize(verb)


# ============================================================================
# TEST RUNNER
# ============================================================================

def run_tests() -> bool:
    """Run all lemmatization tests. Returns True if accuracy >= 95%."""
    print("=" * 70)
    print("LEMMATIZATION ACCURACY TEST (Gate S4)")
    print("=" * 70)

    # Report which backend is in use
    backend = "spaCy (en_core_web_sm)" if _try_load_spacy() else "rule-based fallback"
    print(f"Backend: {backend}")
    print(f"Total test cases: {len(ALL_TESTS)}")
    print()

    # Per-category tracking
    category_stats: dict[str, dict[str, int]] = {}
    failures: list[tuple[str, str, str, str]] = []

    for inflected, expected, category in ALL_TESTS:
        if category not in category_stats:
            category_stats[category] = {"passed": 0, "failed": 0}

        actual = lemmatize_predicate(inflected)
        ok = actual == expected

        if ok:
            category_stats[category]["passed"] += 1
            status = "PASS"
        else:
            category_stats[category]["failed"] += 1
            failures.append((inflected, expected, actual, category))
            status = "FAIL"

        inflected_col = f'"{inflected}"'
        expected_col = f'-> "{expected}"'
        print(f"  [{status}] {inflected_col:<20} {expected_col:<20}", end="")
        if not ok:
            print(f'  GOT "{actual}"')
        else:
            print()

    # Category summary
    print()
    print("-" * 70)
    print("ACCURACY BY CATEGORY:")
    print()

    total_passed = 0
    total_count = 0

    for cat in ["-ing", "-ed", "-s", "irregular"]:
        stats = category_stats.get(cat, {"passed": 0, "failed": 0})
        count = stats["passed"] + stats["failed"]
        pct = (stats["passed"] / count * 100) if count > 0 else 0
        total_passed += stats["passed"]
        total_count += count
        marker = "OK" if pct >= 95 else "LOW"
        print(f"  {cat:<12} {stats['passed']}/{count} ({pct:5.1f}%)  [{marker}]")

    overall_pct = (total_passed / total_count * 100) if total_count > 0 else 0

    print()
    print("-" * 70)

    if failures:
        print()
        print("FAILURES:")
        for inflected, expected, actual, cat in failures:
            print(f'  [{cat}] "{inflected}" -> expected "{expected}", got "{actual}"')
        print()

    print("=" * 70)
    print(f"OVERALL: {total_passed}/{total_count} ({overall_pct:.1f}%)")

    gate_pass = overall_pct >= 95.0
    if gate_pass:
        print("GATE S4: PASS (>= 95% accuracy)")
    else:
        print("GATE S4: FAIL (< 95% accuracy)")
    print("=" * 70)

    return gate_pass


if __name__ == "__main__":
    success = run_tests()
    if not success:
        sys.exit(1)
    sys.exit(0)
