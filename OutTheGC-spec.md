# OutTheGC

Product spec, v0.1 (draft)

## Overview

OutTheGC turns the TikToks and Reels friends send each other into a shared trip map. A user shares a post into the app, the app extracts the place, and pins it to a trip the whole group can see. The goal: get plans out of the group chat and into something the group can actually use.

## Feature priorities

| Priority | Feature |
|---|---|
| High | Send TikToks (and Instagram posts) into the app |
| High | Save places on a map |
| High | Trip based organization |
| High | Group based organization |
| High | Trip specific groups |
| High (moved up from mid) | Label video types (food, views, entertainment). Comes nearly free from the extraction step |
| Low | Money splitting with currency conversion |
| Low | Hotel locations |
| Low | Suggestions based on radius |

## Decisions so far

- **Platform:** mobile first (iOS + Android), web secondary. One codebase with Expo (React Native).
- **Input methods:** shared link (via share sheet), screenshots, screen recordings. No server side downloading of videos from TikTok or Instagram.
- **Extraction:** caption and metadata first. LLM returns structured JSON. The user confirms every result.
- **Places:** Google Places API for resolving names to real places.
- **Backend:** Supabase (Postgres, PostGIS, auth, row level security, realtime).
- **Processing worker:** Python service (ffmpeg, Whisper, LLM API) behind a job queue.
- **Retention:** uploaded media is processed then deleted. Only extracted data and a link to the original post are kept.
- **Core user:** friend groups planning trips.
- **Trips and groups:** every trip is its own group. There is no separate group object; members belong to trips directly.
- **Sign in:** Apple, Google, phone number, and email.
- **Pinning:** extraction never auto pins. The user always confirms the place before it is saved.
- **Joining a trip:** invite link or a join code.
- **Share flow:** the user picks the trip in the share sheet before the post is saved.
- **Multiple places in one post:** show every extracted place; the user checks which ones to save.
- **Launch platform:** TikTok only. Instagram comes later.
- **Duplicate places:** the same place saved more than once in a trip merges into one pin. The pin shows how many people saved it, from any source (TikTok, screenshot, manual add), and links every post about it.
- **Map views:** a toggle between "my saves" and "the whole group's saves". No visited status, votes, comments, or itinerary at launch.
- **Roles:** one owner plus members. The owner manages trip settings and members. The owner must pick a successor before leaving the trip or deleting their account.
- **Editing pins:** anyone on the trip can edit a pin. Deleting offers two choices: remove my save (the pin disappears once nobody has it saved) or delete it for everyone.
- **Deleted accounts:** places a person added stay on the trip, credited to "former member".
- **Chat:** no in-app chat. The app sits next to the group chat, but TikToks get sent to the app instead of the GC, so places don't get lost in the chat.
- **Directions:** hand off to Google Maps or Apple Maps.
- **Trip end:** trips get archived (read-only, still viewable).

## Pipeline

1. **Input:** link from share sheet, screenshots, or screen recording.
2. **Gather:** link gives caption, hashtags, author (TikTok oEmbed first; Instagram needs a Meta developer app). Screenshots go straight to a multimodal LLM. Recordings are split into frames (ffmpeg) and audio (Whisper).
3. **Extract:** LLM returns JSON: place name, area, category, price, notes, confidence.
4. **Resolve:** Google Places Text Search, biased to the trip destination.
5. **Confirm:** the user always confirms. Show the best match first, other candidates below, and manual search as a fallback.
6. **Save:** pin stored on the trip, visible to all trip members.

## Data model (v0.2)

| Table | One row is | Key columns |
|---|---|---|
| `profiles` | a user | id (same as the Auth user id), username, display_name, avatar_url |
| `trips` | a trip, which is also the group | name, destination, start_date, end_date, owner_id, invite_code, archived_at |
| `trip_members` | a person on a trip | trip_id, user_id, joined_at |
| `posts` | one share or upload (also the processing job) | trip_id, added_by, source (tiktok, screenshot, recording, manual), url, caption, status |
| `post_candidates` | a place the extraction found, waiting on the confirm screen | post_id, name, google_place_id, confidence, selected |
| `places` | a real world place, shared across all trips | google_place_id (unique), name, address, location (PostGIS point) |
| `trip_places` | a pin: one place on one trip, merged | trip_id, place_id, category, notes; unique on (trip_id, place_id) |
| `saves` | one person saving a pin | trip_place_id, user_id (null if account deleted); unique on (trip_place_id, user_id) |
| `post_places` | which posts mention which pin | post_id, trip_place_id |
| `expenses`, `expense_splits` | money splitting | low priority, designed later |

How the decisions map to tables:

- **Merged pins:** `trip_places` is unique per trip and place, so a second share of the same restaurant adds a `saves` row and a `post_places` row instead of a new pin.
- **"Saved by N people":** count of `saves` rows for the pin.
- **My saves vs group:** "mine" filters pins by `saves.user_id = me`; "group" shows every `trip_places` row.
- **Remove my save:** delete my `saves` row. When a pin has zero saves, it is deleted.
- **Delete for everyone:** delete the `trip_places` row; its saves and post links go with it.
- **Owner:** stored on `trips.owner_id`, so there is exactly one. Transferring ownership updates that column.
- **Deleted account:** `saves.user_id` and `posts.added_by` become null and display as "former member".
- **Archived trip:** `archived_at` is set; permission rules block edits.

Permission rules (row level security), in plain terms:

- You can see a trip and everything on it only if you are in `trip_members`.
- Any member can add posts, edit pins, save, unsave, and delete pins.
- Only the owner can rename the trip, change dates, remove members, reset the invite code, archive, or transfer ownership.
- Joining requires a valid invite code.
- Nobody can edit an archived trip.

## Build order

See OutTheGC-roadmap.md for the step by step build plan.

---

## Open questions

### 1. Product and users
- Is there a personal map outside of any trip ("my saved places")?
- Launch region: US only at first? Any specific cities to test with?
- Business model: free, freemium, ads, affiliate links (hotels, reservations), or undecided?
- Is this solo, or will anyone build it with you? Target timeline for a first beta?

### 2. Groups and trips
- Starting a new trip with the same friends: a "duplicate members from a past trip" shortcut?
- Do invite links and codes expire, and can the owner turn them off?
- Roles: owner/admin/member? Who can delete or edit someone else's pin?
- Archive automatically after the end date, or manually by the owner?
- Can a place saved in one trip be copied to another?

### 3. Sharing posts in
- Should the share sheet let you create a new trip on the spot?
- Should sharing work without fully opening the app (quick share sheet UI)?
- Should the original post be viewable in the app (embedded) or just linked?

### 4. Extraction
- Which fields matter most: name, address, category, price, hours, dishes/items, vibe, tips?
- ~~Which categories at launch?~~ Decided at step 8: `food, views, entertainment, stay, shopping, nightlife, other` as a Postgres ENUM on `trip_places.category`.
- LLM provider and a cost ceiling per post?

### 5. Map and places
- Pin style per category (color, icon)?
- Is "visited" per person or shared across the whole trip?
- Google Maps everywhere, or Apple Maps on iOS?
- Later: votes, comments, day by day itinerary?

### 6. Social and notifications
- What does a trip invite link look like when pasted somewhere (link preview card)?
- Notifications: new pin added, someone voted, trip starting soon?
- Activity feed per trip?

### 7. Accounts and privacy
- Profiles: username, avatar, anything public?
- Can trips be made public or shared via a view-only link?
- Account deletion in app (required by Apple) and data export?

### 8. Web
- Full web app, or view-only trip links that open in a browser?

### 9. Money (low priority)
- Split types: equal, by amount, by percentage, by item?
- Settle up tracking, or just "who owes who"?
- Payment links (Venmo, Cash App) or no payments at all?

### 10. Design and brand
- Look and feel: any apps you want it to feel like?
- Light, dark, or both? Brand colors?
- Tone of copy: playful, clean, minimal?

### 11. Operations
- Where to host the processing worker (Railway, Fly.io, Render)?
- Analytics and crash reporting (PostHog, Sentry)?
- Beta testing through TestFlight with friend groups?
