import { describe, expect, it } from 'vitest';
import type { ChatMsg } from '@tumble/netcode';
import { ServerMetrics } from '../src/metrics.ts';
import { ChatRelay } from '../src/chat.ts';
import { RoomManager } from '../src/room/RoomManager.ts';
import { FakeConnection, TestClient, testDeps, type FakeMatchSim } from './helpers.ts';

describe('ChatRelay', () => {
  it('relays quick-chat presets as their text and rejects unknown ids', () => {
    const chat = new ChatRelay();
    chat.register(3, { muted: false }, 0);
    expect(chat.handle(3, { quick: 'ping:watch' }, 0)).toEqual({
      kind: 'relay',
      msg: { t: 'chat', from: 3, text: 'Watch out!', quick: 'ping:watch' },
    });
    expect(chat.handle(3, { quick: 'ping:<script>' }, 0)).toEqual({ kind: 'violation' });
  });

  it('filters text: slurs always masked, swearing only in the masked copy', () => {
    const chat = new ChatRelay();
    chat.register(1, { muted: false }, 0);
    const out = chat.handle(1, { text: 'oh shit' }, 0);
    expect(out).toEqual({
      kind: 'relay',
      msg: { t: 'chat', from: 1, text: 'oh shit', masked: 'oh ****' },
    });
    const slur = chat.handle(1, { text: 'f4ggot' }, 10_000);
    expect(slur.kind === 'relay' && slur.msg.text).toBe('******');
  });

  it('rate-limits per player, and a re-register (reconnect) keeps the bucket', () => {
    const chat = new ChatRelay({ perSec: 0.5, burst: 2 });
    chat.register(0, { muted: false }, 0);
    expect(chat.handle(0, { text: 'a' }, 0).kind).toBe('relay');
    expect(chat.handle(0, { text: 'b' }, 0).kind).toBe('relay');
    chat.register(0, { muted: false }, 0);
    expect(chat.handle(0, { text: 'c' }, 0)).toEqual({ kind: 'drop', reason: 'rate' });
    expect(chat.handle(0, { text: 'd' }, 2_100).kind).toBe('relay');
  });

  it('drops text from chat-banned players but keeps their quick pings', () => {
    const chat = new ChatRelay();
    chat.register(5, { muted: true }, 0);
    expect(chat.canSendText(5)).toBe(false);
    expect(chat.handle(5, { text: 'hello' }, 0)).toEqual({ kind: 'drop', reason: 'banned' });
    expect(chat.handle(5, { quick: 'ping:gg' }, 0).kind).toBe('relay');
  });

  it('drops empty and unknown senders', () => {
    const chat = new ChatRelay();
    chat.register(0, { muted: false }, 0);
    expect(chat.handle(0, { text: ' \u0000 ' }, 0)).toEqual({ kind: 'drop', reason: 'empty' });
    expect(chat.handle(9, { text: 'hi' }, 0).kind).toBe('drop');
  });
});

describe('Room chat', () => {
  it('broadcasts filtered chat and quick pings to every player', () => {
    const clock = { now: 1000 };
    const sims: FakeMatchSim[] = [];
    const manager = new RoomManager(testDeps(clock, sims), new ServerMetrics(), null, {
      config: { capacity: 4, fillWaitMs: 60_000, startAtHumans: 4, resumeWindowMs: 30_000 },
      profileLogMs: 0,
    });
    const connect = (name: string): TestClient => {
      const conn = new FakeConnection();
      manager.accept(conn);
      const c = new TestClient(conn);
      c.hello(name);
      c.pump(clock.now);
      return c;
    };
    const a = connect('alice');
    const b = connect('bob');
    const pumpAll = (): void => {
      for (let i = 0; i < 4; i++) {
        clock.now += 50;
        manager.tick();
        a.pump(clock.now);
        b.pump(clock.now);
      }
    };
    a.send({ t: 'chat', from: 99, text: 'what the fuck' });
    a.send({ t: 'chat', from: 99, text: '', quick: 'ping:go' });
    pumpAll();
    const got = b.lowFreq('chat') as ChatMsg[];
    expect(got).toEqual([
      { t: 'chat', from: a.welcome!.playerId, text: 'what the fuck', masked: 'what the ****' },
      { t: 'chat', from: a.welcome!.playerId, text: 'Go here!', quick: 'ping:go' },
    ]);
  });
});
