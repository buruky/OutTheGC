# 0002: Use simple polling for the processing worker's job queue

- Status: Accepted
- Date: 2026-10-09
- Stage: Step 13 (turn the script into a worker)

## Context
Step 13 turns `extract.py`/`resolve_place.py` from scripts run by hand into a worker that reacts automatically when a post is added. How it finds new work shapes the worker's structure, failure/retry handling, and what step 20's hosting choice needs to support. `posts.status` already exists as the job-state column (spec's data model). Real scale is a friend group, not high volume.

## Options considered

| Option | Cost | Complexity | Learning value | Resume signal |
|---|---|---|---|---|
| A: Simple polling | $0 extra | Lowest — a loop, a sleep, a query | Fundamentals: status state machines, idempotency, crash handling | Honest but needs the "why" explained to land well |
| B: Postgres LISTEN/NOTIFY | $0 extra | Real gotcha: notifications missed while disconnected, often needs a polling backstop anyway | Narrow, Postgres-specific pub/sub pattern | Minor, not strongly differentiated |
| C: pgmq (Postgres queue extension) | $0 extra (same DB, no new infra) | New API to learn, but replaces hand-rolled stale-job detection with built-in visibility timeouts | Real message-queue semantics (visibility timeout, at-least-once), transferable to Redis/SQS/RabbitMQ | Strongest — demonstrates queue literacy plus restraint (Postgres-native over new infra) |

## Decision
Use simple polling: the worker loops on an interval, selects `pending` rows from `posts`, processes them, updates status.

## Why
- Developer's own call: "keep it simple" — prioritizing the simplest working worker over additional queue-semantics learning for this step.
- Claude's presented lean was pgmq (close call, not a blowout) on the grounds that its cost/complexity premium over polling is small at this project's scale while the reliability and learning value jump is real — but the developer weighed "simplest version shipped" higher than "learn real queue semantics" for this step, which the options were explicitly framed around as the deciding factor.
- At this project's real scale (a friend group, not high job volume), polling's downsides (wasted queries when idle, no built-in crash-retry) are low-stakes.

## Tradeoffs accepted
- No built-in retry-on-crash: if the worker dies mid-job, there's no automatic "this job became visible again" behavior like pgmq's visibility timeout — a stuck/crashed job needs to be detected and retried by logic this step has to hand-build itself (e.g., a stale `processing` status with a timeout check), not get it for free.
- Polling interval is a manual tradeoff between pickup latency and wasted queries — picked and tuned in step 13's implementation, not a decision recorded here.
- Revisiting this later (pgmq or otherwise) means changing how the worker finds work, which touches its core loop — not a trivial swap once built.

## Revisit if
- Job volume grows enough that polling's wasted-query overhead or pickup latency becomes a real problem.
- Crash/retry handling becomes a recurring manual pain point (jobs getting stuck in `processing` with no automatic recovery).
- Worker hosting (step 20) ends up somewhere that makes a persistent LISTEN/NOTIFY connection or pgmq's richer semantics meaningfully easier to justify.

## 30-second version
"I went with simple polling for the worker's job queue instead of Postgres's pgmq extension, which would've given me real message-queue semantics like automatic retry-on-crash. At this project's scale — a friend group, not high volume — polling is completely sufficient, and I wanted the simplest working version of the worker rather than spending this step learning queue internals. It's a close call I could defend either way, and pgmq is the natural upgrade path if job volume or reliability needs ever grow into it."
