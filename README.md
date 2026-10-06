# OutTheGC

OutTheGC turns the TikToks and Reels friends send each other into a shared trip map. Someone shares a post into the app, the app extracts the place, and pins it to a trip the whole group can see — so plans stop getting lost in the group chat.

Mobile app (iOS + Android, Expo/React Native) backed by Supabase (Postgres, PostGIS, Auth, Row Level Security), with a Python worker that extracts places from posts via an LLM and resolves them with Google Places.
