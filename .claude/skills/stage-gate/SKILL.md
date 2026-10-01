---
name: stage-gate
description: Entry and exit checks for each step of the OutTheGC build roadmap (OutTheGC-roadmap.md, steps 0-20 plus the unordered "Later" list). Use whenever the developer starts, finishes, or asks about a step, says "gate", "am I ready for step N", "is this step done", "what's next", or is about to stack a new piece (auth, RLS, the worker, the share extension, a dev build) on top of one that hasn't been verified. Also use before wiring the mobile app to Supabase or the worker if the piece underneath hasn't passed its exit gate.
---

# Stage Gate

OutTheGC is built step by step from `OutTheGC-roadmap.md`: zero to a beta, each step adding one piece and ending in something the developer can see or test. Each step in that file already has a Goal, a Try, a Learn, and a Done when — this skill is the checkpoint that makes sure "done when" is actually verified, not assumed, before the next step stacks on top.

Before running a gate, read `CLAUDE.md` and `OutTheGC-spec.md` to see which decisions have been made. If a step depends on a choice that hasn't been recorded (job queue mechanism, LLM provider, worker hosting, styling approach, and others — see `references/decisions-map.md` for which step forces which open question), do not assume one. Stop, present options with tradeoffs (or hand off to the `decision-record` skill for anything structural), and let the developer decide.

## Two modes

Figure out which one applies from context. If unclear, ask.

### Entry gate (starting a step)

Read the step's existing Goal/Try/Learn/Done-when straight out of `OutTheGC-roadmap.md` and produce this, and nothing else until the developer agrees to it:

```
## Step N entry: <name>
Goal: <from the roadmap>
Prerequisites: <done-when criteria from earlier steps this depends on, each marked verified or not>
Decisions needed: <open questions this step forces, from references/decisions-map.md or the spec, with options -- or "none">
Primitive test: <the lowest level tool that proves it works, e.g. curl, a bare Python script, the Supabase dashboard>
Done when: <copied from the roadmap, broken into checkable items if it isn't already>
Cost exposure: <free tier / small / bills per use (e.g. SMS, LLM calls, Places calls), and what to watch>
Out of scope: <what's deliberately left for a later step>
```

If any prerequisite isn't verified, say so plainly and recommend going back. Don't let an unverified layer get built on.

### Exit gate (finishing a step)

1. Go through each done-when criterion from the roadmap. For each one, either run the check (read-only commands, curl, a script) or give the developer the exact command/action and expected result and ask for the output. Don't mark a criterion passed on assumption -- "account A can't see account B's trip" means actually testing with two accounts, not reading the policy and assuming it works.
2. Report:

```
## Step N exit: <name>
  - [x] <criterion>: <evidence, e.g. "account B saw a 403/empty result querying account A's trip id directly">
  - [ ] <criterion>: <what failed and the likely layer at fault>
Result: PASS / FAIL
Left running: <services/resources still up and whether they cost anything>
Explain it back: <2 or 3 questions the developer should be able to answer in an interview about this step>
```

3. On PASS: check the step's box in `OutTheGC-roadmap.md` and fill in its **Notes:** line (what was decided, anything that took longer than expected, links that helped). On FAIL: don't move on; help debug the failing criterion, working from the outermost layer inward, and leave the box unchecked.

## Rules

- Never start the next step's work during an exit gate.
- A step can pass with a known limitation only if the developer explicitly accepts it -- record it in that step's Notes line.
- Checkboxes and Notes live directly in `OutTheGC-roadmap.md`; there's no separate stage-tracking file to keep in sync.
- Keep the report tight. No filler.

For which open questions each step tends to surface, see `references/decisions-map.md`.
