-- ADR 0005 (docs/decisions/0005-scrapecreators-for-transcripts.md) added a
-- paid, per-call transcript fetch (ScrapeCreators). Right now
-- services/worker/transcript.py has no cache at all -- two different shares
-- of the identical TikTok video (realistic in a friend-group app: the same
-- viral video pasted into two different trips, or twice into the same one)
-- currently pay for the fetch twice. This migration adds the cache table
-- only -- it does NOT wire up the check-before-fetch/write-after-fetch
-- logic in worker.py/transcript.py, that's pipeline-expert's job next.

-- ---------------------------------------------------------------------------
-- URL normalization: decided here, enforced in application code, not SQL.
-- ---------------------------------------------------------------------------
-- Real TikTok URLs carry query-string noise that varies by how they were
-- copied/shared (?is_from_webapp=1&sender_device=pc, tracking params, etc --
-- see several services/worker/eval/cases/*.json for live examples). Keying
-- this cache on the raw, as-received URL would miss the exact duplicate case
-- this table exists to catch, since two shares of the same video rarely
-- carry identical query strings. So the lookup key below (video_url) is
-- documented as the NORMALIZED url -- the stable "https://www.tiktok.com/
-- @<user>/video/<id>" path, query string stripped -- not whatever string a
-- user happened to paste.
--
-- That normalization happens in Python (pipeline-expert, worker.py or
-- transcript.py), not as a Postgres generated column, for one reason: the
-- knowledge of what a "TikTok video URL" looks like (and its edge cases --
-- vm.tiktok.com/vt.tiktok.com short links that redirect, mobile vs. desktop
-- paths, etc) already lives entirely in Python in this repo (transcript.py's
-- own docstring, extract.py's handling of URLs) and nowhere in SQL. Writing
-- an equivalent regexp_replace in a generated column would mean the same
-- URL-shape logic has to be kept correct and in sync in two languages
-- instead of one -- strictly worse for a project this size, for zero benefit
-- (nothing queries this table except the worker, which always has the
-- normalization code in-process already). If a short-link redirect ever
-- needs resolving before normalization, that has to happen in Python anyway
-- (an HTTP call), which a SQL column could never do.
--
-- Net: schema-level enforcement here is just "video_url is the key, make it
-- stable" via the primary key constraint; the actual stripping logic is 100%
-- application-level, and callers (pipeline-expert) MUST normalize before
-- every read and write against this table or the cache silently stops
-- working for noisy-but-identical URLs.

create table public.tiktok_transcript_cache (
  -- The lookup key IS the row identity -- no separate surrogate id, since
  -- nothing else ever references this table by foreign key (it's a flat,
  -- global cache, not trip-scoped or user-scoped, per the task). Caller
  -- (pipeline-expert) is responsible for passing the normalized url (see
  -- above) on every select/insert -- this column does not re-derive or
  -- validate that itself.
  video_url text primary key,

  -- Mirrors transcript.py's TranscriptOutcome enum values exactly (ok,
  -- empty, not_available). Text + check, not a Postgres enum, for the same
  -- reason posts.status/post_candidates.match_quality already made that
  -- call in this repo: this vocabulary lives in Python
  -- (pipeline-expert's file), and matching a change there should be a cheap
  -- constraint edit here, not an ALTER TYPE.
  outcome text not null,

  -- Plain parsed text (transcript.py's TranscriptResult.text), not the raw
  -- WebVTT -- this is what extract.py actually consumes downstream. Empty
  -- string (not null) for the empty/not_available outcomes, matching
  -- TranscriptResult's own default so callers don't need a null check on
  -- top of an outcome check.
  transcript_text text not null default '',

  -- When this row was written. Not used for any expiry logic yet (none is
  -- being built now, per task scope) but kept so a future staleness check
  -- (e.g. "re-fetch if fetched_at < now() - interval '90 days'") is a
  -- WHERE clause against an existing column, not a schema change.
  fetched_at timestamptz not null default now(),

  constraint tiktok_transcript_cache_outcome_valid_values check (
    outcome in ('ok', 'empty', 'not_available')
  )
);

comment on table public.tiktok_transcript_cache is
  'Cache of ScrapeCreators transcript-fetch outcomes, keyed by normalized TikTok video URL (query string stripped -- see this migration''s header comment). Caches ok/empty/not_available alike so a non-video URL or a silent video isn''t re-queried every time, same as a real transcript would be. Written/read only by the worker via the service role key.';

comment on column public.tiktok_transcript_cache.video_url is
  'Normalized form only (stable /@user/video/<id> path, no query string) -- normalization happens in Python (worker.py/transcript.py), not here. Caller must normalize before every read and write.';

-- ---------------------------------------------------------------------------
-- RLS: same shape as posts/post_candidates (step 13) -- nothing in the app
-- ever reads or writes this table, only the worker, via the service role
-- key, which bypasses RLS by design. So: enable RLS, add zero policies (a
-- table with RLS on and no policies default-denies every operation to every
-- non-service-role caller), and preemptively revoke anon's table-level
-- grants the same way step 13 did -- not reactively, after some future
-- Realtime/grant gotcha surfaces it, but now, since nothing depends on anon
-- having any access to this table and never will (it's not trip-scoped,
-- not user-scoped, there's no membership concept to even check).
alter table public.tiktok_transcript_cache enable row level security;

revoke select, insert, update, delete on public.tiktok_transcript_cache from anon;
