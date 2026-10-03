/**
 * UTC calendar helpers shared by the API and the offline client so daily,
 * weekly and seasonal rotations agree everywhere. Every reset happens at
 * 00:00 UTC; weeks are ISO weeks starting Monday.
 */

/** Milliseconds in a day. */
export const DAY_MS = 86_400_000;

/**
 * `YYYY-MM-DD` (UTC) for a date.
 *
 * @param d - Any instant.
 */
export function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * ISO week key `YYYY-Www` (UTC), e.g. `2026-W40`.
 *
 * @param d - Any instant.
 */
export function utcWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay() || 7;
  // The ISO week-year is the year of the Thursday in this week.
  t.setUTCDate(t.getUTCDate() + 4 - dow);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Start of the next ISO week (Monday 00:00 UTC).
 *
 * @param d - Any instant.
 */
export function nextUtcWeekStart(d: Date): Date {
  const dow = d.getUTCDay() || 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + (8 - dow)));
}

/**
 * The same UTC day-of-month `months` later. Season boundaries are always on
 * the 1st, so there is no end-of-month clamping to worry about.
 *
 * @param d - Start instant.
 * @param months - Months to add (may be negative).
 */
export function addUtcMonths(d: Date, months: number): Date {
  return new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth() + months,
      d.getUTCDate(),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
    ),
  );
}
