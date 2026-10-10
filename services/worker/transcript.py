"""
ADR 0005: fetch a TikTok video's spoken-audio transcript from ScrapeCreators,
additive on top of oEmbed's caption (see
docs/decisions/0005-scrapecreators-for-transcripts.md for the full
reasoning/tradeoffs, and 0004 for the no-scraping decision this supersedes).

Pipeline position: part of "gather", alongside oEmbed in worker.py --
caption and transcript are two independent text sources extract.py now
reasons over together (see extract.py's SYSTEM_PROMPT). This module only
fetches+parses one video's transcript given its URL; it doesn't call
extract.py and doesn't touch the database.

normalize_tiktok_url also lives here, not worker.py: it's pure "what shape
is a TikTok video URL" knowledge (same knowledge this module's docstring and
oembed_caption.py's validate_tiktok_url already encode), not a database
concern. worker.py imports it to build the tiktok_transcript_cache key
(migration 20261010010000) before every cache read/write; this module's own
fetch_transcript() also normalizes before calling ScrapeCreators, see its
docstring for why.

API (confirmed working, see test_scrapecreators_connection.py):
    GET https://api.scrapecreators.com/v1/tiktok/video/transcript
    Headers: x-api-key
    Query params: url (required), language (optional, 2-letter code),
        use_ai_as_fallback (optional, 'true'/'false' -- AI transcription
        when no native transcript exists, +10 credits, only for videos
        under 2 minutes)
    Response: {success, credits_remaining, credits_charged, id, url,
        transcript} -- transcript is WebVTT (cue timestamps + text).

WebVTT is a subtitle format: a "WEBVTT" header line, then repeated blocks of
a timing line ("00:00:00.080 --> 00:00:03.540") followed by one or more
lines of cue text, separated by blank lines. parse_webvtt_to_text strips the
header/timing/blank lines and keeps just the spoken text -- timestamps are
pure noise for place extraction and would waste LLM tokens for nothing.

Documented error responses: 400, 403, 404, 500 -- no documented error body
format, so these are handled generically (status code only), except where
noted below. No documented rate limit; 429 is handled defensively the same
as a 5xx anyway.
"""

from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass
from enum import Enum
from typing import Optional

import requests
from dotenv import load_dotenv

TRANSCRIPT_ENDPOINT = "https://api.scrapecreators.com/v1/tiktok/video/transcript"
REQUEST_TIMEOUT_SECONDS = 15

# Matches the stable https://www.tiktok.com/@<user>/video/<id> shape -- a
# prefix match (not anchored at the end), so trailing query-string noise
# (?is_from_webapp=1&sender_device=pc etc, see this repo's eval cases and
# the cache migration's own comment) is simply never captured, not stripped
# via a second step.
_CANONICAL_URL_RE = re.compile(r"^https?://(?:www\.)?tiktok\.com/@([\w.\-]+)/video/(\d+)")


def normalize_tiktok_url(url: Optional[str]) -> Optional[str]:
    """Returns the stable "https://www.tiktok.com/@<user>/video/<id>" form
    of a TikTok video URL -- query string, scheme casing, and www/mobile
    host variants collapsed away -- or None if `url` doesn't match that
    shape at all.

    Decision on short links (vm.tiktok.com/vt.tiktok.com), stated per the
    task that added this: these redirect to the real @user/video/<id> URL
    but don't carry it themselves, and resolving that would mean an extra
    HTTP call (a redirect-follow) before every cache lookup -- real added
    latency and complexity for what's a secondary share path (most shares
    this app sees are already-expanded app-share links, not short links).
    So: short links return None here, which callers (worker.py) treat as
    "skip the cache for this URL" -- it still gets fetched from
    ScrapeCreators normally, just never cached or cache-checked, so the
    cache-hit rate for that URL shape is simply worse, not broken.
    """
    if not url:
        return None
    match = _CANONICAL_URL_RE.match(url.strip())
    if not match:
        return None
    username, video_id = match.groups()
    return f"https://www.tiktok.com/@{username}/video/{video_id}"

# Same bounded-retry policy/values as extract.py/resolve_place.py -- kept as
# a separate copy, same reasoning as resolve_place.py's own comment on this
# (unrelated APIs, nothing to share but the two numbers).
MAX_TRANSIENT_RETRIES = 2
RETRY_BACKOFF_SECONDS = [3, 9]


class TranscriptOutcome(str, Enum):
    ok = "ok"  # non-empty spoken text was parsed out
    # Success, but genuinely nothing to transcribe (music-only/silent video,
    # or ScrapeCreators has nothing) -- a real, expected outcome per the
    # task that commissioned this module, not an error.
    empty = "empty"
    # ScrapeCreators couldn't produce a transcript for THIS specific video
    # (couldn't resolve the URL to an actual video, private/geo-blocked,
    # etc). Video-specific, not an API-health problem -- the caller should
    # degrade to caption-only, not treat this as a failure.
    not_available = "not_available"


@dataclass
class TranscriptResult:
    outcome: TranscriptOutcome
    text: str = ""  # plain text, "" for empty/not_available
    raw_vtt: str = ""
    credits_charged: int = 0
    reason: str = ""


class TranscriptError(Exception):
    """Base class for all transcript-fetch failures. Also raised directly
    for a non-retryable problem that isn't clearly video-specific (e.g. a
    403 with no quota-looking body, which could be a bad/revoked API key --
    a real config problem affecting every future call, not just this
    video). Per CLAUDE.md's debugging rule: fail loud with a clear message
    rather than letting a raw requests/JSON exception escape unlabeled."""


class TransientTranscriptError(TranscriptError):
    """Safe to retry with backoff: a dropped connection, a timeout, a 5xx,
    or an (undocumented) 429. Not safe to retry forever -- see
    MAX_TRANSIENT_RETRIES."""


class QuotaExhaustedTranscriptError(TranscriptError):
    """Credits exhausted. Not this-video's problem -- every other call this
    batch would fail the same way, so the caller should stop spending
    calls on transcript entirely rather than keep hammering a wall, same
    pattern as extract.py/resolve_place.py's own QuotaExhaustedError."""


class MalformedTranscriptResponseError(TranscriptError):
    """200 OK but the body didn't have the shape we need, or success:false
    with no documented reason given. Bad-input/vendor-shaped, not
    transient -- fail fast rather than retry pointlessly."""


def parse_webvtt_to_text(vtt: str) -> str:
    """Strips WebVTT down to plain spoken text: drops the WEBVTT header,
    cue-numbering lines, blank lines, and '-->' timing lines; keeps
    everything else, joined with single spaces. Deliberately simple, not a
    full WebVTT parser -- ScrapeCreators' actual output is plain cues with
    no styling cues or speaker tags (see this module's docstring), and the
    task that commissioned this only asked for exactly that shape to be
    handled."""
    lines = []
    for raw_line in (vtt or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.upper().startswith("WEBVTT"):
            continue
        if "-->" in line:
            continue
        if line.isdigit():  # optional numeric cue-index line
            continue
        lines.append(line)
    return " ".join(lines)


def _is_quota_body(text: str) -> bool:
    text = text.lower()
    return "credit" in text or "quota" in text or "insufficient" in text


def _api_key() -> str:
    load_dotenv()
    key = os.environ.get("SCRAPECREATORS_API_KEY")
    if not key:
        raise TranscriptError(
            "SCRAPECREATORS_API_KEY is not set. Check services/worker/.env."
        )
    return key


def fetch_transcript(
    url: str,
    *,
    language: Optional[str] = None,
    use_ai_as_fallback: bool = False,
    api_key: Optional[str] = None,
) -> TranscriptResult:
    """Fetch and parse one TikTok video's transcript. Never raises for a
    normal "nothing here" outcome -- TranscriptOutcome.empty (no spoken
    content) and .not_available (ScrapeCreators couldn't resolve/access
    this specific video -- e.g. the url isn't a real @user/video/<id> link,
    or the video is private/geo-blocked) are both ordinary return values,
    not exceptions. Only an actual API/transport failure raises a
    TranscriptError subclass (see classes above) -- see worker.py for how
    callers are expected to treat each case.

    use_ai_as_fallback defaults OFF: per ScrapeCreators' docs this costs
    +10 credits on top of the base call (11 total instead of 1) and only
    applies to videos under 2 minutes. That's an 11x per-call cost increase
    specifically for videos with no native transcript -- a real cost
    decision, not a detail, so it stays off by default here rather than
    silently always-on. Pass True explicitly per-call if/when the developer
    decides the extra coverage is worth the extra cost.

    Sends the normalized form of `url` to ScrapeCreators when it matches
    the canonical @user/video/<id> shape (falls back to the raw `url` for
    short links/anything else normalize_tiktok_url can't parse -- see that
    function). ScrapeCreators needs the @user/video/<id> path to identify
    the video; the tracking query params that normalization strips
    (?is_from_webapp=1 etc) are TikTok-webapp noise it has no documented
    use for, so stripping them costs nothing and keeps the exact URL this
    function sends in sync with the one worker.py uses as the cache key --
    one fewer thing that can silently drift between the two.
    """
    key = api_key or _api_key()
    url = normalize_tiktok_url(url) or url
    params = {"url": url}
    if language:
        params["language"] = language
    if use_ai_as_fallback:
        params["use_ai_as_fallback"] = "true"

    attempt = 0
    while True:
        try:
            response = requests.get(
                TRANSCRIPT_ENDPOINT,
                headers={"x-api-key": key},
                params=params,
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
            if attempt >= MAX_TRANSIENT_RETRIES:
                raise TransientTranscriptError(
                    f"Still unable to reach ScrapeCreators after "
                    f"{MAX_TRANSIENT_RETRIES} retries (url={url!r}): {e}"
                ) from e
            time.sleep(RETRY_BACKOFF_SECONDS[attempt])
            attempt += 1
            continue

        if response.status_code == 200:
            try:
                body = response.json()
            except ValueError as e:
                raise MalformedTranscriptResponseError(
                    f"200 OK but body wasn't valid JSON (url={url!r}): "
                    f"{response.text[:300]}"
                ) from e
            if not body.get("success"):
                raise MalformedTranscriptResponseError(
                    f"200 OK but success=false, no documented reason given "
                    f"(url={url!r}): {body}"
                )
            raw_vtt = body.get("transcript") or ""
            text = parse_webvtt_to_text(raw_vtt)
            credits = body.get("credits_charged") or 0
            if not text.strip():
                return TranscriptResult(
                    outcome=TranscriptOutcome.empty,
                    raw_vtt=raw_vtt,
                    credits_charged=credits,
                    reason=(
                        "ScrapeCreators returned a transcript with no "
                        "spoken text (music-only/silent video, or "
                        "genuinely nothing to transcribe)"
                    ),
                )
            return TranscriptResult(
                outcome=TranscriptOutcome.ok,
                text=text,
                raw_vtt=raw_vtt,
                credits_charged=credits,
            )

        if response.status_code in (400, 404):
            # Video-specific, not an API-health problem: most commonly the
            # url isn't a real, specific video ScrapeCreators can resolve
            # (a TikTok discover/tag/search page, not an @user/video/<id>
            # link), or the video is private/deleted/unreachable to the
            # scraper. Degrade gracefully -- don't raise.
            return TranscriptResult(
                outcome=TranscriptOutcome.not_available,
                reason=(
                    f"ScrapeCreators returned {response.status_code} for "
                    f"this url (url={url!r}): {response.text[:300]}"
                ),
            )

        if response.status_code == 403:
            body_text = response.text
            if _is_quota_body(body_text):
                raise QuotaExhaustedTranscriptError(
                    f"ScrapeCreators credits exhausted (403, url={url!r}): "
                    f"{body_text[:300]}"
                )
            # No documented body format for a non-quota 403. Could be a
            # bad/revoked API key (a real config problem that would also
            # break every future call, not just this video) or a
            # video-specific block (private/geo-restricted) -- the response
            # alone can't distinguish them. Raise loud rather than guess:
            # worker.py treats ANY TranscriptError as this-post-only (see
            # its module docstring), so the cost of raising here instead of
            # degrading is bounded to one extra log line, not a retry storm
            # or a paused batch.
            raise TranscriptError(
                f"ScrapeCreators returned 403 (url={url!r}): {body_text[:300]}"
            )

        if response.status_code == 429 or response.status_code >= 500:
            if attempt >= MAX_TRANSIENT_RETRIES:
                raise TransientTranscriptError(
                    f"Still getting HTTP {response.status_code} from "
                    f"ScrapeCreators after {MAX_TRANSIENT_RETRIES} retries "
                    f"(url={url!r}): {response.text[:300]}"
                )
            time.sleep(RETRY_BACKOFF_SECONDS[attempt])
            attempt += 1
            continue

        raise TranscriptError(
            f"ScrapeCreators returned unexpected HTTP {response.status_code} "
            f"(url={url!r}): {response.text[:300]}"
        )


if __name__ == "__main__":
    # Tiny manual smoke test, same style as extract.py/resolve_place.py's
    # own __main__ blocks -- one real call against a URL already confirmed
    # reachable (test_scrapecreators_connection.py), so this can be
    # sanity-checked without spending extra credits on a new case.
    import sys

    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    # Self-check for normalize_tiktok_url -- no network, no cost. Covers
    # the cases this function exists for: tracking-param noise stripped,
    # already-canonical passthrough, and the short-link "give up" case.
    assert normalize_tiktok_url(
        "https://www.tiktok.com/@foo/video/123?is_from_webapp=1&sender_device=pc"
    ) == "https://www.tiktok.com/@foo/video/123"
    assert normalize_tiktok_url("https://www.tiktok.com/@foo/video/123") == (
        "https://www.tiktok.com/@foo/video/123"
    )
    assert normalize_tiktok_url("https://vm.tiktok.com/ZMabcdefg/") is None
    assert normalize_tiktok_url(None) is None
    print("normalize_tiktok_url self-check passed.")

    TEST_URL = "https://www.tiktok.com/@showerwithspongebob/video/7351432562931191083"
    result = fetch_transcript(TEST_URL)
    print(f"outcome={result.outcome.value} credits_charged={result.credits_charged}")
    print(f"text[:300]={result.text[:300]!r}")
