# 0005: Use ScrapeCreators for TikTok video transcripts, superseding the no-scraping decision

- Status: Accepted
- Date: 2026-10-10
- Stage: Post-step-14 (extraction quality improvement)

## Context
Step 14's live testing (2026-10-10) confirmed caption-only extraction has a real ceiling: a TikTok's actual place name is often only spoken aloud or shown as on-screen text, never typed in the caption oEmbed exposes. Competitor research confirmed real apps in this space (GeoTok, TokSpot, Venturr) read on-screen text and audio for exactly this reason, and the developer independently confirmed a competitor (Plotline) found a place from a TikTok with nothing usable in its caption. This supersedes ADR 0004 ("no server-side downloading or scraping of TikTok/Instagram") — getting audio content requires either the developer building their own screen-recording + Whisper pipeline (already planned, deferred to "Later"), or a third-party service that extracts it directly. The developer chose the latter now rather than wait.

## Options considered

| Option | Cost | Complexity | Learning value | Resume signal |
|---|---|---|---|---|
| A: ScrapeCreators | Pay-as-you-go credits, don't expire (~$47/25k per third-party pricing, unconfirmed on vendor's own page) | Low — dedicated `/v1/tiktok/video/transcript` endpoint, one REST call, same pattern as every other integration in this project | Working with a specialized third-party data API, including its ToS/reliability tradeoffs | Real story: identified a product gap, researched competitors, made a deliberate build-vs-buy call |
| B: Social Fetch | Lower entry price ($29) | Similar REST shape | Same | Same, but undermined by option's own reliability risk below |
| C: Apify | Credit-based, varies by Actor | Higher — inconsistent schema per Actor, needs normalization | Broader scraping-ecosystem exposure | Lower — more integration grunt work than a clean decision |
| D: EnsembleData | Subscription, daily-resetting credits | Low, but wrong usage-shape fit | Low marginal value over A | Low |
| E: Bright Data / Oxylabs | High entry cost, enterprise minimums | High, built for massive scale | Low marginal value for this project's size | Low — overkill reads as not understanding the actual problem size |
| F: Build it ourselves (Whisper + ffmpeg on self-captured screen recordings) | Per-minute Whisper cost, no scraping-ToS risk | Higher — full pipeline to build (upload, ffmpeg, Whisper, OCR decision) | Highest — real audio/video pipeline engineering | Highest, but slower to ship | 

## Decision
Use ScrapeCreators' TikTok transcript endpoint to add spoken-audio content to extraction, on top of the existing oEmbed-sourced caption (oEmbed is kept, not replaced — it's free, already built, and zero ToS risk for what it already does well).

## Why
- Developer's own call: ship the capability now rather than wait for the full self-built screen-recording pipeline (option F), which is real future work, not abandoned — just not blocking this.
- Of the scraping options, ScrapeCreators has a confirmed, purpose-built endpoint for exactly this need; Social Fetch's TikTok transcript support is only marketing-claimed, not confirmed in its own docs — a real reliability risk for the one capability being paid for. Apify's per-Actor schema inconsistency means more integration work for an equivalent result. EnsembleData and Bright Data/Oxylabs don't fit this project's usage shape (sporadic, low-volume) or scale (a side project, not enterprise harvesting).

## Tradeoffs accepted
- **This is the real tradeoff, stated plainly**: OutTheGC now depends on unauthorized access to TikTok's platform for transcript data, which ADR 0004 was specifically written to avoid. Real exposure: TikTok can detect/block the scraping vendor at any time (service could degrade or disappear without notice), and there is genuine ToS/legal risk that sits with whoever directs the scraping, not only the vendor running it. This is a knowing, deliberate acceptance of that risk, not an oversight.
- On-screen text (burned-in captions, location stickers) is still NOT covered by this — transcript-only closes the audio half of the competitor-parity gap, not the visual half. A real OCR/frame-analysis solution is still future work if full parity is wanted.
- New per-call cost dimension requiring the same budget-alert discipline already applied to OpenAI/Google Places — not yet set up as of this decision (see roadmap Notes for status).

## Revisit if
- ScrapeCreators is blocked/degraded by TikTok, or its pricing changes unfavorably.
- The self-built screen-recording + Whisper + OCR pipeline (ADR 0004's original fallback, still on the "Later" list) gets built anyway for the on-screen-text capability it provides that ScrapeCreators doesn't — at that point, re-evaluate whether the scraping dependency is still worth keeping alongside it, or whether the self-built path can absorb transcript duty too and ScrapeCreators can be dropped.

## 30-second version
"I'd originally decided against any server-side scraping of TikTok, for legal and reliability reasons. Live testing exposed how much that limited extraction — the caption often just doesn't have the place name at all, confirmed against real competitor apps that read audio and on-screen text. I evaluated the scraping-API market, picked ScrapeCreators for its purpose-built transcript endpoint over broader-but-less-certain alternatives, and made the call to accept the ToS risk now rather than wait for the slower, fully-compliant self-built pipeline — which is still on the roadmap for the on-screen-text piece this doesn't cover."
