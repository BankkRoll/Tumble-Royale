/**
 * Graceful drain on SIGTERM, so a deploy or scale-down never cuts a show off
 * mid-round.
 *
 * Steps:
 * 1. Mark the server not ready (`/ready` → 503, `tumble_draining` → 1).
 * 2. Deregister from the matchmaker, which stops placing matches here.
 * 3. Wait `settleMs` for players of matches placed just before that to
 *    arrive (their tickets name this server; their rooms open on first join).
 * 4. Wait until every room has closed, up to `timeoutMs` after the drain
 *    began; shows still running then are cut off.
 * 5. Close the transport and the HTTP server.
 * 6. Retry undelivered results for up to `outboxFlushMs`; anything left stays
 *    in the outbox directory and is delivered by the next process that
 *    starts with the same `RESULTS_OUTBOX_DIR`.
 */

/** Collaborators of {@link drain}. */
export interface DrainDeps {
  setDraining(): void;
  /** Deregisters from the matchmaker; null when not linked. */
  link: { stop(): Promise<void> } | null;
  /** Rooms still open. */
  rooms(): number;
  closeServer(): Promise<void>;
  outbox: { flush(timeoutMs: number): Promise<number>; stop(): void } | null;
  log(msg: string): void;
  settleMs: number;
  timeoutMs: number;
  outboxFlushMs: number;
  /** Poll interval while waiting for rooms (default 1 s). */
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** What was left when the drain finished. */
export interface DrainResult {
  /** Rooms cut off by the timeout. */
  roomsCut: number;
  /** Results left in the outbox for the next start. */
  outboxLeft: number;
}

/**
 * Drains the server; resolves once it is safe to exit.
 *
 * @param d - Collaborators and limits.
 */
export async function drain(d: DrainDeps): Promise<DrainResult> {
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = now();
  const deadline = started + d.timeoutMs;
  d.setDraining();
  d.log(`[drain] draining: ${d.rooms()} room(s) open, up to ${Math.round(d.timeoutMs / 1000)} s`);
  if (d.link) {
    await d.link.stop().catch(() => undefined);
    d.log('[drain] deregistered from the matchmaker');
    const settleUntil = Math.min(started + d.settleMs, deadline);
    while (now() < settleUntil) await sleep(Math.min(d.pollMs ?? 1000, settleUntil - now()));
  }
  let lastReport = now();
  while (d.rooms() > 0 && now() < deadline) {
    if (now() - lastReport >= 30_000) {
      d.log(`[drain] waiting for ${d.rooms()} room(s) to finish`);
      lastReport = now();
    }
    await sleep(Math.max(1, Math.min(d.pollMs ?? 1000, deadline - now())));
  }
  const roomsCut = d.rooms();
  if (roomsCut > 0) d.log(`[drain] timeout reached; closing ${roomsCut} room(s) that are still running`);
  await d.closeServer();
  let outboxLeft = 0;
  if (d.outbox) {
    outboxLeft = await d.outbox.flush(d.outboxFlushMs);
    d.outbox.stop();
    if (outboxLeft > 0)
      d.log(`[drain] ${outboxLeft} result(s) still undelivered; kept on disk for the next start`);
  }
  d.log(`[drain] done in ${Math.round((now() - started) / 1000)} s`);
  return { roomsCut, outboxLeft };
}
