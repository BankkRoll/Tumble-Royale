import { Rng, type RoundDefinition, type RoundDefinitionInput } from '@tumble/shared';
import { generateBotNames } from '../bots/names.ts';
import { pickSkill } from '../bots/skill.ts';
import type { CharacterInput } from '../character/types.ts';
import { FixedStepper } from '../loop.ts';
import type { MatchDeps } from '../match/deps.ts';
import { createMatchSim, type MatchSimHandle } from '../match/match-sim.ts';
import type { Rapier } from '../physics/rapier.ts';
import { ShowDirector } from './director.ts';
import { ShowPlaylistSchema, type ShowPlaylist, type ShowPlaylistInput } from './schema/index.ts';
import type { ShowParticipant, ShowTimings } from './types.ts';

const NAMES_SALT = 0xb07_5eed;

/** Options for {@link createOfflineShow}. */
export interface OfflineShowOptions {
  R: Rapier;
  deps: MatchDeps;
  playlist: ShowPlaylist | ShowPlaylistInput;
  rounds: readonly (RoundDefinition | RoundDefinitionInput)[] | ReadonlyMap<string, RoundDefinition>;
  seed: number;
  /** The local player's display name; null for an all-bot show (attract mode, soak tests). */
  humanName: string | null;
  /** Total seats including the human. Defaults to the playlist's `maxPlayers`. */
  players?: number;
  timings?: Partial<ShowTimings>;
}

/** A single-player show against bots, running entirely in the browser (or a test). */
export interface OfflineShow {
  readonly director: ShowDirector;
  /** Player id of the human, or -1 for an all-bot show. */
  readonly humanId: number;
  readonly participants: readonly ShowParticipant[];
  /** The round currently simulated (for rendering), or null between rounds. */
  readonly match: MatchSimHandle | null;
  /** Fraction of a fixed step left over, for render interpolation. */
  readonly alpha: number;
  /** Feeds the human's input for upcoming steps. */
  setInput(input: CharacterInput): void;
  /**
   * Advances the director and the match by a wall-clock delta.
   *
   * @returns Fixed steps executed.
   */
  advance(frameDt: number): number;
  dispose(): void;
}

/**
 * Builds an offline show: one human (id 0) plus seeded bots with generated
 * names and the playlist's skill mix, a director, and a match sim per round
 * stepped at the fixed rate.
 *
 * @example
 * const show = createOfflineShow({ R, deps, playlist: FIRST_SHOW, rounds: ROUNDS, seed: 42, humanName: 'You' });
 * renderLoop((dt) => { show.setInput(readInput()); show.advance(dt); draw(show.match); });
 */
export function createOfflineShow(opts: OfflineShowOptions): OfflineShow {
  const playlist = ShowPlaylistSchema.parse(opts.playlist);
  const seats = Math.max(2, Math.min(60, opts.players ?? playlist.maxPlayers));
  const rng = new Rng((opts.seed ^ NAMES_SALT) >>> 0);
  const humanId = opts.humanName === null ? -1 : 0;
  const participants: ShowParticipant[] = [];
  if (opts.humanName !== null) participants.push({ id: 0, name: opts.humanName, isBot: false, partyId: 0 });
  const botCount = seats - participants.length;
  const names = generateBotNames(botCount, rng, opts.humanName ? [opts.humanName] : []);
  for (let i = 0; i < botCount; i++) {
    const id = participants.length;
    participants.push({
      id,
      name: names[i] as string,
      isBot: true,
      botSkill: pickSkill(rng.next(), playlist.botSkillMix),
      // Bots fill parties in seat order so duos/squads have complete teams.
      partyId: Math.floor(id / playlist.partySize),
    });
  }

  let match: MatchSimHandle | null = null;
  const stepper = new FixedStepper(() => match?.step());
  const director = new ShowDirector({
    seed: opts.seed,
    playlist,
    rounds: opts.rounds,
    participants,
    timings: opts.timings,
    host: {
      startRound(info) {
        const sim = createMatchSim(
          {
            R: opts.R,
            round: info.round,
            seed: info.seed,
            stage: info.stage,
            players: info.players,
            mode: 'offline',
            qualifyTarget: info.qualifyTarget,
          },
          opts.deps,
        );
        match = sim;
        stepper.reset();
        return {
          setPhase: (phase, time) => sim.setPhase(phase, time),
          getStatus: () => sim.getStatus(),
          forfeit: (id) => sim.forfeit(id),
          dispose() {
            if (match === sim) match = null;
            sim.dispose();
          },
        };
      },
    },
  });
  director.on((e) => {
    // Offline there is nothing to download: the human is ready the moment a round loads.
    if (e.type === 'roundSelected' && humanId >= 0) director.onPlayerLoaded(humanId);
  });

  return {
    director,
    humanId,
    participants,
    get match() {
      return match;
    },
    get alpha() {
      return stepper.alpha;
    },
    setInput(input) {
      if (humanId >= 0) match?.setInput(humanId, input);
    },
    advance(frameDt) {
      director.tick(frameDt);
      return match ? stepper.advance(frameDt) : 0;
    },
    dispose() {
      match?.dispose();
      match = null;
    },
  };
}
