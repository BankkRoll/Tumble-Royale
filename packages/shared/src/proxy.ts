/**
 * Client address resolution behind reverse proxies, shared by the Node
 * services (API, matchmaker, game server). Browser code must not import this
 * module.
 *
 * Responsibilities:
 * - Parse `TRUST_PROXY` (`false`, a hop count, or a list of proxy addresses
 *   and CIDR ranges) once at boot.
 * - Build the trust function Fastify's `trustProxy` option takes, and resolve
 *   the client address of raw `IncomingMessage`s (WebSocket upgrades) with the
 *   very same rules, so HTTP routes and sockets agree on who the client is.
 *
 * SECURITY: `X-Forwarded-For` is written by whoever sends the request. Only
 * entries appended by proxies we trust may be believed; everything to the
 * left of the first untrusted hop is attacker-controlled. The default trusts
 * no proxy, which is correct when the service faces the internet directly.
 */
import type { IncomingMessage } from 'node:http';
import proxyaddr from '@fastify/proxy-addr';

/**
 * Which proxies in front of the service may set `X-Forwarded-For`:
 * `false` none; a number = that many hops (load balancer → ingress = 2);
 * a list = proxy addresses, CIDR ranges or the keywords `loopback`,
 * `linklocal`, `uniquelocal`.
 */
export type TrustProxy = false | number | readonly string[];

/** A trust predicate: `addr` is the `i`-th address from the socket (0) leftwards. */
export type TrustFn = (addr: string, i: number) => boolean;

/** Hop counts above this are surely a mistake (and would trust spoofed entries). */
const MAX_HOPS = 10;

/**
 * Parses a `TRUST_PROXY` value.
 *
 * @param raw - The variable; unset, empty, `false` or `0` mean no proxy.
 * @returns The setting, or an error message for an unusable value.
 * @example
 * parseTrustProxy('2'); // { value: 2 }
 * parseTrustProxy('10.0.0.0/8, 127.0.0.1'); // { value: ['10.0.0.0/8', '127.0.0.1'] }
 */
export function parseTrustProxy(raw: string | undefined): { value: TrustProxy } | { error: string } {
  const v = raw?.trim() ?? '';
  if (v === '' || v === 'false' || v === '0') return { value: false };
  if (v === 'true')
    return {
      error:
        'true would trust every X-Forwarded-For entry, which clients can forge; ' +
        'use the number of proxies in front of the service or their addresses/CIDRs',
    };
  if (/^\d+$/.test(v)) {
    const hops = Number(v);
    if (hops > MAX_HOPS) return { error: `must be at most ${MAX_HOPS} hops (got ${hops})` };
    return { value: hops };
  }
  const list = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  try {
    proxyaddr.compile(list);
  } catch (err) {
    return { error: `is not a hop count or a list of IPs/CIDRs (${(err as Error).message})` };
  }
  return { value: list };
}

/**
 * The trust predicate for a setting, in the form Fastify's `trustProxy`
 * option and {@link clientIp} take.
 *
 * @returns False when no proxy is trusted (Fastify then ignores the headers).
 */
export function trustFunction(trust: TrustProxy): TrustFn | false {
  if (trust === false) return false;
  if (typeof trust === 'number') return (_addr, i) => i < trust;
  return proxyaddr.compile([...trust]);
}

/**
 * The client address of a raw request, believing `X-Forwarded-For` only as
 * far as `trust` allows. Same result as Fastify's `request.ip` for the same
 * setting.
 *
 * @param req - Typically a WebSocket upgrade request.
 * @param trust - From {@link trustFunction}.
 * @returns The address, or `'unknown'` when the socket has none (closed).
 */
export function clientIp(req: IncomingMessage, trust: TrustFn | false): string {
  const socketAddr = req.socket?.remoteAddress;
  if (!socketAddr) return 'unknown';
  if (trust === false) return socketAddr;
  const addrs = proxyaddr.all(req, trust);
  return addrs[addrs.length - 1] ?? socketAddr;
}
