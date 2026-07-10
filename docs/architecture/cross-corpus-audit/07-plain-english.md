# The Cross-Corpus Feature, in Plain English

A no-jargon explainer. If you want the technical version, read `04-hardened-spec.md`. This one assumes you know nothing about the guts.

---

## What it will do (the feature list)

1. **Load two or more separate collections of documents and keep them apart.** Today the system blends everything you feed it into one big pile. This feature lets you keep collections separate on purpose, so they never get mixed up, even when they mention the same thing.
2. **Let an AI assistant read across the collections and draw connections between them.** For example: "this piece of code breaks this rule in the coding standard."
3. **Every connection comes with a written reason and links back to its exact sources.** So you can check the AI's work instead of taking it on faith.
4. **Use a reliable automated checker as the source of truth where one exists, and only ask the AI about the fuzzy stuff.** For code, a linter can decide many rules for certain. We let it. We only bring in the AI for the rules no tool can settle.
5. **Keep a permanent, growing map of all the connections that you can ask questions about later.** Like: "show me everything that breaks rule 21.6," or "what have we checked so far, and what is still left?"
6. **Work in any subject area, not just code.** Code is only the first test case, because code is the one area with a tool that can grade the AI's answers. The same machine would work for research papers vs a textbook, or a story bible vs a novel draft.
7. **Plug into other AI agents as a tool.** It is exposed as something an agent can call, not just a website.
8. **Two ways to use it.** A thorough sweep that checks everything and keeps score of what is left, or a free-roam mode where the assistant just notes connections as it spots them.

---

## What it is, in one breath

A way to take two separate bodies of knowledge, keep them separate, and let an AI build a checkable, permanent set of "these two things are related, and here is why" links between them.

## The problem it fixes

Right now the system is a good note-taker with one bad habit for this job: it merges everything. If you tell it about "printf" in some code and "printf" in a rulebook, it decides they are the same thing and glues them together. That is exactly what you want for a personal memory (all your notes about one friend should link up). It is exactly what you do NOT want when you are trying to *compare* two things. You cannot compare two piles once you have poured them into one.

So the first job is a switch: "blend this in" versus "keep this separate and let me draw the comparisons myself."

## How it works, step by step

1. **You load a collection and tag it.** The tag is the switch. One tag says "this is my main pile, blend it in." A different tag says "keep this one separate."
2. **The system reads each collection on its own terms.** It does not take sides or form opinions while reading. It just records what is there. Keeping this step neutral is what lets you reuse the same collections for different purposes later.
3. **An AI assistant then looks across the two collections and makes connections.** This is where the opinions live. It says things like "this function breaks that rule," and it must write down why and point at the exact lines and rule it used.
4. **Where a dependable checker exists, we trust the checker, not the AI.** For code, many rules can be decided for certain by a linter. We feed those in as ground truth. We only spend the AI on the rules a machine cannot decide.
5. **Every connection is saved for good.** Not as a one-off report, but as a lasting record you can query, add to, and re-run. The report is just a question asked against that record.

## The pieces, in plain words

- **Corpus.** A fancy word for "one collection of documents." A codebase is a corpus. A rulebook is a corpus.
- **Bridge.** A single saved connection between something in one corpus and something in another, like a sticky note that says "this breaks that" plus the reason and a citation. Bridges are the actual product.
- **The catalog.** A lightweight list of the individual things in a corpus (each function in the code, each rule in the standard), each with a stable name so we can point at it reliably even as the code changes. These are kept as plain list entries, deliberately NOT mixed into the main memory, so nothing can accidentally glue them together.
- **The checker (or "oracle").** An outside tool that is always right about the things it covers, like a linter for code. We use it wherever we can and fall back to the AI only where we must.
- **The sweep versus free-roam.** The sweep is the methodical mode: check every item against every relevant rule and keep score. Free-roam is the AI wandering and noting anything interesting it sees. Both save the same kind of checkable connection.

## How we are building it, and why so carefully

We are being deliberately cautious, in a good way.

- **We test the scariest assumption first, cheaply.** The whole thing rests on one bet: that the AI can actually find the right rule for a piece of code even when they use totally different words. Before building anything, we run a small throwaway experiment to see if that works. If it does not, we stop and save ourselves the whole project. This is the single most valuable step.
- **We build the smallest useful version first.** Only the switch (keep collections separate), the connection records, and the minimum needed to prove it works with hand-made test data. Everything fancy waits.
- **We do not build things before we need them.** A lot of tempting machinery (a big tracking dashboard, a live code scanner, a plugin system) is deliberately left for later phases, because none of it is needed to prove the idea works.
- **We fix the ground before we build on it.** There is a first phase that just makes sure the existing system is healthy and does not have surprises, before we add anything. It is small on purpose: verify a couple of things, fix one known bug, and take a proper look around for anything we have not noticed yet.

## The parts we are honestly not sure about yet

Good plans admit what they do not know.

- **Can the AI reliably match code to rules across different wording?** This is the big bet. We test it first, on purpose.
- **Will the AI sometimes confidently give a wrong reason?** Probably, sometimes. We cannot fully catch that with automation, so early on a human checks the AI's connections. We also stamp each connection with which version of the code and which AI made it, so anything can be re-run and double-checked.
- **How do we keep the links fresh when the code keeps changing?** The code moves on every commit; our notes move when we load new documents. Keeping links in sync across two things that change at different speeds is genuinely hard, so we have parked that for a later phase and made a simple rule for now: never quietly re-point a link. If its source changed, flag it and let a human or a fresh pass sort it out.

## The one rule we keep repeating

Every single connection the AI makes must come with a written reason and a link to its sources. No exceptions. A connection with no explanation is not allowed to exist. That is what makes the whole thing trustworthy instead of a black box.

---

## The short version

Keep collections separate, let an AI draw explained and sourced links between them, trust a real checker wherever one exists, save every link so you can ask questions later, and prove the risky part works before building the rest.
