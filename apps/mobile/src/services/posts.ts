/**
 * Supabase queries for step 14's "paste a link" flow: `posts` (the job row —
 * a pasted TikTok link) and `post_candidates` (what extraction+resolution
 * found, waiting on confirmation), plus the `confirm_post_candidate` RPC
 * that turns a confirmed candidate into a real pin. Mirrors the live schema
 * in `supabase/migrations/20261009000000_add_posts_post_candidates.sql` and
 * `supabase/migrations/20261010000000_add_post_places_and_confirm.sql` —
 * update together if those change. Follows the same pattern as
 * `src/services/trips.ts`/`src/services/places.ts`.
 */
import { supabase } from '@/lib/supabase';
import type { TripPlaceCategory } from '@/services/places';

export type PostStatus = 'pending' | 'processing' | 'needs_confirmation' | 'confirmed' | 'failed';

export type PostCandidateMatchQuality = 'confident' | 'low_confidence' | 'no_match' | 'skipped_no_name';

export type PostCandidateRow = {
  id: string;
  post_id: string;
  /** LLM-extracted guess (may be null for a skipped_no_name candidate). */
  name: string | null;
  google_place_id: string | null;
  confidence: number;
  match_quality: PostCandidateMatchQuality;
  /** Google's own name — null unless match_quality is confident/low_confidence. */
  resolved_name: string | null;
  formatted_address: string | null;
  lat: number | null;
  lng: number | null;
  category: TripPlaceCategory;
  selected: boolean;
};

/**
 * Inserts a pending post for a pasted TikTok link. `caption` is left unset —
 * the worker fetches it itself via oEmbed (see `worker.py`'s `process_post`).
 * `added_by` is required by the posts INSERT policy's `with check`.
 */
export async function createTikTokPost(tripId: string, userId: string, url: string): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from('posts')
    .insert({ trip_id: tripId, added_by: userId, source: 'tiktok', url })
    .select('id')
    .single();

  if (error) throw error;
  return data;
}

/** Polled every ~3s by the processing-state UI until it leaves pending/processing. */
export async function fetchPostStatus(postId: string): Promise<PostStatus> {
  const { data, error } = await supabase.from('posts').select('status').eq('id', postId).single();

  if (error) throw error;
  return data.status as PostStatus;
}

/** Every candidate extraction found for one post. Caller sorts for display. */
export async function fetchPostCandidates(postId: string): Promise<PostCandidateRow[]> {
  const { data, error } = await supabase
    .from('post_candidates')
    .select(
      'id, post_id, name, google_place_id, confidence, match_quality, resolved_name, formatted_address, lat, lng, category, selected',
    )
    .eq('post_id', postId);

  if (error) throw error;
  return (data ?? []) as PostCandidateRow[];
}

export type ConfirmPostCandidateResult = { trip_place_id: string; is_new_pin: boolean };

/**
 * Wraps the `confirm_post_candidate` RPC (one candidate id at a time, by
 * design — not a batch call). Same `unknown`-typed-result situation as
 * `joinTripByCode` in `services/trips.ts` (no generated `Database` type
 * exists yet) — but this function is declared `returns table (...)`, so
 * (unlike `joinTripByCode`'s `.single()`) the raw response is an array even
 * for this one-row call; asserted accordingly rather than chaining `.single()`.
 */
export async function confirmPostCandidate(candidateId: string): Promise<ConfirmPostCandidateResult> {
  const { data, error } = await supabase.rpc('confirm_post_candidate', {
    p_post_candidate_id: candidateId,
  });

  if (error) throw error;
  const rows = data as ConfirmPostCandidateResult[];
  return rows[0];
}
