"""
Step 12 end-to-end test harness: feeds every real extracted place from
step 11's saved eval run through resolve_place(), one Places Text Search
call per extracted place.

Reuses eval/runs/20261009T183129Z-rescored.json's `extracted` field (the
real gpt-5.4-mini v3-prompt output for all 37 cases) instead of re-calling
extract_places() -- per the task, no need to re-spend OpenAI calls to test
the resolution half of the pipeline. This is still the realistic
caption -> extraction -> resolution shape, just with the extraction half
already paid for and saved.

Not a scored eval like run_eval.py -- step 12's done-when is "captions
resolve to real places with coordinates," a sanity spot-check, not a
numeric rubric. This just prints a clear per-case result.
"""

import json
import sys
import time
from pathlib import Path

from resolve_place import MatchQuality, resolve_place

HERE = Path(__file__).parent
RUN_FILE = HERE / "eval" / "runs" / "20261009T183129Z-rescored.json"

# Places API (New) doesn't publish a strict free-tier RPM the way the
# OpenAI dashboard did for extract.py -- this is just politeness spacing to
# avoid bursting 46 calls in a couple seconds, not a measured limit.
SECONDS_BETWEEN_CALLS = 0.5


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    with open(RUN_FILE, encoding="utf-8") as f:
        run = json.load(f)

    cases = [r for r in run["results"] if r.get("extracted") is not None]
    total_places = sum(len(r["extracted"]) for r in cases)
    print(
        f"Resolving {total_places} extracted place(s) across {len(cases)} "
        f"case(s) from {RUN_FILE.name}. Zero OpenAI calls (reusing saved "
        f"extraction output); up to {total_places} Google Places calls "
        f"(fewer if any candidate has name=None, which is skipped)."
    )

    counts = {q: 0 for q in MatchQuality}
    first_call = True

    for case in cases:
        case_id = case["case_id"]
        extracted = case["extracted"]
        if not extracted:
            continue
        print(f"\n[{case_id}] {len(extracted)} candidate(s)")
        for p in extracted:
            if not first_call:
                time.sleep(SECONDS_BETWEEN_CALLS)
            first_call = False

            try:
                result = resolve_place(p["name"], p["area"], p["confidence"])
            except Exception as e:
                print(f"  - EXTRACTED name={p['name']!r} area={p['area']!r}")
                print(f"    RESOLVE ERROR: {type(e).__name__}: {e}")
                continue

            counts[result.match_quality] += 1
            print(f"  - EXTRACTED name={p['name']!r} area={p['area']!r} confidence={p['confidence']}")
            print(f"    query sent: {result.query!r}")
            if result.match_quality == MatchQuality.skipped_no_name:
                print(f"    SKIPPED: {result.reason}")
            elif result.match_quality == MatchQuality.no_match:
                print(f"    NO MATCH: {result.reason}")
            else:
                tag = "CONFIDENT" if result.match_quality == MatchQuality.confident else "LOW CONFIDENCE"
                print(f"    {tag}: {result.name!r} | {result.formatted_address}")
                print(f"    coords: {result.lat}, {result.lng}")
                print(f"    why: {result.reason}")

    print("\n--- Summary ---")
    for q in MatchQuality:
        print(f"{q.value}: {counts[q]}")


if __name__ == "__main__":
    sys.exit(main() or 0)
