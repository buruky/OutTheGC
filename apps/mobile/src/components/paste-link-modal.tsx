import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrimaryButton } from './primary-button';
import { TextField } from './text-field';
import { ThemedText } from './themed-text';
import { ThemedView } from './themed-view';

import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { TripPlaceCategory } from '@/services/places';
import {
  confirmPostCandidate,
  createTikTokPost,
  fetchPostCandidates,
  fetchPostStatus,
  type PostCandidateRow,
} from '@/services/posts';

type Stage = 'paste' | 'processing' | 'confirm' | 'failed';

// Responsive enough to feel live for a pipeline run that takes a handful of
// seconds, without hammering Supabase — matches worker.py's own
// POLL_INTERVAL_SECONDS reasoning, scaled down since this is polling one
// row, not a whole queue.
const POLL_INTERVAL_MS = 3000;

// Basic sanity check only, per the brief — doesn't duplicate the worker's own
// validate_tiktok_url (oembed_caption.py). A non-TikTok or malformed-but-
// URL-shaped link still ends this post up status=failed, which this modal
// already has to handle (the 'failed' stage) regardless.
function looksLikeUrl(value: string): boolean {
  return /^https?:\/\/\S+\.\S+/i.test(value.trim());
}

const MATCH_QUALITY_RANK: Record<PostCandidateRow['match_quality'], number> = {
  confident: 0,
  low_confidence: 1,
  no_match: 2,
  skipped_no_name: 2,
};

/** Best match first: confident, then low_confidence, then confidence descending within each. */
function sortCandidates(rows: PostCandidateRow[]): PostCandidateRow[] {
  return [...rows].sort((a, b) => {
    const rankDiff = MATCH_QUALITY_RANK[a.match_quality] - MATCH_QUALITY_RANK[b.match_quality];
    return rankDiff !== 0 ? rankDiff : b.confidence - a.confidence;
  });
}

/** no_match/skipped_no_name candidates have no google_place_id/lat/lng — the RPC rejects confirming one. */
function isConfirmable(candidate: PostCandidateRow): boolean {
  return candidate.match_quality !== 'no_match' && candidate.match_quality !== 'skipped_no_name';
}

function formatCategoryLabel(category: TripPlaceCategory): string {
  return category.charAt(0).toUpperCase() + category.slice(1);
}

type PasteLinkModalProps = {
  visible: boolean;
  tripId: string;
  userId: string | undefined;
  onClose: () => void;
  /** Called once any candidate has been confirmed, so the caller can refetch pins. */
  onConfirmed: () => void;
};

/**
 * Step 14's "paste a link" flow: paste -> processing (polled) -> confirm
 * (checkboxes) -> failed. A single self-contained modal rather than a new
 * route, matching the trip screen's existing "+ Add a place" modal pattern
 * — this one just has more internal stages.
 */
export function PasteLinkModal({ visible, tripId, userId, onClose, onConfirmed }: PasteLinkModalProps) {
  const theme = useTheme();

  const [stage, setStage] = useState<Stage>('paste');
  const [url, setUrl] = useState('');
  const [postId, setPostId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<PostCandidateRow[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [submitStatus, setSubmitStatus] = useState<'idle' | 'submitting'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Candidates already confirmed this session — lets a retry after a
  // partial failure skip re-confirming ones that already succeeded, instead
  // of just re-running (which would also be safe/idempotent, just wasteful).
  const confirmedIds = useRef<Set<string>>(new Set());

  // Fresh state every time the modal is opened — the caller remounts this
  // component on each open (a changing `key` prop, see the trip screen),
  // rather than this effect resetting state here directly: an effect that
  // calls setState unconditionally in its body (not from inside an async
  // callback) triggers an extra cascading render for no benefit, which the
  // lint rule this project follows (react-hooks/set-state-in-effect) flags.
  // Remount-via-key gives the same "fresh state on open" result with React's
  // own initial-render path instead.

  const handleSubmitUrl = useCallback(() => {
    if (!userId) return;
    const trimmed = url.trim();
    if (!looksLikeUrl(trimmed)) {
      setErrorMessage("That doesn't look like a link.");
      return;
    }
    setErrorMessage(null);
    setSubmitStatus('submitting');
    createTikTokPost(tripId, userId, trimmed)
      .then(({ id }) => {
        setPostId(id);
        setStage('processing');
        setSubmitStatus('idle');
      })
      .catch((err: unknown) => {
        setErrorMessage(err instanceof Error ? err.message : 'Something went wrong.');
        setSubmitStatus('idle');
      });
  }, [tripId, userId, url]);

  // Processing state: poll this one post's status every ~3s until it moves
  // off pending/processing (decision: simple polling, not Realtime — see
  // the step 14 brief; posts/post_candidates aren't in the realtime
  // publication). Scoped to `visible && stage === 'processing'`, not plain
  // mount/unmount — RN's Modal keeps its children mounted while hidden, so
  // the interval has to be torn down on close too, or it'd keep polling (and
  // eventually setState on a hidden modal) after the user dismisses it.
  useEffect(() => {
    if (!visible || stage !== 'processing' || !postId) return;

    let cancelled = false;

    const poll = () => {
      fetchPostStatus(postId)
        .then((status) => {
          if (cancelled) return;
          if (status === 'needs_confirmation') {
            return fetchPostCandidates(postId).then((rows) => {
              if (cancelled) return;
              setCandidates(sortCandidates(rows));
              setStage('confirm');
            });
          }
          if (status === 'failed') {
            setStage('failed');
          }
          // pending/processing: keep polling. (confirmed isn't reachable yet
          // — nothing in this step's scope sets it — but if it ever is,
          // there's nothing this modal needs to show differently for it.)
        })
        .catch(() => {
          // A network/Supabase blip on the poll itself — ignore and retry
          // next tick rather than failing the whole flow over one missed poll.
        });
    };

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [visible, stage, postId]);

  const toggleCandidate = useCallback((candidate: PostCandidateRow) => {
    if (!isConfirmable(candidate)) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(candidate.id)) next.delete(candidate.id);
      else next.add(candidate.id);
      return next;
    });
  }, []);

  const handleConfirmSelected = useCallback(() => {
    if (selectedIds.size === 0 || submitStatus === 'submitting') return;
    setSubmitStatus('submitting');
    setErrorMessage(null);

    const idsToConfirm = Array.from(selectedIds).filter((candidateId) => !confirmedIds.current.has(candidateId));

    // Sequential, one RPC call per candidate — the RPC takes one id at a
    // time by design. Stops at the first error so a retry only has to
    // redo what didn't already succeed (confirmedIds tracks that).
    const confirmSequentially = async () => {
      for (const candidateId of idsToConfirm) {
        await confirmPostCandidate(candidateId);
        confirmedIds.current.add(candidateId);
      }
    };

    confirmSequentially()
      .then(() => {
        onConfirmed();
        onClose();
      })
      .catch((err: unknown) => {
        setErrorMessage(err instanceof Error ? err.message : 'Something went wrong adding a place.');
        setSubmitStatus('idle');
      });
  }, [selectedIds, submitStatus, onConfirmed, onClose]);

  const handleRetryPaste = useCallback(() => {
    setStage('paste');
    setUrl('');
    setPostId(null);
    setErrorMessage(null);
  }, []);

  const handleClose = useCallback(() => {
    if (submitStatus === 'submitting') return;
    onClose();
  }, [submitStatus, onClose]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <ThemedView style={styles.container}>
        <SafeAreaView style={styles.safeArea} edges={['top', 'bottom', 'left', 'right']}>
          <ThemedView style={styles.header}>
            <ThemedText type="subtitle">Paste a TikTok link</ThemedText>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              accessibilityState={{ disabled: submitStatus === 'submitting' }}
              disabled={submitStatus === 'submitting'}
              onPress={handleClose}
              style={({ pressed }) => [
                styles.closeButton,
                pressed && submitStatus !== 'submitting' && styles.pressed,
                submitStatus === 'submitting' && styles.disabled,
              ]}>
              <ThemedText type="link">Close</ThemedText>
            </Pressable>
          </ThemedView>

          {stage === 'paste' && (
            <ThemedView style={styles.form}>
              <TextField
                label="TikTok link"
                value={url}
                onChangeText={setUrl}
                placeholder="https://www.tiktok.com/@..."
                autoFocus
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
              {errorMessage && (
                <ThemedText type="small" themeColor="textSecondary">
                  {errorMessage}
                </ThemedText>
              )}
              <PrimaryButton
                label="Find this place"
                onPress={handleSubmitUrl}
                loading={submitStatus === 'submitting'}
                disabled={submitStatus === 'submitting'}
              />
            </ThemedView>
          )}

          {stage === 'processing' && (
            <ThemedView style={[styles.form, styles.centered]}>
              <ActivityIndicator accessibilityLabel="Processing link" />
              <ThemedText type="small" themeColor="textSecondary">
                Looking for a place in this video…
              </ThemedText>
            </ThemedView>
          )}

          {stage === 'failed' && (
            <ThemedView style={[styles.form, styles.centered]}>
              <ThemedText type="default">Couldn&apos;t process this link.</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                It might be private, deleted, or not a TikTok video.
              </ThemedText>
              <PrimaryButton label="Try another link" onPress={handleRetryPaste} />
            </ThemedView>
          )}

          {stage === 'confirm' && (
            <ThemedView style={styles.form}>
              {candidates.length === 0 ? (
                <ThemedText type="small" themeColor="textSecondary">
                  No places found in this video.
                </ThemedText>
              ) : (
                candidates.map((candidate) => {
                  const confirmable = isConfirmable(candidate);
                  const checked = selectedIds.has(candidate.id);
                  const name = candidate.resolved_name ?? candidate.name ?? '(unnamed place)';
                  return (
                    <Pressable
                      key={candidate.id}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked, disabled: !confirmable }}
                      accessibilityLabel={
                        confirmable
                          ? `${name}, ${formatCategoryLabel(candidate.category)}`
                          : `${name}, couldn't find a match`
                      }
                      disabled={!confirmable}
                      onPress={() => toggleCandidate(candidate)}
                      style={({ pressed }) => [
                        styles.candidateRow,
                        { backgroundColor: theme.backgroundElement },
                        pressed && confirmable && styles.pressed,
                        !confirmable && styles.disabled,
                      ]}>
                      <View
                        style={[
                          styles.checkbox,
                          { borderColor: theme.textSecondary },
                          checked && { backgroundColor: theme.backgroundSelected },
                        ]}>
                        {checked && <ThemedText type="smallBold">✓</ThemedText>}
                      </View>
                      <ThemedView style={styles.candidateInfo}>
                        <ThemedText type="smallBold">{name}</ThemedText>
                        {confirmable ? (
                          <>
                            <ThemedText type="small" themeColor="textSecondary">
                              {formatCategoryLabel(candidate.category)}
                            </ThemedText>
                            {candidate.formatted_address && (
                              <ThemedText type="small" themeColor="textSecondary">
                                {candidate.formatted_address}
                              </ThemedText>
                            )}
                          </>
                        ) : (
                          <ThemedText type="small" themeColor="textSecondary">
                            Couldn&apos;t find a match
                          </ThemedText>
                        )}
                      </ThemedView>
                    </Pressable>
                  );
                })
              )}

              {errorMessage && (
                <ThemedText type="small" themeColor="textSecondary">
                  {errorMessage}
                </ThemedText>
              )}

              <PrimaryButton
                label={
                  selectedIds.size > 0
                    ? `Add ${selectedIds.size} place${selectedIds.size === 1 ? '' : 's'}`
                    : 'Add to trip'
                }
                onPress={handleConfirmSelected}
                loading={submitStatus === 'submitting'}
                disabled={submitStatus === 'submitting' || selectedIds.size === 0}
              />
            </ThemedView>
          )}
        </SafeAreaView>
      </ThemedView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: Spacing.four,
  },
  closeButton: {
    minHeight: 44,
    minWidth: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.7,
  },
  disabled: {
    opacity: 0.5,
  },
  form: {
    paddingHorizontal: Spacing.four,
    gap: Spacing.three,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  candidateRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.three,
    padding: Spacing.three,
    borderRadius: Spacing.two,
    minHeight: 44,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderWidth: 2,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  candidateInfo: {
    flex: 1,
    gap: 2,
  },
});
