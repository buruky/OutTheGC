# Step → decision map

Starting points only -- pulled from `OutTheGC-spec.md`'s Open Questions and Decisions. A step can surface more than what's listed here; this just flags the ones that come up most often so an entry gate doesn't miss them.

| Step | Decisions it tends to force |
|---|---|
| 1. Hello world on your phone | Where the Expo project lives -- `apps/mobile/` per `CLAUDE.md`'s target layout, not the repo root. |
| 3. The map | Google Maps vs Apple Maps on iOS (Open Q #5); pin icon/color per category isn't needed yet but will be by step 8. |
| 6. Trips with permissions | RLS policy design -- the core permission system; see `CLAUDE.md`'s "Permission rules" for the exact rules policies must satisfy. |
| 7. Invite codes | Do codes/links expire, can the owner disable them (Open Q #2); the join function's abuse surface (guessing codes, joining an archived trip) is a `security-reviewer` check, not just a feature to build. |
| 8. Pins from the database | Launch categories (Open Q #4); pin style per category (Open Q #5). |
| 11. LLM extraction and a test set | LLM provider and a cost ceiling per post (Open Q #4); which extraction fields matter most (Open Q #4). This is also where `extraction-eval`'s test set and scoring convention should get set up. |
| 12. Google Places lookup | Budget alert on the Google Maps Platform key before the first real call. |
| 13. Turn the script into a worker | Job queue mechanism -- polling the `posts` table vs something like pgmq (not yet decided); worker hosting is a later step (20) but the shape of this one constrains it. |
| 14. Paste a link in the app | Confirm-screen UX: best match first, other candidates below, manual search fallback (spec's "Confirm" step) -- not optional, it's load-bearing for the "extraction never auto-pins" decision. |
| 15. Development build | Needs an Apple Developer account ($99/yr) for an iOS device build -- flag the cost before the step starts, not mid-step. |
| 16. Share from TikTok | Needs step 15's dev build first (share extensions aren't available in Expo Go) -- a hard prerequisite, not just a suggestion. |
| 18. Screenshot upload | Storage bucket policy + actually deleting the upload after processing (retention decision from `CLAUDE.md`) -- a `security-reviewer` check as much as a feature. |
| 19. Full sign in and account management | Phone auth's underlying SMS provider and per-send cost; Apple's in-app account deletion requirement. |
| 20. Deploy and test with friends | Worker hosting (Railway/Fly/Render, Open Q #11); analytics/crash reporting choice (Open Q #11). |
