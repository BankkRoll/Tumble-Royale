/**
 * Recent chat kept per sender so a report can carry what the reported player
 * actually said.
 *
 * Only two kinds of line are kept: global chat (public to everyone online)
 * and whispers, which are attached to a report only when the reporter was
 * their recipient. Party chat is not kept: the API cannot tell afterwards
 * whether the reporter was in that party. Lines expire after
 * {@link CHAT_EVIDENCE_TTL_MS}; a report snapshots them into `reports.evidence`.
 */
import type { KV } from '../kv/index.ts';

/** Lines kept per sender. */
export const CHAT_EVIDENCE_MAX = 20;
/** How long an unreported line is kept. */
export const CHAT_EVIDENCE_TTL_MS = 60 * 60_000;

/** One stored line. */
export interface EvidenceLine {
  channel: 'global' | 'whisper';
  /** As relayed (slurs already masked by the chat filter). */
  text: string;
  /** Epoch ms. */
  at: number;
  /** Whisper recipient. */
  to?: string;
}

const key = (userId: string) => `chat-evidence:${userId}`;

function read(raw: string | null): EvidenceLine[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as EvidenceLine[]) : [];
  } catch {
    return [];
  }
}

/**
 * Remembers a line the user sent. Never throws: losing evidence must not
 * lose the chat line itself.
 *
 * NOTE: read-modify-write without a lock. Senders are rate limited to a few
 * lines per second, so a lost line under a race is acceptable for evidence.
 *
 * @param kv - Shared KV (so a report on any instance sees it).
 * @param userId - Sender.
 * @param line - The relayed line.
 */
export async function rememberChatLine(kv: KV, userId: string, line: EvidenceLine): Promise<void> {
  try {
    const lines = read(await kv.get(key(userId)));
    lines.push(line);
    await kv.set(key(userId), JSON.stringify(lines.slice(-CHAT_EVIDENCE_MAX)), CHAT_EVIDENCE_TTL_MS);
  } catch {
    // Evidence is best effort.
  }
}

/**
 * Drops a user's kept lines (account deletion).
 *
 * @param kv - Shared KV.
 * @param userId - Sender.
 */
export async function forgetChatLines(kv: KV, userId: string): Promise<void> {
  await kv.del(key(userId));
}

/**
 * The target's recent lines the reporter could have seen: every global line,
 * and whispers sent to the reporter.
 *
 * @param kv - Shared KV.
 * @param targetId - Reported player.
 * @param reporterId - Who is reporting.
 * @returns Lines oldest first, or null when there are none.
 */
export async function chatEvidence(
  kv: KV,
  targetId: string,
  reporterId: string,
): Promise<EvidenceLine[] | null> {
  // SECURITY: whispers to anyone else stay private, even from moderators.
  const lines = read(await kv.get(key(targetId))).filter(
    (l) => l.channel === 'global' || (l.channel === 'whisper' && l.to === reporterId),
  );
  return lines.length ? lines : null;
}
