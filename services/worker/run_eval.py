"""
Eval runner for OutTheGC's extraction step (roadmap step 11), per the
extraction-eval skill (.claude/skills/extraction-eval/SKILL.md).

Runs extract.extract_places() against every case file in eval/cases/,
scores each one, prints a per-case result line, writes the full run to
eval/runs/<timestamp>.json, and appends one line to eval/log.md.

Usage:
    python run_eval.py [--notes "what changed"] [--limit N] [--case-id ID]

--limit N restricts the run to the first N case files (sorted by filename) --
for cheap manual iteration against a handful of cases instead of spending
a full run on every prompt tweak.
--case-id ID runs exactly one case by its "id" field (or filename prefix).
"""

from __future__ import annotations

import argparse
import difflib
import json
import re
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from extract import (
    MODEL,
    ExtractionError,
    MalformedResponseError,
    QuotaExhaustedError,
    TransientExtractionError,
    _client,
    extract_places,
)

HERE = Path(__file__).parent
CASES_DIR = HERE / "eval" / "cases"
RUNS_DIR = HERE / "eval" / "runs"
LOG_PATH = HERE / "eval" / "log.md"

# gpt-5.4-mini's free-tier rate limit is 10 requests/minute (confirmed from
# the dashboard, per the task that commissioned this script). 6.5s between
# calls keeps us comfortably under that (10/min = 6s minimum spacing).
SECONDS_BETWEEN_CALLS = 6.5


def _normalize_name(name: Optional[str]) -> str:
    if name is None:
        return ""
    text = name.lower()
    # \w is Unicode-aware for str patterns in Python 3 (matches Hangul,
    # Kanji, Cyrillic, accented Latin, etc, not just a-z0-9) -- the old
    # `[^a-z0-9\s]` pattern stripped ALL non-ASCII, which silently reduced
    # any non-Latin-script name (Korean, Japanese, ...) to an empty string
    # on both sides of a comparison, making it unmatchable regardless of
    # whether the extraction was correct (case 016 in the v2 eval run hit
    # exactly this: a correct Korean-only extraction scored as a name
    # mismatch because both sides normalized to "" vs "nolsoop comic
    # cafe"). This still strips punctuation the same way for Latin-script
    # names (apostrophes, accents attached to punctuation marks) --
    # verified against existing passing cases ("Jonny's Pizza" ->
    # "jonnys pizza", "L'Atic" -> "latic") before relying on it.
    text = re.sub(r"[^\w\s]", "", text, flags=re.UNICODE)
    return re.sub(r"\s+", " ", text).strip()


def names_match(a: Optional[str], b: Optional[str]) -> bool:
    """Case-insensitive, fuzzy-substring name match per the skill's
    rubric. Both-null counts as a match (the deliberate 'no name, address
    only' case)."""
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    na, nb = _normalize_name(a), _normalize_name(b)
    if not na or not nb:
        return False
    if na in nb or nb in na:
        return True
    # Order-independent word-set match: catches a bilingual name whose
    # English/native halves are in opposite order ("Anipark (애니파크)" vs
    # "애니파크 (Anipark)" -- case 017, a real regression introduced by the
    # Unicode fix above: preserving non-Latin scripts means word order now
    # matters to the substring/ratio checks in a way the old all-stripping
    # bug accidentally didn't). Deliberately exact SET equality, not a
    # fuzzy overlap threshold -- a looser "most words in common" rule would
    # risk matching genuinely different names that happen to share words
    # (this test set has exactly that case: "El Califa" vs "Taquería El
    # Califa de León" are two different, unrelated taco stands).
    if set(na.split()) == set(nb.split()):
        return True
    return difflib.SequenceMatcher(None, na, nb).ratio() >= 0.65


@dataclass
class CaseScore:
    case_id: str
    expected_count: int
    points: float
    max_points: float
    outcomes: List[str] = field(default_factory=list)  # one line per expected entry (+ extras)
    error: Optional[str] = None


def score_case(expected: List[dict], extracted: List[dict]) -> CaseScore:
    """Implements the skill's rubric (hit=1, partial=0.5, miss=0, scored
    once per expected entry), with one explicit addition: for a case whose
    `expected` list is empty (several cases deliberately test this -- a
    vague post with nothing extractable), the case is worth 1 point,
    scored as a hit if the model also returned nothing and a miss if it
    hallucinated anything. The literal "score once per expected entry" rule
    has no way to score a zero-expected case at all otherwise, which would
    silently give hallucinations on those cases a free pass."""
    outcomes: List[str] = []

    if not expected:
        if not extracted:
            return CaseScore("", 0, 1.0, 1.0, ["hit: correctly returned nothing"])
        names = ", ".join(repr(p.get("name")) for p in extracted)
        return CaseScore(
            "", 0, 0.0, 1.0, [f"miss: expected nothing, hallucinated {names}"]
        )

    # Two-phase global matching, not a single greedy left-to-right pass.
    # A naive "for each expected entry, in order, grab the best remaining
    # extracted entry" approach has a real bug: if expected[0] has no real
    # match at all, its category-only fallback can steal the extracted
    # entry that was actually the correct exact match for expected[2],
    # cascading into wrong pairings for everything after it (confirmed
    # against a real case -- see eval run notes). Fix: resolve ALL full
    # hits first (across the whole list), then ALL name-only partials,
    # before any category-only fallback runs for anyone.
    pairs: dict[int, tuple[int, str]] = {}  # expected_idx -> (extracted_idx, kind)
    used_extracted: set[int] = set()

    def find(predicate):
        for ei, exp in enumerate(expected):
            if ei in pairs:
                continue
            for xi, x in enumerate(extracted):
                if xi in used_extracted:
                    continue
                if predicate(exp, x):
                    return ei, xi
        return None, None

    # Phase A: full hit -- name and category both match.
    while True:
        ei, xi = find(
            lambda e, x: names_match(e.get("name"), x.get("name"))
            and x.get("category") == e.get("category")
        )
        if ei is None:
            break
        pairs[ei] = (xi, "hit")
        used_extracted.add(xi)

    # Phase B: name matches, category doesn't -- a name match is a much
    # stronger identity signal than category, so this still runs globally
    # ahead of the category-only fallback.
    while True:
        ei, xi = find(lambda e, x: names_match(e.get("name"), x.get("name")))
        if ei is None:
            break
        pairs[ei] = (xi, "partial_name")
        used_extracted.add(xi)

    # Phase C: category matches, name doesn't ("vice versa" in the
    # rubric). Restricted to single-expected-entry cases: in a multi-place
    # list, two unrelated items sharing a category (e.g. two different
    # food spots) isn't real evidence of correspondence and would hand out
    # spurious partial credit that isn't a real signal.
    if len(expected) == 1:
        ei, xi = find(lambda e, x: x.get("category") == e.get("category"))
        if ei is not None:
            pairs[ei] = (xi, "partial_category")
            used_extracted.add(xi)

    points = 0.0
    for ei, exp in enumerate(expected):
        exp_name, exp_cat = exp.get("name"), exp.get("category")
        pair = pairs.get(ei)
        if pair is None:
            outcomes.append(f"miss: no extracted entry matched '{exp_name}' ({exp_cat})")
            continue
        xi, kind = pair
        x = extracted[xi]
        if kind == "hit":
            points += 1.0
            outcomes.append(f"hit: '{exp_name}' ({exp_cat})")
        elif kind == "partial_name":
            points += 0.5
            outcomes.append(
                f"partial: '{exp_name}' name matched, category mismatch "
                f"(expected {exp_cat}, got {x.get('category')})"
            )
        else:
            points += 0.5
            outcomes.append(
                f"partial: category matched ({exp_cat}), name mismatch "
                f"(expected '{exp_name}', got '{x.get('name')}')"
            )

    for xi, x in enumerate(extracted):
        if xi not in used_extracted:
            outcomes.append(
                f"note: extra unmatched extraction '{x.get('name')}' "
                f"({x.get('category')}, confidence {x.get('confidence')})"
            )

    return CaseScore("", len(expected), points, float(len(expected)), outcomes)


def load_cases(limit: Optional[int] = None, case_id: Optional[str] = None) -> List[dict]:
    paths = sorted(CASES_DIR.glob("*.json"))
    if case_id:
        paths = [p for p in paths if p.stem == case_id or p.stem.startswith(case_id)]
        if not paths:
            raise SystemExit(f"No case file matches id '{case_id}'")
    if limit:
        paths = paths[:limit]
    cases = []
    for p in paths:
        with open(p, encoding="utf-8") as f:
            cases.append(json.load(f))
    return cases


def rescore_run(run_path: Path) -> int:
    """Re-applies score_case to an already-saved run's recorded
    expected/extracted pairs -- no API calls, no new cost. For verifying a
    scorer fix (not a prompt/extraction fix) against real past data instead
    of needing to re-spend LLM calls just to re-test the scoring logic."""
    with open(run_path, encoding="utf-8") as f:
        old_run = json.load(f)

    total_points = 0.0
    total_max = 0.0
    changed = []
    for r in old_run["results"]:
        if r.get("error") is not None or r.get("extracted") is None:
            continue  # nothing to rescore for a failed call
        new_score = score_case(r["expected"], r["extracted"])
        old_points = r.get("points")
        total_points += new_score.points
        total_max += new_score.max_points
        if old_points is not None and abs(new_score.points - old_points) > 1e-9:
            changed.append((r["case_id"], old_points, new_score.points))
        r["points"] = new_score.points
        r["max_points"] = new_score.max_points
        r["outcomes"] = new_score.outcomes

    print(f"Rescored {run_path.name} with the current score_case/names_match logic.")
    print(f"Old total: {old_run['total_points']:g}/{old_run['total_max_points']:g}")
    print(f"New total: {total_points:g}/{total_max:g}")
    if changed:
        print("Cases whose score changed:")
        for case_id, old_pts, new_pts in changed:
            print(f"  [{case_id}] {old_pts:g} -> {new_pts:g}")
    else:
        print("No case's score changed.")

    old_run["total_points"] = total_points
    old_run["total_max_points"] = total_max
    old_run["rescored_from"] = run_path.name
    old_run["rescore_notes"] = "Rescored in place with an updated scorer; no new API calls were made."
    out_path = run_path.with_name(run_path.stem + "-rescored.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(old_run, f, indent=2, ensure_ascii=False)
    print(f"Saved rescored run to {out_path}")
    return 0


def git_sha() -> str:
    try:
        return (
            subprocess.check_output(
                ["git", "rev-parse", "--short", "HEAD"], cwd=HERE, stderr=subprocess.DEVNULL
            )
            .decode()
            .strip()
        )
    except Exception:
        return "unknown"


def main() -> int:
    # TikTok captions and some outcome strings carry emoji/non-Latin text
    # (Korean, accented Spanish/German) -- Windows consoles default to a
    # legacy codepage that can't encode them. Same fix as oembed_caption.py
    # (step 10): force UTF-8, replace anything still unprintable instead of
    # crashing mid-run and losing already-paid-for API calls.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--notes", default="", help="What changed since the last run.")
    parser.add_argument("--limit", type=int, default=None, help="Only run the first N cases.")
    parser.add_argument("--case-id", default=None, help="Run exactly one case by id.")
    parser.add_argument(
        "--skip",
        type=int,
        default=0,
        help="Skip the first N case files (resume a run without re-spending calls already made).",
    )
    parser.add_argument(
        "--rescore",
        default=None,
        metavar="RUN_FILE",
        help=(
            "Re-score an existing eval/runs/<timestamp>.json file with the current "
            "scorer, no API calls. Use this to verify a scorer-only fix without "
            "spending LLM calls to re-test extraction."
        ),
    )
    args = parser.parse_args()

    if args.rescore:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        return rescore_run(Path(args.rescore))

    cases = load_cases(limit=args.limit, case_id=args.case_id)
    if args.skip:
        cases = cases[args.skip :]
    n = len(cases)
    est_seconds = n * SECONDS_BETWEEN_CALLS
    print(
        f"This run will make {n} LLM call(s) against model '{MODEL}' "
        f"(one per case, paced {SECONDS_BETWEEN_CALLS}s apart -> "
        f"~{est_seconds / 60:.1f} min)."
    )

    client = _client()
    results = []
    total_points = 0.0
    total_max = 0.0
    total_usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    quota_hit_at: Optional[str] = None

    for i, case in enumerate(cases):
        case_id = case["id"]
        expected = case.get("expected", [])

        if i > 0:
            time.sleep(SECONDS_BETWEEN_CALLS)

        try:
            call_result = extract_places(
                caption=case["caption"], hashtags=case.get("hashtags"), client=client
            )
        except QuotaExhaustedError as e:
            print(
                f"[{case_id}] STOPPED: daily/quota cap hit -- {e}\n"
                f"Stopping the run here rather than continuing to fail "
                f"against the same wall. {i}/{n} cases completed."
            )
            quota_hit_at = case_id
            break
        except (TransientExtractionError, MalformedResponseError, ExtractionError) as e:
            print(f"[{case_id}] ERROR (not scored): {e}")
            results.append(
                {
                    "case_id": case_id,
                    "expected": expected,
                    "extracted": None,
                    "score": None,
                    "error": str(e),
                }
            )
            continue

        extracted = [p.model_dump(mode="json") for p in call_result.places]
        score = score_case(expected, extracted)

        if call_result.dropped_low_confidence:
            for p in call_result.dropped_low_confidence:
                print(
                    f"    - note: dropped by MIN_CONFIDENCE floor before "
                    f"scoring: '{p.name}' (confidence {p.confidence})"
                )
        total_points += score.points
        total_max += score.max_points

        if call_result.usage:
            total_usage["prompt_tokens"] += call_result.usage.prompt_tokens
            total_usage["completion_tokens"] += call_result.usage.completion_tokens
            total_usage["total_tokens"] += call_result.usage.total_tokens

        status = (
            "HIT"
            if score.points == score.max_points and score.max_points > 0
            else ("MISS" if score.points == 0 else "PARTIAL")
        )
        print(f"[{case_id}] {status} {score.points}/{score.max_points}")
        for line in score.outcomes:
            if not line.startswith("hit:"):
                print(f"    - {line}")

        results.append(
            {
                "case_id": case_id,
                "expected": expected,
                "extracted": extracted,
                "dropped_low_confidence": [
                    p.model_dump(mode="json") for p in call_result.dropped_low_confidence
                ],
                "points": score.points,
                "max_points": score.max_points,
                "outcomes": score.outcomes,
                "usage": asdict(call_result.usage) if call_result.usage else None,
            }
        )

    print(
        f"\nTotal: {total_points:g}/{total_max:g} "
        f"({(total_points / total_max * 100) if total_max else 0:.1f}%)"
        f" across {len([r for r in results if r.get('error') is None])} scored case(s)"
        f" of {n} attempted."
    )
    print(
        f"Token usage -- prompt: {total_usage['prompt_tokens']}, "
        f"completion: {total_usage['completion_tokens']}, "
        f"total: {total_usage['total_tokens']}"
    )
    if quota_hit_at:
        print(
            f"NOTE: run stopped early at case '{quota_hit_at}' due to the "
            f"daily/quota cap -- score above is partial, not a full-set result."
        )

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    run_path = RUNS_DIR / f"{timestamp}.json"
    run_record = {
        "timestamp": timestamp,
        "model": MODEL,
        "git_sha": git_sha(),
        "notes": args.notes,
        "cases_attempted": n,
        "cases_scored": len([r for r in results if r.get("error") is None]),
        "stopped_early_at": quota_hit_at,
        "total_points": total_points,
        "total_max_points": total_max,
        "token_usage": total_usage,
        "results": results,
    }
    with open(run_path, "w", encoding="utf-8") as f:
        json.dump(run_record, f, indent=2, ensure_ascii=False)

    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    score_str = f"{total_points:g}/{total_max:g}"
    if quota_hit_at:
        score_str += f" (stopped early at {quota_hit_at})"
    log_line = (
        f"| {timestamp} | {score_str} | {args.notes or '(no notes given)'} "
        f"| `eval/runs/{timestamp}.json` |\n"
    )
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(log_line)

    print(f"\nSaved run to {run_path}")
    print(f"Appended to {LOG_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
