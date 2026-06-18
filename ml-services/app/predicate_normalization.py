"""
Predicate normalization — Layer 1 of the living predicate ontology fold
(truth-graph doc 42 §4/§6, PC3): lemmatization and tense normalization applied
BEFORE embedding/scoring.

Ported from ml-services/tests/test_lemmatization.py and test_tense_normalization.py
into a live module. `lemmatize_predicate` tries spaCy (en_core_web_sm) and falls
back to a rule-based lemmatizer when spaCy is unavailable (the project default —
spaCy is optional, doc 42 §6). `normalize_tense` is refactored to take the
canonical set + alias map from the live registry (the DB) instead of the test's
in-module ONTOLOGY constant; the tense-alias and ambiguous-predicate tables stay
static (they encode grammar, not vocabulary).
"""

from __future__ import annotations

from typing import Optional

# ---------------------------------------------------------------------------
# Lemmatization
# ---------------------------------------------------------------------------

_IRREGULAR_PAST: dict[str, str] = {
    "led": "lead", "built": "build", "met": "meet", "spoke": "speak", "ran": "run",
    "wrote": "write", "drove": "drive", "gave": "give", "took": "take", "made": "make",
    "said": "say", "went": "go", "came": "come", "knew": "know", "grew": "grow",
    "threw": "throw", "drew": "draw", "flew": "fly", "chose": "choose", "broke": "break",
    "woke": "wake", "wore": "wear", "bore": "bore", "swore": "swear", "tore": "tear",
    "froze": "freeze", "rose": "rise", "shone": "shine", "got": "get", "sat": "sit",
    "held": "hold", "told": "tell", "sold": "sell", "found": "find", "kept": "keep",
    "left": "leave", "felt": "feel", "lost": "lose", "spent": "spend", "sent": "send",
    "lent": "lend", "bent": "bend", "dealt": "deal", "meant": "mean", "brought": "bring",
    "bought": "buy", "caught": "catch", "taught": "teach", "thought": "think",
    "fought": "fight", "sought": "seek", "stood": "stand", "understood": "understand",
    "began": "begin", "drank": "drink", "sang": "sing", "swam": "swim", "rang": "ring",
}

_IRREGULAR_PARTICIPLE: dict[str, str] = {
    "spoken": "speak", "written": "write", "driven": "drive", "given": "give",
    "taken": "take", "known": "know", "grown": "grow", "thrown": "throw",
    "drawn": "draw", "flown": "fly", "chosen": "choose", "broken": "break",
    "woken": "wake", "worn": "wear", "sworn": "swear", "torn": "tear",
    "frozen": "freeze", "risen": "rise", "gotten": "get", "begun": "begin",
    "drunk": "drink", "sung": "sing", "swum": "swim", "rung": "ring",
}

_SILENT_E_ENDINGS = (
    "ate", "ize", "ise", "ase", "ose", "use",
    "ive", "ave", "ove",
    "ure", "ire", "ore", "are",
    "age", "uge", "ige",
    "ude", "ide", "ade",
    "ete", "ite", "ute",
    "ine",
    "ace", "ice",
    "ple", "ble", "tle",
    "rce", "nce", "lve",
    "rse", "nse",
)

_spacy_nlp = None
_spacy_available: Optional[bool] = None


def _try_load_spacy() -> bool:
    """Attempt to load spaCy en_core_web_sm once. Returns True if successful."""
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
    doc = _spacy_nlp(verb)
    if doc and len(doc) > 0:
        return doc[0].lemma_
    return verb


def _rule_based_lemmatize(verb: str) -> str:
    """Rule-based English verb lemmatizer for common inflection patterns:
    irregulars (lookup), -ing, -ed, -s/-es/-ies (with consonant-doubling reversal
    and silent-e restoration)."""
    word = verb.lower().strip()

    if word in _IRREGULAR_PAST:
        return _IRREGULAR_PAST[word]
    if word in _IRREGULAR_PARTICIPLE:
        return _IRREGULAR_PARTICIPLE[word]

    # -ing forms
    if word.endswith("ing") and len(word) > 4:
        stem = word[:-3]
        if stem.endswith("y") and len(stem) == 2:
            return stem[:-1] + "ie"
        if stem.endswith("y"):
            return stem
        if len(stem) >= 2 and stem[-1] == stem[-2] and stem[-1] not in "aeiou":
            return stem[:-1]
        if stem[-1] not in "aeiou":
            if stem[-1] in "vtczgs" and len(stem) >= 3 and stem[-2] in "aeiou":
                return stem + "e"
        return stem

    # -ed forms
    if word.endswith("ed") and len(word) > 3:
        if word.endswith("ied") and len(word) > 4:
            return word[:-3] + "y"
        stem_no_ed = word[:-2]
        stem_no_d = word[:-1]
        if (
            len(stem_no_ed) >= 2
            and stem_no_ed[-1] == stem_no_ed[-2]
            and stem_no_ed[-1] not in "aeiou"
        ):
            return stem_no_ed[:-1]
        if stem_no_d.endswith(_SILENT_E_ENDINGS):
            return stem_no_d
        return stem_no_ed

    # -s forms
    if word.endswith("s") and len(word) > 2 and not word.endswith("ss"):
        if word.endswith("ies") and len(word) > 4:
            return word[:-3] + "y"
        if word.endswith("es") and len(word) > 3:
            stem_no_es = word[:-2]
            stem_no_s = word[:-1]
            if stem_no_es.endswith(("ch", "sh", "ss", "x", "z")):
                return stem_no_es
            if stem_no_s.endswith("e"):
                return stem_no_s
            return stem_no_s
        return word[:-1]

    return word


def lemmatize_predicate(verb: str) -> str:
    """Lemmatize an inflected predicate verb to its base form. Tries spaCy first
    (high accuracy), falls back to the rule-based lemmatizer."""
    if _try_load_spacy():
        return _spacy_lemmatize(verb)
    return _rule_based_lemmatize(verb)


# ---------------------------------------------------------------------------
# Tense normalization
# ---------------------------------------------------------------------------

# Past-tense alias -> "past". Grammar, not vocabulary, so kept static.
TENSE_ALIASES: dict[str, str] = {
    "worked_at": "past",
    "formerly_at": "past",
    "ex_employee_of": "past",
    "used_to_work_at": "past",
    "lived_in": "past",
    "formerly_in": "past",
    "used_to_live_in": "past",
}

# Canonical predicates that are grammatically past-tense but ARE the canonical
# form — temporality cannot be inferred from the name alone, so no hint.
AMBIGUOUS_PREDICATES: set[str] = {
    "created", "founded", "visited", "organized", "studied_at", "attended_event", "spoke_at",
}


def normalize_tense(
    predicate: str,
    alias_to_canonical: dict[str, str],
    canonical_set: set[str],
) -> tuple[str, Optional[str]]:
    """Normalize a predicate to its base (present-tense) form and emit a temporal
    hint. `alias_to_canonical` and `canonical_set` come from the live registry
    (the DB canonicals + their aliases). Returns (base_predicate, temporal_hint)
    where hint is 'past' | 'current' | None.

    The hint fills valid_at/invalid_at ONLY when the proposer left the fact
    undated — it never overrides an explicit validAt (doc 42 §4, doc 41 §12 #7)."""
    normalized = predicate.lower().strip().replace(" ", "_")

    # 1. Known past-tense alias -> base + "past"
    if normalized in TENSE_ALIASES:
        base = alias_to_canonical.get(normalized)
        if base is not None:
            return (base, TENSE_ALIASES[normalized])

    # 2. Already canonical
    if normalized in canonical_set:
        if normalized in AMBIGUOUS_PREDICATES:
            return (normalized, None)
        return (normalized, "current")

    # 3. Non-tense alias -> base + "current"
    canonical = alias_to_canonical.get(normalized)
    if canonical is not None:
        if canonical in AMBIGUOUS_PREDICATES:
            return (canonical, None)
        return (canonical, "current")

    # 4. Unknown predicate — pass through
    return (normalized, "current")
