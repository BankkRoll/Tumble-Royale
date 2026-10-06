/**
 * Keyset pagination cursors for lists ordered newest first by a timestamp,
 * with the row id as the tie-break so rows sharing a timestamp are neither
 * skipped nor repeated between pages.
 *
 * A cursor is opaque to clients: base64url of `<epoch ms>:<id>`.
 */
import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { z } from 'zod';

/** The last row of a page: where the next (older) page starts. */
export interface PageCursor {
  at: Date;
  id: string;
}

/**
 * Encodes the last row of a page as a cursor.
 *
 * @example
 * encodeCursor(new Date(0), 'abc'); // 'MDphYmM'
 */
export function encodeCursor(at: Date, id: string | number): string {
  return Buffer.from(`${at.getTime()}:${id}`, 'utf8').toString('base64url');
}

function decode(raw: string): PageCursor | null {
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const sep = text.indexOf(':');
  if (sep <= 0) return null;
  const ms = Number(text.slice(0, sep));
  const id = text.slice(sep + 1);
  if (!Number.isSafeInteger(ms) || id.length === 0 || id.length > 64) return null;
  return { at: new Date(ms), id };
}

/** Query-string schema for an optional cursor; a malformed one is a 400. */
export const CursorParam = z
  .string()
  .max(200)
  .transform((raw, c) => {
    const cursor = decode(raw);
    if (!cursor) c.addIssue({ code: 'custom', message: 'Invalid cursor' });
    return cursor ?? { at: new Date(0), id: '' };
  });

/**
 * Rows strictly after the cursor in `(at desc, id desc)` order.
 *
 * @param at - The ordering timestamp column.
 * @param id - The tie-break column.
 * @param cursor - Last row of the previous page.
 */
export function olderThan(at: AnyColumn, id: AnyColumn, cursor: PageCursor): SQL {
  return sql`(${at}, ${id}) < (${cursor.at.toISOString()}::timestamptz, ${cursor.id})`;
}
