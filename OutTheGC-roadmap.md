# OutTheGC build roadmap

A hands on path from zero to a beta. Every step ends with something working that you can see or test, and each one adds one new piece of the stack. Do them in order; later steps assume earlier ones.

Each step has:
- **Goal:** what you are building
- **Try:** the concrete things to do
- **Learn:** the concept the step teaches
- **Done when:** how you know it works
- **Notes:** space for what you hit, links that helped, decisions made

Check off steps as you finish them. Add new steps anywhere; renumbering is fine.

---

## Phase 0: Setup

### [x] 0. Tools
- **Goal:** a machine ready to build.
- **Try:** install Node (LTS), Git, VS Code, and the Expo Go app on your phone. Make a GitHub account and an empty `outthegc` repo. Make a Supabase account.
- **Learn:** what each tool is for. Node runs the dev tools, Git tracks your history, Expo Go runs your app on a real phone without a build.
- **Done when:** `node -v` and `git --version` print versions, and the repo exists.
- **Notes:** Node v22.20.0, Git 2.44.0 already installed. VS Code, Expo Go, GitHub repo, and Supabase account confirmed done by the developer.

---

## Phase 1: The app shell (no backend yet)

### [x] 1. Hello world on your phone
- **Goal:** your own app running on your phone.
- **Try:** `npx create-expo-app@latest outthegc` (it uses TypeScript). Run `npx expo start`, scan the QR code with your phone. Change some text and watch it update live.
- **Learn:** the project layout, hot reload, and how JSX/TSX describes a screen.
- **Done when:** your edited text shows on your phone. First commit pushed to GitHub.
- **Notes:** Scaffolded in `apps/mobile/` (not the repo root) to match the monorepo layout in `CLAUDE.md`. SDK 57's default template already wires up Expo Router, with routes under `src/app/` rather than a top-level `app/` — updated `mobile-expert.md` to match. Confirmed hot reload on a physical device via Expo Go. Pushed as commit `9eb185e`.

### [x] 2. Screens and navigation
- **Goal:** the app's skeleton with fake data.
- **Try:** with Expo Router, make tabs for Trips and Profile, plus a trip detail screen at `app/trip/[id].tsx`. Show a hardcoded list of 2 or 3 trips; tapping one opens its detail screen.
- **Learn:** file based routing, components, props, and passing an id through a route.
- **Done when:** you can tap from the trip list into a trip and back.
- **Notes:** Tab screens moved into a `(tabs)` route group so `trip/[id]` could be pushed as a sibling `Stack.Screen` with a real header/back button — a flat tab bar alone can't give a pushed detail screen a back gesture. Fake trip data (`src/data/trips.ts`) mirrors the real `trips` table's fields for an easy swap to Supabase in step 4. Also turned on ESLint (`eslint` + `eslint-config-expo`) while here, since `AGENTS.md` already assumed `npx expo lint` worked. Confirmed working live on device.

### [x] 3. The map
- **Goal:** pins on a real map.
- **Try:** add `react-native-maps` to the trip screen. Put 5 hardcoded pins near a city. Tapping a pin shows the place name in a card at the bottom.
- **Learn:** coordinates (latitude, longitude), map regions, and component state (`useState`) for "which pin is selected".
- **Done when:** the map shows your pins and tapping one updates the card.
- **Notes:** Used default map providers (Apple Maps iOS, Google Maps Android) — no API key, works in Expo Go as-is; revisit "Google everywhere" (spec Open Q #5) once step 12 requires a Google Maps Platform key anyway. 5 real Tokyo-area pins on the tokyo-2026 fake trip; other fake trips show an empty-pins state. `react-native-maps` doesn't support the web build at all (hard crash, not just ugly) — left unaddressed since web is explicitly deferred. Debugged a separate "request timed out" issue on device: phone WiFi was off, not a firewall/network problem — check that first next time before anything more involved.

---

## Phase 2: Real data with Supabase

### [x] 4. Connect Supabase
- **Goal:** the app talks to a real database.
- **Try:** create a Supabase project. Install the Supabase CLI and link it to the project. Write your first migration creating a simple `trips` table, push it, add a row in the dashboard, and read it from the app with `supabase-js`.
- **Learn:** SQL tables, migrations (schema changes saved as files in git), and keeping keys in environment variables.
- **Done when:** the trip list in the app comes from the database, not hardcoded data.
- **Notes:** `trips` table deliberately minimal -- no `owner_id`/`invite_code`/RLS yet, those are steps 6-7. Table is currently open to anyone with the (public-by-design) anon key; that's expected until step 6 adds RLS, not a gap in this step. Confirmed live: a dashboard-added row shows up in the app, with the pre-existing hardcoded map pins correctly showing "no pins" for a real trip id (expected until steps 8/12). Keys live in `apps/mobile/.env.local`, gitignored.


### [x] 5. Sign in
- **Goal:** real accounts.
- **Try:** add email sign in with Supabase Auth. Create a `profiles` table filled in when someone signs up. Keep people signed in after they close the app. Add sign out.
- **Learn:** sessions, auth state, and protected screens (signed out users only see the sign in screen).
- **Done when:** you can sign up, close the app, reopen, and still be signed in.
- **Notes:** Email confirmation required (deliberate) -- signup creates the account but no session until the link is clicked, then sign in separately. `profiles` row created via a SECURITY DEFINER trigger on auth.users, not a client-side insert. Session persistence via AsyncStorage; `Stack.Protected` gates (tabs)/trip behind a session. Post-build security review tightened `profiles` RLS to own-row-only reads (was accidentally world-readable to any signed-up account) and fixed a config.toml/production drift on email confirmation -- see the Log section for what's still deliberately deferred (secure token storage, profile value constraints, app scheme, dead redirect page). Also discovered the free email tier caps at 2 sends/hour -- SMTP setup is a live option if this keeps being disruptive.

### [x] 6. Trips with permissions
- **Goal:** each person only sees their own trips.
- **Try:** add `trip_members` and `owner_id`. Build "create trip" in the app. Write row level security policies so you can only read trips you belong to. Test with two accounts on two devices (or a phone and a simulator).
- **Learn:** row level security, the core of the whole permission system.
- **Done when:** account A cannot see account B's trip, even by guessing its id.
- **Notes:** Membership on trip creation handled by a SECURITY DEFINER trigger (same pattern as the profiles trigger), not a client-side insert, so a dropped connection can't lock the creator out of their own trip. Two real RLS bugs found and fixed post-build, both worth remembering:
  1. **Infinite recursion** -- the first trip_members SELECT policy checked membership via a self-join back onto trip_members itself; since that table has RLS enabled, evaluating the policy required evaluating the policy, forever (Postgres error 42P17). Fixed with a SECURITY DEFINER helper function (`is_trip_member`) that bypasses RLS internally, breaking the cycle.
  2. **Same-statement trigger visibility** -- after fixing #1, `insert into trips ... returning` (exactly what createTrip() does) still failed, because the RETURNING clause's implicit SELECT-policy check didn't reliably see the trip_members row the trigger had just written in that same statement (confirmed empirically; didn't matter whether the helper function was `stable` or not). Fixed by giving the trips SELECT policy a direct `owner_id = auth.uid()` fast path that doesn't depend on trip_members at all for the owner's own row -- a better policy on its own merits, not just a workaround.
  Isolation verified two ways: directly against the database (a simulated second identity got zero rows on both a direct id lookup and an unfiltered list -- no error, just nothing) and by the developer with a real second account in the app.

### [x] 7. Invite codes
- **Goal:** friends can join a trip.
- **Try:** generate an `invite_code` per trip. Add a "join with code" screen. Then make an invite link that opens the app to the join screen.
- **Learn:** database functions (joining needs to bypass normal rules safely) and deep links.
- **Done when:** account B joins account A's trip with a code and sees it in their list.
- **Notes:** Code is 8 chars, server-generated only (ambiguity-free alphabet, retry-on-collision, backed by a UNIQUE constraint) -- client never supplies it. `join_trip_by_code()` is idempotent (rejoining is a no-op, not an error) and returns a distinguishable SQLSTATE (22023) for a bad code. Found and fixed mid-build: Supabase auto-grants EXECUTE on new functions directly to anon/authenticated/service_role, not through PUBLIC -- `revoke from public` alone didn't block anon; fixed with an explicit `revoke ... from anon`, then applied the same cleanup to the two earlier helper functions as defense-in-depth (confirmed neither actually leaked anything to anon, just tightened on principle). `app.json`'s scheme renamed `mobile` -> `outthegc` -- this step needed a real one for the invite link, not just the earlier OAuth concern. Confirmed working end to end: join by typing a code, rejoin shows "already in," bad code shows a clear message, all with a real second account. The deep link itself is correctly built but can't be tested as a tappable link until step 15 (Expo Go doesn't register custom schemes) -- see Log.

### [x] 8. Pins from the database
- **Goal:** the map shows real saved places.
- **Try:** add `places`, `trip_places`, and `saves`. Add a place by hand (type a name and coordinates for now). Show the "saved by N" count. Add the "my saves / group" toggle and "remove my save".
- **Learn:** join tables, unique constraints (how merging works), and PostGIS points.
- **Done when:** two accounts saving the same place on a trip creates one pin that says "saved by 2".
- **Notes:** Launch categories resolved (Open Q #4): `food, views, entertainment, stay, shopping, nightlife, other` as a Postgres ENUM on `trip_places.category`, default `'other'`. `places` is trip-agnostic (shared across trips) with permissive RLS (any authenticated user can read/insert — privacy enforced at `trip_places`, not here); `trip_places`/`saves` gated by `is_trip_member`, same helper function as steps 6/7. A zero-saves pin deletes itself via a `SECURITY DEFINER` trigger (`cleanup_empty_trip_place`) rather than app-layer logic, so the invariant holds no matter what client removes the last save. `trip_places.place_id` FK is `RESTRICT` not `CASCADE` (a place can be pinned on multiple unrelated trips). Mobile: `places.location` (PostGIS `geography`) comes back over PostgREST as hex EWKB, not JSON — hand-rolled a small fixed-shape parser rather than add a dependency; inserts use EWKT text via PostGIS's registered assignment cast, no RPC needed. No fuzzy or exact dedup on hand-added places yet (accepted gap until step 12's `google_place_id` gives a real match key) — two people typing identical coordinates get two separate pins; the "merged pin" demo path is add-once-then-others-save, matching this step's literal done-when. Verified via direct SQL (saved_by count + trigger-deletes-empty-pin) and the full flow on two real accounts/devices, including the my/group toggle and delete-for-everyone. `archived_at` still doesn't exist as a column (flagged with TODOs in the migration, same as step 7) — not blocking yet.

### [x] 9. Live updates
- **Goal:** pins appear for everyone without refreshing.
- **Try:** subscribe to the trip's pins with Supabase Realtime.
- **Learn:** realtime subscriptions and keeping app state in sync with the database.
- **Done when:** a pin added on one phone appears on the other within a second or two.
- **Notes:** Used Supabase Realtime's Postgres Changes (not Broadcast) on `trip_places`/`saves`, added to the `supabase_realtime` publication. A security review during this step found and fixed a real gap: DELETE events aren't RLS-gated at all (a Postgres/Realtime limitation, not project-specific) and were reachable by the anon key, not just signed-in users — fixed with `revoke select ... from anon` on both tables, verified via direct SQL. Remaining accepted gap: a signed-in non-member can still receive a bare deleted-row UUID with no trip linkage for trips they're not on; inert today (no leave-trip/remove-member feature exists to populate a removed member's cache with ids to watch) but must be revisited via Broadcast before that feature ships. Also surfaced, logged separately in the spec (not blocking): `places` rows are readable by any authenticated user by design, but since places are currently hand-typed (not Google-resolved until step 12), a hand-added address is user-written trip content exposed to non-members — open question, not fixed. Mobile: subscribes on focus/unsubscribes on blur (not mount/unmount, since Expo Router keeps pushed-under screens mounted), full-list refetch on any relevant event rather than incremental patching (simpler, matches the project's no-premature-optimization bias at this trip's realistic scale), debounced 400ms so a cascade delete's multiple events coalesce into one refetch. `saves` DELETE events can't be filtered server-side at all (no `trip_id` column, and delete payloads are stripped to bare `id` regardless of replica identity) — matched locally against each pin's `saveIds` instead. Verified end to end on two real devices.

---

## Phase 3: Extraction

### [x] 10. Caption from a TikTok link
- **Goal:** the first piece of the pipeline, outside the app.
- **Try:** a Python script that takes a TikTok URL, calls TikTok's oEmbed endpoint, and prints the caption and author.
- **Learn:** calling an HTTP API from Python, reading JSON responses, and Python virtual environments.
- **Done when:** the script prints captions for 3 different TikToks.
- **Notes:** `services/worker/oembed_caption.py`, plain `venv` + `requirements.txt` (not Poetry/pipenv -- revisit once step 13 makes this a real multi-dependency worker). Takes multiple URLs in one invocation, each tried independently so one bad link doesn't block the others; distinguishes bad-input/404/other-non-200/network-failure/malformed-JSON with a clear message for each rather than a raw stack trace. TikTok's oEmbed `title` field holds the caption (no separate title concept on TikTok). Hit and fixed a real bug during testing: Windows' default console codepage can't print emoji (TikTok captions are full of them) -- forced UTF-8 on stdout/stderr rather than crashing. Confirmed with 3 real TikTok URLs, all succeeded. Cost: $0, oEmbed is public and keyless -- cheapest step in the whole pipeline; step 11 (LLM) and step 12 (Google Places) are where real per-post cost starts.

### [x] 11. LLM extraction and a test set
- **Goal:** captions turned into structured place data.
- **Try:** send the caption to an LLM API and ask for JSON matching a schema (place name, area, category, confidence). Collect 20 real food/travel TikTok captions in a file as test cases and run them all.
- **Learn:** prompt design, structured outputs, and evaluating results against known answers.
- **Done when:** you can see how many of the 20 it gets right, and you have improved the prompt at least once.
- **Notes:** LLM provider decided via ADR 0001 (OpenAI, small-model tier — `gpt-5.4-mini`). 37 real TikTok captions in `services/worker/eval/cases/` (well past the 20-minimum), categories constrained to step 8's exact 7-value Postgres enum rather than a separate vocabulary. `extract.py` uses OpenAI Structured Outputs with a Pydantic schema so `category` can't be an invalid value even if the model "wants" to; explicit bounded-retry error handling distinguishes transient/quota/malformed failures. `run_eval.py` is the eval runner per the `extraction-eval` skill's convention, with a `--rescore` mode for verifying scorer-only fixes without spending API calls. Prompt iterated twice (v1→v2→v3), each change tied to a diagnosed failure pattern, not guessed: v1→v2 fixed null-name hallucination, category miscalibration (neighborhood/gallery/bar-named-place), and hashtag-vs-caption-text name preference, but introduced 4 new regressions the aggregate score masked (+3.5 real fixes, -3.0 new breaks, netting only +0.5) — caught by diffing every case individually instead of trusting the total, exactly the trap the eval convention warns about. v3 fixed those regressions (a rule-6 self-conflict between two category heuristics; two low-confidence hallucinations, fixed via both a prompt instruction and a code-level `MIN_CONFIDENCE` floor as defense in depth) plus a scorer bug (Unicode normalization stripped non-Latin scripts entirely, making correct Korean-script extractions unmatchable) — which itself introduced a second scorer bug (word-order sensitivity on a bilingual name) fixed with an exact word-set equality check. Final score: **51/54 (94.4%)**, up from a 47/54 (87.0%) v1 baseline. Real remaining gaps, accepted not chased: one case's aside-recommendation extraction is inconsistent run-to-run (LLM non-determinism on a genuinely hard multi-item list, not a prompt bug); one hotel/rooftop-bar category is inherently ambiguous from the caption alone. Also hit and fixed, unrelated to extraction logic: a Windows console UTF-8 crash on non-Latin output (same class of bug as step 10's oEmbed script).

### [x] 12. Google Places lookup
- **Goal:** names turned into real places.
- **Try:** get a Google Maps Platform API key, set a budget alert, and call Places Text Search with the extracted name plus the area.
- **Learn:** API keys, billing safety, and matching messy text to real entities.
- **Done when:** your test captions resolve to real places with coordinates.
- **Notes:** New dedicated `outthegc` Google Cloud project (separate from an old unrelated project), Places API (New) enabled, key restricted to that one API (no application/IP restriction yet — deferred until the worker is actually hosted somewhere, step 20 territory), $10/month budget alert. `resolve_place.py` uses Text Search with field mask `id,displayName,formattedAddress,location` only — billed at Places' "Pro" SKU, which has a 5,000 free calls/month allowance; the full 45-call test run cost nothing against that. Two independent signals gate a `confident` vs `low_confidence` result: resolved-name similarity to the searched name, and step 11's own extraction confidence (floor 0.75, chosen from the real confidence spread across the test data) — a result failing either signal is surfaced as low-confidence rather than presented as certain, per "extraction never auto-pins." Tested against all 37 real eval captions end-to-end (reusing step 11's saved extraction output, $0 additional OpenAI cost): 41 confident, 4 correctly flagged low-confidence, 0 no-match, 1 skipped (an address-only candidate with no name text to search on — step 11's schema currently discards the actual address string, keeping only a broad area; a real gap, not fixed here). **Known, accepted limitation:** no destination bias exists yet, so a correctly-named-but-location-free search can resolve confidently to the wrong country (confirmed: "EL REY DEL PASTOR," a Mexico City taco stand with no caption location, resolved CONFIDENT to an unrelated same-named restaurant in Buford, GA). Needs Places' `locationBias`/`regionCode` params against a real trip destination — not fixable until step 14 wires extraction to an actual trip. No Supabase writes in this step (step 14's job); no job-queue/worker loop (step 13's job).

### [x] 13. Turn the script into a worker
- **Goal:** the pipeline runs on its own.
- **Try:** the worker watches the `posts` table for `pending` rows, runs steps 10 to 12, writes `post_candidates`, and sets status to `needs_confirmation` (or `failed`). Run it on your laptop.
- **Learn:** background jobs, job status, and handling failures and retries.
- **Done when:** inserting a post row in the dashboard produces candidates automatically.
- **Notes:** Job queue mechanism decided via ADR 0002 (simple polling, not pgmq). Required an unplanned migration first — `posts`/`post_candidates` didn't exist yet (no prior step created them); `status` is text+check (known to still change, cheap to redefine) while `source` is a real enum (closed value set, same reasoning as step 8's category enum). `post_candidates.selected` is structurally forced false by a CHECK constraint, not just an RLS gap — holds even against the service-role key, which bypasses RLS by design. `worker.py` is the first use of the Supabase service-role key in this project (trusted-backend credential, bypasses RLS, lives only in `services/worker/.env`, never the mobile app). Talks to Supabase over raw PostgREST calls (no `supabase-py` dependency — matches every other script in this directory). Three-bucket failure handling: an API-health error (quota exhausted, or still failing after extract.py's/resolve_place.py's own internal retries) fails just that post AND pauses the rest of that poll tick, since hitting the same wall repeatedly wastes calls for no new information; a malformed-response error (bad input for one specific caption) fails just that post and continues immediately; any undocumented exception does the same but logs loudly. Verified end to end with two real posts (different captions) inserted by hand in the dashboard — both picked up within the 7s poll interval, extracted, resolved, and landed real `post_candidates` rows with `confident` match quality, no manual script-running. Known gaps, flagged not fixed: no crash-recovery sweep for a post stuck in `processing` if the worker dies mid-job (the `processing` status and `updated_at` column exist specifically to support one later, not built this step); a write failure *after* extraction+resolution succeeds would strand a post in `processing` with the API cost already spent and no automatic retry of just the write.

### [x] 14. Paste a link in the app
- **Goal:** the full loop end to end.
- **Try:** add a "paste TikTok link" box in a trip. Show a processing state, then the confirm screen with checkboxes for each candidate. Confirmed places become pins.
- **Learn:** async UI states (loading, success, error) driven by database status.
- **Done when:** paste a link, confirm, and the pin appears on everyone's map.
- **Notes:** Biggest step yet, spanning three specialists and two security-review rounds. Key decisions: worker (not the app) fetches the caption via oEmbed when a post arrives URL-only (ADR territory-adjacent, recorded in Notes not a separate ADR); confirming a candidate goes through a `SECURITY DEFINER` RPC (`confirm_post_candidate`), not direct client writes (ADR 0003) -- a security review caught that plain client inserts would have left `places` (shared across every trip) poisonable by any signed-in user merging bad data onto a real place via a crafted caption, since `places.name` would have trusted the LLM-extracted name (traceable to attacker-controlled caption text) instead of Google's own resolved name. Fixed before ship: narrowed the step-8 `places` INSERT policy, added a dedicated `resolved_name` column the RPC trusts instead of the LLM's `name`, fixed a real `ON CONFLICT` ambiguity bug that would have failed every call, added the post-status re-check the ADR called for. Destination bias (step 12's known gap) closed via simple query-text append, not full geocoded `locationBias` -- cheap, closes the demonstrated failure case. Live testing found and fixed a second real bug same-session: an address-only caption (real street address, no business name) had nothing confirmable because `ExtractedPlace` only kept a coarse `area`, never the actual address text -- added a dedicated `address` field, `resolve_place.py` now searches on it directly. **Known, accepted limitation:** extraction is caption-only (TikTok oEmbed's `title` field, nothing else -- no audio, no on-screen text, no video analysis). Confirmed via live testing and competitor research (GeoTok/TokSpot/Venturr publicly read on-screen text + audio for exactly this reason; Plotline independently confirmed found a place from a caption with nothing in it) that this is a real ceiling, not a theoretical one -- logged in the Later list and the Log below as an elevated-priority next project, deliberately not pulled into this step's scope. Confirm screen's "manual search fallback" (spec's Confirm step) also deliberately deferred -- not built, flagged not silently dropped. Full 37-case eval re-run still owed after the address-field prompt change (only 2 targeted cases re-verified so far).

---

## Phase 4: Make it feel like a real app

### [ ] 15. Development build
- **Goal:** move off Expo Go so native features work.
- **Try:** set up EAS and make a development build for your phone. (iOS on a real device needs an Apple Developer account.)
- **Learn:** the difference between Expo Go and a custom build, and what native modules are.
- **Done when:** your app runs from its own icon on your phone.
- **Notes:**

### [ ] 16. Share from TikTok
- **Goal:** the core feature.
- **Try:** add a share extension. Sharing from TikTok opens a small sheet: pick a trip, send. The post enters the pipeline.
- **Learn:** share intents/extensions and how apps receive data from other apps.
- **Done when:** you share a TikTok from the TikTok app and it reaches the confirm screen.
- **Notes:**

### [ ] 17. Push notifications
- **Goal:** friends know when spots are added.
- **Try:** Expo Notifications. Notify trip members when someone adds pins, batched ("Buruk added 3 spots to Tokyo").
- **Learn:** push tokens, sending from the server, and batching.
- **Done when:** your second phone gets a notification after you add pins.
- **Notes:**

### [ ] 18. Screenshot upload
- **Goal:** the second input method.
- **Try:** pick images in the app, upload to Supabase Storage, and have the worker send them to a multimodal LLM. Delete the images after processing.
- **Learn:** file uploads, storage permissions, and multimodal prompts.
- **Done when:** a screenshot of a TikTok produces correct candidates.
- **Notes:**

---

## Phase 5: Ship a beta

### [ ] 19. Full sign in and account management
- **Goal:** everything the app stores need.
- **Try:** add Apple, Google, and phone sign in. Add account deletion (with the owner successor rule) and ownership transfer.
- **Learn:** OAuth providers, SMS costs, and app store requirements.
- **Done when:** all four sign in methods work and an account can be deleted cleanly.
- **Notes:**

### [ ] 20. Deploy and test with friends
- **Goal:** real users.
- **Try:** deploy the worker to a host. Add Sentry for crashes. Ship to TestFlight (iOS) and internal testing (Android). Plan a real trip with a friend group.
- **Learn:** production environments, monitoring, and real feedback.
- **Done when:** a friend group plans a trip in the app without your help.
- **Notes:**

---

## Later (unordered, add as needed)

- [ ] Web version with view only trip pages
- [ ] Instagram links
- [ ] Screen recordings (ffmpeg + Whisper) -- **partially superseded by ScrapeCreators (ADR 0005), not abandoned.** The audio-transcript half of this item's value is being delivered sooner via ScrapeCreators' TikTok transcript API (see Decisions, ADR 0005) instead of waiting for a self-built Whisper pipeline. What's still genuinely "Later" and NOT covered by ScrapeCreators: on-screen/burned-in text (OCR), and screen recording as an input method for posts that aren't TikTok links at all (Instagram, or a TikTok that's since been deleted). Revisit this item's scope once ScrapeCreators is wired in -- it may shrink to "OCR only," not the full original pipeline.
- [ ] Hotel locations
- [ ] Suggestions within a radius
- [ ] Money splitting with currency conversion

---

## Log

Use this for anything that doesn't fit a step: bugs that took hours, ideas, things to revisit.

- `react-native-maps` (step 3) hard-crashes the web build (`codegenNativeComponent is not a function`) -- not just ugly, doesn't render at all. Left unaddressed; web is explicitly secondary per CLAUDE.md.
- Security review after step 5 surfaced a few things deliberately deferred, not forgotten:
  - **Refresh tokens sit in plaintext in AsyncStorage** (Supabase's documented default for Expo). Fine for now; before a real beta (step 20-ish), switch to `expo-secure-store` with the "LargeSecureStore" wrapper pattern from Supabase's docs, since SecureStore alone has a ~2KB size limit a session can exceed.
  - **`profiles` UPDATE policy doesn't constrain column values** -- no length limit on `display_name`, no validation on `avatar_url`, `username` isn't unique/normalized. Not exploitable yet since no UI writes these columns. Revisit (CHECK constraints, or route writes through a validated RPC) once profile editing actually ships.
  - **`app.json`'s `scheme` is `"mobile"`** -- generic, another app could claim it. Harmless today (no OAuth/magic-link redirects use it), but rename to something unique before step 19 adds Apple/Google sign-in.
  - **`auth.site_url` is still `http://127.0.0.1:3000`** -- confirmation still works (the email link hits Supabase's own verify endpoint first), but the post-confirm redirect lands on a dead local page. Cosmetic; fix once there's a real redirect destination to point to.
  - **Profile visibility beyond "own row only"** is still an open spec question (can co-members see each other's username/avatar?) -- current policy is maximally conservative (`auth.uid() = id`) on purpose; revisit when `trip_members` exists in step 6.
- Step 7 (invite codes) deliberately deferred, per the developer's "do the suggested ones for now" call:
  - **No code expiration.** A code works forever once generated.
  - **No owner reset/revoke.** The owner can't currently invalidate a leaked code -- there's no trip-settings screen to put that button on yet (not itemized in any of the 20 roadmap steps, worth noticing when one gets added).
  - **No app-level rate limiting on `join_trip_by_code` beyond the code's own entropy** (32^8 combinations). A wrong code returns a distinct, guessable-against SQLSTATE (22023), so it is technically a clean oracle for brute-forcing -- impractical at this keyspace size today, but worth a real decision before any kind of public/wide beta.
  - **`archived_at` check in `join_trip_by_code`** -- flagged with a TODO directly in the function's migration; needs `and archived_at is null` added once a future step adds trip archiving (no column exists yet).
  - **Signed-out invite links drop their destination.** Tapping `outthegc://join/<code>` while signed out hits the same `Stack.Protected` guard as everything else and redirects to sign-in -- the pending code isn't persisted through that redirect, so the person has to find the invite again after signing up. Fine for now (every tester has an account already), but worth a real decision before invite links go to people who don't have the app yet.
  - **The share link isn't tappable yet.** `outthegc://join/<code>` only opens the app once a real build exists (Expo Go doesn't register custom schemes) -- works correctly once step 15 lands, not a bug now.
- Step 14 live testing (2026-10-10) found a real extraction gap, fixed same-session: a caption with a genuine street address but no business name (`📍 1 Chome-23-10 Jinnan, Shibuya...`) correctly triggered extraction's "address-only" rule but had nothing confirmable to show, because `ExtractedPlace` only ever carried a coarse `area`, never the actual address text. Fixed by adding a dedicated `address` field (`extract.py`) that `resolve_place.py` now searches on directly when there's no business name, instead of skipping. Verified against the real failure case and against eval case 018 (same shape) -- both now resolve correctly. Full 37-case eval re-run still owed before calling this broadly validated (only 2 targeted cases re-tested so far, budget-aware).
- Same testing surfaced a bigger, structural finding: caption-only extraction (TikTok's oEmbed, the only signal currently used) has a real ceiling -- a caption can describe a place as "this hidden gem" with the actual name only ever shown as on-screen text or spoken in the video, which is invisible to the current pipeline entirely, not just hard to extract. Confirmed real competitors (GeoTok, TokSpot, Venturr) explicitly read on-screen text (OCR) and audio (Whisper) for exactly this reason; separately confirmed firsthand that Plotline (a competitor) found a place from a TikTok with nothing in the caption. Decision (2026-10-10, revised same day -- see next entry): initially planned to ship step 14 caption-only and build a self-hosted Whisper/ffmpeg pipeline later.
- **Revised same day**: rather than wait for the self-built audio pipeline, decided to add TikTok video transcripts via a third-party scraping API (ScrapeCreators) now -- this reverses the project's original "no server-side scraping of TikTok/Instagram" decision. Backfilled that original decision and superseded it properly: `docs/decisions/0004-no-serverside-scraping.md` (backfill) and `docs/decisions/0005-scrapecreators-for-transcripts.md` (the new decision, with the full options comparison against Social Fetch/Apify/EnsembleData/Bright Data-Oxylabs, and the ToS/reliability risk stated plainly, accepted knowingly). oEmbed is kept, not replaced -- it's free and already covers caption; ScrapeCreators is additive, for transcript only. Still does NOT cover on-screen/burned-in text -- that's still the self-built OCR pipeline's job, now a smaller remaining scope than originally planned.
- **Built and verified (2026-10-10):** `transcript.py` (fetch + WebVTT-to-plain-text parsing), `extract.py`'s prompt redesigned for two-source reconciliation (caption vs. transcript precedence, waypoint/landmark distinction, source-agreement confidence), `worker.py` wired to fetch transcript after oEmbed and degrade gracefully to caption-only on any transcript-specific failure (never pauses the tick or fails the post over a non-load-bearing enrichment call). Eval set refreshed with 15 real transcripts (22/37 cases have placeholder, non-video URLs and were correctly skipped rather than burning calls on a known-bad result); full re-run found and fixed 3 real prompt regressions via honest case-by-case diagnosis (not trusting the aggregate), landing at 49/54 apples-to-apples vs. the 51/54 caption-only baseline -- the gap is one stale test oracle (case 025, flagged above) and one case of genuine LLM nondeterminism, not a real quality drop. Case `011`'s ground truth legitimately grew 7->12 expected entries: the real transcript named 5 real NYC pizza spots the caption never mentioned at all -- the clearest concrete proof this whole change delivers what it was for. A `tiktok_transcript_cache` table (keyed by normalized video URL, closes over duplicate shares of the same video across posts/trips) was added afterward and verified live: pasting the same TikTok twice showed a real 1-credit fetch the first time and a confirmed 0-credit cache hit the second time, identical transcript both times.
- **Confirmed real ScrapeCreators reliability gap (2026-10-10), via live testing, not speculation.** A real TikTok (`@memarcog/video/7642631293443771669`) with genuine spoken dialogue (developer-confirmed by ear) returned `outcome: empty` from the transcript API three separate ways: the default call, an explicit `use_ai_as_fallback=true` retry (still only charged the base 1 credit, not the documented +10 -- meaning the AI fallback path likely never actually ran, probably because the video exceeds the undocumented "under 2 minutes" eligibility window), and a retry via the canonical long-form URL (ruling out short-link resolution as the cause). Checked ScrapeCreators' own docs directly (not from memory) for an explanation -- they document no reason a transcript can come back empty, don't clarify what "2 minutes" actually measures or what happens past it, and don't explain their underlying transcription method at all. This is exactly the reliability risk ADR 0005 flagged going in ("TikTok can detect/block the scraping vendor... service could degrade... without notice") -- now a confirmed real instance, not a theoretical one. Other videos in the same session transcribed correctly (`@thetokyocamera`'s video got a full, accurate transcript), so this is inconsistent/per-video reliability, not a systemic outage. No fix applied -- worker.py's existing degrade-to-caption-only behavior already handles this gracefully (this post still produced a result from caption alone), so nothing broke, but worth knowing the transcript signal has real, silent gaps on some real videos.
-
