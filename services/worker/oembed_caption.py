"""
Step 10 of the OutTheGC build: the first piece of the processing pipeline,
standalone and outside the app.

Takes one or more TikTok URLs, calls TikTok's oEmbed endpoint for each, and
prints the caption and author. No database, no job queue, no LLM yet -- those
are later steps (11-14). This script's only job is: given a link, can we get
text back from TikTok at all?

Usage:
    python oembed_caption.py <tiktok-url> [<tiktok-url> ...]

Example:
    python oembed_caption.py https://www.tiktok.com/@someaccount/video/1234567890123456789
"""

import argparse
import json
import sys
from urllib.parse import quote, urlparse

import requests

OEMBED_ENDPOINT = "https://www.tiktok.com/oembed"

# oEmbed (https://oembed.com/) is an open spec a lot of sites implement so
# other sites can show a rich preview of a link without scraping the page --
# "give me this URL's embeddable version as JSON." TikTok's implementation is
# public and keyless: no API key, no auth, just a GET request with the
# video's URL as a query param. That's exactly why this is step 10 and not a
# later step -- it's the simplest possible way to get real data out of a
# TikTok link.
#
# A browser-facing "title" on a TikTok video page is the caption text the
# poster wrote, not a separate title field (TikTok doesn't have a concept of
# a video "title" distinct from the caption) -- so oEmbed's generic `title`
# field is where that caption text ends up. `author_name` is the account's
# display name.

# requests.get defaults to *no timeout*, which means a hung connection would
# block forever -- not acceptable even in a throwaway script. 10 seconds is
# generous for a single small JSON response.
REQUEST_TIMEOUT_SECONDS = 10


class OEmbedError(Exception):
    """Raised for any failure we want to report with a clear message instead
    of a raw stack trace: bad input, a 404/private video, or a network
    problem. Callers catch this one type and print str(e)."""


def validate_tiktok_url(url: str) -> None:
    """Fail fast on obviously malformed or non-TikTok input, before making a
    network call. Catching this early means a typo'd URL costs nothing, not
    even a wasted HTTP request."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise OEmbedError(f"'{url}' doesn't look like a valid URL.")
    # tiktok.com and its subdomains (www.tiktok.com, vm.tiktok.com for short
    # links, etc.) are all fine -- just reject anything clearly not TikTok.
    if "tiktok.com" not in parsed.netloc:
        raise OEmbedError(
            f"'{url}' doesn't look like a TikTok URL (host was '{parsed.netloc}')."
        )


def fetch_oembed(url: str) -> dict:
    """Call TikTok's oEmbed endpoint for one URL and return the parsed JSON.
    Raises OEmbedError with a human-readable message for every failure mode
    worth distinguishing: bad input, a 404 (private/deleted/not found),
    some other non-200 response, a network failure, or a response that
    claims success but isn't valid/expected JSON."""
    validate_tiktok_url(url)

    # The video URL has to be the value of a query param, so it must be
    # percent-encoded (e.g. the ':' and '/' in "https://..." would otherwise
    # be read as part of the oEmbed request's own URL structure).
    request_url = f"{OEMBED_ENDPOINT}?url={quote(url, safe='')}"

    try:
        response = requests.get(request_url, timeout=REQUEST_TIMEOUT_SECONDS)
    except requests.exceptions.Timeout as e:
        raise OEmbedError(
            f"Request to TikTok timed out after {REQUEST_TIMEOUT_SECONDS}s."
        ) from e
    except requests.exceptions.ConnectionError as e:
        raise OEmbedError(
            "Network error -- couldn't reach TikTok. Check your internet connection."
        ) from e
    except requests.exceptions.RequestException as e:
        # Catch-all for anything else requests can raise (redirect loops,
        # malformed response line, etc.) -- still want our message, not theirs.
        raise OEmbedError(f"Request to TikTok failed: {e}") from e

    if response.status_code == 404:
        # This is the realistic "private or deleted video" case: TikTok's
        # oEmbed endpoint 404s rather than returning a JSON error body for
        # videos it won't embed.
        raise OEmbedError(
            f"TikTok returned 404 for this URL -- the video may be private, "
            f"deleted, or the link is wrong.\nURL: {url}"
        )
    if response.status_code != 200:
        raise OEmbedError(
            f"TikTok returned HTTP {response.status_code} (expected 200).\n"
            f"URL: {url}\nResponse body: {response.text[:300]}"
        )

    try:
        return response.json()
    except json.JSONDecodeError as e:
        # A 200 that isn't valid JSON would be unexpected, but "handle and
        # log malformed responses explicitly, don't let a json.loads
        # exception silently fail the whole job" is the standing rule for
        # this pipeline from step 10 onward, so it applies here too.
        raise OEmbedError(
            f"TikTok returned a 200 but the body wasn't valid JSON.\n"
            f"Raw body: {response.text[:300]}"
        ) from e


def print_caption(url: str, data: dict) -> None:
    # oEmbed's spec guarantees neither field; be explicit if TikTok's
    # response is missing one rather than printing "None" silently.
    caption = data.get("title", "<no caption found in response>")
    author = data.get("author_name", "<no author found in response>")
    print(f"URL:     {url}")
    print(f"Author:  {author}")
    print(f"Caption: {caption}")


def main() -> int:
    # TikTok captions are full of emoji. Windows terminals often default to
    # a legacy codepage (cp1252) that can't encode them, which would crash
    # print() with a raw UnicodeEncodeError -- exactly the kind of
    # unhandled failure this step is supposed to avoid. Force UTF-8 on
    # stdout/stderr; `errors="replace"` swaps any still-unprintable
    # character for "?" instead of crashing. reconfigure() needs Python
    # 3.7+, which this project already assumes.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(
        description="Fetch caption + author for one or more TikTok URLs via oEmbed."
    )
    parser.add_argument(
        "urls",
        nargs="+",
        help="One or more TikTok video URLs (space-separated).",
    )
    args = parser.parse_args()

    succeeded = 0
    failed = 0
    for i, url in enumerate(args.urls):
        if i > 0:
            print()  # blank line between entries when running multiple URLs
        try:
            data = fetch_oembed(url)
            print_caption(url, data)
            succeeded += 1
        except OEmbedError as e:
            print(f"FAILED: {e}", file=sys.stderr)
            failed += 1

    if len(args.urls) > 1:
        print(f"\n{succeeded} succeeded, {failed} failed out of {len(args.urls)}.")

    # Non-zero exit if everything failed, so this is scriptable later
    # (e.g. a CI smoke test) without parsing printed text.
    return 0 if succeeded > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
