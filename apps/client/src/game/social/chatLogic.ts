/**
 * Pure chat rules for the client: mapping UI quick-ping intents to preset ids,
 * seeded bot replies for offline shows, bubble text, and the mute-list format.
 *
 * Bot replies are cosmetic: they never touch the deterministic sim, and they
 * use their own seeded RNG so a replayed show stays identical.
 */
import type { Rng } from '@tumble/shared';
import { quickChat } from '@tumble/shared';

/**
 * Turns a `quickPing` intent's `kind` into a preset id.
 *
 * @param kind - `go` from the emote wheel (`ping:` stripped), or a full id like `cam:gg`.
 * @returns The preset id, or null when it is not a preset.
 * @example
 * quickChatId('watch'); // 'ping:watch'
 * quickChatId('cam:wow'); // 'cam:wow'
 */
export function quickChatId(kind: string): string | null {
  const id = kind.includes(':') ? kind : `ping:${kind}`;
  return quickChat(id) ? id : null;
}

/** Which presets bots answer a ping with. */
const BOT_REPLIES: Readonly<Record<string, readonly string[]>> = {
  'ping:go': ['ping:go', 'ping:nice'],
  'ping:watch': ['ping:nice', 'ping:watch'],
  'ping:nice': ['ping:nice', 'ping:gg'],
  'ping:gg': ['ping:gg', 'cam:gg'],
  'cam:gg': ['cam:gg', 'ping:gg'],
  'cam:wow': ['cam:wow', 'ping:nice'],
  'cam:next': ['cam:gg', 'ping:nice'],
};

/** A scheduled bot reply. */
export interface BotReply {
  botId: number;
  presetId: string;
  delayMs: number;
}

/**
 * Picks zero to two bots to answer the player's ping.
 *
 * @param rng - Cosmetic RNG (never the sim's).
 * @param trigger - The player's preset id.
 * @param bots - Candidate bot ids (still in the show).
 * @returns Replies in delay order.
 */
export function planBotReplies(rng: Rng, trigger: string, bots: readonly number[]): BotReply[] {
  const options = BOT_REPLIES[trigger];
  if (!options || bots.length === 0) return [];
  const pool = rng.shuffle([...bots]);
  const out: BotReply[] = [];
  const odds = [0.65, 0.3];
  for (let i = 0; i < odds.length && i < pool.length; i++) {
    if (!rng.chance(odds[i]!)) break;
    out.push({
      botId: pool[i]!,
      presetId: rng.pick(options),
      delayMs: Math.round(rng.range(700, 2400)) + i * 600,
    });
  }
  return out.sort((a, b) => a.delayMs - b.delayMs);
}

/** Characters that fit a speech bubble before it is cut with an ellipsis. */
export const BUBBLE_CHARS = 26;

/**
 * Shortens chat text for a speech bubble.
 *
 * @param text - Display text.
 */
export function bubbleText(text: string): string {
  const chars = [...text];
  return chars.length <= BUBBLE_CHARS
    ? text
    : `${chars
        .slice(0, BUBBLE_CHARS - 1)
        .join('')
        .trimEnd()}…`;
}

/**
 * The mute key for a player: the account id when known, else their name.
 *
 * @param p - Player identity.
 */
export function muteKey(p: { userId?: string | undefined; name: string }): string {
  return p.userId ?? `name:${p.name}`;
}

/** Most mutes kept in storage (oldest drop first). */
export const MAX_MUTES = 500;

/**
 * Adds or removes a key from a mute list.
 *
 * @param list - Current keys.
 * @param key - Player key.
 * @param muted - Desired state.
 */
export function toggleMute(list: readonly string[], key: string, muted: boolean): string[] {
  const rest = list.filter((k) => k !== key);
  return muted ? [...rest, key].slice(-MAX_MUTES) : rest;
}
