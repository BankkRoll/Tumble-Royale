/**
 * @tumble/audio — Web Audio engine, procedural SFX bank, adaptive music and
 * announcer for Tumble Royale. Everything is synthesized at runtime: no audio
 * files ship, and the game is never silent.
 *
 * Quick start:
 * ```ts
 * const engine = new AudioEngine();
 * engine.installUnlockHandlers();
 * engine.sfx.prewarm();
 * const audio = createGameAudio(engine);
 * audio.playCue('music.menu');
 * ```
 *
 * See `packages/audio/README.md` for the full API, cue list and authoring guide.
 */

export { AudioEngine, LoopEmitter, DEFAULT_AUDIO_SETTINGS, isMobileDevice } from './core/engine.ts';
export { VoiceChatMixer, rmsLevel } from './core/voiceChat.ts';
export type { VoiceChatPeer, VoiceLevelMeter } from './core/voiceChat.ts';
export type {
  AudioEngineOptions,
  AudioSettings,
  BusName,
  EmitterOptions,
  PlayOptions,
  VoiceHandle,
} from './core/engine.ts';
export {
  VoicePool,
  VoicePriority,
  LOCAL_PLAYER_PRIORITY_BONUS,
  pickVoiceToSteal,
  voiceKeepScore,
  inverseDistanceGain,
} from './core/voicePool.ts';
export type { VoiceAcquire, VoiceSlot } from './core/voicePool.ts';

export { SfxBank, LOOP_CROSSFADE, bakeLoop } from './sfx/bank.ts';
export { SFX_DEFS, SFX_NAMES, RARITIES } from './sfx/library/index.ts';
export type { Rarity } from './sfx/library/index.ts';
export type { SfxBus, SfxDef, SfxDefs } from './sfx/types.ts';

export * as synth from './synth/toolkit.ts';
export type { SynthContext } from './synth/toolkit.ts';
export { INSTRUMENTS, DRUM_IDS, phrase, snareRoll, riser } from './synth/instruments.ts';
export type { InstrumentFn, InstrumentId, MelodicInstrumentId, DrumId } from './synth/instruments.ts';

export { MusicSystem, getPreparedTrack, LOOKAHEAD, TICK_MS } from './music/sequencer.ts';
export type { MusicPosition, PlayTrackOptions } from './music/sequencer.ts';
export { TRACKS, TRACK_IDS, TRACK_ALIASES, STINGERS, STINGER_IDS, STINGER_ALIASES } from './music/tracks.ts';
export { STEM_IDS } from './music/types.ts';
export type {
  MusicTrackId,
  PartDef,
  PartMode,
  StemId,
  StingerDef,
  StingerId,
  TrackDef,
} from './music/types.ts';
export { prepareTrack, stemLevels, createStemLevels, isDrum } from './music/prepare.ts';
export type { PreparedNote, PreparedPart, PreparedTrack, StemLevels } from './music/prepare.ts';
export * from './music/theory.ts';
export * from './music/timing.ts';

export { Announcer } from './announcer/announcer.ts';
export type { AnnouncerOptions, CaptionListener, SayOptions } from './announcer/announcer.ts';
export {
  ANNOUNCER_LINES,
  ANNOUNCER_LINE_IDS,
  fillLine,
  estimateSpeechMs,
  countSyllables,
} from './announcer/lines.ts';
export type { AnnouncerLineId, LineVars } from './announcer/lines.ts';

export { createGameAudio, trackForRound, intensityForStatus } from './game/bindings.ts';
export type {
  AudioSimEvent,
  GameAudio,
  GameAudioOptions,
  ObstacleInfo,
  RoundAudioStatus,
  RoundInfo,
  SimEventLike,
} from './game/bindings.ts';
export {
  resolveCue,
  soundForObstacleCue,
  listCueNames,
  UI_CUE_NAMES,
  MUSIC_CUE_NAMES,
  CUE_ALIASES,
  OBSTACLE_CUES,
  OBSTACLE_LOOPS,
} from './game/cues.ts';
export type { CueAction, ResolvedCue, UiCueName } from './game/cues.ts';
export { FootstepCadence, FOOTSTEP_SOUNDS, MIN_STEP_SPEED, stepRate } from './game/footsteps.ts';
export type { FootSurface } from './game/footsteps.ts';
