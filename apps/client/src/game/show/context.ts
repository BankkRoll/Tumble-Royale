/**
 * Everything a running show needs from the app, plus the normalised data
 * shapes the offline and online runners hand to the shared choreography.
 */
import type { WebGPURenderer } from 'three/webgpu';
import type { TumblerLoadout } from '@tumble/render/scenes';
import type { RoundDefinition, RoundType } from '@tumble/shared';
import type { Rapier } from '@tumble/sim';
import type { MatchDeps, MatchPlayerInfo } from '@tumble/sim/match';
import type { Settings } from '@tumble/ui';
import type { InputSystem } from '../../input/index.ts';
import type { AudioBridge } from '../audioBridge.ts';
import type { ResolvedTumblerFactory } from '../characters.ts';
import type { GameConfig } from '../config.ts';
import type { OnlineAccount } from '../online/account.ts';
import type { ProfileStore } from '../profile.ts';
import type { QualityManager } from '../quality.ts';
import type { ReplayHooks } from '../replay/live.ts';
import type { CeremonyPost } from '../views/ceremonies.ts';
import type { SceneDirector } from '../views/sceneDirector.ts';

/** Why a show session ended. */
export type SessionEnd = 'rewards' | 'backToLobby' | 'playAgain' | 'failed';

/** App services handed to a show session. */
export interface GameContext {
  readonly R: Rapier;
  readonly cfg: GameConfig;
  readonly renderer: WebGPURenderer;
  readonly director: SceneDirector;
  /** Post effects already filtered by Reduce Flashing. */
  readonly post: CeremonyPost;
  readonly quality: QualityManager;
  readonly audio: AudioBridge;
  readonly input: InputSystem;
  /** Offline profile (also the rewards fallback when no account answered). */
  readonly profile: ProfileStore;
  /** Signed-in account, or null when playing offline. */
  readonly account: OnlineAccount | null;
  /** The local player's current look (account loadout online, profile offline). */
  look(): TumblerLoadout;
  /** The local player's display name. */
  playerName(): string;
  /** Lifetime Crowns before this show (victory card counter). */
  crowns(): number;
  readonly tumblers: ResolvedTumblerFactory;
  readonly matchDeps: MatchDeps;
  /** Smoothed FPS for the HUD. */
  fps(): number;
  /** Current settings snapshot. */
  settings(): Settings;
  /** The session is done; the app decides what comes next. */
  onEnd(reason: SessionEnd): void;
  /** Round recorder for replays (absent in tools and tests). */
  readonly replays?: ReplayHooks | null;
}

/** A show participant as the session tracks them. */
export interface SessionPlayer {
  id: number;
  name: string;
  isBot: boolean;
  loadout: TumblerLoadout;
  partyId?: number;
}

/** A round about to load (normalised from the director or a `joinRound` message). */
export interface RoundStart {
  index: number;
  isFinal: boolean;
  round: RoundDefinition;
  players: MatchPlayerInfo[];
  seed: number;
  stage: number;
  /** Expected qualifiers (1 in a final). */
  qualifyTarget: number;
  /** Show mutator id (`@tumble/sim/mutators`), or null. */
  mutatorId?: string | null;
}

/** One finished round (best first in each list). */
export interface RoundOutcomeInfo {
  roundId: string;
  name: string;
  type: RoundType;
  isFinal: boolean;
  qualified: number[];
  eliminated: number[];
}

/** End-of-show recap (normalised). */
export interface SessionSummary {
  winnerId: number | null;
  rounds: RoundOutcomeInfo[];
  /** Final place per player (1 = Crown). */
  placements: ReadonlyMap<number, number>;
}
