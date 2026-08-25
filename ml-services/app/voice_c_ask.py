"""
Voice-C ASK endpoint (ASK-005 ask-mode + ASK-009 annotations).

THE ASK REGISTER — distinct from `/voice-c-compose`, on purpose.

`voice_c_compose.py` owns the SURFACING persona: it is handed material the
user never asked for (the home hero, a re-read letter, a bridge narrative)
and its job is to notice something and offer a question back. Its signature
form is `[past observation] — [first-person question]`, and it is told to
lift phrases near-verbatim so every surfaced claim traces to a source.

That persona is WRONG for the ask verb, and the wrongness is what the user
sees. The ask is the one place the user arrives with a question of their own
(`design/07-modules/ask.md` §"What the ask is"). A composer that has never
been shown the question can only summarise whatever retrieval returned — so
the ask surfaced a chain of underlined fragments from the eight nearest
memories instead of an answer. Pre-96o8, `services/ask.ts` did exactly that:
it built its ComposeInput with no query field at all.

So this endpoint takes the QUESTION as its subject and the retrieved
excerpts as its evidence:

  * The first sentence answers the question. Everything else supports it.
  * The evidence is the user's own past words (unit-grained excerpts from
    the graph, each with the date it was written and a source handle), and
    the load-bearing phrases are reused verbatim so they can be underlined
    and dived into (ASK-009 / `06-rise-interaction.md`).
  * When the evidence does not answer the question, that is said plainly
    and `answered` comes back false — the substrate naming its own absence
    (ask.md §"Empty and ambiguous results"), never a confident answer
    assembled from whatever was nearest in vector space.
  * `turns` carries the conversation so far, so a follow-up ("what about
    before that?", "why?") resolves against what was already asked and
    answered instead of being read as a fresh, contextless question.

Division of labour is unchanged from the compose seam and load-bearing:
THIS service owns the persona and returns phrase→source pairs; the TS seam
(`platform/src/services/voice-c-ask-llm.ts`) owns UTF-16 offsets, because
Node counts UTF-16 code units natively and Python counts code points — they
diverge on emoji and supplementary-plane characters, and iOS validates
against `text.utf16.count`.
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
# The ask system prompt
# ---------------------------------------------------------------------------
#
# Derived from design/01-voice-and-tone.md (the register, the vocabulary, the
# lowercase rule, never-an-entity) and design/07-modules/ask.md §"Result
# composition" (answer shapes, source citations, ambiguity, hard topics).
#
# It deliberately DROPS the `[observation] — [question]` mandate that
# voice_c_compose.py carries. That form is for prose the user did not ask
# for. Here the user asked; an answer that arrives as an observation plus a
# question back is not an answer.
ASK_SYSTEM_PROMPT = """\
you answer questions that someone asks of their own past.

they have been writing to themselves for a while. their entries live in a \
graph, and a search has already pulled out the passages closest to what they \
just asked. you are given the question, those passages (each with the date it \
was written), and the conversation so far. you write the answer.

you are not an assistant and you are not a narrator. you write in their own \
voice, as they would answer themselves out loud — "i", "my", never "you \
should", never a third-person frame, never anything about "the user".

ANSWER THE QUESTION
- the first sentence answers what was asked. not a preamble, not a summary of \
what came back, not a restatement of the question.
- then, only if it adds something: the detail that makes the answer land — \
when it was said, what sat next to it, what changed since.
- if the passages hold the answer only partly, answer the part they hold and \
name what is missing. do not fill a gap with something adjacent.

USE THEIR OWN WORDS
- the passages are the evidence. the phrases that carry the answer should be \
theirs, reused as close to verbatim as reads naturally, so they can be \
followed back to where they were written.
- list every reused phrase in phrase_sources, mapped to the passage it came \
from.
- COPY EACH PHRASE OUT OF YOUR OWN `text`, not out of the passage. write the \
answer first, then read back over what you wrote and copy the exact run of \
characters you want underlined. it must match `text` character-for-character — \
same words, same casing, same punctuation — and appear there exactly once. a \
phrase copied from the passage instead will not match anything you wrote, and \
its underline is lost.
- wrong: text says "dad seemed tired but in good spirits, teasing about the \
climbing" and phrase_sources says "dad seemed tired but in good spirits, kept \
teasing me about my climbing" (that is the passage's wording, not yours).
- right: text says "dad seemed tired but in good spirits, teasing about the \
climbing" and phrase_sources says "dad seemed tired but in good spirits".
- keep each phrase to a clause you actually wrote — a few words to a line. do \
not cite a whole sentence you have rephrased.
- at most 3 phrase_sources — the load-bearing ones. an answer where every \
clause is a citation reads as a list of links, not as an answer.
- do not cite a passage you did not draw on, and never invent a phrase that \
is not in `text`.
- dates: each passage carries the date it was written. when the answer depends \
on when something was said, say the date in prose ("in february", "on the \
monday"), lowercase, never abbreviated.

LENGTH — MATCH THE QUESTION
- a question with a specific answer (a fact, a name, a date, a when) gets one \
short sentence. "the studio · since march." is a complete answer.
- a reflective or thematic question gets 2 to 4 sentences that draw the \
passages together.
- never more than 5 sentences.

THE CLOSING QUESTION IS OPTIONAL
- you may end with one first-person question, present tense, after a spaced \
em-dash ( — ), but only when the answer genuinely opens something: " — what's \
still unsaid?"
- most factual answers end without one. an answer that always ends in a \
question stops reading as an answer. never ask a question with a right answer \
waiting, and never ask one in the hard-topics register.

WHEN THE PASSAGES DO NOT ANSWER IT
- set answered to false, and say so plainly in their voice: what is actually \
there, or that there is nothing yet.
- naming a real absence is honest and welcome: "there's almost nothing here \
about the move — i mentioned it twice and never tied it to anything."
- never assemble a confident answer out of passages that merely sit near the \
question. a wrong answer costs more than an empty one.
- do not apologise, and do not tell them the question was bad.

AMBIGUITY
- when the passages hold several distinct things that all match, say so and \
name them, rather than picking one: "three meetings come back — the studio one \
in march, the family one in june, the work one last week. — which?"

A CONVERSATION, NOT ONE SHOT
- `turns` is what has already been asked and answered, oldest first. the new \
question continues it.
- resolve "it", "that", "them", "then", "why" against the previous turns. "what \
about before that?" means before whatever the last answer was about.
- do not repeat an answer already given; add to it. if the follow-up changes \
the subject entirely, just answer the new question.

LOWERCASE
- everything you write is lowercase, including "i" and dates ("monday", \
"february").
- names keep the case they have in the passages: a person written as "M" stays \
"M", a place written as "Rivendell" stays "Rivendell". do not lowercase \
someone's name, and do not capitalise anything else — no sentence-initial \
capitals.

VOCABULARY — never use these words in your own prose
delete, save, store, submit, send, sync, upload, complete, finish, notify, \
remind, share, retry, suggest, recommend, delightful, powerful, smart, \
intelligent, advanced, modern, beautiful, amazing, perfect, awesome, great, \
easy, simple, quickly, seamlessly, magically, instantly, automatically, \
conveniently.
(a phrase quoted from their own passages is theirs — quote it as written, even \
if it contains one of these.)

NEVER NAME THE SYSTEM
never "i noticed", never "the system found", never "mnemo". there is no entity \
here. if you cannot say it in their voice, do not say it.

NO HEDGING IN YOUR OWN VOICE
never "might", "perhaps", "could be", "seems like", "appears to". if the \
passages do not support it, set answered to false instead of hedging.

HARD TOPICS
when hard_topics is true: at most 2 sentences, no closing question, no \
pattern-matching, no "i heard this as" framing. the answer is solemn and it \
still answers. sources are still cited.

EXAMPLES

question: "where did the move first come up?"
passages: [{text: "I think we might actually leave the city.", date: "the third of march", source: {type: memory, id: m1}}]
->
text: "the first time was in march — \\"i think we might actually leave the city\\"."
phrase_sources: [{phrase: "i think we might actually leave the city", source: {type: memory, id: m1}}]
answered: true

question: "what was i saying about dad in february?"
passages: [{text: "The text from Dad was harder than I expected.", date: "monday the fifth of february", source: {type: memory, id: m1}},
           {text: "Found the photograph again. It won't sit right with me.", date: "sunday the eighteenth of february", source: {type: memory, id: m2}}]
->
text: "twice, and both times sideways. on the monday the text from Dad was harder than i expected, and by the sunday it was the photograph that wouldn't sit right. — what's still unsaid?"
phrase_sources: [{phrase: "the text from Dad was harder than i expected", source: {type: memory, id: m1}},
                 {phrase: "the photograph that wouldn't sit right", source: {type: memory, id: m2}}]
answered: true

question: "what have i said about my brother?"
passages: [{text: "Long call with mum tonight, mostly about the house.", date: "last tuesday", source: {type: memory, id: m1}}]
->
text: "nothing about him yet. the closest is a long call with mum about the house, and he isn't in it."
phrase_sources: [{phrase: "a long call with mum about the house", source: {type: memory, id: m1}}]
answered: false

return ONLY the json object: {text, phrase_sources, answered}. no prose, no \
code fences.\
"""


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------
class VoiceCSource(BaseModel):
    """A source handle. Wire-stable raw values (see iOS Annotation.swift
    WireType)."""
    type: str
    id: str


class AskPart(BaseModel):
    """One retrieved excerpt the answer may draw on. `text` is the
    unit-grained matched passage (NOT the whole parent window — see the
    module docstring), `date` is human date prose the answer can use."""
    text: str
    date: str = ""
    source: VoiceCSource


class AskTurn(BaseModel):
    """One prior exchange in this ask conversation, oldest first. `answer`
    is the prose that was served, so the model can avoid repeating it and
    can resolve references back into it."""
    query: str
    answer: str


class AskComposeRequest(BaseModel):
    query: str
    parts: List[AskPart]
    turns: List[AskTurn] = Field(
        default_factory=list,
        description="prior (query, answer) exchanges, oldest first. empty for a first turn.",
    )
    hard_topics: bool = Field(
        default=False,
        description="collapse to the hard-topics register: at most 2 sentences, no questions.",
    )


class PhraseSource(BaseModel):
    """A phrase reused in `text`, mapped to the passage it came from.
    `phrase` MUST appear in `text` character-for-character so the TS seam can
    re-locate it via UTF-16 indexOf."""
    phrase: str
    source: VoiceCSource


class AskComposeResponse(BaseModel):
    text: str
    phrase_sources: List[PhraseSource] = Field(default_factory=list)
    answered: bool = Field(
        default=True,
        description=(
            "false when the passages do not answer the question. `text` still "
            "carries honest prose naming what is (or is not) there; the caller "
            "decides whether to serve it or fall through to the empty state."
        ),
    )


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------
@router.post("/voice-c-ask", response_model=AskComposeResponse)
async def voice_c_ask(request: AskComposeRequest):
    """Answer a question from sourced excerpts, in the asker's own voice.

    Returns {text, phrase_sources, answered}. The TS seam computes UTF-16
    spans; this endpoint never emits offsets. 503 when the LLM pool buffer is
    full so the caller can degrade rather than hang.
    """
    if not request.query.strip():
        raise HTTPException(status_code=422, detail="query must be non-blank")
    if not request.parts:
        raise HTTPException(status_code=422, detail="parts must be non-empty")

    prompt = _build_prompt(request)

    try:
        result = await llm_pool.submit(
            llm_client.generate_json,
            prompt,
            AskComposeResponse,
            {
                "task": "voice_c_ask",
                "system_prompt": ASK_SYSTEM_PROMPT,
                "tools": "",
                "max_turns": 2,
            },
        )
    except QueueFullError:
        logger.warning("[voice-c-ask] llm pool full, returning 503")
        raise HTTPException(status_code=503, detail="Service busy, retry later")
    except HTTPException:
        # ClaudeCodeProvider._run raises HTTPException with a structured detail
        # dict on CLI failure — re-raise unchanged so the platform's mlFetch
        # wrapper sees the diagnostic body.
        raise
    except Exception as exc:
        logger.exception("[voice-c-ask] composition failed")
        raise HTTPException(status_code=500, detail=f"composition failed: {exc}")

    if isinstance(result, AskComposeResponse):
        return result
    try:
        return AskComposeResponse.model_validate(result)
    except Exception as exc:
        logger.error("[voice-c-ask] response failed validation: %s", exc)
        raise HTTPException(status_code=502, detail=f"upstream returned invalid shape: {exc}")


def _build_prompt(request: AskComposeRequest) -> str:
    """Render the user-turn prompt: the question, the conversation so far, and
    the retrieved passages.

    The question comes FIRST and last — models attend to both ends of a
    prompt, and the failure this endpoint exists to prevent is an answer that
    drifts into summarising the passages instead of answering.
    """
    passages_json = json.dumps(
        [
            {
                "text": p.text,
                "date": p.date,
                "source": {"type": p.source.type, "id": p.source.id},
            }
            for p in request.parts
        ],
        ensure_ascii=False,
    )
    register = (
        "hard-topics register: at most 2 sentences, no closing question, no pattern-matching."
        if request.hard_topics
        else "normal register: at most 5 sentences."
    )

    conversation = ""
    if request.turns:
        turns_json = json.dumps(
            [{"asked": t.query, "answered": t.answer} for t in request.turns],
            ensure_ascii=False,
        )
        conversation = (
            f"the conversation so far, oldest first — the new question continues it:\n"
            f"{turns_json}\n\n"
        )

    return (
        f"the question: {json.dumps(request.query, ensure_ascii=False)}\n\n"
        f"{conversation}"
        f"passages retrieved from their own past (evidence for the answer):\n"
        f"{passages_json}\n\n"
        f"{register}\n"
        f"answer the question above. every phrase in phrase_sources must appear "
        f"in text character-for-character exactly once. set answered to false if "
        f"these passages do not answer it.\n\n"
        f"return ONLY {{text, phrase_sources, answered}}."
    )
