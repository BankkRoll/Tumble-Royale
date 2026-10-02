import { loadRapier, maxStateError, runDeterminismScenario, type DeterminismResult } from '@tumble/sim';

/** Outcome of comparing the browser's Rapier run against the game server's. */
export interface DeterminismReport {
  client: DeterminismResult;
  server: DeterminismResult | null;
  /** Max absolute component difference; `null` when the server was unreachable. */
  maxError: number | null;
  identical: boolean;
  /** Human-readable summary for the overlay. */
  summary: string;
}

/** Tolerance for Phase 0 acceptance. Identical builds should give 0. */
export const DETERMINISM_TOLERANCE = 1e-4;

/**
 * Runs the scripted physics scenario locally and on the game server and compares.
 *
 * @param steps - Number of fixed steps to simulate.
 */
export async function checkDeterminism(steps = 600): Promise<DeterminismReport> {
  const R = await loadRapier();
  const client = runDeterminismScenario(R, steps);

  let server: DeterminismResult | null = null;
  try {
    const res = await fetch(`/gs/debug/determinism?steps=${steps}`);
    if (res.ok) server = (await res.json()) as DeterminismResult;
  } catch {
    server = null;
  }

  if (!server) {
    return {
      client,
      server,
      maxError: null,
      identical: false,
      summary: `client ${client.hash} · server unreachable`,
    };
  }

  const maxError = maxStateError(client.state, server.state);
  const identical = client.hash === server.hash;
  const pass = maxError <= DETERMINISM_TOLERANCE;
  return {
    client,
    server,
    maxError,
    identical,
    summary: `${pass ? 'PASS' : 'FAIL'} ${steps} steps · ${identical ? 'bit-identical' : `max err ${maxError.toExponential(2)}`}`,
  };
}
