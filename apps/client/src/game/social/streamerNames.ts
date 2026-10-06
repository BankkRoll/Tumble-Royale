/**
 * Streamer Mode for the names the game itself writes into toasts,
 * notifications and dialogs (the UI masks what it renders on its own).
 *
 * Responsibilities:
 * - read the current Streamer Mode setting;
 * - name another account in toast text, masked while streaming;
 * - turn a loaded profile card into its masked form.
 */
import { maskedName, MASKED_TAG, streamerSafeAccountLabel, ui, type ProfileData } from '@tumble/ui';

/** True while Settings → Streamer mode is on. */
export function streamerMode(): boolean {
  return ui.getState().settings.gameplay.streamerMode;
}

/** Another player as realtime events and API answers name them. */
export interface OtherPlayer {
  userId?: string;
  name?: string;
  tag?: string;
}

/**
 * Another player's name for a toast, notification or dialog.
 *
 * @param p - The player, when the event named one.
 * @param fallback - Used when there is no name (or no account id to mask by).
 * @param withTag - Append `#tag` (`#••••` while streaming).
 * @param streamer - Streamer Mode (defaults to the current setting).
 * @returns The text to show.
 * @example
 * otherPlayerName(from, 'Someone', true); // 'Wobbleton#0420', or 'Tumbler 417#••••' while streaming
 */
export function otherPlayerName(
  p: OtherPlayer | null | undefined,
  fallback: string,
  withTag = false,
  streamer = streamerMode(),
): string {
  if (!p?.name) return fallback;
  // SECURITY: without an account id there is nothing stable to mask by, so a
  // streamer gets the generic fallback rather than the real name.
  if (!p.userId) return streamer ? fallback : p.name;
  return streamerSafeAccountLabel(
    { userId: p.userId, name: p.name, ...(p.tag ? { tag: p.tag } : {}) },
    streamer,
    withTag,
  );
}

/**
 * A profile card opened from a masked name: it keeps that mask and hides
 * the tag, so View profile cannot undo Streamer Mode.
 *
 * @param card - The loaded card.
 * @param label - The masked name the player clicked, if known.
 * @returns The card to show.
 */
export function maskedProfile(card: ProfileData, label?: string): ProfileData {
  return { ...card, name: label || maskedName(card.id), tag: MASKED_TAG, masked: true };
}
