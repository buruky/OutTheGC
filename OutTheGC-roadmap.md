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

### [ ] 2. Screens and navigation
- **Goal:** the app's skeleton with fake data.
- **Try:** with Expo Router, make tabs for Trips and Profile, plus a trip detail screen at `app/trip/[id].tsx`. Show a hardcoded list of 2 or 3 trips; tapping one opens its detail screen.
- **Learn:** file based routing, components, props, and passing an id through a route.
- **Done when:** you can tap from the trip list into a trip and back.
- **Notes:**

### [ ] 3. The map
- **Goal:** pins on a real map.
- **Try:** add `react-native-maps` to the trip screen. Put 5 hardcoded pins near a city. Tapping a pin shows the place name in a card at the bottom.
- **Learn:** coordinates (latitude, longitude), map regions, and component state (`useState`) for "which pin is selected".
- **Done when:** the map shows your pins and tapping one updates the card.
- **Notes:**

---

## Phase 2: Real data with Supabase

### [ ] 4. Connect Supabase
- **Goal:** the app talks to a real database.
- **Try:** create a Supabase project. Install the Supabase CLI and link it to the project. Write your first migration creating a simple `trips` table, push it, add a row in the dashboard, and read it from the app with `supabase-js`.
- **Learn:** SQL tables, migrations (schema changes saved as files in git), and keeping keys in environment variables.
- **Done when:** the trip list in the app comes from the database, not hardcoded data.
- **Notes:**

### [ ] 5. Sign in
- **Goal:** real accounts.
- **Try:** add email sign in with Supabase Auth. Create a `profiles` table filled in when someone signs up. Keep people signed in after they close the app. Add sign out.
- **Learn:** sessions, auth state, and protected screens (signed out users only see the sign in screen).
- **Done when:** you can sign up, close the app, reopen, and still be signed in.
- **Notes:**

### [ ] 6. Trips with permissions
- **Goal:** each person only sees their own trips.
- **Try:** add `trip_members` and `owner_id`. Build "create trip" in the app. Write row level security policies so you can only read trips you belong to. Test with two accounts on two devices (or a phone and a simulator).
- **Learn:** row level security, the core of the whole permission system.
- **Done when:** account A cannot see account B's trip, even by guessing its id.
- **Notes:**

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

-
