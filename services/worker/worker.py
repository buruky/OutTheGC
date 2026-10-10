"""
Step 13 of the OutTheGC build: turn extract.py (step 11) and resolve_place.py
(step 12) from scripts run by hand into a worker that reacts to new `posts`
rows on its own.

Job queue mechanism: simple polling (docs/decisions/0002-polling-job-queue.md)
-- loop on an interval, select `pending` rows from `posts`, process them,
update status. No pgmq, no LISTEN/NOTIFY.

Pipeline position (OutTheGC-spec.md): gather -> extract -> resolve -> write
post_candidates -> set posts.status. "Gather" (TikTok oEmbed, step 10) now
runs IN this file when needed: step 14 is the first place a post can be
created from just a pasted `url` with a null `caption` (a human pasting a
link in the app, not a script that already filled the caption in). Decision:
the worker runs oEmbed, not the mobile app -- see process_post below. If
oEmbed itself fails (bad/private video, network error), that's this post's
failure (status=failed); extraction never runs with no caption to work from.

Talks to Supabase over PostgREST (the same REST API the mobile app's JS
client calls, just over plain HTTP instead of through a client library) --
GET to list, PATCH to update a row, POST to insert rows, filtered with
PostgREST's query-param syntax (`?status=eq.pending`, `?order=created_at.asc`).
Authenticated with the SERVICE ROLE key, not the anon key the mobile app
uses: the service role key is a trusted-backend credential that bypasses Row
Level Security entirely (by design -- the worker has to read/write every
trip's posts, not just ones some particular user is a member of), so it
must never reach a client, a log line, or source control. Raw `requests`
calls rather than the `supabase-py` client library: every other script in
this directory (oembed_caption.py, resolve_place.py) already talks to a
documented REST API the same way, and the worker only needs three simple
queries (select pending, claim one, insert candidates) -- not enough surface
to justify a new dependency that would also pull in postgrest-py/gotrue/
storage3/realtime underneath it. Easy to swap later if that changes.
"""

from __future__ import annotations

import os
import sys
import time
from typing import Optional

import requests
from dotenv import load_dotenv

from extract import (
    MalformedResponseError as ExtractMalformedResponseError,
    QuotaExhaustedError as ExtractQuotaExhaustedError,
    TransientExtractionError,
    extract_places,
)
from oembed_caption import OEmbedError, fetch_oembed
from resolve_place import (
    MalformedResponseError as ResolveMalformedResponseError,
    QuotaExhaustedError as ResolveQuotaExhaustedError,
    TransientResolutionError,
    resolve_place,
)
from transcript import (
    TranscriptError,
    TranscriptOutcome,
    fetch_transcript,
    normalize_tiktok_url,
)

# Responsive enough for manual testing (insert a row, see it picked up
# within ~10s) without polling aggressively enough to spam Supabase on
# every empty tick. Only matters while the queue is empty -- draining a
# backlog of pending posts loops immediately, no sleep between them (see
# run_once/main below).
POLL_INTERVAL_SECONDS = 7

REQUEST_TIMEOUT_SECONDS = 10

# Exceptions that mean "the API itself is unhealthy right now," not "this
# one post's input was bad" -- see the failure-handling decision in
# process_post/run_once below.
_API_HEALTH_ERRORS = (
    ExtractQuotaExhaustedError,
    ResolveQuotaExhaustedError,
    TransientExtractionError,
    TransientResolutionError,
)


class WorkerConfigError(Exception):
    """Missing/misconfigured env var -- fail loudly at startup, before the
    loop ever runs, not on the first poll tick."""


def _load_config() -> tuple[str, str]:
    load_dotenv()
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url:
        raise WorkerConfigError("SUPABASE_URL is not set. Check services/worker/.env.")
    if not key:
        raise WorkerConfigError(
            "SUPABASE_SERVICE_ROLE_KEY is not set. Check services/worker/.env -- "
            "copy it from the Supabase dashboard's API settings (the service_role "
            "key, NOT the anon key)."
        )
    return url.rstrip("/"), key


def _headers(service_role_key: str) -> dict:
    return {
        "apikey": service_role_key,
        "Authorization": f"Bearer {service_role_key}",
        "Content-Type": "application/json",
    }


def fetch_pending_posts(base_url: str, headers: dict) -> list[dict]:
    """GET posts where status=pending, oldest first -- decision 0002's own
    description of the worker's core access pattern, backed by this
    migration's partial index on (status) where status in
    ('pending','processing').

    select now also pulls `url` (step 14: needed to run oEmbed when caption
    is null) and an embedded `trips(destination)` -- PostgREST auto-detects
    the posts.trip_id foreign key and embeds the related trips row inline,
    so the trip's destination (for resolve_place.py's destination bias)
    comes back in the same request instead of a second GET per post."""
    resp = requests.get(
        f"{base_url}/rest/v1/posts",
        headers=headers,
        params={
            "select": "id,caption,url,trip_id,trips(destination)",
            "status": "eq.pending",
            "order": "created_at.asc",
        },
        timeout=REQUEST_TIMEOUT_SECONDS,
    )
    resp.raise_for_status()
    return resp.json()


def claim_post(base_url: str, headers: dict, post_id: str) -> bool:
    """Mark one post `processing`, but only if it's still `pending` -- the
    `status=eq.pending` filter is enforced server-side, so two worker
    processes racing on the same row can't both "win" the claim (whichever
    PATCH lands second matches zero rows and no-ops). Returns False if
    someone else already claimed it. Nothing in this step's scope runs more
    than one worker process, but the filter costs one query param, not a
    system to build, so there's no reason to skip it."""
    resp = requests.patch(
        f"{base_url}/rest/v1/posts",
        headers={**headers, "Prefer": "return=representation"},
        params={"id": f"eq.{post_id}", "status": "eq.pending"},
        json={"status": "processing"},
        timeout=REQUEST_TIMEOUT_SECONDS,
    )
    resp.raise_for_status()
    return len(resp.json()) == 1


def set_post_status(base_url: str, headers: dict, post_id: str, status: str) -> None:
    resp = requests.patch(
        f"{base_url}/rest/v1/posts",
        headers=headers,
        params={"id": f"eq.{post_id}"},
        json={"status": status},
        timeout=REQUEST_TIMEOUT_SECONDS,
    )
    resp.raise_for_status()


def set_post_caption(base_url: str, headers: dict, post_id: str, caption: str) -> None:
    """Persist an oEmbed-fetched caption back onto the post row (step 14) --
    a one-time write so a re-run of this post (crash recovery, manual retry)
    doesn't need to call oEmbed again for the same post."""
    resp = requests.patch(
        f"{base_url}/rest/v1/posts",
        headers=headers,
        params={"id": f"eq.{post_id}"},
        json={"caption": caption},
        timeout=REQUEST_TIMEOUT_SECONDS,
    )
    resp.raise_for_status()


def get_cached_transcript(base_url: str, headers: dict, video_url: str) -> Optional[dict]:
    """Cache lookup (migration 20261010010000) before spending a
    ScrapeCreators credit. `video_url` must already be normalized (see
    transcript.normalize_tiktok_url) -- this function doesn't normalize,
    same contract the migration documents for every caller.

    A cache read failure here (network/Supabase blip) must never block the
    real transcript fetch -- this table is a cost optimization, not a
    pipeline dependency -- so any request failure is logged and treated as
    a plain miss (falls through to calling ScrapeCreators), never raised.
    """
    try:
        resp = requests.get(
            f"{base_url}/rest/v1/tiktok_transcript_cache",
            headers=headers,
            params={
                "select": "outcome,transcript_text",
                "video_url": f"eq.{video_url}",
            },
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        resp.raise_for_status()
        rows = resp.json()
        return rows[0] if rows else None
    except requests.exceptions.RequestException as e:
        print(f"transcript cache lookup failed (treating as miss): {e}")
        return None


def write_transcript_cache(
    base_url: str, headers: dict, video_url: str, outcome: str, transcript_text: str
) -> None:
    """Write-after-fetch for a real ScrapeCreators result -- all three
    outcomes (ok/empty/not_available), not just successful ones, per the
    migration's own reasoning (a silent/music-only video or an
    unresolvable url is just as worth not re-querying as a real
    transcript). Never called for a TranscriptError (transient/quota/
    malformed) -- those aren't a real outcome for this video, just a
    failed attempt, so caching one would permanently poison the cache with
    a wrong answer.

    Upsert (on_conflict=video_url, resolution=merge-duplicates) rather
    than a plain insert so this can't itself fail the post over a
    duplicate-key conflict. Best-effort: a write failure is logged and
    swallowed -- the transcript result already fetched is still valid and
    used for this post, it just won't be cached for next time.
    """
    try:
        resp = requests.post(
            f"{base_url}/rest/v1/tiktok_transcript_cache",
            headers={
                **headers,
                "Prefer": "resolution=merge-duplicates,return=minimal",
            },
            params={"on_conflict": "video_url"},
            json={
                "video_url": video_url,
                "outcome": outcome,
                "transcript_text": transcript_text,
            },
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        resp.raise_for_status()
    except requests.exceptions.RequestException as e:
        print(f"transcript cache write failed (continuing without caching): {e}")


def insert_candidates(base_url: str, headers: dict, rows: list[dict]) -> None:
    if not rows:
        return
    resp = requests.post(
        f"{base_url}/rest/v1/post_candidates",
        headers={**headers, "Prefer": "return=minimal"},
        json=rows,
        timeout=REQUEST_TIMEOUT_SECONDS,
    )
    resp.raise_for_status()


def process_post(base_url: str, headers: dict, post: dict) -> bool:
    """Run extraction + resolution for one already-claimed post, write its
    candidates, and set its final status. Returns True if the rest of this
    poll tick's pending posts should be skipped (an API-health error, not a
    bad-input one -- see the module docstring / failure-handling notes)."""
    post_id = post["id"]
    caption = post.get("caption")

    if not caption or not caption.strip():
        # Step 14: a post can now arrive with just a url and no caption (a
        # pasted link, not a script that already filled caption in) -- the
        # worker runs oEmbed itself here (decision: worker, not the mobile
        # app). This is the one-time gather step for a TikTok url; it costs
        # one extra HTTP call to TikTok's (free, keyless) oEmbed endpoint,
        # not an LLM/Places call, so it adds nothing to this post's paid
        # per-post cost.
        url = post.get("url")
        if not url:
            # Bad input, not a transient problem -- fail this post only,
            # don't retry, don't pause the cycle (CLAUDE.md: "a bad input
            # ... should fail fast rather than retry pointlessly").
            print(f"[{post_id}] FAILED: no caption and no url on this post, nothing to extract from.")
            set_post_status(base_url, headers, post_id, "failed")
            return False
        try:
            oembed_data = fetch_oembed(url)
        except OEmbedError as e:
            # Bad/private video or a network error -- this post's failure,
            # not a reason to pause the rest of the tick (oEmbed is keyless
            # and per-URL, not a shared API wall like a quota).
            print(f"[{post_id}] FAILED: oEmbed fetch failed: {e}")
            set_post_status(base_url, headers, post_id, "failed")
            return False
        caption = oembed_data.get("title")
        if not caption or not caption.strip():
            # oEmbed's spec doesn't guarantee a `title` field -- don't hand
            # extraction an empty string.
            print(f"[{post_id}] FAILED: oEmbed succeeded but returned no caption text, nothing to extract from.")
            set_post_status(base_url, headers, post_id, "failed")
            return False
        set_post_caption(base_url, headers, post_id, caption)
        print(f"[{post_id}] fetched caption via oEmbed and saved it to the post row.")

    # Destination bias (step 12's known gap): PostgREST's embedded
    # trips(destination) from fetch_pending_posts, falling back to None for
    # a trip with no destination set -- resolve_place.py degrades to today's
    # unbiased behavior in that case.
    trip_destination = (post.get("trips") or {}).get("destination")

    # ADR 0005: fetch the video's spoken-audio transcript as a second,
    # independent text source for extraction, additive on top of caption
    # (never replacing it). Costs one ScrapeCreators credit per post when a
    # real video url is present and reachable.
    #
    # Failure-handling line drawn here, deliberately different from
    # extract.py's/resolve_place.py's own errors: transcript is NOT
    # required for the pipeline to produce a result (caption-only
    # extraction already works and always has) the way OpenAI/Places are,
    # so ANY TranscriptError -- transient, quota-exhausted, malformed, or
    # even a hard config error -- degrades this one post to caption-only
    # rather than failing the post or pausing the rest of the tick. Losing
    # the bonus signal for one post is an acceptable outcome; losing the
    # whole post, or stalling every other pending post, over a
    # non-load-bearing enrichment call is not. TranscriptOutcome.empty and
    # .not_available aren't exceptions at all (see transcript.py) -- they
    # just mean this video genuinely has no transcript to give, which is
    # the normal case for silent/music-only videos.
    transcript_text: Optional[str] = None
    url = post.get("url")
    if url:
        # Migration 20261010010000: check the cache (keyed on the
        # normalized url) before spending a ScrapeCreators credit. A short
        # link (normalize_tiktok_url -> None) skips the cache entirely --
        # see that function's docstring for why -- and falls through to
        # fetch_transcript exactly as before this change.
        normalized_url = normalize_tiktok_url(url)
        cached = get_cached_transcript(base_url, headers, normalized_url) if normalized_url else None
        if cached is not None:
            if cached["outcome"] == TranscriptOutcome.ok.value:
                transcript_text = cached["transcript_text"]
                print(
                    f"[{post_id}] transcript: cache hit, ok, "
                    f"{len(transcript_text)} chars (0 credits spent)"
                )
            else:
                print(f"[{post_id}] transcript: cache hit, {cached['outcome']} (0 credits spent)")
        else:
            try:
                result = fetch_transcript(normalized_url or url)
                if result.outcome == TranscriptOutcome.ok:
                    transcript_text = result.text
                    print(
                        f"[{post_id}] transcript: ok, {len(transcript_text)} chars "
                        f"(credits charged: {result.credits_charged})"
                    )
                else:
                    print(f"[{post_id}] transcript: {result.outcome.value} -- {result.reason}")
                if normalized_url:
                    write_transcript_cache(
                        base_url, headers, normalized_url, result.outcome.value, result.text
                    )
            except TranscriptError as e:
                print(
                    f"[{post_id}] transcript fetch failed ({type(e).__name__}: {e}) "
                    f"-- continuing caption-only."
                )
    else:
        print(f"[{post_id}] no url on this post -- skipping transcript fetch, caption-only.")

    try:
        extraction = extract_places(caption, hashtags=None, transcript=transcript_text)
        candidate_rows = []
        for place in extraction.places:
            resolved = resolve_place(
                place.name,
                place.area,
                place.confidence,
                address=place.address,
                trip_destination=trip_destination,
            )
            candidate_rows.append(
                {
                    "post_id": post_id,
                    "name": place.name,
                    "category": place.category.value,
                    "google_place_id": resolved.google_place_id,
                    "confidence": place.confidence,
                    "match_quality": resolved.match_quality.value,
                    "resolved_name": resolved.name,
                    "formatted_address": resolved.formatted_address,
                    "lat": resolved.lat,
                    "lng": resolved.lng,
                }
            )
    except _API_HEALTH_ERRORS as e:
        # Quota exhausted, or still failing after extract.py's/
        # resolve_place.py's own bounded internal retries -- the API is
        # unhealthy right now, not this one post's input. This post can't
        # be salvaged (no partial-candidate writes -- "processing
        # completed" has to mean the whole pipeline actually ran), but
        # burning through the rest of the pending queue hitting the same
        # wall would just rack up more failed calls for no new
        # information. Fail this post, then signal run_once to stop this
        # tick and let the normal poll interval be the backoff.
        print(f"[{post_id}] FAILED -- API-health error, pausing rest of this tick: {type(e).__name__}: {e}")
        set_post_status(base_url, headers, post_id, "failed")
        return True
    except (ExtractMalformedResponseError, ResolveMalformedResponseError) as e:
        # Bad-input-shaped (the model refused, or returned something we
        # couldn't use for this specific caption) -- scoped to this post.
        print(f"[{post_id}] FAILED: {type(e).__name__}: {e}")
        set_post_status(base_url, headers, post_id, "failed")
        return False
    except Exception as e:
        # Anything outside the documented error taxonomy -- a real bug, not
        # an expected failure mode. Still scoped to this post (never let one
        # post's crash take down the loop), but logged loudly since this
        # shouldn't happen.
        print(f"[{post_id}] FAILED (unexpected {type(e).__name__}): {e}")
        set_post_status(base_url, headers, post_id, "failed")
        return False

    insert_candidates(base_url, headers, candidate_rows)
    set_post_status(base_url, headers, post_id, "needs_confirmation")
    print(f"[{post_id}] done -- {len(candidate_rows)} candidate(s) written, status=needs_confirmation")
    return False


def run_once(base_url: str, headers: dict) -> int:
    """One poll tick. Returns how many posts were claimed (0 if the queue
    was empty), so main() knows whether to sleep before the next tick."""
    pending = fetch_pending_posts(base_url, headers)
    claimed = 0
    for post in pending:
        post_id = post["id"]
        if not claim_post(base_url, headers, post_id):
            continue  # already claimed by another pass -- not expected with one worker, but harmless
        claimed += 1
        print(f"[{post_id}] claimed, processing...")
        if process_post(base_url, headers, post):
            print("Pausing rest of this poll tick; will retry remaining pending posts next tick.")
            break
    return claimed


def main() -> int:
    # Windows console default codepage can't print the emoji/non-Latin text
    # that shows up in TikTok captions -- same fix as oembed_caption.py,
    # run_eval.py, test_places_connection.py.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    try:
        base_url, service_role_key = _load_config()
    except WorkerConfigError as e:
        print(f"FATAL: {e}", file=sys.stderr)
        return 1

    headers = _headers(service_role_key)
    print(f"Worker started. Polling for pending posts every {POLL_INTERVAL_SECONDS}s. Ctrl+C to stop.")

    try:
        while True:
            try:
                claimed = run_once(base_url, headers)
            except requests.exceptions.RequestException as e:
                # A Supabase/network blip on the poll query itself (not a
                # per-post error) -- log and retry next tick rather than
                # crashing the whole worker.
                print(f"Poll tick failed (network/Supabase error), will retry next tick: {e}")
                claimed = 0
            if claimed == 0:
                time.sleep(POLL_INTERVAL_SECONDS)
    except KeyboardInterrupt:
        print("\nStopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
