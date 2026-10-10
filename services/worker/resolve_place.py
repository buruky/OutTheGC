"""
Step 12 of the OutTheGC build: resolve an extracted name+area (step 11's
ExtractedPlace shape, see extract.py) to a real place via Places API (New)
Text Search.

Pipeline position (OutTheGC-spec.md): gather -> extract (extract.py) ->
resolve (this file) -> write post_candidates -> set posts.status. This file
does NOT write to Supabase -- that's step 14. It does not run a job loop --
that's step 13.

Text Search (New): POST https://places.googleapis.com/v1/places:searchText
with a free-text query and an API key header, same shape proven in
test_places_connection.py. X-Goog-FieldMask is kept to exactly
id,displayName,formattedAddress,location -- per the task, these three bill
under Places' "Pro" SKU (5,000 free calls/month); adding fields like
rating/photos/currentOpeningHours would push the call into a pricier SKU,
so nothing else is requested.

The real work here, per the roadmap's "Learn" line for this step, is
deciding whether a result is a CONFIDENT match or not -- "Extraction never
auto-pins" (root CLAUDE.md) means a shaky match must be distinguishable from
a solid one, not presented the same way. Two independent signals feed that
call: (1) how closely the resolved place's name matches the name we
searched for, and (2) step 11's own extraction confidence for that
candidate -- a vague extraction can still accidentally text-match a real
place by coincidence, so a low extraction confidence caps the result at
LOW_CONFIDENCE even if Places' name matches well.

Step 14 adds an optional trip_destination param, biasing the search query
toward the trip's own destination (free-text append, not a geocoded
locationBias) -- see resolve_place()'s own docstring for why and the real
failure case it closes.
"""

from __future__ import annotations

import difflib
import os
import re
import time
from dataclasses import dataclass
from enum import Enum
from typing import Optional

import requests
from dotenv import load_dotenv

FIELD_MASK = "places.id,places.displayName,places.formattedAddress,places.location"
TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"

# Same bounded-retry policy/values as extract.py's MAX_TRANSIENT_RETRIES /
# RETRY_BACKOFF_SECONDS -- kept as a separate copy rather than a shared
# import since the two files call unrelated APIs and the only thing in
# common is the two numbers themselves.
MAX_TRANSIENT_RETRIES = 2
RETRY_BACKOFF_SECONDS = [3, 9]

# Secondary confidence floor applied here, on top of extract.py's own
# MIN_CONFIDENCE=0.55 floor (which already dropped anything below that
# before a candidate ever reaches this function). Chosen from the real
# spread of extraction confidences across the eval's 46 extracted places
# (see handback report): two genuine outliers at 0.63/0.66 (one had a
# mangled accented character, one a terse all-caps brand), then a clear
# jump to 0.84 and a tight cluster at 0.9+. 0.75 sits in that gap -- it
# flags the two real outliers as "extraction itself was shaky" without
# penalizing the much larger confident cluster. Revisit if the eval set
# grows and a legitimate case lands between 0.66 and 0.84.
EXTRACTION_CONFIDENCE_FLOOR_FOR_CONFIDENT = 0.75

# How closely the resolved displayName must match the name we searched for
# to count as a real identity match rather than a coincidental text hit.
NAME_SIMILARITY_FLOOR = 0.6


class MatchQuality(str, Enum):
    confident = "confident"
    low_confidence = "low_confidence"
    no_match = "no_match"
    # No API call was made at all -- there was no name AND no address to
    # search for (genuinely nothing identifiable -- vague hype with zero
    # location signal). Searching on area alone would return something --
    # just not reliably the actual place -- so this is surfaced as its own
    # outcome instead of either skipping silently or spending a call on a
    # query with no identifying signal. When an address IS present (step
    # 11's address-only case), resolve_place searches on it instead of
    # hitting this branch -- see resolve_place's docstring.
    skipped_no_name = "skipped_no_name"


@dataclass
class ResolvedPlace:
    match_quality: MatchQuality
    reason: str
    query: Optional[str] = None  # the exact textQuery sent, for debugging
    google_place_id: Optional[str] = None
    name: Optional[str] = None
    formatted_address: Optional[str] = None
    lat: Optional[float] = None
    lng: Optional[float] = None


class ResolutionError(Exception):
    """Base class for all resolution failures. Also raised directly for
    non-retryable failures (bad request, auth/permission problems) --
    per CLAUDE.md's debugging rule, fail fast rather than retry pointlessly."""


class TransientResolutionError(ResolutionError):
    """Safe to retry with backoff: a dropped connection, a timeout, a
    5xx. Not safe to retry forever -- see MAX_TRANSIENT_RETRIES."""


class QuotaExhaustedError(ResolutionError):
    """429 (RESOURCE_EXHAUSTED) that didn't clear after MAX_TRANSIENT_RETRIES.
    Places' error body doesn't distinguish a per-minute throttle from a
    billing/daily cap the way OpenAI's does (extract.py's
    _is_daily_or_quota_limit) -- so a 429 gets the benefit of the doubt and
    a bounded retry first, but if it's still 429 after that, it's treated
    as a wall worth stopping the whole batch for, not something to keep
    hammering call-by-call."""


class MalformedResponseError(ResolutionError):
    """200 OK but the JSON didn't have the shape we need (missing id or
    location on the top result). Bad-input-shaped, not transient."""


def _normalize_name(name: str) -> str:
    # Same approach as run_eval.py's _normalize_name (Unicode-aware \w so
    # non-Latin scripts survive instead of collapsing to ""), copied here
    # rather than imported since that function lives in the eval harness,
    # not production code this runs as part of.
    text = name.lower()
    text = re.sub(r"[^\w\s]", "", text, flags=re.UNICODE)
    return re.sub(r"\s+", " ", text).strip()


def _names_look_related(a: str, b: str) -> bool:
    na, nb = _normalize_name(a), _normalize_name(b)
    if not na or not nb:
        return False
    if na in nb or nb in na:
        return True
    if set(na.split()) == set(nb.split()):
        return True
    return difflib.SequenceMatcher(None, na, nb).ratio() >= NAME_SIMILARITY_FLOOR


def _api_key() -> str:
    load_dotenv()
    key = os.environ.get("GOOGLE_PLACES_API_KEY")
    if not key:
        raise ResolutionError(
            "GOOGLE_PLACES_API_KEY is not set. Check services/worker/.env."
        )
    return key


def _search_text(query: str, *, api_key: str) -> dict:
    """POSTs the Text Search request with bounded retry on transient
    failures (timeout, connection error, 5xx, 429). Returns the parsed JSON
    body on success; raises a ResolutionError subclass otherwise."""
    attempt = 0
    while True:
        try:
            response = requests.post(
                TEXT_SEARCH_URL,
                headers={
                    "Content-Type": "application/json",
                    "X-Goog-Api-Key": api_key,
                    "X-Goog-FieldMask": FIELD_MASK,
                },
                json={"textQuery": query},
                timeout=10,
            )
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
            if attempt >= MAX_TRANSIENT_RETRIES:
                raise TransientResolutionError(
                    f"Still unable to reach Places API after "
                    f"{MAX_TRANSIENT_RETRIES} retries (query={query!r}): {e}"
                ) from e
            time.sleep(RETRY_BACKOFF_SECONDS[attempt])
            attempt += 1
            continue

        if response.status_code == 200:
            return response.json()

        if response.status_code == 429:
            if attempt >= MAX_TRANSIENT_RETRIES:
                raise QuotaExhaustedError(
                    f"Still rate-limited (429) after {MAX_TRANSIENT_RETRIES} "
                    f"retries (query={query!r}): {response.text[:300]}"
                )
            time.sleep(RETRY_BACKOFF_SECONDS[attempt])
            attempt += 1
            continue

        if response.status_code >= 500:
            if attempt >= MAX_TRANSIENT_RETRIES:
                raise TransientResolutionError(
                    f"Still getting {response.status_code} after "
                    f"{MAX_TRANSIENT_RETRIES} retries (query={query!r}): "
                    f"{response.text[:300]}"
                )
            time.sleep(RETRY_BACKOFF_SECONDS[attempt])
            attempt += 1
            continue

        # 400/401/403/404/etc -- bad request, bad/missing key, or a
        # permission problem. Not transient; retrying spends calls for the
        # same outcome.
        raise ResolutionError(
            f"Places API returned {response.status_code} for query "
            f"{query!r}: {response.text[:300]}"
        )


def resolve_place(
    name: Optional[str],
    area: Optional[str],
    extraction_confidence: float,
    *,
    address: Optional[str] = None,
    trip_destination: Optional[str] = None,
    api_key: Optional[str] = None,
) -> ResolvedPlace:
    """Resolve one extracted name+area to a real place. Never raises for a
    normal "didn't find it" outcome -- that's MatchQuality.no_match, not an
    exception. Raises a ResolutionError subclass only for an actual API/
    transport failure (see classes above).

    address (closing the gap found in live testing, see handback report):
    extract.py's rule 2 (a genuine street address, no business name) now
    carries the actual address text separately from the coarse `area`
    field. When name is None but address is present, search Places on the
    address text itself rather than skipping -- an address is a strong,
    specific Text Search query on its own, unlike a bare neighborhood/city
    area. Only when BOTH name and address are absent (genuinely nothing
    identifiable) does this still skip with no API call.

    trip_destination (step 14, closing step 12's known gap): the trip's own
    destination text (trips.destination, e.g. "Tokyo"), appended to the
    search query when present. Demonstrated real failure this fixes: a
    caption with zero location signal ("EL REY DEL PASTOR," no stated city)
    resolved CONFIDENT to an unrelated same-named restaurant in Buford, GA
    instead of the actual Mexico City one. Deliberately just appended to the
    free-text query, not turned into Text Search's `locationBias`/
    `regionCode` params -- that needs the destination geocoded to
    coordinates first (another API call, more complexity) for a gain this
    simpler approach already covers: a query with some location signal in it
    beats one with none, which is exactly the demonstrated failure. None
    (trips don't require a destination) degrades to today's behavior
    unchanged -- no bias applied, not an error."""
    if not name and not address:
        return ResolvedPlace(
            match_quality=MatchQuality.skipped_no_name,
            reason=(
                "extraction had neither a name nor an address -- nothing "
                "specific enough to search for -- no API call made"
            ),
        )

    # Address-only candidate (extract.py rule 2): search on the address
    # text itself, not the coarse `area` -- a street address is a strong,
    # specific Text Search query on its own.
    search_term = name or address
    query_parts = [search_term]
    if area:
        query_parts.append(area)
    if trip_destination:
        query_parts.append(trip_destination)
    query = ", ".join(query_parts)
    key = api_key or _api_key()
    body = _search_text(query, api_key=key)

    places = body.get("places", [])
    if not places:
        return ResolvedPlace(
            match_quality=MatchQuality.no_match,
            reason="Places Text Search returned zero results for this query",
            query=query,
        )

    top = places[0]
    place_id = top.get("id")
    resolved_name = top.get("displayName", {}).get("text")
    location = top.get("location") or {}
    lat, lng = location.get("latitude"), location.get("longitude")
    if not place_id or lat is None or lng is None:
        raise MalformedResponseError(
            f"Top result for query {query!r} is missing id/location: {top!r}"
        )

    if name:
        name_ok = bool(resolved_name) and _names_look_related(name, resolved_name)
    else:
        # No business name was ever extracted, so there's nothing to
        # compare resolved_name against -- the address text itself was the
        # identity signal, and Places already resolved it to a specific,
        # located place. Confidence still gates on extraction_confidence
        # below (rule 2 only fires on a genuinely concrete address, so this
        # isn't a free pass for a vague query).
        name_ok = True
    confidence_ok = extraction_confidence >= EXTRACTION_CONFIDENCE_FLOOR_FOR_CONFIDENT

    if name_ok and confidence_ok:
        quality = MatchQuality.confident
        reason = (
            "resolved name matches the searched name and extraction confidence was high"
            if name
            else "resolved from a concrete address and extraction confidence was high"
        )
    else:
        quality = MatchQuality.low_confidence
        problems = []
        if not name_ok:
            problems.append(
                f"resolved name {resolved_name!r} doesn't look related to searched name {name!r}"
            )
        if not confidence_ok:
            problems.append(
                f"extraction confidence {extraction_confidence:g} was below "
                f"the {EXTRACTION_CONFIDENCE_FLOOR_FOR_CONFIDENT:g} floor for a confident match"
            )
        reason = "; ".join(problems)

    return ResolvedPlace(
        match_quality=quality,
        reason=reason,
        query=query,
        google_place_id=place_id,
        name=resolved_name,
        formatted_address=top.get("formattedAddress"),
        lat=lat,
        lng=lng,
    )


if __name__ == "__main__":
    # Tiny manual smoke test, same style as extract.py's __main__ -- one
    # hardcoded real call so the function can be sanity-checked without
    # spending a full batch run. The real 37-case test is run_resolve_test.py.
    import sys

    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    result = resolve_place("RuRu Shibuya", "Shibuya, Tokyo, Japan", 0.98)
    print(result)
