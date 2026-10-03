/**
 * UTC calendar helpers for daily/weekly rotations. All resets happen at 00:00
 * UTC; weeks are ISO weeks starting Monday.
 */

/** `YYYY-MM-DD` (UTC) for a date. */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Start of the next UTC day. */
export function nextUtcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
}

/** ISO week key `YYYY-Www` (UTC). */
export function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay() || 7;
  // The ISO week-year is the year of the Thursday in this week.
  t.setUTCDate(t.getUTCDate() + 4 - dow);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Start of the next ISO week (Monday 00:00 UTC). */
export function nextIsoWeekStart(d: Date): Date {
  const dow = d.getUTCDay() || 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + (8 - dow)));
}
