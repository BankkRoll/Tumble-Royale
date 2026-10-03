/**
 * Reconnect bookkeeping the connection curtain shows: the real attempt number
 * and limit, the backoff before each attempt, giving up after the last one,
 * and Try again from the connection-lost state.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RECONNECT_ATTEMPTS,
  NetClient,
  reconnectDelayMs,
  type ConnectionState,
  type ReconnectAttempt,
  type WebSocketLike,
} from '../src/net/NetClient.ts';

class FakeSocket implements WebSocketLike {
  binaryType = 'arraybuffer';
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
  /** The server refused or the link dropped. */
  drop(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
}

function harness(maxReconnectAttempts?: number) {
  const clock = { now: 0 };
  const sockets: FakeSocket[] = [];
  const net = new NetClient({
    name: 'Tester',
    url: 'ws://test/ws',
    conditioner: null,
    now: () => clock.now,
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    ...(maxReconnectAttempts !== undefined ? { maxReconnectAttempts } : {}),
  });
  const attempts: ReconnectAttempt[] = [];
  const states: ConnectionState[] = [];
  net.on('reconnect', (a) => attempts.push(a));
  net.on('state', (s) => states.push(s));
  /** Drops the live socket and waits out the backoff so the next attempt opens. */
  const dropAndWait = (): void => {
    sockets.at(-1)?.drop();
    const next = attempts.at(-1);
    if (net.state !== 'reconnecting' || !next) return;
    clock.now += next.delayMs;
    net.update();
  };
  return { clock, sockets, net, attempts, states, dropAndWait };
}

describe('reconnect attempts', () => {
  it('backs off 0.5 s, 1 s, 2 s, then 4 s', () => {
    expect([1, 2, 3, 4, 5, 6].map(reconnectDelayMs)).toEqual([500, 1000, 2000, 4000, 4000, 4000]);
  });

  it('reports each real attempt with the limit, then gives up after the last', () => {
    const { net, sockets, attempts, states, dropAndWait } = harness();
    net.connect();
    expect(sockets).toHaveLength(1);
    for (let i = 0; i < DEFAULT_RECONNECT_ATTEMPTS; i++) dropAndWait();
    expect(attempts.map((a) => a.attempt)).toEqual([1, 2, 3, 4, 5]);
    expect(attempts.every((a) => a.maxAttempts === DEFAULT_RECONNECT_ATTEMPTS)).toBe(true);
    expect(attempts.map((a) => a.delayMs)).toEqual([500, 1000, 2000, 4000, 4000]);
    expect(sockets).toHaveLength(1 + DEFAULT_RECONNECT_ATTEMPTS);
    expect(net.state).toBe('reconnecting');
    sockets.at(-1)?.drop();
    expect(net.state).toBe('failed');
    expect(states.at(-1)).toBe('failed');
  });

  it('opens the next socket only once the backoff elapsed', () => {
    const { net, sockets, clock, attempts } = harness();
    net.connect();
    sockets[0]!.drop();
    clock.now += (attempts[0]?.delayMs ?? 0) - 1;
    net.update();
    expect(sockets).toHaveLength(1);
    clock.now += 1;
    net.update();
    expect(sockets).toHaveLength(2);
  });

  it('Try again starts a fresh set of attempts after giving up', () => {
    const { net, sockets, attempts, dropAndWait } = harness(2);
    net.connect();
    dropAndWait();
    dropAndWait();
    sockets.at(-1)?.drop();
    expect(net.state).toBe('failed');
    const before = sockets.length;
    expect(net.retry()).toBe(true);
    expect(net.state).toBe('reconnecting');
    expect(attempts.at(-1)).toMatchObject({ attempt: 1, maxAttempts: 2 });
    dropAndWait();
    expect(sockets.length).toBeGreaterThan(before);
  });

  it('never retries after the client closed for good', () => {
    const { net } = harness();
    net.connect();
    net.close();
    expect(net.retry()).toBe(false);
    expect(net.state).toBe('idle');
  });
});
