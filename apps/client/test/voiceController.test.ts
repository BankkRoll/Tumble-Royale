/**
 * The voice state machine against fake WebRTC, microphone and mixer: opt-in
 * permission, joins and re-joins, offer/answer/ICE, hang-ups, push-to-talk,
 * the open-mic gate, per-player volume and mute, speaking marks, ICE
 * restarts, microphone loss and server-side endings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TypedMessage } from '../src/game/online/jsonSocket.ts';
import { voice } from '@tumble/ui';
import {
  MAX_RESTARTS,
  SPEAKING_LEVEL,
  VOICE_HOLD_MS,
  VoiceController,
  hasTurnServer,
  voiceIcePolicy,
  type VoiceDeps,
  type VoiceOptions,
} from '../src/game/voice/voiceController.ts';
import { PushToTalkInput } from '../src/game/voice/pushToTalk.ts';

const ME = 'b0000000-0000-4000-8000-000000000000';
const LOW = 'a0000000-0000-4000-8000-000000000000'; // sorts before ME: they offer to us
const HIGH = 'c0000000-0000-4000-8000-000000000000'; // sorts after ME: we offer to them
const SDP = 'v=0\r\ns=-\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const CID = 'tab_fixed000000';

class FakeTrack {
  enabled = true;
  kind = 'audio';
  stopped = false;
  private ended: (() => void)[] = [];
  addEventListener(_: 'ended', fn: () => void) {
    this.ended.push(fn);
  }
  stop() {
    this.stopped = true;
  }
  end() {
    for (const fn of this.ended) fn();
  }
}

class FakeStream {
  readonly tracks = [new FakeTrack()];
  getAudioTracks() {
    return this.tracks;
  }
  getTracks() {
    return this.tracks;
  }
}

class FakePC {
  static all: FakePC[] = [];
  config: RTCConfiguration;
  closed = false;
  connectionState: RTCPeerConnectionState = 'new';
  remoteDescription: RTCSessionDescriptionInit | null = null;
  localDescription: RTCSessionDescriptionInit | null = null;
  added: FakeTrack[] = [];
  candidates: RTCIceCandidateInit[] = [];
  offers: RTCOfferOptions[] = [];
  restartIceCalls = 0;
  replaced: unknown[] = [];
  onicecandidate: ((e: { candidate: { toJSON(): RTCIceCandidateInit } | null }) => void) | null = null;
  ontrack: ((e: { streams: unknown[]; track: unknown }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor(config: RTCConfiguration) {
    this.config = config;
    FakePC.all.push(this);
  }
  setConfiguration(c: RTCConfiguration) {
    this.config = c;
  }
  addTrack(t: FakeTrack) {
    this.added.push(t);
  }
  getSenders() {
    return this.added.map((track) => ({
      track,
      replaceTrack: async (t: unknown) => void this.replaced.push(t),
    }));
  }
  async createOffer(o: RTCOfferOptions = {}) {
    this.offers.push(o);
    return { type: 'offer' as const, sdp: SDP };
  }
  async createAnswer() {
    return { type: 'answer' as const, sdp: SDP };
  }
  async setLocalDescription(d: RTCSessionDescriptionInit) {
    this.localDescription = d;
  }
  async setRemoteDescription(d: RTCSessionDescriptionInit) {
    this.remoteDescription = d;
  }
  async addIceCandidate(c: RTCIceCandidateInit) {
    this.candidates.push(c);
  }
  restartIce() {
    this.restartIceCalls++;
  }
  close() {
    this.closed = true;
  }
  setState(s: RTCPeerConnectionState) {
    this.connectionState = s;
    this.onconnectionstatechange?.();
  }
}

function fakeRealtime() {
  const handlers = new Map<string, ((m: TypedMessage) => void)[]>();
  const sent: TypedMessage[] = [];
  return {
    connected: true,
    sent,
    on(type: string, fn: (m: TypedMessage) => void) {
      handlers.set(type, [...(handlers.get(type) ?? []), fn]);
      return () =>
        handlers.set(
          type,
          (handlers.get(type) ?? []).filter((f) => f !== fn),
        );
    },
    send(m: TypedMessage) {
      sent.push(m);
    },
    emit(type: string, m: Record<string, unknown> = {}) {
      for (const fn of handlers.get(type) ?? []) fn({ type, ...m });
    },
    of(type: string) {
      return sent.filter((m) => m.type === type);
    },
  };
}

interface Rig {
  vc: VoiceController;
  rt: ReturnType<typeof fakeRealtime>;
  gum: ReturnType<typeof vi.fn>;
  streams: FakeStream[];
  peers: { level: number; gain: number; disposed: boolean }[];
  mic: { level: number };
  talking: boolean[];
  volume: number[];
  tracked: { name: string; props: Record<string, unknown> }[];
  enabled: boolean[];
  deviceChange: () => void;
}

const BASE: VoiceOptions = {
  mode: 'ptt',
  threshold: 0.45,
  inputDeviceId: '',
  volume: 0.9,
  relayOnly: false,
  teamVoice: false,
  noiseSuppression: true,
  echoCancellation: true,
  peerVolume: {},
  peerMuted: {},
  playback: true,
};

function rig(
  opts: Partial<VoiceOptions> = {},
  gumImpl?: (c: MediaStreamConstraints) => Promise<unknown>,
  permission: 'granted' | 'prompt' = 'granted',
): Rig {
  const rt = fakeRealtime();
  const streams: FakeStream[] = [];
  const peers: Rig['peers'] = [];
  const mic = { level: 0 };
  const talking: boolean[] = [];
  const volume: number[] = [];
  const tracked: Rig['tracked'] = [];
  const enabled: boolean[] = [];
  let deviceChange = () => undefined as void;
  const gum = vi.fn(
    gumImpl ??
      (async () => {
        const s = new FakeStream();
        streams.push(s);
        return s;
      }),
  );
  const deps: VoiceDeps = {
    realtime: rt,
    fetchConfig: async () => ({ available: true, reason: null, relay: true, teamVoice: true }),
    selfId: () => ME,
    media: {
      supported: () => true,
      getUserMedia: gum as unknown as VoiceDeps['media']['getUserMedia'],
      enumerateDevices: async () => [
        { deviceId: 'mic-1', kind: 'audioinput', label: 'Desk mic' },
        { deviceId: 'cam', kind: 'videoinput', label: 'Camera' },
      ],
      onDeviceChange: (fn) => {
        deviceChange = fn;
        return () => undefined;
      },
      permission: async () => permission,
    },
    mixer: {
      addPeer: () => {
        const p = { level: 0, gain: 1, disposed: false };
        peers.push(p);
        return {
          setGain: (g: number) => void (p.gain = g),
          level: () => p.level,
          dispose: () => void (p.disposed = true),
        };
      },
      meter: () => ({ level: () => mic.level, dispose: () => undefined }),
      setVolume: (v) => void volume.push(v),
      setTalking: (t) => void talking.push(t),
    },
    createPeer: (c) => new FakePC(c) as unknown as RTCPeerConnection,
    track: (name, props) => void tracked.push({ name, props }),
    now: () => Date.now(),
    newCid: () => CID,
    onEnabledChange: (e) => void enabled.push(e),
  };
  const vc = new VoiceController(deps, { ...BASE, ...opts });
  vc.attach();
  return {
    vc,
    rt,
    gum,
    streams,
    peers,
    mic,
    talking,
    volume,
    tracked,
    enabled,
    get deviceChange() {
      return deviceChange;
    },
  } as Rig;
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function room(peers: string[], extra: Record<string, unknown> = {}) {
  return {
    cid: CID,
    room: { id: 'party:p1', kind: 'party' },
    peers: peers.map((userId) => ({ userId, name: `N-${userId.slice(0, 1)}`, tag: '0001' })),
    ice: {
      servers: [{ urls: ['turn:t.example:3478'], username: 'u', credential: 'c' }],
      expiresAt: 0,
      relay: true,
    },
    ...extra,
  };
}

async function live(r: Rig, peers: string[] = [HIGH]) {
  await r.vc.refreshAvailability();
  expect(await r.vc.enable()).toBe(true);
  r.rt.emit('voice_room', room(peers));
  await flush();
}

beforeEach(() => {
  FakePC.all = [];
  voice.getState().reset();
  voice.getState().setAvailability({ available: false, reason: 'offline', relay: false, teamVoice: false });
});
afterEach(() => vi.useRealTimers());

describe('opting in', () => {
  it('asks for the microphone only when switched on, then joins', async () => {
    const r = rig();
    await r.vc.refreshAvailability();
    expect(r.gum).not.toHaveBeenCalled();
    expect(voice.getState().devices).toEqual([{ id: 'mic-1', label: 'Desk mic' }]);
    await r.vc.enable();
    expect(r.gum).toHaveBeenCalledTimes(1);
    const constraints = r.gum.mock.calls[0]![0] as { audio: MediaTrackConstraints };
    expect(constraints.audio).toMatchObject({ echoCancellation: true, noiseSuppression: true });
    expect(r.rt.of('voice_join')).toEqual([{ type: 'voice_join', cid: CID, team: false }]);
    expect(voice.getState().status).toBe('connecting');
    expect(r.enabled).toEqual([true]);
    // The microphone sends nothing until push-to-talk is held.
    expect(r.streams[0]!.tracks[0]!.enabled).toBe(false);
  });

  it('reports a refused microphone and never joins', async () => {
    const r = rig({}, async () => {
      throw Object.assign(new Error('no'), { name: 'NotAllowedError' });
    });
    await r.vc.refreshAvailability();
    expect(await r.vc.enable()).toBe(false);
    expect(voice.getState().status).toBe('denied');
    expect(voice.getState().message).toMatch(/blocked/i);
    expect(r.rt.of('voice_join')).toEqual([]);
    expect(r.enabled).toEqual([false]);
  });

  it('switched off while the microphone prompt is up: closes the granted mic and stays off', async () => {
    let grant!: (s: FakeStream) => void;
    const stream = new FakeStream();
    const r = rig({}, () => new Promise<FakeStream>((resolve) => (grant = resolve)));
    await r.vc.refreshAvailability();
    const enabling = r.vc.enable();
    expect(voice.getState().status).toBe('requesting');
    r.vc.disable();
    expect(voice.getState().status).toBe('off');
    grant(stream);
    expect(await enabling).toBe(false);
    expect(stream.tracks[0]!.stopped).toBe(true);
    expect(r.rt.of('voice_join')).toEqual([]);
    expect(r.enabled).toEqual([false]);
    // Switching on again asks afresh and works.
    const again = r.vc.enable();
    grant(new FakeStream());
    expect(await again).toBe(true);
  });

  it('teardown mid-prompt leaves no microphone open', async () => {
    let grant!: (s: FakeStream) => void;
    const stream = new FakeStream();
    const r = rig({}, () => new Promise<FakeStream>((resolve) => (grant = resolve)));
    await r.vc.refreshAvailability();
    const enabling = r.vc.enable();
    r.vc.dispose();
    grant(stream);
    expect(await enabling).toBe(false);
    expect(stream.tracks[0]!.stopped).toBe(true);
  });

  it('does nothing while the server does not offer voice', async () => {
    const r = rig();
    expect(await r.vc.enable()).toBe(false);
    expect(r.gum).not.toHaveBeenCalled();
  });

  it('restores voice after a reload only when the browser grants the mic without a prompt', async () => {
    const prompt = rig({}, undefined, 'prompt');
    await prompt.vc.restore(true);
    expect(prompt.gum).not.toHaveBeenCalled();
    expect(prompt.enabled).toEqual([false]);
    const granted = rig();
    await granted.vc.restore(true);
    expect(granted.gum).toHaveBeenCalledTimes(1);
    const never = rig();
    await never.vc.restore(false);
    expect(never.gum).not.toHaveBeenCalled();
  });
});

describe('peers', () => {
  it('offers to higher ids, answers lower ids, and ignores other tabs and rooms', async () => {
    const r = rig();
    await live(r, [HIGH, LOW]);
    expect(FakePC.all).toHaveLength(2);
    const [toHigh, toLow] = FakePC.all as [FakePC, FakePC];
    expect(toHigh.config.iceServers?.[0]).toMatchObject({ username: 'u' });
    expect(r.rt.of('voice_signal').filter((m) => m.kind === 'offer')).toEqual([
      { type: 'voice_signal', cid: CID, to: HIGH, kind: 'offer', sdp: SDP },
    ]);
    expect(toLow.added).toHaveLength(0);
    // A candidate before the offer waits for the remote description.
    r.rt.emit('voice_signal', {
      from: LOW,
      roomId: 'party:p1',
      kind: 'ice',
      candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 },
    });
    r.rt.emit('voice_signal', { from: LOW, roomId: 'party:p1', kind: 'offer', sdp: SDP });
    await flush();
    expect(toLow.added).toHaveLength(1);
    expect(toLow.candidates).toHaveLength(1);
    expect(r.rt.of('voice_signal').some((m) => m.kind === 'answer' && m.to === LOW)).toBe(true);
    // Video offers, signals from strangers or another room are ignored.
    r.rt.emit('voice_signal', {
      from: LOW,
      roomId: 'party:p1',
      kind: 'offer',
      sdp: `${SDP}m=video 9 X 96\r\n`,
    });
    r.rt.emit('voice_signal', { from: 'stranger', roomId: 'party:p1', kind: 'offer', sdp: SDP });
    r.rt.emit('voice_signal', {
      from: LOW,
      roomId: 'party:other',
      kind: 'ice',
      candidate: { candidate: '' },
    });
    r.rt.emit('voice_room', { ...room([]), cid: 'tab_someoneelse' });
    await flush();
    expect(toLow.candidates).toHaveLength(1);
    expect(FakePC.all.every((pc) => !pc.closed)).toBe(true);
    expect(voice.getState().peers.map((p) => p.userId)).toEqual([HIGH, LOW]);
  });

  it('hangs up at once on anyone the server no longer lists', async () => {
    const r = rig();
    await live(r, [HIGH, LOW]);
    const toLow = FakePC.all[1]!;
    toLow.ontrack?.({ streams: [new FakeStream()], track: null });
    r.rt.emit('voice_room', room([HIGH]));
    await flush();
    expect(toLow.closed).toBe(true);
    expect(r.peers[0]!.disposed).toBe(true);
    expect(voice.getState().peers.map((p) => p.userId)).toEqual([HIGH]);
  });

  it('forces the TURN relay when relay-only is on', async () => {
    const r = rig({ relayOnly: true });
    await live(r);
    expect(FakePC.all[0]!.config.iceTransportPolicy).toBe('relay');
    r.vc.setOptions({ ...BASE, relayOnly: false });
    expect(FakePC.all[0]!.config.iceTransportPolicy).toBe('all');
    // Changing it restarts ICE so the new policy takes effect.
    expect(FakePC.all[0]!.restartIceCalls).toBe(1);
  });

  it('relays a team room even without relay-only, and re-gathers when a party turns into a team', async () => {
    const r = rig();
    await live(r);
    expect(FakePC.all[0]!.config.iceTransportPolicy).toBe('all');
    r.rt.emit('voice_room', room([HIGH], { room: { id: 'team:m1:0', kind: 'team' } }));
    await flush();
    expect(FakePC.all[0]!.config.iceTransportPolicy).toBe('relay');
    expect(FakePC.all[0]!.restartIceCalls).toBe(1);
    r.rt.emit('voice_room', room([HIGH, LOW], { room: { id: 'team:m1:0', kind: 'team' } }));
    await flush();
    expect(FakePC.all[1]!.config.iceTransportPolicy).toBe('relay');
  });

  it('restarts ICE on failure, asks the offerer when it is the answerer, and gives up after a few tries', async () => {
    const r = rig();
    await live(r, [HIGH, LOW]);
    const [toHigh, toLow] = FakePC.all as [FakePC, FakePC];
    toHigh.setState('failed');
    await flush();
    expect(toHigh.restartIceCalls).toBe(1);
    expect(toHigh.offers.at(-1)).toEqual({ iceRestart: true });
    toLow.setState('failed');
    expect(r.rt.of('voice_signal').some((m) => m.kind === 'restart' && m.to === LOW)).toBe(true);
    for (let i = 0; i < MAX_RESTARTS; i++) toHigh.setState('failed');
    expect(voice.getState().peers.find((p) => p.userId === HIGH)?.connection).toBe('failed');
    toHigh.setState('connected');
    expect(voice.getState().peers.find((p) => p.userId === HIGH)?.connection).toBe('connected');
  });

  it('restarts a connection stuck in disconnected after a grace period', async () => {
    vi.useFakeTimers();
    const r = rig();
    await live(r);
    const pc = FakePC.all[0]!;
    pc.setState('disconnected');
    expect(pc.restartIceCalls).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(pc.restartIceCalls).toBe(1);
  });

  it('re-joins after the socket reconnects', async () => {
    const r = rig();
    await live(r);
    r.rt.emit('socket_open');
    expect(r.rt.of('voice_join')).toHaveLength(2);
  });
});

describe('sending', () => {
  it('push-to-talk opens the track only while held, and never while the tab is hidden', async () => {
    const r = rig();
    await live(r);
    const track = r.streams[0]!.tracks[0]!;
    r.vc.tick(1000);
    expect(track.enabled).toBe(false);
    r.vc.setPushToTalk(true);
    r.vc.tick(1016);
    expect(track.enabled).toBe(true);
    expect(voice.getState().transmitting).toBe(true);
    r.vc.setHidden(true);
    r.vc.tick(1032);
    expect(track.enabled).toBe(false);
    r.vc.setHidden(false);
    r.vc.tick(1048);
    expect(track.enabled).toBe(false);
  });

  it('open mic sends above the threshold and holds briefly after', async () => {
    const r = rig({ mode: 'open', threshold: 0.5 });
    await live(r);
    const track = r.streams[0]!.tracks[0]!;
    r.mic.level = 0.3;
    r.vc.tick(1000);
    expect(track.enabled).toBe(false);
    r.mic.level = 0.7;
    r.vc.tick(1016);
    expect(track.enabled).toBe(true);
    expect(voice.getState().selfSpeaking).toBe(true);
    r.mic.level = 0.1;
    r.vc.tick(1016 + VOICE_HOLD_MS - 10);
    expect(track.enabled).toBe(true);
    r.vc.tick(1016 + VOICE_HOLD_MS + 10);
    expect(track.enabled).toBe(false);
  });
});

describe('receiving', () => {
  it('applies per-player volume and mute, marks speakers and ducks music', async () => {
    const r = rig({ peerVolume: { [HIGH]: 0.4 } });
    await live(r, [HIGH, LOW]);
    FakePC.all[0]!.ontrack?.({ streams: [new FakeStream()], track: null });
    FakePC.all[1]!.ontrack?.({ streams: [new FakeStream()], track: null });
    const [high, low] = r.peers as [Rig['peers'][0], Rig['peers'][0]];
    expect(high.gain).toBe(0.4);
    expect(low.gain).toBe(1);
    high.level = SPEAKING_LEVEL + 0.1;
    r.vc.tick(1000);
    expect(voice.getState().peers.find((p) => p.userId === HIGH)?.speaking).toBe(true);
    expect(r.talking.at(-1)).toBe(true);
    r.vc.setOptions({ ...BASE, peerMuted: { [HIGH]: true } });
    expect(high.gain).toBe(0);
    r.vc.tick(1016);
    // Still shown as speaking (the player can see who it is), but no longer ducks the music.
    expect(voice.getState().peers.find((p) => p.userId === HIGH)?.speaking).toBe(true);
    expect(r.talking.at(-1)).toBe(false);
    high.level = 0;
    r.vc.tick(1016 + VOICE_HOLD_MS + 1);
    expect(voice.getState().peers.find((p) => p.userId === HIGH)?.speaking).toBe(false);
  });

  it("Streamer Mode's don't-play-voice silences the mixer", () => {
    const r = rig({ playback: false });
    expect(r.volume.at(-1)).toBe(0);
    r.vc.setOptions({ ...BASE, playback: true, volume: 0.7 });
    expect(r.volume.at(-1)).toBe(0.7);
  });
});

describe('microphone loss', () => {
  it('reopens the default microphone when the device is unplugged and swaps the sent track', async () => {
    const r = rig();
    await live(r);
    r.streams[0]!.tracks[0]!.end();
    await flush();
    expect(r.gum).toHaveBeenCalledTimes(2);
    expect(FakePC.all[0]!.replaced).toEqual([r.streams[1]!.tracks[0]]);
    expect(r.streams[0]!.tracks[0]!.stopped).toBe(true);
  });

  it('falls back to the default device when the chosen one disappears', async () => {
    const r = rig({ inputDeviceId: 'gone' }, async (c) => {
      const audio = c.audio as MediaTrackConstraints;
      if (audio.deviceId) throw Object.assign(new Error('gone'), { name: 'OverconstrainedError' });
      return new FakeStream();
    });
    await r.vc.refreshAvailability();
    expect(await r.vc.enable()).toBe(true);
    expect(r.gum).toHaveBeenCalledTimes(2);
  });

  it('ends voice with an explanation when the permission is revoked', async () => {
    let calls = 0;
    const r = rig({}, async () => {
      calls++;
      if (calls > 1) throw Object.assign(new Error('revoked'), { name: 'NotAllowedError' });
      return new FakeStream();
    });
    await live(r);
    (r.vc as unknown as { stream: FakeStream }).stream.tracks[0]!.end();
    await flush();
    expect(r.vc.isActive).toBe(false);
    expect(voice.getState().status).toBe('denied');
    expect(FakePC.all[0]!.closed).toBe(true);
    expect(r.tracked.at(-1)).toMatchObject({ name: 'voice.leave', props: { reason: 'mic' } });
  });

  it('reopens the microphone when the device picker changes', async () => {
    const r = rig();
    await live(r);
    r.vc.setOptions({ ...BASE, inputDeviceId: 'mic-1' });
    await flush();
    const last = r.gum.mock.calls.at(-1)![0] as { audio: MediaTrackConstraints };
    expect(last.audio.deviceId).toEqual({ exact: 'mic-1' });
  });
});

describe('server endings', () => {
  it('a voice mute ends voice, explains it and greys the toggle out', async () => {
    const r = rig();
    await live(r);
    r.rt.emit('voice_off', { reason: 'muted' });
    expect(r.vc.isActive).toBe(false);
    expect(FakePC.all[0]!.closed).toBe(true);
    expect(voice.getState().message).toMatch(/moderator/);
    expect(voice.getState().available).toBe(false);
    expect(r.enabled.at(-1)).toBe(false);
  });

  it('another tab taking over ends this one only for its own tab id', async () => {
    const r = rig();
    await live(r);
    r.rt.emit('voice_off', { cid: 'tab_other0000', reason: 'replaced' });
    expect(r.vc.isActive).toBe(true);
    r.rt.emit('voice_off', { cid: CID, reason: 'replaced' });
    expect(r.vc.isActive).toBe(false);
  });

  it('a refused join ends voice with the reason', async () => {
    const r = rig();
    await r.vc.refreshAvailability();
    await r.vc.enable();
    r.rt.emit('error', { code: 'voice_rate', message: 'Slow down' });
    expect(r.vc.isActive).toBe(false);
    expect(voice.getState().message).toMatch(/wait a minute/i);
  });

  it('switching off sends a leave and reports the time in voice', async () => {
    const r = rig();
    await live(r);
    expect(r.tracked[0]).toMatchObject({
      name: 'voice.join',
      props: { kind: 'party', mode: 'ptt', relayOnly: false, peers: 1 },
    });
    r.vc.disable();
    expect(r.rt.of('voice_leave')).toEqual([{ type: 'voice_leave', cid: CID }]);
    expect(r.tracked.at(-1)).toMatchObject({ name: 'voice.leave', props: { reason: 'user' } });
    expect(r.streams[0]!.tracks[0]!.stopped).toBe(true);
    expect(voice.getState().status).toBe('off');
  });
});

describe('PushToTalkInput', () => {
  function target() {
    const listeners = new Map<string, ((e: unknown) => void)[]>();
    return {
      addEventListener: (t: string, fn: (e: unknown) => void) =>
        listeners.set(t, [...(listeners.get(t) ?? []), fn]),
      removeEventListener: (t: string, fn: (e: unknown) => void) =>
        listeners.set(
          t,
          (listeners.get(t) ?? []).filter((f) => f !== fn),
        ),
      fire: (t: string, e: Record<string, unknown> = {}) => {
        for (const fn of listeners.get(t) ?? []) fn({ target: null, repeat: false, ...e });
      },
    };
  }

  it('follows the bound key, ignores typing, and releases on blur', () => {
    const t = target();
    const seen: boolean[] = [];
    const ptt = new PushToTalkInput(t as never, { keys: () => ['KeyV', 'Mouse4'], pad: () => [8] }, (h) =>
      seen.push(h),
    );
    ptt.start();
    t.fire('keydown', { code: 'KeyX' });
    t.fire('keydown', { code: 'KeyV' });
    t.fire('keyup', { code: 'KeyV' });
    t.fire('mousedown', { button: 4 });
    t.fire('blur');
    const input = { tagName: 'INPUT', isContentEditable: false } as unknown as EventTarget;
    t.fire('keydown', { code: 'KeyV', target: input });
    expect(seen).toEqual([true, false, true, false]);
    ptt.poll([
      {
        connected: true,
        mapping: 'standard',
        buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: i === 8 })),
      } as unknown as Gamepad,
    ]);
    expect(ptt.held).toBe(true);
    ptt.stop();
    expect(ptt.held).toBe(false);
  });
});

describe('voiceIcePolicy', () => {
  const turn = [{ urls: ['stun:s.example:3478'] }, { urls: ['turns:t.example:5349'] }];
  const stunOnly = [{ urls: ['stun:s.example:3478'] }];

  it('spots TURN among the ICE servers', () => {
    expect(hasTurnServer(turn)).toBe(true);
    expect(hasTurnServer([{ urls: ['TURN:t.example:3478?transport=udp'] }])).toBe(true);
    expect(hasTurnServer(stunOnly)).toBe(false);
    expect(hasTurnServer([])).toBe(false);
  });

  it('relays team rooms whenever TURN exists, party rooms only when chosen', () => {
    expect(voiceIcePolicy('team', false, turn)).toBe('relay');
    expect(voiceIcePolicy(null, false, turn)).toBe('relay');
    expect(voiceIcePolicy('party', false, turn)).toBe('all');
    expect(voiceIcePolicy('party', true, turn)).toBe('relay');
  });

  it('never forces a relay that does not exist', () => {
    expect(voiceIcePolicy('team', false, stunOnly)).toBe('all');
    expect(voiceIcePolicy('party', true, [])).toBe('all');
  });
});
