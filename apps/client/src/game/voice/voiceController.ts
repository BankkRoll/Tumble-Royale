/**
 * Voice chat in the browser: a WebRTC mesh with exactly the peers the API
 * names.
 *
 * Responsibilities:
 * - the opt-in session: the microphone is requested only when the player
 *   switches voice on; `voice_join` / `voice_leave` over the realtime socket,
 *   re-joined after a reconnect and before the TURN credentials lapse;
 * - one `RTCPeerConnection` per peer of the latest `voice_room`; anyone no
 *   longer listed is hung up at once. The smaller user id offers; ICE
 *   candidates trickle; a failed connection gets an ICE restart (the
 *   answerer asks the offerer for one);
 * - `iceTransportPolicy: 'relay'` whenever TURN is offered, except in a party
 *   room without the "relay only" setting, so strangers in a team room only
 *   ever see the TURN server's address ({@link voiceIcePolicy});
 * - sending: push-to-talk or open mic gated by a level threshold, by
 *   enabling the outgoing track, so no audio leaves while the gate is shut;
 *   paused while the tab is hidden;
 * - receiving: through the audio mixer with per-player volume and mute,
 *   speaking indicators from levels, music ducked while someone talks;
 * - microphone loss (unplugged, permission revoked): falls back to the
 *   default device, or ends voice with an explanation;
 * - mirrors all of it into the UI's voice store.
 *
 * Browser APIs are injected ({@link VoiceDeps}) so the state machine runs
 * under tests with fakes.
 */
import {
  isAudioOnlySdp,
  voiceOfferer,
  type VoiceCandidate,
  type VoiceConfigResponse,
  type VoiceIceServer,
  type VoiceOffReason,
  type VoicePeer,
  type VoiceRoomKind,
} from '@tumble/shared';
import { voice, type VoicePeerView, type VoiceSettings } from '@tumble/ui';
import type { RealtimeLike } from '../social/socialController.ts';

/** Level (0..1, see `rmsLevel`) above which someone counts as speaking (about -40 dBFS). */
export const SPEAKING_LEVEL = 0.33;
/** Speaking marks and the open-mic gate stay on this long after the level drops. */
export const VOICE_HOLD_MS = 350;
/** A connection stuck in `disconnected` this long gets an ICE restart. */
export const DISCONNECT_GRACE_MS = 4000;
/** ICE restarts tried in a row before a peer is shown as unreachable. */
export const MAX_RESTARTS = 3;
/** Credentials are refreshed this long before they expire. */
const REFRESH_LEAD_MS = 10 * 60_000;

/**
 * True when the ICE server list includes a TURN relay (`turn:` or `turns:`).
 *
 * @param servers - ICE servers from the latest `voice_room`.
 * @returns Whether relayed candidates can be gathered at all.
 */
export function hasTurnServer(servers: readonly VoiceIceServer[]): boolean {
  return servers.some((s) => s.urls.some((u) => /^turns?:/i.test(u)));
}

/**
 * The ICE transport policy for a voice room.
 *
 * @param kind - The room's kind; null before the first `voice_room` names one.
 * @param relayChosen - Settings → relay only.
 * @param servers - ICE servers from the latest `voice_room`.
 * @returns `'relay'` or `'all'`.
 * @example
 * voiceIcePolicy('team', false, [{ urls: ['turn:t.example:3478'] }]); // 'relay'
 * voiceIcePolicy('party', false, [{ urls: ['turn:t.example:3478'] }]); // 'all'
 */
export function voiceIcePolicy(
  kind: VoiceRoomKind | null,
  relayChosen: boolean,
  servers: readonly VoiceIceServer[],
): RTCIceTransportPolicy {
  // NOTE: relay-only without a TURN server would gather no candidates at all, so voice would never connect.
  if (!hasTurnServer(servers)) return 'all';
  // SECURITY: host and server-reflexive candidates carry the player's own IP addresses.
  // Party mates chose each other; a team room pairs strangers, so it always relays.
  return relayChosen || kind !== 'party' ? 'relay' : 'all';
}

/** The choices that shape a session (from `Settings.voice` and Streamer Mode). */
export interface VoiceOptions extends Pick<
  VoiceSettings,
  | 'mode'
  | 'threshold'
  | 'inputDeviceId'
  | 'volume'
  | 'relayOnly'
  | 'teamVoice'
  | 'noiseSuppression'
  | 'echoCancellation'
  | 'peerVolume'
  | 'peerMuted'
> {
  /** False silences every peer (Streamer Mode's "don't play voice"). */
  playback: boolean;
}

/** Microphone access as the controller uses it. */
export interface VoiceMedia {
  /** WebRTC and `getUserMedia` exist in a secure context. */
  supported(): boolean;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  enumerateDevices(): Promise<Pick<MediaDeviceInfo, 'deviceId' | 'kind' | 'label'>[]>;
  /** Subscribes to `devicechange`; returns an unsubscribe. */
  onDeviceChange(fn: () => void): () => void;
  /** The microphone permission without prompting. */
  permission(): Promise<'granted' | 'denied' | 'prompt' | 'unknown'>;
}

/** The audio side (see `VoiceChatMixer` in `@tumble/audio`). */
export interface VoiceMixer {
  addPeer(stream: MediaStream): { setGain(g: number): void; level(): number; dispose(): void };
  meter(stream: MediaStream): { level(): number; dispose(): void };
  setVolume(volume: number): void;
  setTalking(talking: boolean): void;
}

/** Everything the controller needs from the outside. */
export interface VoiceDeps {
  realtime: RealtimeLike;
  /** `GET /voice/config`. */
  fetchConfig(): Promise<VoiceConfigResponse>;
  selfId(): string | null;
  media: VoiceMedia;
  mixer: VoiceMixer;
  createPeer(config: RTCConfiguration): RTCPeerConnection;
  track(name: 'voice.join' | 'voice.leave', props: Record<string, string | number | boolean>): void;
  now(): number;
  /** A fresh tab id (`[A-Za-z0-9_-]{8,40}`). */
  newCid(): string;
  /** Persists whether voice is on (`Settings.voice.enabled`). */
  onEnabledChange(enabled: boolean): void;
}

interface PeerLink {
  peer: VoicePeer;
  pc: RTCPeerConnection;
  offerer: boolean;
  pending: RTCIceCandidateInit[];
  output: ReturnType<VoiceMixer['addPeer']> | null;
  restarts: number;
  timer: ReturnType<typeof setTimeout> | null;
  connection: VoicePeerView['connection'];
  speakingUntil: number;
  speaking: boolean;
  closed: boolean;
}

const OFF_TEXT: Record<VoiceOffReason, string> = {
  muted: 'Voice chat was disabled on your account by a moderator.',
  banned: 'Your account is suspended.',
  replaced: 'Voice moved to another tab or device.',
  disabled: 'Voice chat was switched off on this server.',
  expired: 'Voice ended. Switch it on again to rejoin.',
};

const ERROR_TEXT: Record<string, string> = {
  voice_disabled: 'Voice chat is switched off on this server right now.',
  voice_muted: 'Voice chat is disabled on your account.',
  voice_rate: 'Too many tries. Wait a minute and switch voice on again.',
};

function errorName(err: unknown): string {
  return err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
}

/**
 * The voice session state machine.
 *
 * @example
 * const vc = new VoiceController(deps, options);
 * vc.attach();
 * await vc.refreshAvailability();
 * await vc.enable(); // asks for the microphone
 * // every frame:
 * vc.tick(performance.now());
 */
export class VoiceController {
  private opts: VoiceOptions;
  private cid: string | null = null;
  private starting = false;
  /** Bumped when a pending microphone request is called off (voice switched off, teardown). */
  private startGen = 0;
  private active = false;
  private stream: MediaStream | null = null;
  private meter: ReturnType<VoiceMixer['meter']> | null = null;
  private readonly links = new Map<string, PeerLink>();
  private room: { id: string; kind: VoiceRoomKind } | null = null;
  private ice: { servers: VoiceIceServer[]; expiresAt: number; relay: boolean } = {
    servers: [],
    expiresAt: 0,
    relay: false,
  };
  private pttHeld = false;
  private hidden = false;
  private gateUntil = 0;
  private since = 0;
  private trackedRoom: string | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly offs: (() => void)[] = [];

  constructor(
    private readonly deps: VoiceDeps,
    options: VoiceOptions,
  ) {
    this.opts = options;
    this.deps.mixer.setVolume(options.playback ? options.volume : 0);
  }

  /** True while voice is on (connecting or live). */
  get isActive(): boolean {
    return this.active;
  }

  /** Subscribes to the realtime socket and device changes. */
  attach(): void {
    const rt = this.deps.realtime;
    this.offs.push(
      rt.on('voice_room', (m) => this.onRoom(m)),
      rt.on('voice_signal', (m) => void this.onSignal(m).catch(() => undefined)),
      rt.on('voice_off', (m) => this.onOff(m)),
      rt.on('error', (m) => this.onError(m)),
      rt.on('socket_open', () => {
        if (this.active) this.join();
      }),
      this.deps.media.onDeviceChange(() => void this.onDeviceChange()),
    );
  }

  /** Re-reads `GET /voice/config` into the store (Settings opened, signed in). */
  async refreshAvailability(): Promise<void> {
    if (!this.deps.media.supported()) {
      voice
        .getState()
        .setAvailability({ available: false, reason: 'unsupported', relay: false, teamVoice: false });
      return;
    }
    try {
      const c = await this.deps.fetchConfig();
      voice.getState().setAvailability({
        available: c.available,
        reason: c.reason,
        relay: c.relay,
        teamVoice: c.teamVoice,
      });
    } catch {
      voice
        .getState()
        .setAvailability({ available: false, reason: 'offline', relay: false, teamVoice: false });
    }
    await this.refreshDevices();
  }

  /**
   * Reads availability, then turns voice back on after a reload, but only when the player had it on
   * and the browser still grants the microphone without asking: a page load
   * must never pop a permission prompt.
   *
   * @param wasEnabled - `Settings.voice.enabled` from storage.
   */
  async restore(wasEnabled: boolean): Promise<void> {
    await this.refreshAvailability();
    if (!wasEnabled) return;
    const granted = (await this.deps.media.permission().catch(() => 'unknown')) === 'granted';
    if (granted && voice.getState().available) await this.enable();
    else this.deps.onEnabledChange(false);
  }

  /**
   * Switches voice on: asks for the microphone, then joins.
   *
   * @returns Whether voice is now on.
   */
  async enable(): Promise<boolean> {
    if (this.active || this.starting) return this.active;
    if (!this.deps.media.supported() || !voice.getState().available) return false;
    this.starting = true;
    const gen = ++this.startGen;
    voice.getState().setStatus('requesting');
    let stream: MediaStream;
    try {
      stream = await this.acquire();
    } catch (err) {
      if (gen !== this.startGen) return false;
      this.starting = false;
      this.failMic(err);
      this.deps.onEnabledChange(false);
      return false;
    }
    // Switched off while the permission prompt was up: the granted microphone must not stay open.
    if (gen !== this.startGen) {
      for (const t of stream.getTracks()) t.stop();
      return false;
    }
    this.useStream(stream);
    this.starting = false;
    this.active = true;
    this.cid = this.deps.newCid();
    this.since = this.deps.now();
    this.trackedRoom = null;
    voice.getState().setStatus('connecting');
    this.deps.onEnabledChange(true);
    this.join();
    void this.refreshDevices();
    return true;
  }

  /** Switches voice off (the player's choice). */
  disable(): void {
    if (this.starting) {
      this.startGen++;
      this.starting = false;
      voice.getState().setStatus('off');
      this.deps.onEnabledChange(false);
      return;
    }
    if (!this.active) return;
    if (this.cid && this.deps.realtime.connected)
      this.deps.realtime.send({ type: 'voice_leave', cid: this.cid });
    this.end('user', null);
  }

  /**
   * Applies new options; reopens the microphone, reconfigures ICE or
   * re-joins only when the relevant option changed.
   *
   * @param next - Options from settings.
   */
  setOptions(next: VoiceOptions): void {
    const prev = this.opts;
    this.opts = next;
    this.deps.mixer.setVolume(next.playback ? next.volume : 0);
    for (const link of this.links.values()) this.applyGain(link);
    if (!this.active) return;
    if (
      prev.inputDeviceId !== next.inputDeviceId ||
      prev.noiseSuppression !== next.noiseSuppression ||
      prev.echoCancellation !== next.echoCancellation
    )
      void this.reopenMic();
    if (prev.relayOnly !== next.relayOnly)
      for (const link of this.links.values()) {
        this.configure(link);
        link.restarts = 0;
        this.restart(link);
      }
    if (prev.teamVoice !== next.teamVoice) this.join();
  }

  /**
   * Push-to-talk key or button state.
   *
   * @param held - The binding is held down.
   */
  setPushToTalk(held: boolean): void {
    this.pttHeld = held;
  }

  /**
   * The tab was hidden or shown. Sending pauses while hidden: a key release
   * is never seen there, and nobody expects an open mic in a background tab.
   *
   * @param hidden - `document.visibilityState === 'hidden'`.
   */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    if (hidden) this.pttHeld = false;
  }

  /**
   * Per-frame work: the sending gate, speaking marks and music ducking.
   *
   * @param now - Clock reading (ms).
   */
  tick(now: number): void {
    if (!this.active) return;
    const s = voice.getState();
    const mic = this.meter?.level() ?? 0;
    s.setMicLevel(mic);
    let open: boolean;
    if (this.hidden) open = false;
    else if (this.opts.mode === 'ptt') open = this.pttHeld;
    else {
      if (mic >= this.opts.threshold) this.gateUntil = now + VOICE_HOLD_MS;
      open = now < this.gateUntil;
    }
    for (const t of this.stream?.getAudioTracks() ?? []) t.enabled = open;
    s.setSelf({
      transmitting: open,
      selfSpeaking: open && mic >= Math.min(SPEAKING_LEVEL, this.opts.threshold),
    });
    let anyone = false;
    for (const link of this.links.values()) {
      const level = link.output?.level() ?? 0;
      if (level >= SPEAKING_LEVEL) link.speakingUntil = now + VOICE_HOLD_MS;
      const speaking = now < link.speakingUntil;
      if (speaking && !this.opts.peerMuted[link.peer.userId]) anyone = true;
      if (speaking !== link.speaking) {
        link.speaking = speaking;
        s.patchPeer(link.peer.userId, { speaking });
      }
    }
    this.deps.mixer.setTalking(anyone && this.opts.playback);
  }

  /** Ends voice and unsubscribes (signed out). */
  dispose(): void {
    this.disable();
    for (const off of this.offs.splice(0)) off();
  }

  // ---------------------------------------------------------------------------
  // Session
  // ---------------------------------------------------------------------------

  private join(): void {
    if (!this.cid || !this.deps.realtime.connected) return;
    this.deps.realtime.send({ type: 'voice_join', cid: this.cid, team: this.opts.teamVoice });
  }

  /** Tears everything down and reports why. */
  private end(reason: VoiceOffReason | 'user' | 'mic', message: string | null): void {
    const wasActive = this.active;
    for (const id of [...this.links.keys()]) this.hangUp(id);
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    this.meter?.dispose();
    this.meter = null;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.deps.mixer.setTalking(false);
    this.active = false;
    this.starting = false;
    this.cid = null;
    this.room = null;
    voice.getState().reset();
    if (message) voice.getState().setStatus(reason === 'mic' ? 'denied' : 'off', message);
    this.deps.onEnabledChange(false);
    if (wasActive)
      this.deps.track('voice.leave', {
        reason,
        seconds: Math.round((this.deps.now() - this.since) / 1000),
      });
  }

  private onRoom(m: Record<string, unknown>): void {
    if (!this.active || m.cid !== this.cid) return;
    const room = m.room as { id: string; kind: VoiceRoomKind } | null;
    const peers = (Array.isArray(m.peers) ? m.peers : []) as VoicePeer[];
    const ice = m.ice as { servers?: VoiceIceServer[]; expiresAt?: number; relay?: boolean } | undefined;
    const wasRelay = this.relayOnly();
    this.ice = { servers: ice?.servers ?? [], expiresAt: ice?.expiresAt ?? 0, relay: ice?.relay === true };
    this.room = room;
    const keep = new Set(peers.map((p) => p.userId));
    for (const id of [...this.links.keys()]) if (!keep.has(id)) this.hangUp(id);
    const policyChanged = wasRelay !== this.relayOnly();
    for (const link of this.links.values()) {
      this.configure(link);
      // A party mate who stays on into a team room must re-gather relay-only candidates.
      if (policyChanged) {
        link.restarts = 0;
        this.restart(link);
      }
    }
    for (const p of peers) if (!this.links.has(p.userId)) this.call(p);
    voice.getState().setRoom(
      room ? { kind: room.kind } : null,
      peers.map((p) => {
        const link = this.links.get(p.userId);
        return {
          userId: p.userId,
          name: p.name,
          tag: p.tag,
          speaking: link?.speaking ?? false,
          connection: link?.connection ?? 'connecting',
        };
      }),
    );
    voice.getState().setStatus('live');
    this.scheduleRefresh();
    if (room && room.id !== this.trackedRoom) {
      this.trackedRoom = room.id;
      this.deps.track('voice.join', {
        kind: room.kind,
        mode: this.opts.mode,
        relayOnly: this.relayOnly(),
        peers: peers.length,
      });
    }
  }

  private onOff(m: Record<string, unknown>): void {
    const reason = m.reason as VoiceOffReason;
    if (reason === 'muted' || reason === 'banned')
      voice.getState().setAvailability({
        available: false,
        reason: 'muted',
        relay: voice.getState().relayAvailable,
        teamVoice: voice.getState().teamVoiceAllowed,
      });
    if (!this.active || (typeof m.cid === 'string' && m.cid !== this.cid)) return;
    this.end(reason, OFF_TEXT[reason] ?? OFF_TEXT.expired);
  }

  private onError(m: Record<string, unknown>): void {
    const code = typeof m.code === 'string' ? m.code : '';
    if (!this.active || !code.startsWith('voice_')) return;
    this.end('disabled', ERROR_TEXT[code] ?? 'Voice chat could not start.');
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    if (this.ice.expiresAt <= 0) return;
    const wait = Math.max(60_000, this.ice.expiresAt - this.deps.now() - REFRESH_LEAD_MS);
    this.refreshTimer = setTimeout(() => this.join(), wait);
  }

  // ---------------------------------------------------------------------------
  // Peers
  // ---------------------------------------------------------------------------

  private relayOnly(): boolean {
    return voiceIcePolicy(this.room?.kind ?? null, this.opts.relayOnly, this.ice.servers) === 'relay';
  }

  private rtcConfig(): RTCConfiguration {
    return {
      iceServers: this.ice.servers.map((s) => ({ ...s })),
      iceTransportPolicy: this.relayOnly() ? 'relay' : 'all',
      bundlePolicy: 'max-bundle',
    };
  }

  private configure(link: PeerLink): void {
    try {
      link.pc.setConfiguration(this.rtcConfig());
    } catch {
      // COMPAT: some engines refuse a policy change mid-call; the next restart picks it up.
    }
  }

  private send(link: PeerLink, kind: string, extra: { sdp?: string; candidate?: VoiceCandidate } = {}): void {
    if (!this.cid || link.closed) return;
    this.deps.realtime.send({ type: 'voice_signal', cid: this.cid, to: link.peer.userId, kind, ...extra });
  }

  private call(peer: VoicePeer): void {
    const self = this.deps.selfId();
    if (!self || !this.stream) return;
    const pc = this.deps.createPeer(this.rtcConfig());
    const link: PeerLink = {
      peer,
      pc,
      offerer: voiceOfferer(self, peer.userId),
      pending: [],
      output: null,
      restarts: 0,
      timer: null,
      connection: 'connecting',
      speakingUntil: 0,
      speaking: false,
      closed: false,
    };
    this.links.set(peer.userId, link);
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const c = e.candidate.toJSON();
      this.send(link, 'ice', {
        candidate: {
          candidate: c.candidate ?? '',
          sdpMid: c.sdpMid ?? null,
          sdpMLineIndex: c.sdpMLineIndex ?? null,
          ...(c.usernameFragment ? { usernameFragment: c.usernameFragment } : {}),
        },
      });
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      link.output?.dispose();
      link.output = this.deps.mixer.addPeer(stream);
      this.applyGain(link);
    };
    pc.onconnectionstatechange = () => this.onConnectionState(link);
    if (link.offerer) {
      for (const t of this.stream.getAudioTracks()) pc.addTrack(t, this.stream);
      void this.offer(link, false).catch(() => undefined);
    }
  }

  private async offer(link: PeerLink, iceRestart: boolean): Promise<void> {
    const offer = await link.pc.createOffer(iceRestart ? { iceRestart: true } : {});
    if (link.closed) return;
    await link.pc.setLocalDescription(offer);
    this.send(link, 'offer', { sdp: link.pc.localDescription?.sdp ?? offer.sdp ?? '' });
  }

  private async onSignal(m: Record<string, unknown>): Promise<void> {
    if (!this.active || !this.room || m.roomId !== this.room.id) return;
    const link = typeof m.from === 'string' ? this.links.get(m.from) : undefined;
    if (!link) return;
    const pc = link.pc;
    const sdp = typeof m.sdp === 'string' ? m.sdp : '';
    switch (m.kind) {
      case 'offer': {
        // SECURITY: the server already refuses non-audio SDP; checked again so
        // a compromised relay cannot open video or data channels either.
        if (link.offerer || !isAudioOnlySdp(sdp)) return;
        await pc.setRemoteDescription({ type: 'offer', sdp });
        if (this.stream && !pc.getSenders().some((s) => s.track))
          for (const t of this.stream.getAudioTracks()) pc.addTrack(t, this.stream);
        const answer = await pc.createAnswer();
        if (link.closed) return;
        await pc.setLocalDescription(answer);
        this.send(link, 'answer', { sdp: pc.localDescription?.sdp ?? answer.sdp ?? '' });
        await this.flush(link);
        return;
      }
      case 'answer':
        if (!link.offerer || !isAudioOnlySdp(sdp)) return;
        await pc.setRemoteDescription({ type: 'answer', sdp });
        await this.flush(link);
        return;
      case 'ice': {
        const c = m.candidate as RTCIceCandidateInit | undefined;
        if (!c) return;
        if (pc.remoteDescription) await pc.addIceCandidate(c).catch(() => undefined);
        else link.pending.push(c);
        return;
      }
      case 'restart':
        if (link.offerer) {
          link.restarts = 0;
          this.restart(link);
        }
        return;
    }
  }

  private async flush(link: PeerLink): Promise<void> {
    for (const c of link.pending.splice(0)) await link.pc.addIceCandidate(c).catch(() => undefined);
  }

  private onConnectionState(link: PeerLink): void {
    if (link.closed) return;
    const state = link.pc.connectionState;
    if (state === 'connected') {
      link.restarts = 0;
      if (link.timer) clearTimeout(link.timer);
      link.timer = null;
      this.setConnection(link, 'connected');
    } else if (state === 'failed') this.restart(link);
    else if (state === 'disconnected' && !link.timer)
      link.timer = setTimeout(() => {
        link.timer = null;
        if (!link.closed && link.pc.connectionState !== 'connected') this.restart(link);
      }, DISCONNECT_GRACE_MS);
  }

  private restart(link: PeerLink): void {
    if (link.closed) return;
    if (link.restarts >= MAX_RESTARTS) return this.setConnection(link, 'failed');
    link.restarts++;
    this.setConnection(link, 'connecting');
    if (link.offerer) {
      link.pc.restartIce?.();
      void this.offer(link, true).catch(() => undefined);
    } else this.send(link, 'restart');
  }

  private setConnection(link: PeerLink, connection: VoicePeerView['connection']): void {
    link.connection = connection;
    voice.getState().patchPeer(link.peer.userId, { connection });
  }

  private applyGain(link: PeerLink): void {
    const id = link.peer.userId;
    link.output?.setGain(this.opts.peerMuted[id] ? 0 : (this.opts.peerVolume[id] ?? 1));
  }

  private hangUp(id: string): void {
    const link = this.links.get(id);
    if (!link) return;
    link.closed = true;
    if (link.timer) clearTimeout(link.timer);
    link.output?.dispose();
    link.pc.close();
    this.links.delete(id);
  }

  // ---------------------------------------------------------------------------
  // Microphone
  // ---------------------------------------------------------------------------

  private constraints(deviceId: string): MediaStreamConstraints {
    return {
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: this.opts.echoCancellation,
        noiseSuppression: this.opts.noiseSuppression,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    };
  }

  /** Opens the chosen microphone, or the default one when it is gone. */
  private async acquire(): Promise<MediaStream> {
    const id = this.opts.inputDeviceId;
    try {
      return await this.deps.media.getUserMedia(this.constraints(id));
    } catch (err) {
      if (!id || errorName(err) === 'NotAllowedError') throw err;
      return this.deps.media.getUserMedia(this.constraints(''));
    }
  }

  private useStream(stream: MediaStream): void {
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.meter?.dispose();
    this.stream = stream;
    for (const t of stream.getAudioTracks()) {
      t.enabled = false;
      // An unplugged microphone or a revoked permission ends the track.
      t.addEventListener('ended', () => {
        if (this.stream === stream) void this.reopenMic();
      });
    }
    this.meter = this.deps.mixer.meter(stream);
  }

  private async reopenMic(): Promise<void> {
    if (!this.active) return;
    let stream: MediaStream;
    try {
      stream = await this.acquire();
    } catch (err) {
      this.failMic(err);
      return;
    }
    if (!this.active) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    this.useStream(stream);
    const track = stream.getAudioTracks()[0] ?? null;
    for (const link of this.links.values())
      for (const sender of link.pc.getSenders())
        if (!sender.track || sender.track.kind === 'audio')
          void sender.replaceTrack(track).catch(() => undefined);
  }

  private failMic(err: unknown): void {
    const name = errorName(err);
    const message =
      name === 'NotAllowedError' || name === 'SecurityError'
        ? 'Microphone blocked. Allow it for this site in your browser, then switch voice on again.'
        : name === 'NotFoundError' || name === 'OverconstrainedError'
          ? 'No microphone found. Plug one in and try again.'
          : 'Could not open the microphone.';
    if (this.active) this.end('mic', message);
    else voice.getState().setStatus(name === 'NotAllowedError' ? 'denied' : 'error', message);
  }

  private async onDeviceChange(): Promise<void> {
    await this.refreshDevices();
    const id = this.opts.inputDeviceId;
    if (this.active && id && !voice.getState().devices.some((d) => d.id === id)) await this.reopenMic();
  }

  private async refreshDevices(): Promise<void> {
    if (!this.deps.media.supported()) return;
    try {
      const all = await this.deps.media.enumerateDevices();
      const mics = all.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default');
      voice
        .getState()
        .setDevices(mics.map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` })));
    } catch {
      // Device lists are a convenience; the default microphone still works.
    }
  }
}
