import { MAX_PLAYERS, Rng, type RoundDefinition, type RoundDefinitionInput } from '@tumble/shared';
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
  /**
   * `auto` (default) acks the human's load the moment a round is selected
   * (tests, headless shows). `manual` leaves LOADING open until the host
   * calls `director.onPlayerLoaded(humanId)` once its round is built; there is
   * nobody to wait for but the local machine, so the stall/hard-cap timers are
   * off unless `timings` sets them.
   */
  localLoad?: 'auto' | 'manual';
  /** Round timer multiplier, clamped to 0.5–2 (see {@link ShowDirectorOptions.roundTimeScale}). */
  roundTimeScale?: number;
  /** Forces the show mutator (see {@link ShowDirectorOptions.mutatorId}). */
  mutatorId?: string | null;
  /**
   * Round voting between rounds (see {@link ShowDirectorOptions.voting}). The
   * human votes through `director.castVote`; bots vote on their own.
   */
  voting?: boolean;
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
 * Fewest seats a show needs when the playlist does not allow bots to fill the
 * lobby (a private show with "Fill empty spots with bots" off). Offline there
 * are no other humans, so some bots must still play or nothing could be
 * qualified against: the lobby gets exactly enough Tumblers for the most
 * demanding round in the pool (its `players.min`, e.g. a team round needs
 * opponents on every team), and never fewer than 2 (a final needs a rival).
 * Ids missing from the catalogue are ignored.
 *
 * @param playlist - The show's playlist.
 * @param rounds - Round catalogue.
 * @returns Seats including the human.
 * @example
 * minimumShowSeats(customPlaylist, ROUNDS); // 2 for a crown-climb-only show
 */
export function minimumShowSeats(
  playlist: ShowPlaylist | ShowPlaylistInput,
  rounds: OfflineShowOptions['rounds'],
): number {
  const byId = new Map<string, number>();
  const list = rounds instanceof Map ? [...rounds.values()] : (rounds as readonly RoundDefinitionInput[]);
  for (const r of list) byId.set(r.id, r.players?.min ?? 2);
  let seats = 2;
  for (const entry of playlist.pool) {
    const min = byId.get(entry.roundId);
    if (min !== undefined) seats = Math.max(seats, min);
  }
  return seats;
}

/**
 * Builds an offline show: one human (id 0) plus seeded bots with generated
 * names and the playlist's skill mix, a director, and a match sim per round
 * stepped at the fixed rate. When the playlist sets `botsAllowed: false`, only
 * {@link minimumShowSeats} seats are filled.
 *
 * @example
 * const show = createOfflineShow({ R, deps, playlist: FIRST_SHOW, rounds: ROUNDS, seed: 42, humanName: 'You' });
 * renderLoop((dt) => { show.setInput(readInput()); show.advance(dt); draw(show.match); });
 */
export function createOfflineShow(opts: OfflineShowOptions): OfflineShow {
  const playlist = ShowPlaylistSchema.parse(opts.playlist);
  const requested = Math.max(2, Math.min(MAX_PLAYERS, opts.players ?? playlist.maxPlayers));
  const seats =
    playlist.botsAllowed || opts.humanName === null
      ? requested
      : Math.min(requested, minimumShowSeats(playlist, opts.rounds));
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

  const manual = opts.localLoad === 'manual';
  let match: MatchSimHandle | null = null;
  const stepper = new FixedStepper(() => match?.step());
  const director = new ShowDirector({
    seed: opts.seed,
    playlist,
    rounds: opts.rounds,
    participants,
    timings: manual ? { loadingStall: Infinity, loadingHardCap: Infinity, ...opts.timings } : opts.timings,
    ...(opts.roundTimeScale !== undefined ? { roundTimeScale: opts.roundTimeScale } : {}),
    ...(opts.mutatorId !== undefined ? { mutatorId: opts.mutatorId } : {}),
    ...(opts.voting !== undefined ? { voting: opts.voting } : {}),
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
            mutatorId: info.mutatorId,
            roundTimeScale: info.roundTimeScale,
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
    if (e.type === 'roundSelected' && humanId >= 0 && !manual) director.onPlayerLoaded(humanId);
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
