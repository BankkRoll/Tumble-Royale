/**
 * Chat rules shared by the game server (in-show chat), the API (party chat)
 * and the client (display filtering).
 *
 * Responsibilities:
 * - the quick-chat presets (emote-wheel pings, winner-cam lines): only these
 *   ids travel as quick chat, so they need no filtering;
 * - {@link sanitizeChatText}: length and control-character clamp;
 * - {@link filterChat}: what a server relays — slurs always masked, plus the
 *   fully masked variant for players with the chat filter on.
 */
import { maskAbuse, maskProfanity } from './profanity.ts';

/** Longest chat message accepted anywhere (characters). */
export const CHAT_MAX_LENGTH = 120;

/** A preset quick-chat line. */
export interface QuickChatPreset {
  /** Wire id (`ping:*` from the emote wheel, `cam:*` from the winner cam). */
  id: string;
  /** Text shown in bubbles and the feed. */
  text: string;
}

/** Every quick-chat preset, in emote-wheel then winner-cam order. */
export const QUICK_CHAT: readonly QuickChatPreset[] = [
  { id: 'ping:go', text: 'Go here!' },
  { id: 'ping:watch', text: 'Watch out!' },
  { id: 'ping:nice', text: 'Nice!' },
  { id: 'ping:gg', text: 'GG!' },
  { id: 'cam:gg', text: 'GG!' },
  { id: 'cam:wow', text: 'Wow!' },
  { id: 'cam:next', text: 'Next time…' },
];

const QUICK_BY_ID = new Map(QUICK_CHAT.map((p) => [p.id, p]));

/**
 * Looks up a quick-chat preset.
 *
 * @param id - Wire id.
 * @returns The preset, or undefined for anything not on the list.
 * @example
 * quickChat('ping:go')?.text; // 'Go here!'
 */
export function quickChat(id: unknown): QuickChatPreset | undefined {
  return typeof id === 'string' ? QUICK_BY_ID.get(id) : undefined;
}

/**
 * Clamps an untrusted chat string: control characters stripped, whitespace
 * collapsed, length capped.
 *
 * @param text - Anything a client sent.
 * @param maxLen - Cap in characters.
 * @returns The clean text, or null when nothing printable is left.
 */
export function sanitizeChatText(text: unknown, maxLen = CHAT_MAX_LENGTH): string | null {
  if (typeof text !== 'string') return null;
  const clean = text
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point.
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const capped = [...clean].slice(0, maxLen).join('');
  return capped.length > 0 ? capped : null;
}

/** What a server relays for one text message. */
export interface FilteredChat {
  /** Text with slurs masked; shown to players who turned the chat filter off. */
  text: string;
  /** Fully masked text, present only when it differs from `text`. */
  masked?: string;
}

/**
 * Sanitises and filters a chat message for relaying.
 *
 * @param raw - Untrusted message.
 * @returns The relayed forms, or null when the message is empty after cleaning.
 * @example
 * filterChat('what the fuck'); // { text: 'what the fuck', masked: 'what the ****' }
 */
export function filterChat(raw: unknown): FilteredChat | null {
  const clean = sanitizeChatText(raw);
  if (!clean) return null;
  const text = maskAbuse(clean);
  const masked = maskProfanity(text);
  return masked === text ? { text } : { text, masked };
}

/**
 * The text a player sees for a relayed message.
 *
 * @param msg - Relayed message.
 * @param filterOn - The player's "Chat filter" setting.
 */
export function chatTextFor(msg: FilteredChat, filterOn: boolean): string {
  return filterOn && msg.masked ? msg.masked : msg.text;
}
