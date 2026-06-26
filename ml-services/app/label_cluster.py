"""
Cluster topic-label endpoint (iOS API v1 — ASK-014 LLM labels).

The bridge surface (design/07-modules/bridge.md) names each cluster "spoke"
running through the structural bridge entity. The degraded v1 named each spoke
by its highest-pagerank member entity's canonical name (a heuristic — an entity
NAME, not a theme). This endpoint replaces that with a REAL Voice-C TOPIC LABEL:
a short lowercase phrase composing the THEME the cluster's members share
("the move", "the tired weeks", "the studio decision") — a theme, not just one
member's name.

Mirrors summarize.py: a Pydantic request/response, a prompt constant, one
`llm_pool.submit(llm_client.generate_json, ...)` call. Kept cheap (one generate
call, no tools). 503 on QueueFullError so the backend can fall back to its
heuristic. If the LLM returns junk, falls back to the first member name so the
response is always a valid non-blank label.
"""

import logging
import re
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .core.concurrency import QueueFullError, llm_pool
from .core.llm import llm_client

logger = logging.getLogger(__name__)
router = APIRouter()


# ---------------------------------------------------------------------------
# Voice-C topic-label prompt (drafted from design/01-voice-and-tone.md)
# ---------------------------------------------------------------------------
#
# One short lowercase topic phrase capturing the theme the members share.
# Lowercase enforcement lives IN the prompt (post-processing lowercase would
# break a proper noun like "M"). The composer must NOT speak as the system and
# must NOT just echo one member's name verbatim — it names the THEME.
LABEL_CLUSTER_PROMPT = """\
you name clusters of related things in a personal memory graph for an app \
called mnemo. each cluster is a small set of entities the person has written \
about that hang together — people, places, projects, feelings, decisions.

your job: compose ONE short topic label naming the THEME the members share.

RULES
- 2 to 4 words. shorter is better. no period, no quotes, no trailing punctuation.
- lowercase, always. the pronoun "i" stays lowercase. a proper-noun name stays \
cased ("M" the friend, "lisbon" lowercased as a common place reference).
- name the THEME, not just one member. "the move", "the tired weeks", "the \
studio decision", "mornings alone", "the new job". a theme reads like \
something the person would call this corner of their life.
- the person's own voice — never the app's. never "i noticed", never "your \
cluster of…". no system persona. no "topic:", no labels-about-labels.
- gentle, plain, concrete. forbidden modifiers: delightful, powerful, smart, \
amazing, beautiful, important, key, various, miscellaneous, general, related.
- never quantify ("3 things about…"). never frame as a category ("work stuff").
- if the members genuinely share no theme, name the most central one plainly.

EXAMPLES
members: ["the new apartment", "lisbon", "packing", "the lease"] -> the move
members: ["exhaustion", "long hours", "the deadline", "sleep"] -> the tired weeks
members: ["the studio", "whether to sign", "the lease", "rent"] -> the studio decision
members: ["M", "coffee", "saturday walks"] -> mornings with M

return ONLY the json object: {"label": "<phrase>"}. no prose, no code fences.\
"""

MAX_MEMBERS = 12  # cap the prompt size — clusters can be large


class LabelClusterRequest(BaseModel):
    """A cluster's member entity canonical names (+ optional summaries)."""
    member_names: List[str] = Field(default_factory=list)
    member_summaries: Optional[List[str]] = None


class LabelClusterResponse(BaseModel):
    """One short Voice-C topic label."""
    label: str


def _normalize_label(raw: object) -> str:
    """Coerce an LLM label to a non-blank lowercase Voice-C phrase, or "" if junk.

    Strips quotes/code-fence noise and a trailing period, collapses whitespace,
    lowercases, and rejects anything implausible as a 2-4 word topic phrase
    (empty, too long, or multi-line) so the caller can fall back.
    """
    if not isinstance(raw, str):
        return ""
    # A topic phrase is single-line. A multi-line response is an explanation,
    # not a label — reject before collapsing whitespace would hide the newline.
    if "\n" in raw.strip():
        return ""
    s = raw.strip()
    s = re.sub(r"\s+", " ", s)
    # Strip wrapping code fences / quotes and trailing sentence punctuation,
    # iterating so combinations like  `"the move".`  fully unwrap.
    prev = None
    while s != prev:
        prev = s
        s = s.strip().strip("`").strip('"').strip("'").rstrip(".").strip()
    if not s:
        return ""
    # Guard against the model returning a sentence / explanation, not a label.
    if len(s) > 60 or len(s.split()) > 8:
        return ""
    return s.lower()


def _fallback_label(request: LabelClusterRequest) -> str:
    """First non-blank member name, lowercased. Last resort so the response is
    always a valid non-blank label even when the LLM returns junk."""
    for name in request.member_names:
        if isinstance(name, str) and name.strip():
            return re.sub(r"\s+", " ", name.strip()).lower()
    return "this thread"


def _build_prompt(request: LabelClusterRequest) -> str:
    names = [n for n in request.member_names if isinstance(n, str) and n.strip()][:MAX_MEMBERS]
    lines = [f"members: {names}"]
    if request.member_summaries:
        summaries = [s for s in request.member_summaries if isinstance(s, str) and s.strip()][:MAX_MEMBERS]
        if summaries:
            lines.append("context (member summaries, for theme only):")
            lines.extend(f"  - {s}" for s in summaries)
    lines.append('compose the topic label. return ONLY {"label": "<phrase>"}.')
    return "\n".join(lines)


@router.post("/label-cluster", response_model=LabelClusterResponse)
async def label_cluster(request: LabelClusterRequest):
    """Compose one short Voice-C topic label for a cluster's members.

    Returns {label}. 503 when the LLM pool buffer is full so the caller can fall
    back to its heuristic. On any other failure (or a junk LLM response) returns
    the first member name lowercased — the response is never blank, never 500s
    on a labeling hiccup.
    """
    fallback = _fallback_label(request)
    if not request.member_names:
        # Nothing to label — give the caller the last-resort placeholder so the
        # wire shape stays valid (the caller decides whether to use it).
        return LabelClusterResponse(label=fallback)

    prompt = _build_prompt(request)

    try:
        result = await llm_pool.submit(
            llm_client.generate_json,
            prompt,
            None,
            {
                "task": "label_cluster",
                "system_prompt": LABEL_CLUSTER_PROMPT,
                "tools": "",
                "max_turns": 1,
            },
        )
    except QueueFullError:
        logger.warning("[label-cluster] llm pool full, returning 503")
        raise HTTPException(status_code=503, detail="Service busy, retry later")
    except Exception as exc:
        # Never 500 on a labeling hiccup — degrade to the heuristic fallback.
        logger.warning("[label-cluster] labeling failed, falling back: %s", exc)
        return LabelClusterResponse(label=fallback)

    raw_label = result.get("label") if isinstance(result, dict) else None
    label = _normalize_label(raw_label)
    if not label:
        logger.info("[label-cluster] LLM label was junk (%r), falling back to %r", raw_label, fallback)
        label = fallback

    return LabelClusterResponse(label=label)
