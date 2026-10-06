/**
 * The round file format the editor imports and exports (`.round.json`): a
 * small envelope around the round definition, so a file can be recognised,
 * versioned and carry the description that is not part of the definition.
 */
import { z } from 'zod';
import { CUSTOM_ROUND_LIMITS } from './limits.ts';

/** `format` value of a round file. */
export const ROUND_FILE_FORMAT = 'tumble-royale/round';

/** Current file version. */
export const ROUND_FILE_VERSION = 1;

/** A round file. The definition itself is validated separately (`validateCustomRound`). */
export const RoundFileSchema = z.object({
  format: z.literal(ROUND_FILE_FORMAT),
  version: z.literal(ROUND_FILE_VERSION),
  description: z.string().max(CUSTOM_ROUND_LIMITS.descriptionMax).default(''),
  round: z.record(z.string(), z.unknown()),
});

/** Parsed round file. */
export type RoundFile = z.output<typeof RoundFileSchema>;

/**
 * Serialises a round for download.
 *
 * @param round - Definition as authored.
 * @param description - Share description.
 * @returns Pretty-printed JSON.
 */
export function exportRoundFile(round: unknown, description = ''): string {
  return `${JSON.stringify({ format: ROUND_FILE_FORMAT, version: ROUND_FILE_VERSION, description, round }, null, 2)}\n`;
}

/**
 * Reads a round file, or a bare round definition (what other tools and the
 * level data use).
 *
 * @param text - File contents.
 * @returns The definition and description, or a message for the player.
 */
export function parseRoundFile(
  text: string,
): { ok: true; round: Record<string, unknown>; description: string } | { ok: false; error: string } {
  // Twice the definition cap leaves room for pretty-printing whitespace.
  if (text.length > CUSTOM_ROUND_LIMITS.maxBytes * 2) return { ok: false, error: 'That file is too large' };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'That file is not JSON' };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    return { ok: false, error: 'That file is not a round' };
  if ('format' in data) {
    const f = RoundFileSchema.safeParse(data);
    if (!f.success) return { ok: false, error: 'That round file is from an unknown version' };
    return { ok: true, round: f.data.round, description: f.data.description };
  }
  if ('geometry' in data && 'spawn' in data)
    return { ok: true, round: data as Record<string, unknown>, description: '' };
  return { ok: false, error: 'That file is not a round' };
}
