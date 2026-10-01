---
name: extraction-eval
description: Run OutTheGC's extraction pipeline against a fixed test set of real captions, score the results against expected answers, and compare to the last run. Use whenever the developer changes the extraction prompt, schema, or LLM provider/model, says "test the prompt", "run eval", "how's extraction doing", or "did that change help". Also use to set up the test set and scoring convention if `services/worker/eval/` doesn't exist yet -- this is roadmap step 11.
---

# Extraction Eval

"I tweaked the prompt" isn't evidence; "accuracy went from 14/20 to 17/20" is. This skill turns every prompt, schema, or model change into a number against the same fixed test set, so improvement is measured instead of felt. It's also the habit that makes the extraction good -- and a strong, concrete story for an interview or an ML-adjacent application.

Read `OutTheGC-spec.md`'s "Pipeline" section and `OutTheGC-roadmap.md` step 11 before acting; this skill implements that step's "collect 20 real captions and run them all" requirement and keeps it going after.

## Convention

If `services/worker/eval/` doesn't exist yet, set it up:

- `services/worker/eval/cases/*.json` -- one file per test case:
  ```json
  {
    "id": "001-ramen-tokyo",
    "source": "tiktok",
    "caption": "the full caption text",
    "hashtags": ["tokyo", "ramen"],
    "expected": [
      { "name": "Ichiran Shibuya", "area": "Shibuya, Tokyo", "category": "food" }
    ]
  }
  ```
  `expected` is a list because one caption can mention more than one place -- match the spec's "multiple places in one post" behavior.
- `services/worker/eval/runs/<timestamp>.json` -- one file per run: every case's actual output, per-case score, and the total, plus a `notes` field for what changed (prompt diff summary, model/provider, git sha).
- `services/worker/eval/log.md` -- one line per run: date, score (`14/20`), what changed, link to the run file. This is the running record -- read it before claiming "it's better now."

## Scoring

Keep it simple and consistent so scores are comparable run to run:
- **Hit** (1 point): extracted name matches an expected entry (case-insensitive, fuzzy substring is fine) AND category matches.
- **Partial** (0.5 point): name matches but category doesn't, or vice versa.
- **Miss** (0 points): nothing extracted matches, or something extra and wrong was extracted with high confidence.
- Score a case once per expected entry, not once per case, when a caption has multiple expected places.

If the developer wants a different rubric, that's their call to make -- present it as an option, don't just build this one silently if they push back.

## Running an eval

1. Confirm `eval/cases/` has real cases (not placeholders). If it's a step-11 setup task, help the developer collect the 20 captions the roadmap asks for -- real captions, not invented ones, since the whole point is testing against what the extraction will actually see.
2. Run the current extraction function against every case. Before running, say how many LLM calls this costs (one per case, minimum) and check that against any cost ceiling recorded in `docs/decisions/` or the spec's Open Questions -- this is also `pipeline-expert`'s concern, so loop it in if the set is large enough to matter.
3. Score every case; print each one's result and a one-line reason for anything less than a full hit (wrong category, no match found, hallucinated an extra place).
4. Compare the total to the most recent prior entry in `eval/log.md`. Report the delta plainly, and name which specific cases flipped (newly passing, newly failing) -- that diagnostic matters more than the aggregate number, since a flat total can hide a regression that a different case's improvement is masking.
5. If the score dropped, say so first, before anything else, and don't frame it as neutral.
6. Save the run to `eval/runs/`, and append the line to `eval/log.md`.

## Growing the test set

Add a case whenever a real post the extraction got wrong shows up in actual use -- that failure becomes a permanent regression test, not just a one-off fix. Don't let the set stay frozen at the original 20 once the app has real usage to learn from.
