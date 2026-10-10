# 0004: No server-side downloading or scraping of TikTok/Instagram

- Status: Superseded by 0005
- Date: not recorded (predates this file; backfilled)
- Stage: pre-roadmap (foundational)

## Context
One of three structural decisions made before `CLAUDE.md` existed, flagged there as worth backfilling as an ADR. OutTheGC's core loop depends on getting place data out of a TikTok post. The alternative to the chosen approach would have been the app itself fetching/scraping TikTok content server-side.

## Options considered
Not recorded — the developer's original alternatives-considered reasoning wasn't captured before this backfill. What's known from `CLAUDE.md`'s framing of the decision: the chosen approach avoids legal/ToS risk (no unauthorized access to TikTok's platform) and avoids the technical fragility of scraping a platform that actively works to block it.

## Decision
Users bring posts into the app themselves (a shared link, a screenshot, or a screen recording they capture) rather than the app downloading or scraping TikTok/Instagram content server-side. Extraction only uses TikTok's own sanctioned oEmbed endpoint for link-based posts.

## Why
Not recorded in the developer's own words. Inferred from `CLAUDE.md`'s existing framing: avoiding legal/ToS exposure and the operational fragility of unauthorized scraping (detection, blocking, service instability).

## Tradeoffs accepted
Caption-only extraction for TikTok links (oEmbed exposes only caption/author, not audio or on-screen video content) — a real, eventually-hit limitation (see the roadmap's step 14 Log entries, 2026-10-10).

## Revisit if
Caption-only extraction proves too limited in practice. **This happened** — see ADR 0005.

## 30-second version
"Early on I decided OutTheGC wouldn't scrape or download TikTok content server-side — users bring posts in themselves, and extraction only uses TikTok's own public oEmbed API. That avoided legal risk and scraper fragility, but it meant extraction could only ever see caption text, never what's said or shown in the video itself. Once I hit that limit in practice, I revisited the call — see ADR 0005."
