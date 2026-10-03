/**
 * Audio bridge: one {@link AudioEngine} + {@link GameAudio} for the page,
 * wired to the UI cue hooks, announcer captions and the player's settings.
 */
import { AudioEngine, createGameAudio, type GameAudio } from '@tumble/audio';
import type { Vec3 } from '@tumble/shared';
import { setAudioHooks, ui, type Settings } from '@tumble/ui';

/**
 * Owns the page's audio.
 *
 * @example
 * const audio = new AudioBridge();
 * audio.applySettings(settings);
 * // per frame
 * audio.setListener(camPos, camForward, camUp); audio.update();
 */
export class AudioBridge {
  readonly engine: AudioEngine;
  readonly game: GameAudio;
  private captions = false;
  private captionTimer = 0;

  constructor() {
    this.engine = new AudioEngine();
    this.engine.installUnlockHandlers();
    this.game = createGameAudio(this.engine);
    setAudioHooks({
      cue: (name) => this.game.playCue(name),
      music: (track) => this.game.playCue(track),
    });
    this.game.announcer.onCaption((text, ms) => {
      if (!this.captions) return;
      ui.getState().setCaption(text);
      window.clearTimeout(this.captionTimer);
      this.captionTimer = window.setTimeout(() => ui.getState().setCaption(null), Math.max(1200, ms + 400));
    });
  }

  /**
   * Renders the procedural SFX bank in idle time (works before the audio unlock).
   *
   * @param onProgress - Progress callback (done/total).
   */
  prewarm(onProgress?: (done: number, total: number) => void): Promise<void> {
    return this.engine.sfx.prewarm(undefined, onProgress);
  }

  /** Resumes the AudioContext from a user gesture (splash press). */
  unlock(): void {
    void this.engine.unlock();
  }

  /** Applies volume, focus and caption settings. */
  applySettings(s: Settings): void {
    this.engine.applySettings({
      master: s.audio.master,
      music: s.audio.music,
      sfx: s.audio.sfx,
      ui: s.audio.ui,
      voice: s.audio.announcer,
      muteWhenHidden: s.audio.muteUnfocused,
    });
    // Spoken lines are opt-in (product decision); captions fire either way.
    this.game.announcer.setEnabled(s.accessibility.spokenAnnouncer === true);
    this.captions = s.accessibility.captions;
    if (!this.captions) ui.getState().setCaption(null);
  }

  /**
   * Places the listener at the camera.
   *
   * @param pos - Camera position.
   * @param forward - Camera forward (unit).
   * @param up - Camera up (unit).
   */
  setListener(pos: Vec3, forward: Vec3, up: Vec3): void {
    this.engine.setListener(pos, forward, up);
  }

  /** Per-frame upkeep (emitter virtualisation). */
  update(): void {
    this.game.update();
  }
}
