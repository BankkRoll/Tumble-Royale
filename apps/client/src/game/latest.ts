/**
 * Tracks which of several overlapping requests of one kind is the newest,
 * so a slow answer never replaces a newer one on screen.
 *
 * @example
 * const cards = new LatestRequest();
 * const current = cards.begin();
 * const card = await fetchCard(id);
 * if (current()) show(card);
 */
export class LatestRequest {
  private n = 0;

  /**
   * Starts a request; any earlier one stops being current.
   *
   * @returns True while this request is still the newest.
   */
  begin(): () => boolean {
    const id = ++this.n;
    return () => id === this.n;
  }

  /** Makes every request in flight stale (the answer is no longer wanted). */
  cancel(): void {
    this.n++;
  }
}
