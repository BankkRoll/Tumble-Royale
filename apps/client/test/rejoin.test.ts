/**
 * Rejoining a running online show after a reload: what is kept in
 * sessionStorage, how the way back in is chosen (resume token inside the
 * server's 30 s window, a matchmaker rejoin ticket after it), ended matches
 * that must never be re-entered, and the NetClient carrying a stored token.
 */
import { BitReader, BitWriter, MsgType, PROTOCOL_VERSION, readHello, writeWelcome } from '@tumble/netcode';
import { describe, expect, it } from 'vitest';
import {
  ENDED_MATCHES_KEPT,
  REJOIN_MAX_AGE_MS,
  RESUME_WINDOW_MS,
  RejoinStore,
  planRejoin,
  type KeyValueStorage,
  type LiveShowRecord,
} from '../src/game/online/rejoin.ts';
import { NetClient, type WebSocketLike } from '../src/net/NetClient.ts';

class MemoryStorage implements KeyValueStorage {
  readonly map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

const T0 = Date.parse('2026-10-04T12:00:00Z');

const show = (over: Partial<LiveShowRecord> = {}): LiveShowRecord => ({
  serverUrl: 'wss://gs-1.test/ws',
  resumeToken: 'tok-123',
  matchId: 'm_abc',
  ticket: 'ticket.jwt',
  expiresAt: T0 + 90_000,
  playlistId: 'main-show',
  queue: 'casual',
  lastSeenAt: T0,
  ...over,
});

const never = (): boolean => false;

describe('rejoin decision', () => {
  it('offers nothing without a stored show', () => {
    expect(planRejoin(null, T0, never)).toEqual({ kind: 'none' });
  });

  it('resumes the same seat with the token inside the resume window', () => {
    const plan = planRejoin(show(), T0 + RESUME_WINDOW_MS - 1, never);
    expect(plan).toMatchObject({ kind: 'rejoin', resumeToken: 'tok-123', freshTicket: false });
  });

  it('still resumes with the token but fetches a ticket when the stored one expired', () => {
    const plan = planRejoin(show({ expiresAt: T0 + 5_000 }), T0 + 10_000, never);
    expect(plan).toMatchObject({ kind: 'rejoin', resumeToken: 'tok-123', freshTicket: true });
  });

  it('asks the matchmaker for a rejoin ticket once the window closed', () => {
    const plan = planRejoin(show(), T0 + RESUME_WINDOW_MS, never);
    expect(plan).toMatchObject({ kind: 'rejoin', resumeToken: null, freshTicket: true });
  });

  it('never uses an empty token', () => {
    expect(planRejoin(show({ resumeToken: '' }), T0 + 1000, never)).toMatchObject({
      resumeToken: null,
      freshTicket: true,
    });
  });

  it('gives up on ended matches, long-gone shows and clocks that went backwards', () => {
    expect(planRejoin(show(), T0 + 1000, (id) => id === 'm_abc')).toEqual({ kind: 'none' });
    expect(planRejoin(show(), T0 + REJOIN_MAX_AGE_MS + 1, never)).toEqual({ kind: 'none' });
    expect(planRejoin(show(), T0 - 1, never)).toEqual({ kind: 'none' });
  });
});

describe('rejoin storage', () => {
  it('saves, touches and clears the live show', () => {
    let now = T0;
    const storage = new MemoryStorage();
    const store = new RejoinStore(storage, () => now);
    const { lastSeenAt: _ignored, ...record } = show();
    store.save(record);
    expect(store.load()).toEqual(show());
    now += 20_000;
    store.touch('m_abc');
    expect(store.load()?.lastSeenAt).toBe(T0 + 20_000);
    // A stale session touching another match does not move this one's window.
    store.touch('m_other');
    expect(store.load()?.lastSeenAt).toBe(T0 + 20_000);
    store.clear();
    expect(store.load()).toBeNull();
  });

  it('survives a reload: a new store over the same storage reads it back', () => {
    const storage = new MemoryStorage();
    new RejoinStore(storage, () => T0).save(show());
    expect(new RejoinStore(storage, () => T0 + 5).load()?.matchId).toBe('m_abc');
  });

  it('remembers ended matches (most recent kept) and forgets their live record', () => {
    const storage = new MemoryStorage();
    const store = new RejoinStore(storage, () => T0);
    store.save(show());
    store.finish('m_abc');
    expect(store.load()).toBeNull();
    expect(store.isEnded('m_abc')).toBe(true);
    for (let i = 0; i < ENDED_MATCHES_KEPT; i++) store.finish(`m_${i}`);
    expect(store.isEnded('m_abc')).toBe(false);
    expect(store.isEnded(`m_${ENDED_MATCHES_KEPT - 1}`)).toBe(true);
  });

  it('finishing another match leaves the live record alone', () => {
    const store = new RejoinStore(new MemoryStorage(), () => T0);
    store.save(show());
    store.finish('m_older');
    expect(store.load()?.matchId).toBe('m_abc');
  });

  it('treats malformed or unreadable storage as empty and never throws', () => {
    const storage = new MemoryStorage();
    storage.setItem('tumble.liveShow', '{"matchId":5}');
    storage.setItem('tumble.endedShows', 'not json');
    const store = new RejoinStore(storage);
    expect(store.load()).toBeNull();
    expect(store.isEnded('x')).toBe(false);
    const broken: KeyValueStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    const safe = new RejoinStore(broken);
    expect(() => {
      safe.save(show());
      safe.touch('m_abc');
      safe.finish('m_abc');
      safe.clear();
    }).not.toThrow();
    expect(safe.load()).toBeNull();
    expect(new RejoinStore(null).load()).toBeNull();
  });
});

class CaptureSocket implements WebSocketLike {
  binaryType = 'arraybuffer';
  readyState = 1;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly sent: Uint8Array[] = [];
  send(data: Uint8Array): void {
    this.sent.push(data.slice());
  }
  close(): void {
    this.readyState = 3;
  }
}

function hello(bytes: Uint8Array) {
  const r = new BitReader().reset(bytes);
  expect(r.readBits(8)).toBe(MsgType.Hello);
  return readHello(r);
}

describe('NetClient resume token', () => {
  it('sends a stored token and ticket in its first Hello after a reload', () => {
    const socket = new CaptureSocket();
    const net = new NetClient({
      name: 'Tester',
      url: 'ws://test/ws',
      conditioner: null,
      ticket: 'fresh.ticket',
      resumeToken: 'tok-123',
      createSocket: () => socket,
    });
    expect(net.resumeToken).toBe('tok-123');
    net.connect();
    socket.onopen?.({});
    expect(hello(socket.sent[0]!)).toMatchObject({ resumeToken: 'tok-123', ticket: 'fresh.ticket' });
  });

  it("exposes the server's token after Welcome so it can be persisted", () => {
    const socket = new CaptureSocket();
    const net = new NetClient({
      name: 'Tester',
      url: 'ws://test/ws',
      conditioner: null,
      createSocket: () => socket,
    });
    expect(net.resumeToken).toBe('');
    net.connect();
    socket.onopen?.({});
    expect(hello(socket.sent[0]!).resumeToken).toBe('');
    const w = new BitWriter(256);
    writeWelcome(w, {
      version: PROTOCOL_VERSION,
      playerId: 3,
      resumeToken: 'server-token',
      roomId: 'r1',
      serverTick: 0,
      tickEpochMs: 0,
      tickMs: 1000 / 30,
      resumed: false,
    });
    socket.onmessage?.({ data: w.finish().slice().buffer });
    expect(net.resumeToken).toBe('server-token');
  });
});
