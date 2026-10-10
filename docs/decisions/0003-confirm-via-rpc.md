# 0003: Confirm a candidate via a server-side RPC, not direct client writes

- Status: Accepted
- Date: 2026-10-10
- Stage: Step 14 (paste a link in the app)

## Context
Confirming an extraction candidate into a real pin touches several tables at once: `places` (create or merge by `google_place_id`), `trip_places` (create or merge by `(trip_id, place_id)`), `post_places` (link the source post), `saves` (the confirming user's first save), and `post_candidates.selected`. A security review of the step 14 schema migration (`20261010000000_add_post_places_and_confirm.sql`) surfaced a real risk in doing this as plain client-side inserts: `places` has had `with check (true)` since step 8 (any authenticated user can insert any `google_place_id`/coordinates), which was an acceptable tradeoff when nothing matched on `google_place_id` — step 14 is what makes that matching (and therefore first-writer-wins poisoning of a shared place across unrelated trips) actually exploitable.

## Options considered

| Option | Cost | Complexity | Learning value | Resume signal |
|---|---|---|---|---|
| A: Server-side RPC (`SECURITY DEFINER` function, same pattern as step 7's `join_trip_by_code`) | $0 extra | More code to write and scrutinize; one function owns the create-or-merge logic across 4-5 tables atomically | Real practice with SECURITY DEFINER scoping, `search_path` pinning, and designing a privileged write path — the same care already applied in step 7 | Demonstrates recognizing and closing a real escalation path, not just building the feature |
| B: Plain client-side inserts (step 8's hand-add-a-place pattern) | $0 extra | Simplest, most consistent with existing code | Low — repeats an already-learned pattern | The places-poisoning risk ships as a known, accepted gap, not a secret one, but it does ship |

## Decision
Confirm is implemented as a server-side RPC the app calls with a candidate id, not as a sequence of direct client table writes.

## Why
- Closes the actual risk the security review found: the RPC controls exactly how/when a `places` row gets created or merged, instead of leaving that decision to whatever the client's own insert happens to send.
- Gives atomicity for free — today's alternative (several separate client-side inserts) could half-fail partway through (e.g. `trip_places` created but `saves` insert fails), leaving inconsistent state; one function call either fully succeeds or fully fails.
- Direct continuation of a pattern this project already trusts and has done carefully once (`join_trip_by_code`, step 7) — not a new category of risk to learn, an extension of one already handled well.

## Tradeoffs accepted
- More code than plain inserts, and it's privileged code (`SECURITY DEFINER`) — needs the same scrutiny step 7's function got (search_path pinned, explicit anon/authenticated grants, re-verify trip membership and post status inside the function rather than trusting RLS alone).
- The confirm action is now a single opaque RPC call from the client's point of view, not a sequence of inspectable table writes — slightly less transparent to debug from the mobile app's own code, though the function itself should be straightforward to read.

## Revisit if
- The RPC's logic grows complex enough that splitting it into multiple calls (with its own atomicity handling, e.g. a transaction wrapper) becomes clearer than one large function.
- A future step needs partial/incremental confirm (e.g. confirming candidates one at a time with different outcomes) that doesn't fit a single all-at-once RPC shape.

## 30-second version
"A security review during step 14 found that letting the client directly insert into the shared `places` table — which has been open to any signed-in user since step 8 — becomes a real cross-trip data-poisoning risk once confirm starts merging by Google place id. I closed it the same way step 7 handled joining a trip by invite code: a server-side function that owns the privileged part of the write, instead of trusting client-side inserts to behave."
