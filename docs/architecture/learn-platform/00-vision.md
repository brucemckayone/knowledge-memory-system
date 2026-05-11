# Vision — Why This Platform Is Different

**Status:** Carries through every version. The "north star" of the project.

---

## The problem with normal learning platforms

Normal e-learning is a glorified slideshow with quizzes bolted on. The system has no model of what *you* understand and why; it simply tracks completion percentage and quiz scores. When you fail a quiz, it gives you the right answer. When you ask a question, it pattern-matches to FAQ content. When you finish a course, it has no memory of you when you start the next one.

The fundamental missing capability is **a model of the learner that grows over time, captures causal structure, and connects across all material the learner has ever touched.**

## What we have that nothing else does

The Nmemo dual-graph gives us this for free:

- **Graph S** — the learner's evolving knowledge state. Every demonstrated understanding, every misconception, every gap, with bi-temporal validity windows. Knowledge decays without practice. Confidence is not just a score, it's a vector embedded in a network.
- **Graph C** — the *causal* structure of learning. Why is this learner struggling with X? Trace it. Find the prerequisite they skipped, the misconception they internalised three weeks ago, the connection they never made. This is the layer no normal LMS has.

Combined with **emergent ontology** (the system's vocabulary for describing your learning evolves with the data), **causal extraction agents**, and **pattern lifecycle** (recurring learning patterns get named and tracked over time), we can build something nobody has built.

## The three demonstrable moments

Every version of this platform must keep these alive:

### 1. The diagnostic moment
"You're struggling with X. Here's why, traced back through your last three weeks of sessions: you missed Y, Y is a prerequisite for Z, Z is what X builds on." This is gap analysis with causal reasoning. Already shipped in v0.1.

### 2. The connection moment
"You learned about closures in the JavaScript course three weeks ago. The same concept appears in the Rust course you're starting now — they call it a *move closure* but the mental model is identical. Here's how they map." This is cross-course intelligence via same-as detection on concept entities. Coming in v0.2.

### 3. The synthesis moment
"You've been learning about graph algorithms, recursion, and dynamic programming over the last month. The system has noticed a deep connection: they all share the same underlying recursive substructure principle. Here's an article that ties them together." This is article generation from dense concept clusters. Coming in v0.2.

## What we will not build

- **A vector-search-only system.** RAG over course material would be cheaper but it has no concept of *you*. We're building the opposite.
- **Static personalised paths.** No "learner type X gets path Y". The graph is the path; it's continuously redrawn.
- **A grading system.** This isn't about scoring; it's about understanding. Confidence is internal signal, not a report card.
- **Predefined ontologies.** No fixed list of "skill types" or "learning styles". The vocabulary emerges from data — that's the point of the platform underneath.

## The principle that decides everything

When we add a feature, we ask: **does this lean on the graph, or does this go around it?**

A feature that goes around the graph is a feature this platform doesn't deserve to ship. It would work just as well on top of any LMS. It wouldn't justify the architecture.

A feature that leans on the graph — that uses entities, facts, causal edges, contradictions, patterns, blast radius, decay, same-as links — is the kind of feature that genuinely couldn't exist anywhere else.

## UX principle: chat lives next to the lesson, never as its own destination

The chat tutor is not a feature you visit. It is a sidekick that sits next to whatever the learner is reading and is always aware of the section, the highlighted text, the lesson overlay, and the learner's cross-course state via MCP. There is no standalone "chat" tab; there is a section page where the chat lives in a persistent sidebar and acts on what the learner is touching right now.

This decides a lot:
- Surfaces are judged by whether they bring the learner closer to the lesson, or pull them away from it.
- A tab that exists to expose a feature *we built* but that the learner never naturally walks toward is the wrong shape. The right shape is to surface that feature on the dashboard or inline on the section page.
- Chat threads are scoped to the lesson the conversation is about. A new section means a new thread; the tutor's MCP memory of the learner persists across them.
