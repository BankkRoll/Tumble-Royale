/**
 * Matchmaking region selection (Settings → Gameplay → Region).
 *
 * Responsibilities:
 * - probe round-trip times: per-region ping URLs when the matchmaker lists
 *   them, otherwise the matchmaker's own `GET /ping`, which counts for its
 *   single region;
 * - guess a region from the device time zone when nothing could be measured;
 * - pick the region for "Auto" ({@link chooseRegion}), which the client then
 *   stores, sends with `PATCH /me` and with queue requests.
 */

/** Regions the account API accepts. */
export const REGIONS = ['na', 'eu', 'asia', 'sa', 'oce'] as const;

/** A matchmaking region id. */
export type Region = (typeof REGIONS)[number];

/** `GET /ping` from the matchmaker. */
export interface PingInfo {
  ok: boolean;
  /** Regions with live game servers. */
  regions?: string[];
  /** Per-region endpoints to time directly, when the deployment has them. */
  pingUrls?: Record<string, string>;
}

/** What a probe found. */
export interface RegionProbe {
  /** Median RTT (ms) per region that could be measured. */
  pings: Partial<Record<Region, number>>;
  /** Regions with live servers (empty when unknown). */
  available: Region[];
  /** RTT to the matchmaker itself, null when it did not answer. */
  matchmakerMs: number | null;
}

/** Narrows a string to a known region. */
export function isRegion(v: unknown): v is Region {
  return typeof v === 'string' && (REGIONS as readonly string[]).includes(v);
}

const SOUTH_AMERICA =
  /^America\/(Argentina\/|Sao_Paulo|Santiago|Lima|Bogota|Caracas|Montevideo|Asuncion|La_Paz|Guayaquil|Fortaleza|Recife|Belem|Manaus|Cuiaba|Bahia|Maceio|Araguaina|Campo_Grande|Porto_Velho|Boa_Vista|Rio_Branco|Paramaribo|Cayenne|Guyana|Punta_Arenas)/;

/**
 * Best guess from the device time zone (IANA name first, UTC offset as a
 * fallback). Only used when no round trip could be measured.
 *
 * @param timeZone - e.g. `Intl.DateTimeFormat().resolvedOptions().timeZone`.
 * @param utcOffsetMin - Minutes east of UTC (`-new Date().getTimezoneOffset()`).
 * @example
 * timezoneRegion('Europe/Berlin', 120); // 'eu'
 */
export function timezoneRegion(timeZone: string | undefined, utcOffsetMin: number): Region {
  const tz = timeZone ?? '';
  if (SOUTH_AMERICA.test(tz)) return 'sa';
  if (tz.startsWith('America/') || tz.startsWith('US/') || tz.startsWith('Canada/')) return 'na';
  if (tz.startsWith('Europe/') || tz.startsWith('Africa/') || tz.startsWith('Atlantic/')) return 'eu';
  if (tz.startsWith('Australia/') || tz.startsWith('Pacific/Auckland') || tz.startsWith('Pacific/'))
    return tz === 'Pacific/Honolulu' ? 'na' : 'oce';
  if (tz.startsWith('Asia/') || tz.startsWith('Indian/')) return 'asia';
  const h = utcOffsetMin / 60;
  if (h <= -4) return 'na';
  if (h < 4) return 'eu';
  if (h < 9.5) return 'asia';
  return 'oce';
}

/** The device's own time-zone guess. */
export function deviceTimezoneRegion(): Region {
  let tz: string | undefined;
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    tz = undefined;
  }
  return timezoneRegion(tz, -new Date().getTimezoneOffset());
}

/**
 * The region to play in.
 *
 * Manual choices win. "Auto" takes the lowest measured ping (preferring
 * regions known to have servers), then the only region with servers, then
 * the time-zone guess.
 *
 * @param setting - `gameplay.region` (`auto` or a region id).
 * @param probe - Measured pings and live regions.
 * @param guess - Time-zone guess.
 * @example
 * chooseRegion('auto', { pings: { eu: 40, na: 120 }, available: [] }, 'na'); // 'eu'
 */
export function chooseRegion(setting: string, probe: RegionProbe, guess: Region): Region {
  if (isRegion(setting)) return setting;
  const measured = (Object.entries(probe.pings) as [Region, number][]).filter(
    ([r, ms]) => isRegion(r) && Number.isFinite(ms) && ms >= 0,
  );
  const live = new Set(probe.available);
  const pool =
    live.size > 0 && measured.some(([r]) => live.has(r)) ? measured.filter(([r]) => live.has(r)) : measured;
  if (pool.length > 0) return pool.reduce((best, cur) => (cur[1] < best[1] ? cur : best))[0];
  if (probe.available.length === 1) return probe.available[0]!;
  if (live.size === 0 || live.has(guess)) return guess;
  return probe.available[0]!;
}

/** Median of a list (0 for an empty one). */
export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Dependencies of {@link probeRegions}, injectable for tests. */
export interface ProbeDeps {
  fetch: (url: string, init: { signal: AbortSignal; cache: RequestCache }) => Promise<Response>;
  now: () => number;
  /** Samples per endpoint (the first warms the connection and is dropped). */
  samples?: number;
  timeoutMs?: number;
}

/**
 * Times `url` a few times and returns the median, or null when it fails.
 * The first request (DNS, TLS, connection setup) is discarded.
 */
export async function measureRtt(
  url: string,
  deps: ProbeDeps,
): Promise<{ ms: number; body: unknown } | null> {
  const n = Math.max(2, deps.samples ?? 4);
  const times: number[] = [];
  let body: unknown = null;
  for (let i = 0; i < n; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? 1500);
    const t0 = deps.now();
    try {
      const res = await deps.fetch(url, { signal: ctrl.signal, cache: 'no-store' });
      if (!res.ok) return null;
      if (i === 0) body = await res.json().catch(() => null);
      else await res.arrayBuffer().catch(() => undefined);
      if (i > 0) times.push(deps.now() - t0);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return { ms: Math.round(median(times)), body };
}

/**
 * Probes the matchmaker: per-region URLs when `/ping` lists them, otherwise
 * its own RTT, which is attributed to its region when it serves exactly one.
 *
 * @param mmUrl - Matchmaker base URL.
 * @param deps - fetch/clock.
 */
export async function probeRegions(mmUrl: string, deps: ProbeDeps): Promise<RegionProbe> {
  const out: RegionProbe = { pings: {}, available: [], matchmakerMs: null };
  const base = await measureRtt(`${mmUrl.replace(/\/$/, '')}/ping`, deps);
  if (!base) return out;
  out.matchmakerMs = base.ms;
  const info = (base.body ?? {}) as PingInfo;
  out.available = (info.regions ?? []).filter(isRegion);
  const urls = Object.entries(info.pingUrls ?? {}).filter(([r]) => isRegion(r)) as [Region, string][];
  if (urls.length > 0) {
    // One at a time: parallel probes would queue behind each other and skew the slower links.
    for (const [r, u] of urls) {
      const res = await measureRtt(u, deps);
      if (res) out.pings[r] = res.ms;
    }
  } else if (out.available.length === 1) {
    out.pings[out.available[0]!] = base.ms;
  }
  return out;
}
