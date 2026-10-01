# Project: OutTheGC

OutTheGC turns the TikToks and Reels friends send each other into a shared trip map. Someone shares a post into the app, the app extracts the place, and pins it to a trip the whole group can see. Full product spec: `OutTheGC-spec.md`. Build plan: `OutTheGC-roadmap.md` (20 steps from an empty repo to a beta, plus an unordered "Later" list).

## Decisions

- Platform: mobile first (iOS + Android) via Expo (React Native), one codebase. Web is secondary, later.
- Backend: Supabase (Postgres, PostGIS, Auth, Row Level Security, Realtime, Storage).
- Processing worker: a separate Python service (ffmpeg, Whisper, LLM API) behind a job queue, reading/writing the `posts` and `post_candidates` tables.
- Extraction never auto-pins. The user always confirms a place before it's saved.
- No server-side downloading of TikTok/Instagram videos. Input is a shared link (oEmbed/caption), a screenshot, or a screen recording the user captures themselves.
- Launch platform: TikTok only. Instagram, screen recordings, and web are later (see roadmap "Later" section).

Three of these — Supabase over Firebase, Expo over Flutter, and users bringing posts into the app rather than the app scraping TikTok/Instagram — were made before this file existed and are good interview material. Backfill them as ADRs with the `decision-record` skill before relying on "we just know why."

Everything else — worker framework, job queue mechanism (polling vs pgmq), worker hosting (Railway/Fly/Render), LLM provider, styling approach (NativeWind vs Tamagui vs plain `StyleSheet`), the SMS/phone-auth provider underneath Supabase Auth — is undecided. Don't assume one because it's a common pairing; check `docs/decisions/` and the spec's Open Questions first.

## Current step

Not started. Step 0 (tooling) in `OutTheGC-roadmap.md` is next. Run the `stage-gate` skill before starting it and before moving to each step after.

## How to work in this repo

- The owner makes every structural decision and wants to be able to explain each one in an interview. Before adding a dependency, library, or architectural pattern, present 2–4 options with tradeoffs (cost, complexity, what it teaches, resume signal) and wait — use the `decision-record` skill for anything that would be expensive to reverse.
- Never install packages or push schema/infra changes without approval.
- Explain unfamiliar tools and commands briefly as you introduce them; this project is explicitly a learning build, not just a shipped artifact.
- Steps are built and verified one at a time, in the primitive-first order the roadmap lays out (console/CLI before code, a Python script before a worker, curl before UI). Don't wire a new piece onto one that hasn't passed its exit gate.
- Route work to the specialist that owns it: `supabase-expert` (migrations, RLS, Auth, Realtime, Storage, Edge Functions), `mobile-expert` (the Expo app), `pipeline-expert` (the Python worker), `security-reviewer` (read-only review, use proactively after RLS/auth/storage/worker changes).

## File organization (target layout, not yet created)

- `apps/mobile/` — the Expo app. Roadmap step 1's `npx create-expo-app` should land here, not at the repo root — the repo already holds the spec and roadmap, and will hold `supabase/` and `services/worker/` as siblings.
- `services/worker/` — the Python processing worker (oEmbed/caption gathering, LLM extraction, Google Places resolution, job status handling). `services/worker/eval/` holds the extraction test set — see the `extraction-eval` skill.
- `supabase/` — migrations and config managed by the Supabase CLI (`supabase/migrations/`, `supabase/functions/` for Edge Functions).
- `docs/decisions/` — ADRs, numbered `NNNN-title.md`, written by the `decision-record` skill.
- `OutTheGC-spec.md`, `OutTheGC-roadmap.md` — product spec and build plan. Read both before any nontrivial change; the roadmap is also the stage tracker (check off steps, fill in each step's Notes).

If something doesn't obviously fit one of these, ask before adding a new top-level folder.

## Data model

Full table-by-table detail, including how each product decision (merged pins, "saved by N", remove-my-save vs delete-for-everyone, archived trips, deleted-account handling) maps to columns, lives in `OutTheGC-spec.md` under "Data model" — read it before touching schema. Core tables: `profiles`, `trips`, `trip_members`, `posts`, `post_candidates`, `places`, `trip_places`, `saves`, `post_places`; `expenses`/`expense_splits` are low priority and designed later.

## Permission rules (row level security)

- A trip and everything on it is visible only to members in `trip_members`.
- Any member can add posts, edit pins, save, unsave, and delete pins.
- Only the trip owner (`trips.owner_id`) can rename the trip, change dates, remove members, reset the invite code, archive, or transfer ownership.
- Joining a trip requires a valid invite code.
- Nobody can edit an archived trip (`archived_at` set).

These rules are the acceptance criteria for every RLS policy `supabase-expert` writes and everything `security-reviewer` checks policies against.

## Open questions

Unresolved product and ops questions (business model, categories, pin styling, web scope, money splitting, worker hosting, analytics, and more) are tracked in `OutTheGC-spec.md` under "Open questions." Surface the relevant one when a roadmap step depends on it instead of guessing.
