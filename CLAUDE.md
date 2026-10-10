# Project: OutTheGC

OutTheGC turns the TikToks and Reels friends send each other into a shared trip map. Someone shares a post into the app, the app extracts the place, and pins it to a trip the whole group can see. Full product spec: `OutTheGC-spec.md`. Build plan: `OutTheGC-roadmap.md` (20 steps from an empty repo to a beta, plus an unordered "Later" list).

## Decisions

- Platform: mobile first (iOS + Android) via Expo (React Native), one codebase. Web is secondary, later.
- Backend: Supabase (Postgres, PostGIS, Auth, Row Level Security, Realtime, Storage).
- Processing worker: a separate Python service (ffmpeg, Whisper, LLM API) behind a job queue, reading/writing the `posts` and `post_candidates` tables.
- Extraction never auto-pins. The user always confirms a place before it's saved.
- Input is a shared link, a screenshot, or a screen recording the user captures themselves — the app never downloads TikTok/Instagram video itself. As of ADR 0005, link-based extraction *does* use a third-party scraping service (ScrapeCreators) for video transcripts, superseding the original "no scraping at all" stance — see Decisions below.
- Launch platform: TikTok only. Instagram, screen recordings, and web are later (see roadmap "Later" section).
- LLM provider for place extraction: OpenAI (small-model tier). See [docs/decisions/0001-openai-for-extraction.md](docs/decisions/0001-openai-for-extraction.md).
- Job queue mechanism: simple polling (not pgmq). See [docs/decisions/0002-polling-job-queue.md](docs/decisions/0002-polling-job-queue.md).
- Confirming a candidate into a real pin: server-side RPC, not direct client writes (closes a places-poisoning risk). See [docs/decisions/0003-confirm-via-rpc.md](docs/decisions/0003-confirm-via-rpc.md).
- ~~No server-side scraping of TikTok/Instagram~~ — superseded. See [docs/decisions/0004-no-serverside-scraping.md](docs/decisions/0004-no-serverside-scraping.md) (backfilled original decision).
- TikTok transcript data via ScrapeCreators (third-party scraping API), added to extraction alongside the existing free oEmbed caption. Accepts real ToS/reliability risk, done deliberately — see [docs/decisions/0005-scrapecreators-for-transcripts.md](docs/decisions/0005-scrapecreators-for-transcripts.md) for the full tradeoff.

Two decisions predate this file and are good interview material: Supabase over Firebase, Expo over Flutter. Backfill them as ADRs with the `decision-record` skill before relying on "we just know why." (The third, no-scraping, is now backfilled — see ADR 0004 — since it was just superseded.)

Everything else — worker framework, worker hosting (Railway/Fly/Render), styling approach (NativeWind vs Tamagui vs plain `StyleSheet`), the SMS/phone-auth provider underneath Supabase Auth — is undecided. Don't assume one because it's a common pairing; check `docs/decisions/` and the spec's Open Questions first.

## Current step

Steps 0-14 done — the full extraction loop works end to end (paste a TikTok link → confirm → pin appears live on everyone's map). **ScrapeCreators TikTok transcripts are now live in extraction** (ADR 0005, `docs/decisions/0005-scrapecreators-for-transcripts.md`) — caption + spoken-audio transcript both feed the LLM, with a URL-keyed cache (`tiktok_transcript_cache`) so duplicate shares of the same video don't re-spend credits; verified end to end (first paste: real fetch, 1 credit; second paste of the same URL: cache hit, 0 credits). Step 15 (development build) in `OutTheGC-roadmap.md` is next. Run the `stage-gate` skill before starting it and before moving to each step after.

**Carried-forward gaps:**
- No crash-recovery sweep for a post stuck in `processing` (step 13) — the `status`/`updated_at` columns support one being built later, not built yet.
- On-screen text (burned-in captions, location stickers) still isn't read — ScrapeCreators' transcript closes the *audio* half of the competitor-parity gap, not the visual half. The self-built screen-recording + ffmpeg + Whisper + OCR pipeline is still on the "Later" list for that piece.
- Confirm screen has no manual-search fallback (spec's Confirm step calls for one) — deferred, not built.
- **Eval case `025-cdmx-tacos-unnamed-list`'s ground truth needs a human check.** Its real transcript has genuine ASR ambiguity (ungrammatical Spanish, could be a real place name or filler) that couldn't be resolved confidently from text alone — needs the developer to actually listen to the source video and correct the test case's `expected` list, or mark it explicitly unverifiable.
- **ScrapeCreators transcript has confirmed real-world gaps.** A real video with genuine spoken dialogue returned empty 3 separate ways (base call, AI-fallback call, canonical-URL retry) — see roadmap Log, 2026-10-10. Not a bug in our code; their own docs don't explain when/why this happens. Handled gracefully already (degrades to caption-only), but the transcript signal isn't reliable on every video — don't assume it always works when debugging an unexpected extraction result.
- **Extraction may be too eager to treat a recognizable name (sports team, brand, person) as a visitable "place."** Surfaced live: `#gambaosaka` (a football club, not a venue) got extracted and resolved to an unrelated nearby business. Not yet fixed — a real prompt-tightening candidate, and the confirm screen also doesn't visually distinguish `confident` from `low_confidence` candidates, which made this look more trustworthy than the system actually believed it was.
- **22 of 37 eval cases have placeholder URLs** (TikTok search/topic pages, not real videos) and can never get a real transcript via this API — pre-existing from before the eval set had any transcript dependency. Transcript-eval coverage today is 15/37 cases, not the full set. Will need a second full re-run once transcripts are wired in too.

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
