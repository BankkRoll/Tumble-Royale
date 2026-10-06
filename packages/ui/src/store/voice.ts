/**
 * Voice chat UI state: whether voice can be used at all, where the player's
 * session stands, who is in their room and who is speaking.
 *
 * Its own Zustand store so speaking indicators flipping never re-render the
 * menus. The game fills it (`voiceController.ts`); the UI reads it and emits
 * `voice*` intents. The player's choices (on/off, push-to-talk, device,
 * volumes) live in `Settings.voice` instead, so they persist.
 */
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

/** Where the player's voice session stands. */
export type VoiceStatus =
  /** Voice is switched off (the default). */
  | 'off'
  /** Waiting on the browser's microphone prompt. */
  | 'requesting'
  /** Microphone allowed, waiting for the server's room. */
  | 'connecting'
  /** In voice (alone or with peers). */
  | 'live'
  /** The microphone was refused or revoked. */
  | 'denied'
  /** Something else went wrong; `message` says what. */
  | 'error';

/** Why voice is not offered. */
export type VoiceUnavailableReason =
  | 'flag_off'
  | 'not_configured'
  | 'muted'
  | 'offline'
  /** The browser has no WebRTC or microphone access (or the page is not a secure context). */
  | 'unsupported';

/** One peer in the room. */
export interface VoicePeerView {
  userId: string;
  name: string;
  tag: string;
  speaking: boolean;
  connection: 'connecting' | 'connected' | 'failed';
}

/** A microphone the player can pick. */
export interface VoiceDeviceView {
  id: string;
  label: string;
}

/** Voice store state + setters. */
export interface VoiceState {
  available: boolean;
  unavailableReason: VoiceUnavailableReason | null;
  /** A TURN relay exists, so "relay only" can work. */
  relayAvailable: boolean;
  /** The account may use team voice with players outside its party. */
  teamVoiceAllowed: boolean;
  status: VoiceStatus;
  /** Player-facing explanation of the last problem. */
  message: string | null;
  room: { kind: 'party' | 'team' } | null;
  peers: VoicePeerView[];
  /** The microphone is sending right now (push-to-talk held or the open mic gate open). */
  transmitting: boolean;
  /** The player is talking (transmitting and above the noise floor). */
  selfSpeaking: boolean;
  /** Microphone level 0..1, for the sensitivity meter. */
  micLevel: number;
  devices: VoiceDeviceView[];

  setAvailability(v: {
    available: boolean;
    reason: VoiceUnavailableReason | null;
    relay: boolean;
    teamVoice: boolean;
  }): void;
  setStatus(status: VoiceStatus, message?: string | null): void;
  setRoom(room: VoiceState['room'], peers: VoicePeerView[]): void;
  /** Merges one peer's fields (no-op for an unknown peer or no change). */
  patchPeer(userId: string, patch: Partial<Omit<VoicePeerView, 'userId'>>): void;
  setSelf(v: { transmitting: boolean; selfSpeaking: boolean }): void;
  setMicLevel(level: number): void;
  setDevices(devices: VoiceDeviceView[]): void;
  /** Back to "off" (signed out, voice ended). */
  reset(): void;
}

const SESSION = {
  status: 'off' as VoiceStatus,
  message: null,
  room: null,
  peers: [],
  transmitting: false,
  selfSpeaking: false,
  micLevel: 0,
};

/** The voice store (vanilla; read with {@link useVoice}). */
export const voice = createStore<VoiceState>()((set, get) => ({
  available: false,
  unavailableReason: 'offline',
  relayAvailable: false,
  teamVoiceAllowed: false,
  devices: [],
  ...SESSION,
  setAvailability: (v) =>
    set({
      available: v.available,
      unavailableReason: v.available ? null : v.reason,
      relayAvailable: v.relay,
      teamVoiceAllowed: v.teamVoice,
    }),
  setStatus: (status, message = null) => set({ status, message }),
  setRoom: (room, peers) => set({ room, peers }),
  patchPeer: (userId, patch) => {
    const peers = get().peers;
    const i = peers.findIndex((p) => p.userId === userId);
    if (i < 0) return;
    const cur = peers[i]!;
    if ((Object.keys(patch) as (keyof typeof patch)[]).every((k) => cur[k] === patch[k])) return;
    const next = peers.slice();
    next[i] = { ...cur, ...patch };
    set({ peers: next });
  },
  setSelf: (v) => {
    const s = get();
    if (s.transmitting !== v.transmitting || s.selfSpeaking !== v.selfSpeaking) set(v);
  },
  setMicLevel: (micLevel) => {
    if (Math.abs(get().micLevel - micLevel) >= 0.02) set({ micLevel });
  },
  setDevices: (devices) => set({ devices }),
  reset: () => set({ ...SESSION }),
}));

/**
 * React hook over the voice store.
 *
 * @example
 * const speaking = useVoice((s) => s.peers.some((p) => p.speaking));
 */
export function useVoice<T>(selector: (s: VoiceState) => T): T {
  return useStore(voice, selector);
}

/** Player-facing text for why voice is unavailable. */
export const VOICE_UNAVAILABLE_TEXT: Readonly<Record<VoiceUnavailableReason, string>> = {
  flag_off: 'Voice chat is switched off on this server right now.',
  not_configured: 'This server has not set up voice chat.',
  muted: 'Voice chat is disabled on your account.',
  offline: 'Sign in online to use voice chat.',
  unsupported: 'This browser cannot use voice chat (it needs a microphone, WebRTC and a secure page).',
};
