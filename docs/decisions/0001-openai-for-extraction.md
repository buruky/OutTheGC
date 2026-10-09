# 0001: Use OpenAI for place extraction

- Status: Accepted
- Date: 2026-10-09
- Stage: Step 11 (LLM extraction and a test set)

## Context
Step 11 sends TikTok captions to an LLM and asks for structured JSON (place name, area, category, confidence). The provider shapes the prompt format, the structured-output mechanism, the Python SDK this and later steps build around, and the per-post cost. Extraction never auto-pins (the user always confirms), so a bad or garbled result is a UX annoyance, not a safety issue — accuracy-maximizing was not the deciding factor.

## Options considered

| Option | Cost | Complexity | Learning value | Resume signal |
|---|---|---|---|---|
| A: OpenAI (`gpt-4o-mini` tier) | ~$0.15/1M in, $0.60/1M out — fractions of a cent per post | Lowest friction; dedicated JSON-Schema Structured Outputs, most tutorials/community support | Default "LLM in, typed JSON out" skill | Safe, recognized, but the most common choice — least differentiated |
| B: Anthropic (Claude Haiku tier) | Similar order of magnitude; not precisely quoted (would need current pricing before relying on it) | Structured output via tool-use/function-calling, not a dedicated JSON mode — slightly more setup | Same core skill plus tool-use patterns | Real "built end-to-end with Claude" story (this project is built with Claude Code) |
| C: Google Gemini (Flash tier) | Cheapest; usable free tier, plausibly $0 for this step and step 11's eval | Comparable; less common in tutorials | Same core skill | Least differentiated; free tier means less real budgeting practice |

## Decision
Use OpenAI (small-model tier, e.g. `gpt-4o-mini` or whatever the current equivalent is at implementation time) for place extraction.

## Why
- Lowest-friction structured-output support (dedicated JSON Schema mode) while prompt design and eval scoring are both being learned in the same step — fewer unknowns to debug at once.
- Most mature ecosystem/documentation for this exact "unstructured text in, typed JSON out" pattern.
- Developer picked this directly when presented with the OpenAI/Anthropic/Gemini tradeoff (notably over the "dogfooding Claude end-to-end" narrative Option B offered) — not recorded why beyond the direct choice; ask again if this comes up in an interview and the specific reasoning matters.

## Tradeoffs accepted
- Giving up the cheapest option (Gemini's free tier) and the most interview-differentiated option (Anthropic's "built with Claude, extracts with Claude" story) for the most common, safest choice.
- Real per-post cost isn't known yet — set as a placeholder target below, to be confirmed once step 11's 20-caption test set actually runs and token usage is measurable.
- Locks the worker's structured-output mechanism to OpenAI's Structured Outputs API shape; switching providers later means re-deriving schema enforcement under a different mechanism (Anthropic's tool-use, Gemini's schema param), not just swapping an API key.

## Revisit if
- Per-post cost measured from the real test set blows past a reasonable ceiling (placeholder: under $0.01/post — confirm or adjust once step 11's eval runs).
- OpenAI structured-output reliability turns out worse than expected against the 20-caption test set.
- The "dogfooding Claude" story becomes something the developer actually wants for the product, not just the build process.

## 30-second version
"I picked OpenAI for extraction because it had the most mature structured-output support, which mattered since I was also designing the prompt and eval scoring for the first time in that same step — I wanted to minimize unknowns. I considered Anthropic (nice end-to-end story since I built the whole project with Claude Code) and Gemini (cheapest, generous free tier), but went with the most proven path for a part of the pipeline where correctness isn't safety-critical anyway, since the app never auto-pins without user confirmation."
