"""
One-time eval-set refresh: add a `transcript` field to every file in
eval/cases/ by actually calling ScrapeCreators (transcript.py) against each
case's existing `url` field. Run once, not part of the eval harness itself.

Stores the PARSED PLAIN TEXT (not raw WebVTT) in each case file, as
`transcript` -- this is what extract_places() actually consumes (run_eval.py
passes it straight through), so the case file matches production input
shape with no re-parsing step. The one-time cost of this choice: if
transcript.py's WebVTT parser changes later, these 15 real transcripts would
need re-fetching to reflect a parser fix, rather than being re-parsed for
free from stored raw VTT. Accepted deliberately -- simplicity over that
hypothetical, especially since raw VTT was already confirmed closely
following the plain documented format (see transcript.py's docstring).

IMPORTANT, confirmed by directly testing transcript.py against this eval
set before writing this script: of the 37 case files, only 15 have a real
`/@user/video/<id>` TikTok URL. The other 22 have a `/discover/<slug>` or
`/tag/<slug>` URL -- TikTok's topic/search landing pages, not a link to one
specific video. These appear to be placeholder/representative links from
whenever this eval set was originally hand-written (several captions read
like they were authored to test a specific extraction rule, not copied from
a real post) -- a pre-existing eval-set property, not something this task
introduced. ScrapeCreators' transcript endpoint cannot resolve a
non-video URL to any transcript, and confirmed directly: it doesn't fail
fast for one either -- it hangs until read-timeout (~15s), so routing all
22 through fetch_transcript() would cost ~22 * ~57s (3 attempts x 15s +
backoff, transcript.py's own bounded-retry policy) for a result already
known in advance. This script skips the API call for those 22 and records
why, rather than burning ~21 minutes for zero new information.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from transcript import TranscriptError, TranscriptOutcome, fetch_transcript

HERE = Path(__file__).parent
CASES_DIR = HERE / "eval" / "cases"

# Matches a real, specific TikTok video link -- the only shape
# ScrapeCreators' transcript endpoint can actually resolve. Anything else
# (a /discover/... or /tag/... topic page) is skipped, see module docstring.
REAL_VIDEO_URL_RE = re.compile(r"^https?://(www\.)?tiktok\.com/@[^/]+/video/\d+/?$")


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    paths = sorted(CASES_DIR.glob("*.json"))
    print(f"Found {len(paths)} case files.")

    total_credits = 0
    counts = {"ok": 0, "empty": 0, "not_available": 0, "skipped_placeholder_url": 0, "error": 0}

    for path in paths:
        with open(path, encoding="utf-8") as f:
            case = json.load(f, object_pairs_hook=dict)
        case_id = case.get("id", path.stem)
        url = case.get("url", "")

        transcript_text = ""
        note = None

        if not REAL_VIDEO_URL_RE.match(url):
            counts["skipped_placeholder_url"] += 1
            note = (
                "url is not a real /@user/video/<id> TikTok link (a "
                "/discover or /tag topic page) -- ScrapeCreators cannot "
                "resolve this to any video, so no API call was made."
            )
            print(f"[{case_id}] SKIPPED (placeholder url): {url}")
        else:
            try:
                result = fetch_transcript(url)
                total_credits += result.credits_charged
                if result.outcome == TranscriptOutcome.ok:
                    transcript_text = result.text
                    counts["ok"] += 1
                    print(
                        f"[{case_id}] OK -- {len(transcript_text)} chars "
                        f"(credits charged: {result.credits_charged})"
                    )
                elif result.outcome == TranscriptOutcome.empty:
                    counts["empty"] += 1
                    note = result.reason
                    print(f"[{case_id}] EMPTY (no spoken content): {result.reason}")
                else:  # not_available
                    counts["not_available"] += 1
                    note = result.reason
                    print(f"[{case_id}] NOT AVAILABLE: {result.reason}")
            except TranscriptError as e:
                counts["error"] += 1
                note = f"fetch failed: {type(e).__name__}: {e}"
                print(f"[{case_id}] ERROR (not fetched): {e}")

        # Rebuild the dict preserving key order, inserting transcript (and
        # transcript_note, only when there's something to explain) right
        # before `expected` so the file reads caption -> hashtags ->
        # transcript -> expected, matching what extract_places() consumes.
        new_case = {}
        for k, v in case.items():
            if k == "expected":
                new_case["transcript"] = transcript_text
                if note:
                    new_case["transcript_note"] = note
            new_case[k] = v
        if "expected" not in case:
            new_case["transcript"] = transcript_text
            if note:
                new_case["transcript_note"] = note

        with open(path, "w", encoding="utf-8") as f:
            json.dump(new_case, f, indent=2, ensure_ascii=False)
            f.write("\n")

    print(f"\nDone. Total ScrapeCreators credits charged: {total_credits}")
    print(f"Outcome counts: {counts}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
