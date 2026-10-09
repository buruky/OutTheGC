# Extraction eval log

One line per run: date, score, what changed, link to the run file. Scoring convention and case file format: see the `extraction-eval` skill (`.claude/skills/extraction-eval/SKILL.md`).

| Date | Score | What changed | Run file |
|---|---|---|---|
| 20261009T081643Z | 2.5/3 | mechanics smoke test, prompt v1 | `eval/runs/20261009T081643Z.json` |
| 20261009T082241Z | 27.5/30 | baseline run, prompt v1 (resumed after a Windows console encoding crash at case 16; cases 1-16 scored in the first partial attempt, see report) | `eval/runs/20261009T082241Z.json` |
| 20261009T082424Z | 3/7 | diagnostic: inspect raw extraction for the pizza-list case | `eval/runs/20261009T082424Z.json` |
| 20261009T082604Z | 0.5/1 | diagnostic: recover detail lost to the console crash | `eval/runs/20261009T082604Z.json` |
| BASELINE-v1 | 47/54 (87.0%) | **Official prompt-v1 baseline, all 37 cases.** Reconstructed from the three entries above plus the original (crashed) run's console output for cases 1-10/12-15 -- see the run file's `notes` for exactly how. Also fixed a real scoring-algorithm bug (greedy per-expected matching could let an early unmatched expected entry steal a later entry's correct match) before finalizing this total. | `eval/runs/BASELINE-v1.json` |
| 20261009T082903Z | 0/1 | v2 spot-check: rule 2 tightened (no address = no null-name entry) | `eval/runs/20261009T082903Z.json` |
| 20261009T082938Z | 1/1 | v2 spot-check retry: rule 2 wording strengthened + explicit example added after first retry still hallucinated | `eval/runs/20261009T082938Z.json` |
| 20261009T082945Z | 1/1 | v2 spot-check: neighborhood -> other, not views | `eval/runs/20261009T082945Z.json` |
| 20261009T082951Z | 1/1 | v2 spot-check: explicit caption-text name over conflicting hashtag | `eval/runs/20261009T082951Z.json` |
| 20261009T082959Z | 7/7 | v2 spot-check: aside-mention places (didn't include X, but great too) should still be extracted | `eval/runs/20261009T082959Z.json` |
