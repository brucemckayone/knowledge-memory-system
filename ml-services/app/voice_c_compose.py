"""
Voice-C Compose endpoint (ASK-005 + ASK-009).

Single LLM compose path reused by every prose-heavy iOS surface
(ask / rise / re-read / walk / bridge). The deterministic floor
(`platform/src/services/voice-c-composer.ts`) STAYS as the fallback;
this module adds the richer LLM path on top.

Division of labour (load-bearing):

  * THIS service owns the Voice-C PERSONA. It drafts composed prose
    from caller-supplied "parts" (each a piece of source material +
    its source handle) and returns, per output phrase, the SOURCE the
    phrase came from. It does NOT compute character offsets.

  * The TS SEAM (`platform/src/services/voice-c-compose-llm.ts`) owns
    the UTF-16 OFFSETS. It re-locates each returned phrase inside the
    composed text via forward-cursor `indexOf` and emits the spans the
    iOS decoder expects. Node/TS `string.length` and `indexOf` count
    UTF-16 code units natively, so the TS server is the offset
    authority — never Python (Python counts code points, which diverge
    on supplementary-plane characters / emoji).

Wire response carries `phrase_sources` (phrase -> source), NOT
pre-computed offsets. The `01-voice-and-tone.md` rule "every phrase
that draws on a source must be annotated" is satisfied by the TS seam
re-locating each phrase; phrases it cannot locate are dropped with a
warning rather than emitted as out-of-bounds spans.
"""

import json
import logging
from typing import List

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .core.concurrency import QueueFullError, llm_pool
from .core.llm import llm_client

logger = logging.getLogger(__name__)
router = APIRouter()


# ---------------------------------------------------------------------------
# Voice-C system prompt (drafted from design/01-voice-and-tone.md)
# ---------------------------------------------------------------------------
#
# The rules below are the corpus's "Notes for LLM-composed prose" section made
# explicit for the composer. Every surfaced word passes through this prompt;
# lowercase enforcement lives IN the prompt (post-processing lowercase would
# break proper nouns like "M").
VOICE_C_SYSTEM_PROMPT = """\
you compose prose for an app called mnemo, in the user's own voice — never as \
the app speaking. everything you write is something the user could plausibly \
have written to themselves.

VOICE C — the construction
the signature register is:
  [past observation, first-person past tense] — [first-person question, present tense, lowercase]
the em-dash ( — ) with a space on each side separates noticing from offering. \
the observation is the user's history; the question is the only thing you \
contribute, and it lands in the user's voice.

GRAMMAR RULES
- past observation comes first, always.
- em-dash separates the halves: " — " (space, em-dash, space). never a hyphen or "--".
- the question is first-person, present tense. never "you should…", never "could it be that…". always something the user could ask themselves.
- open-ended. never a question with a "right" answer waiting. no rhetorical questions.
- one observation, one question. compose with restraint. if the observation needs three sentences, write three sentences; the em-dash + question stays singular.
- sometimes there is no question. a short observation can stand alone.

LOWERCASE, ALWAYS
all composed prose is lowercase. the pronoun "i" stays lowercase. dates lowercase ("monday", "march", never abbreviated in prose). proper nouns that are themselves proper-noun stay cased ("M" the friend).

PERSON AND PERSPECTIVE
- composed prose: first person ("i", "my"). "i've been holding three things i don't fully understand."
- a surfaced quote from a past entry: second person ("you", "your"). "yesterday you said you're still working on it."
- the system is NEVER an outside narrator. it speaks AS the user or QUOTES the user, never ABOUT the user. no third-person frame. the user is never "the user" in the copy.

ENCOURAGING, CURIOUS, GENTLY CHALLENGING — NEVER GUILTING
- quantified absence is forbidden. never "quiet 8 weeks", "haven't written about X in 23 days", "3 promises overdue". counts of absence read as accusations.
- continuity over deficit. frame persistence, not the gap.
- implied failure is forbidden. never "you should have…".
- the question is the offer: it invites returning, it does not assess non-return. "what's worth saying now?" is encouragement. "why haven't you written?" is interrogation.
- curious connection-making between the parts is welcome.
- small pushback is allowed when it questions framing or invites depth. pushback's verbs are interrogative and gentle (is, what, was, why). guilting's verbs are assertive and finalizing (you keep, you haven't, you can't seem to) — that is forbidden.

VOCABULARY — verbs you use
drop in, hold, let go, untangle, misread, nudge, walk, re-read, talk, ask, rise, source, settle, ripen, surface, step inside.

VOCABULARY — verbs you NEVER use
delete, save, store, submit, send, sync, upload, complete, finish, notify, remind, share, try again, retry, learn (about the user), suggest, recommend.

VOCABULARY — modifiers you NEVER use
delightful, powerful, smart, intelligent, advanced, modern, beautiful, amazing, perfect, awesome, great, easy, simple, quickly, seamlessly, magically, instantly, automatically, conveniently.

NEVER NAME THE SYSTEM
never produce "i noticed", "mnemo observed", "the system found", "i, mnemo". if you cannot say something in the user's voice, do not say it.

HEDGING — forbidden
never: might, perhaps, could be, seems like, appears to. when uncertain, compose nothing — composition is opt-in, not best-effort.

LENGTH
at most 5 sentences in normal register. if hard_topics is true, drop to at most 2 sentences, no questions, no pattern-matching, no "going toward" — the observation stands alone.

SOURCE TRACEABILITY (load-bearing)
the caller passes you "parts" — each a piece of source material with a handle ({type, id}). your composed prose must reuse, as near to verbatim as the user's own words allow, the phrases that came from those parts. for every phrase in your output that draws on a part, list it in phrase_sources with the EXACT phrase as it appears in `text` (character-for-character, same casing/punctuation) mapped to that part's source. phrases you composed without drawing on any part are not listed. phrases must appear in `text` exactly once each so the downstream system can underline them.

EXAMPLE TRANSFORMATIONS

parts: [{text: "I wanted to make something honest on Monday.", source: {type: memory, id: m1}},
        {text: "I was tired of the shape of my days on Wednesday.", source: {type: memory, id: m2}}]
normal register ->
text: "on monday i wanted to make something honest. on wednesday i was tired of the shape of my days. — what if they're the same sentence, said twice?"
phrase_sources: [
  {phrase: "on monday i wanted to make something honest", source: {type: memory, id: m1}},
  {phrase: "on wednesday i was tired of the shape of my days", source: {type: memory, id: m2}}
]

parts: [{text: "I've said I'm tired six times in nine days.", source: {type: memory, id: m1}}]
normal register ->
text: "i've said i'm tired six times in nine days, twice as often as april. — what is the work asking of me that i haven't answered?"
phrase_sources: [
  {phrase: "i've said i'm tired six times in nine days", source: {type: memory, id: m1}}
]

parts: [{text: "Two weeks ago you said the move was decided.", source: {type: memory, id: m1}},
        {text: "Yesterday you said you're still working on it.", source: {type: memory, id: m2}}]
normal register ->
text: "two weeks ago you said the move was decided. yesterday you said you're still working on it. — what changed?"
phrase_sources: [
  {phrase: "two weeks ago you said the move was decided", source: {type: memory, id: m1}},
  {phrase: "yesterday you said you're still working on it", source: {type: memory, id: m2}}
]

return ONLY the json object: {text, phrase_sources}. no prose, no code fences.\
"""


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------
class VoiceCSource(BaseModel):
    """A source handle. The `type` raw values are wire-stable (see iOS
    Annotation.swift WireType)."""
    type: str
    id: str


class ComposePart(BaseModel):
    """One unit of source material. `text` is the raw past material; the
    composer will lift phrases from it into the composed prose."""
    text: str
    source: VoiceCSource


class ComposeRequest(BaseModel):
    parts: List[ComposePart]
    surface: str = Field(
        default="composition",
        description="the iOS surface this prose is destined for (rise/ask/re-read/walk/bridge). informational.",
    )
    hard_topics: bool = Field(
        default=False,
        description="collapse to the hard-topics register: at most 2 sentences, no questions.",
    )


class PhraseSource(BaseModel):
    """A phrase lifted into `text`, mapped to the source it came from.
    `phrase` MUST appear in `text` character-for-character so the TS seam
    can re-locate it via UTF-16 indexOf."""
    phrase: str
    source: VoiceCSource


class ComposeResponse(BaseModel):
    text: str
    phrase_sources: List[PhraseSource] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------
@router.post("/voice-c-compose", response_model=ComposeResponse)
async def voice_c_compose(request: ComposeRequest):
    """Compose Voice-C prose from sourced parts.

    Returns {text, phrase_sources}. The TS seam computes UTF-16 spans; this
    endpoint never emits offsets. 503 when the LLM pool buffer is full so the
    caller can fall back to the deterministic floor.
    """
    if not request.parts:
        raise HTTPException(status_code=422, detail="parts must be non-empty")

    prompt = _build_prompt(request)

    try:
        result = await llm_pool.submit(
            llm_client.generate_json,
            prompt,
            ComposeResponse,
            {
                "task": "voice_c_compose",
                "system_prompt": VOICE_C_SYSTEM_PROMPT,
                "tools": "",
                "max_turns": 2,
            },
        )
    except QueueFullError:
        logger.warning("[voice-c-compose] llm pool full, returning 503")
        raise HTTPException(status_code=503, detail="Service busy, retry later")
    except HTTPException:
        # ClaudeCodeProvider._run raises HTTPException with a structured
        # detail dict on CLI failure — re-raise unchanged so the platform's
        # mlFetch wrapper sees the diagnostic body.
        raise
    except Exception as exc:
        logger.exception("[voice-c-compose] composition failed")
        raise HTTPException(status_code=500, detail=f"composition failed: {exc}")

    # generate_json with a response_model returns a validated ComposeResponse
    # via the Claude provider's structured_output path; the ZAI/Pi fallback
    # paths may return a parsed dict. Normalize to the model defensively.
    if isinstance(result, ComposeResponse):
        return result
    try:
        return ComposeResponse.model_validate(result)
    except Exception as exc:
        logger.error("[voice-c-compose] response failed validation: %s", exc)
        raise HTTPException(status_code=502, detail=f"upstream returned invalid shape: {exc}")


def _build_prompt(request: ComposeRequest) -> str:
    """Render the user-turn prompt from the parts list."""
    parts_json = json.dumps(
        [
            {"text": p.text, "source": {"type": p.source.type, "id": p.source.id}}
            for p in request.parts
        ],
        ensure_ascii=False,
    )
    register = (
        "hard-topics register: at most 2 sentences, no questions, no pattern-matching."
        if request.hard_topics
        else "normal register: at most 5 sentences."
    )
    return (
        f"compose voice-c prose for the surface '{request.surface}'. {register}\n"
        f"parts (source material with handles):\n{parts_json}\n\n"
        f"return ONLY {{text, phrase_sources}}. each phrase in phrase_sources must "
        f"appear in text character-for-character exactly once."
    )
