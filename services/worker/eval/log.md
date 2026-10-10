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
| 20261009T181619Z | 47.5/54 | prompt v2 full re-run | `eval/runs/20261009T181619Z.json` |
| 20261009T182357Z | 1/1 | v3 spot-check: rule 6 merged precedence (explicit restaurant/cafe wording wins over co-occurring nightlife word) | `eval/runs/20261009T182357Z.json` |
| 20261009T182403Z | 1/1 | v3 spot-check: rule 1 confidence-floor instruction + code-level MIN_CONFIDENCE=0.55 filter | `eval/runs/20261009T182403Z.json` |
| 20261009T182413Z | 0/1 | v3 spot-check: rule 1 confidence-floor instruction + code-level MIN_CONFIDENCE=0.55 filter | `eval/runs/20261009T182413Z.json` |
| 20261009T182434Z | 0/1 | v3 spot-check retry: re-run 027 to check non-determinism vs systematic rule-2 over-trigger | `eval/runs/20261009T182434Z.json` |
| 20261009T182520Z | 1/1 | v3 spot-check retry 2: rule 1 clarified -- capitalized generic category phrase (Rooftop Bar) is not a name | `eval/runs/20261009T182520Z.json` |
| 20261009T182526Z | 1/1 | v3 spot-check retry 2 confirm: re-run once more to check it holds, not a one-off | `eval/runs/20261009T182526Z.json` |
| 20261009T182541Z | 1/1 | v3 spot-check confirm: re-run 037 once more to check consistency | `eval/runs/20261009T182541Z.json` |
| 20261009T182546Z | 1/1 | v3 spot-check confirm: re-run 025 once more to check consistency | `eval/runs/20261009T182546Z.json` |
| 20261009T183129Z | 50.5/54 | prompt v3: fixed rule 6 conflict, confidence floor, unicode scorer bug | `eval/runs/20261009T183129Z.json` |
| 20261009T183129Z-rescored | 51/54 (94.4%) | **FINAL v3 score.** Rescore only, no new API calls: fixed a second scorer bug the previous entry's Unicode fix introduced (word-order-sensitive matching broke case 017, a bilingual name whose English/native halves are in the opposite order from its translation) by adding exact word-SET equality as a third match path alongside substring/ratio. Only case 017 changed (0.5->1.0); verified no other case's score moved, including the one pair this test set has that's genuinely at risk of a looser fix causing false positives ("El Califa" vs "Taquería El Califa de León", case 021). | `eval/runs/20261009T183129Z-rescored.json` |
| 20261010T041328Z | 1/1 | address field fix: rule 2 now populates address text, resolve_place searches on it instead of skipping | `eval/runs/20261010T041328Z.json` |
| 20261010T051113Z | 47/54 | ADR 0005: transcript added as second input source, prompt redesigned for caption+transcript reconciliation | `eval/runs/20261010T051113Z.json` |
| 20261010T051243Z | 0/1 | diagnostic: re-check 022 consistency, isolate rule 1 rewrite vs transcript | `eval/runs/20261010T051243Z.json` |
| 20261010T051550Z | 0/1 | diagnostic: rule 5 waypoint fix | `eval/runs/20261010T051550Z.json` |
| 20261010T051554Z | 1/1 | diagnostic: rule 1 formatting-signal fix | `eval/runs/20261010T051554Z.json` |
| 20261010T051556Z | 1/1 | diagnostic: rule 2 null+null guard fix | `eval/runs/20261010T051556Z.json` |
| 20261010T051601Z | 0/1 | diagnostic: recheck 025 after fixes (ground-truth flagged separately, not edited) | `eval/runs/20261010T051601Z.json` |
| 20261010T051629Z | 0/1 | diagnostic: 007 retry 2, check consistency | `eval/runs/20261010T051629Z.json` |
| 20261010T051633Z | 0/1 | diagnostic: 007 retry 3, check consistency | `eval/runs/20261010T051633Z.json` |
| 20261010T051710Z | 1/1 | diagnostic: rule 5 strengthened (grabbing/action-at-waypoint still a waypoint) | `eval/runs/20261010T051710Z.json` |
| 20261010T051717Z | 1/1 | diagnostic: 007 confirm stability after rule 5 strengthening | `eval/runs/20261010T051717Z.json` |
| 20261010T052200Z | 54/59 | ADR 0005 v2: transcript reconciliation rules + 3 fixes (rule 1 formatting-as-signal, rule 2 null+null guard, rule 5 waypoint/landmark distinction) after diagnosing the first transcript-enabled run's regressions | `eval/runs/20261010T052200Z.json` |
