---
name: decision-record
description: Present options and record architecture decisions (ADRs) for OutTheGC. Use whenever a structural choice comes up, anywhere in the stack: worker hosting, job queue design (polling vs pgmq), LLM provider, styling approach (NativeWind vs Tamagui), phone-auth/SMS provider, database schema shape, CI setup, or any choice that would be expensive to reverse. Also use when the developer says "decide", "which should I use", "options for", "ADR", "log this decision", "why did we pick X", or wants to backfill a decision already made. Use it even if the choice seems obvious, because the developer makes every structural call themselves.
---

# Decision Record

The developer makes every structural decision on this project and wants a log of them to talk through in interviews. This skill has two jobs: present the choice well, then record it well. Never skip straight to recording, and never implement a structural choice before it's recorded.

## Is this a structural decision?

Record it if it's hard or costly to reverse, shapes later roadmap steps, or is something an interviewer might ask "why did you choose that?" about. Examples from this project: the job queue mechanism, worker hosting, LLM provider and prompt/schema shape, styling approach, which SMS provider backs phone auth, how invite codes are generated, PostGIS vs a simpler coordinate scheme -- plus the pre-existing calls worth backfilling (see below).

Don't record small implementation details inside an already-made decision (a column name, a retry backoff value, a styling utility class). Just handle those and mention what you picked.

If unsure, ask: "Worth an ADR, or just pick one?"

## Step 1: Present the options

Read `CLAUDE.md`, `OutTheGC-spec.md`, `OutTheGC-roadmap.md`, and existing ADRs in `docs/decisions/` first, so options respect decisions already made. Then present 2 to 4 real options, in this format:

```
## Decision: <question being decided>
Why it matters now: <what this blocks or shapes, one or two lines>
Constraints: <things already decided or required, e.g. Expo + Supabase, cost per post, mobile performance>

### Option A: <name>
What it is: <one line, no jargon left unexplained>
Cost: <at this project's scale, including idle cost, free tier limits, and per-use cost if relevant -- e.g. per-SMS, per-LLM-call>
Complexity: <setup and ongoing work, what can go wrong>
Learning value: <what building it teaches>
Resume signal: <how it reads to a new grad SWE or ML-adjacent recruiter/interviewer>

### Option B: ...

Lean: <which one Claude would lean toward and why, in 1 to 2 lines, or "no strong lean">
Question for you: <anything only the developer can answer that would change the pick>
```

Guidance:
- Options must be genuinely viable. Don't pad with a strawman.
- Be concrete about cost with real pricing shape (per request, per hour, idle, per-SMS, per-LLM-call) rather than "cheap."
- Name the tradeoff each option forces, not only its benefits.
- If the answer depends on something not yet known (e.g. actual per-post LLM cost once step 11's test set runs), say so and suggest settling that first.
- Then stop and wait. The developer picks.

## Step 2: Record the decision

Once the developer chooses, write an ADR using `references/template.md`.

- File: `docs/decisions/NNNN-short-kebab-title.md`, numbered in order starting at 0001.
- Capture the developer's reasoning in their own words where they gave it. If they chose against Claude's lean, record their reasons fairly; don't editorialize.
- Keep it to about a page. Tight language, no filler.
- Add the choice to `CLAUDE.md`'s Decisions list, one line, linking to the ADR.

## Changing a decision later

Never edit an accepted ADR's decision. Write a new ADR that supersedes it, and change the old one's status to `Superseded by NNNN`. The history of changing your mind is itself a good interview story.

## Backfill mode

Three decisions predate this file and are worth backfilling first: **Supabase over Firebase**, **Expo over Flutter**, and **users bring posts into the app instead of the app scraping TikTok/Instagram**. Ask the developer, one at a time, what alternatives they considered and why they chose this. Write each as an ADR with status `Accepted (backfilled)`. Don't invent reasons they didn't give; leave a field as "not recorded" instead.

## Interview prep

When asked "prep me on my decisions" or similar, read all ADRs and quiz the developer: ask why they chose X over Y, what would make them switch, and what went wrong. Give feedback on whether their answer was specific and mentioned a real tradeoff.
