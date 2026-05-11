# Gap Analysis UI — Description

## What the gap-analyzer agent already does

`learn/src/agents/gap-analyzer.ts` (104 lines) reads the learner's Graph S + Graph C state to find the highest-impact gap: the weakness that blocks the most downstream understanding. The agent:

1. **Diagnoses efficiently** — calls `get_struggle_areas` first (fast), then `get_prerequisite_chain` (fast), only calling the expensive `get_causal_learning_history` reasoning agent when ambiguous.
2. **Traces causal history** — uses Graph C to find why the gap exists: a skipped prerequisite, an internalised misconception, a broken connection.
3. **Generates targeted mini-lessons** — creates 3–5 paragraph remedial content with follow-up questions.

The agent works reliably. It ships a JSON result with `targetConcept`, `rootCause`, `whyItMatters`, `lesson`, `followUpQuestions`, `nextSteps`.

## Why no UI today

v0.3 carved every secondary tab except Dashboard and Courses. The v0.2 design shipped gap analysis UI as a standalone "My Gaps" tab (mentioned in `02-v0.2-design.md` as deferred). Rationale: validate the core "lesson + chat sidebar" flow before adding secondary surfaces. The agent code was retained; the surface disappeared.

Decision rule per v0.3: **does this lean on the graph in a way that brings the learner closer to a lesson?** A standalone "My Gaps" tab pulls the learner *away* from lessons. A gap card that lives on the dashboard or inline on a section page, with a CTA to regenerate the section's lesson tuned to the gap, leans on the graph and *pulls the learner toward* remedial content.

## Why re-instating it the right way matters

1. **It's the demonstrable wow.** Per vision doc (§"The diagnostic moment"), gap analysis with causal reasoning is the #1 differentiator from normal e-learning. Invisible features don't ship value.
2. **Composes with graph-aware lessons (nmemo-7si).** The gap-analyzer identifies the root-cause concept; graph-aware lesson generation (nmemo-7si) personalises the section's lesson to that concept. Together they close the loop: "Here's your gap; here's a lesson designed to fix it."
3. **Fits the v0.3 principle.** Dashboard is where the learner lands first. A "Top gap" card surfaces the insight without requiring new navigation. Clicking "Fix this" regenerates the section's lesson and navigates there — the learner stays in the lesson.
4. **Builds credibility.** Learners see the system "gets it" — it found the gap, understood the reason, and materialized a targeted lesson. That's the value proposition.
