/**
 * Connects voice chat to the rest of the client once an online account is
 * signed in: settings, UI intents, push-to-talk input, tab visibility,
 * analytics and the per-frame tick.
 */
import type { AudioEngine } from '@tumble/audio';
import { ui, uiEvents, type Settings } from '@tumble/ui';
import type { ApiClient } from '../api.ts';
import { track } from '../liveOps/analytics.ts';
import type { RealtimeLike } from '../social/socialController.ts';
import { browserVoiceMedia, browserVoiceMixer, newVoiceCid } from './browserVoice.ts';
import { PushToTalkInput } from './pushToTalk.ts';
import { VoiceController, type VoiceOptions } from './voiceController.ts';

/** What the app keeps of the voice wiring. */
export interface VoiceHandle {
  readonly controller: VoiceController;
  /** Per-frame work (push-to-talk pad polling, speaking marks). */
  tick(now: number): void;
  dispose(): void;
}

/**
 * The controller options for a set of settings.
 *
 * @param s - All settings.
 * @returns Voice options, with Streamer Mode's "don't play voice" folded in.
 */
export function voiceOptions(s: Settings): VoiceOptions {
  const v = s.voice;
  return {
    mode: v.mode,
    threshold: v.threshold,
    inputDeviceId: v.inputDeviceId,
    volume: v.volume,
    relayOnly: v.relayOnly,
    teamVoice: v.teamVoice,
    noiseSuppression: v.noiseSuppression,
    echoCancellation: v.echoCancellation,
    peerVolume: v.peerVolume,
    peerMuted: v.peerMuted,
    playback: !(s.gameplay.streamerMode && v.streamerMute),
  };
}

/**
 * Starts voice for a signed-in account. Voice itself stays off unless the
 * player switches it on (or had it on and the browser still grants the
 * microphone without a prompt).
 *
 * @param opts - The account's realtime socket and API, the player's id and the audio engine.
 * @returns A handle to tick and dispose.
 */
export function startVoice(opts: {
  realtime: RealtimeLike;
  api: ApiClient;
  selfId: () => string | null;
  engine: AudioEngine;
}): VoiceHandle {
  const mixer = browserVoiceMixer(opts.engine);
  const settings = () => ui.getState().settings;
  const controller = new VoiceController(
    {
      realtime: opts.realtime,
      fetchConfig: () => opts.api.voiceConfig(),
      selfId: opts.selfId,
      media: browserVoiceMedia(),
      mixer,
      createPeer: (config) => new RTCPeerConnection(config),
      track: (name, props) => track(name, props),
      now: () => Date.now(),
      newCid: newVoiceCid,
      onEnabledChange: (enabled) => {
        if (settings().voice.enabled !== enabled) ui.getState().updateSettings('voice', { enabled });
      },
    },
    voiceOptions(settings()),
  );
  controller.attach();
  const ptt = new PushToTalkInput(
    window,
    {
      keys: () => (settings().controls.keybinds.pushToTalk ?? []).filter(Boolean),
      pad: () => settings().controls.padBinds.pushToTalk ?? [],
    },
    (held) => controller.setPushToTalk(held),
  );
  ptt.start();
  const onVisibility = () => controller.setHidden(document.visibilityState === 'hidden');
  document.addEventListener('visibilitychange', onVisibility);
  const offs = [
    uiEvents.on('voiceToggle', ({ on }) => {
      if (on) void controller.enable();
      else controller.disable();
    }),
    uiEvents.on('voiceRefresh', () => void controller.refreshAvailability()),
    uiEvents.on('settingsChange', ({ settings: s }) => controller.setOptions(voiceOptions(s))),
  ];
  void controller.restore(settings().voice.enabled);
  return {
    controller,
    tick: (now) => {
      if (!controller.isActive) return;
      if (typeof navigator.getGamepads === 'function') ptt.poll(navigator.getGamepads());
      controller.tick(now);
    },
    dispose: () => {
      for (const off of offs) off();
      document.removeEventListener('visibilitychange', onVisibility);
      ptt.stop();
      controller.dispose();
      mixer.dispose();
    },
  };
}
