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

### [ ] 7. Invite codes
- **Goal:** friends can join a trip.
- **Try:** generate an `invite_code` per trip. Add a "join with code" screen. Then make an invite link that opens the app to the join screen.
- **Learn:** database functions (joining needs to bypass normal rules safely) and deep links.
- **Done when:** account B joins account A's trip with a code and sees it in their list.
- **Notes:**

### [ ] 8. Pins from the database
- **Goal:** the map shows real saved places.
- **Try:** add `places`, `trip_places`, and `saves`. Add a place by hand (type a name and coordinates for now). Show the "saved by N" count. Add the "my saves / group" toggle and "remove my save".
- **Learn:** join tables, unique constraints (how merging works), and PostGIS points.
- **Done when:** two accounts saving the same place on a trip creates one pin that says "saved by 2".
- **Notes:**

### [ ] 9. Live updates
- **Goal:** pins appear for everyone without refreshing.
- **Try:** subscribe to the trip's pins with Supabase Realtime.
- **Learn:** realtime subscriptions and keeping app state in sync with the database.
- **Done when:** a pin added on one phone appears on the other within a second or two.
- **Notes:**

---

## Phase 3: Extraction

### [ ] 10. Caption from a TikTok link
- **Goal:** the first piece of the pipeline, outside the app.
- **Try:** a Python script that takes a TikTok URL, calls TikTok's oEmbed endpoint, and prints the caption and author.
- **Learn:** calling an HTTP API from Python, reading JSON responses, and Python virtual environments.
- **Done when:** the script prints captions for 3 different TikToks.
- **Notes:**

### [ ] 11. LLM extraction and a test set
- **Goal:** captions turned into structured place data.
- **Try:** send the caption to an LLM API and ask for JSON matching a schema (place name, area, category, confidence). Collect 20 real food/travel TikTok captions in a file as test cases and run them all.
- **Learn:** prompt design, structured outputs, and evaluating results against known answers.
- **Done when:** you can see how many of the 20 it gets right, and you have improved the prompt at least once.
- **Notes:**

### [ ] 12. Google Places lookup
- **Goal:** names turned into real places.
- **Try:** get a Google Maps Platform API key, set a budget alert, and call Places Text Search with the extracted name plus the area.
- **Learn:** API keys, billing safety, and matching messy text to real entities.
- **Done when:** your test captions resolve to real places with coordinates.
- **Notes:**

### [ ] 13. Turn the script into a worker
- **Goal:** the pipeline runs on its own.
- **Try:** the worker watches the `posts` table for `pending` rows, runs steps 10 to 12, writes `post_candidates`, and sets status to `needs_confirmation` (or `failed`). Run it on your laptop.
- **Learn:** background jobs, job status, and handling failures and retries.
- **Done when:** inserting a post row in the dashboard produces candidates automatically.
- **Notes:**

### [ ] 14. Paste a link in the app
- **Goal:** the full loop end to end.
- **Try:** add a "paste TikTok link" box in a trip. Show a processing state, then the confirm screen with checkboxes for each candidate. Confirmed places become pins.
- **Learn:** async UI states (loading, success, error) driven by database status.
- **Done when:** paste a link, confirm, and the pin appears on everyone's map.
- **Notes:**

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
- [ ] Screen recordings (ffmpeg + Whisper)
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
-
