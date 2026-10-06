/**
 * The real browser behind {@link VoiceController}: `getUserMedia`, device
 * lists, the microphone permission, `RTCPeerConnection` and the voice mixer
 * in `@tumble/audio`.
 */
import { VoiceChatMixer, type AudioEngine } from '@tumble/audio';
import type { VoiceMedia, VoiceMixer } from './voiceController.ts';

/**
 * Microphone access through `navigator.mediaDevices`.
 *
 * @param nav - The browser navigator (injectable for tests).
 * @returns The media side of the voice controller.
 */
export function browserVoiceMedia(nav: Navigator = navigator): VoiceMedia {
  const md = nav.mediaDevices as MediaDevices | undefined;
  return {
    supported: () =>
      typeof RTCPeerConnection !== 'undefined' &&
      !!md?.getUserMedia &&
      (typeof isSecureContext === 'undefined' || isSecureContext),
    getUserMedia: (c) => md!.getUserMedia(c),
    enumerateDevices: async () => (md ? md.enumerateDevices() : []),
    onDeviceChange: (fn) => {
      md?.addEventListener('devicechange', fn);
      return () => md?.removeEventListener('devicechange', fn);
    },
    permission: async () => {
      try {
        // COMPAT: Firefox and older Safari have no "microphone" permission name and throw.
        const status = await nav.permissions.query({ name: 'microphone' as PermissionName });
        return status.state;
      } catch {
        return 'unknown';
      }
    },
  };
}

/**
 * The voice mixer on the game's audio engine.
 *
 * @param engine - The game's audio engine.
 */
export function browserVoiceMixer(engine: AudioEngine): VoiceMixer & { dispose(): void } {
  return new VoiceChatMixer(engine);
}

/**
 * A random tab id for voice sessions.
 *
 * @returns 24 URL-safe characters.
 */
export function newVoiceCid(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `tab_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
