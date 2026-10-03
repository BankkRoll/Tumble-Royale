/**
 * Lobby mini-game wire format: the `game` and `claim` extras that ride on
 * `party_lobby` frames while a party plays Goal Rush, Hot Potato or Target
 * Hop on the menu platform.
 *
 * Responsibilities:
 * - {@link LobbyGameWire}: the leader's complete game snapshot. Every
 *   snapshot is self-contained (players, scores, timers, the last event), so
 *   a dropped or rate-limited frame never leaves a member out of step;
 * - {@link LobbyGameClaim}: a member's report (a tag, a target hit) that only
 *   the leader may turn into a score change;
 * - {@link sanitizeLobbyGame} / {@link sanitizeLobbyClaim}: structural
 *   validation and clamping, shared by the gateway and the clients.
 *
 * Party membership (that the players and a claim's target really are in the
 * sender's party) is the gateway's job; nothing here knows the party.
 */

/** The lobby mini-games. */
export const LOBBY_GAME_KINDS = ['goal', 'potato', 'targets'] as const;
/** A lobby mini-game. */
export type LobbyGameKind = (typeof LOBBY_GAME_KINDS)[number];

/** What the picker and the intro card show for a game. */
export interface LobbyGameInfo {
  title: string;
  /** The rules in one line. */
  rule: string;
  /** Fewest players on the platform for the game to make sense. */
  minPlayers: number;
  /** Length of the play phase (s); 0 when the game ends on its own (Hot Potato). */
  playS: number;
}

/** The lobby mini-games, in picker order. */
export const LOBBY_GAME_INFO: Readonly<Record<LobbyGameKind, LobbyGameInfo>> = {
  goal: {
    title: 'Goal Rush',
    rule: 'Push or dive the ball into the other goal. First to 3 wins.',
    minPlayers: 1,
    playS: 90,
  },
  potato: {
    title: 'Hot Potato',
    rule: 'Grab or dive into someone to pass the potato before it pops.',
    minPlayers: 2,
    playS: 0,
  },
  targets: {
    title: 'Target Hop',
    rule: 'Land on the glowing targets. Gold ones are worth 3.',
    minPlayers: 1,
    playS: 45,
  },
};

/** Phases of one game. */
export const LOBBY_GAME_PHASES = ['intro', 'play', 'results'] as const;
/** A game phase. */
export type LobbyGamePhase = (typeof LOBBY_GAME_PHASES)[number];

/**
 * What a snapshot announces: the first ones of a game (`start`), a regular
 * update (`state`), the first send of a new event (`event`) or the final
 * results / a cancel (`end`). Receivers treat every op as a full snapshot.
 */
export const LOBBY_GAME_OPS = ['start', 'state', 'event', 'end'] as const;
/** A snapshot op. */
export type LobbyGameOp = (typeof LOBBY_GAME_OPS)[number];

/** Things that happen during a game, shown once per client. */
export const LOBBY_GAME_EVENTS = ['goal', 'tag', 'pop', 'hit', 'out'] as const;
/** A game event kind. */
export type LobbyGameEventKind = (typeof LOBBY_GAME_EVENTS)[number];

/** Limits for game snapshots and claims. */
export const LOBBY_GAME_LIMITS = {
  /** Most players in one game (a full party). */
  maxPlayers: 4,
  /** Highest score a player or team can show. */
  maxScore: 99,
  /** Longest phase timer (s). */
  maxSeconds: 600,
  /** Most targets live at once in Target Hop. */
  maxTargets: 3,
  /** Highest target value. */
  maxTargetValue: 5,
  /** Horizontal radius targets are clamped to (m), inside the platform rim. */
  targetRadius: 5.5,
  /** The leader includes the game in a frame at least this often (ms), i.e. ≤ 10 Hz. */
  sendMs: 100,
} as const;

/** The most recent game event; receivers play each `n` once. */
export interface LobbyGameEvent {
  /** Event counter within the game (1, 2, …). */
  n: number;
  k: LobbyGameEventKind;
  /** Main actor: player index, or the scoring team for a goal (-1 when none). */
  a: number;
  /** Second actor: the tagged player, the target slot hit (-1 when none). */
  b: number;
}

/** The leader's snapshot of the running game. */
export interface LobbyGameWire {
  op: LobbyGameOp;
  /** Game instance id; a new game always gets a new id. */
  id: number;
  kind: LobbyGameKind;
  phase: LobbyGamePhase;
  /** Seconds left in the current phase (0.1 s resolution). */
  left: number;
  /** Participants' user ids (slot order); indices below refer to this list. */
  players: string[];
  /** Team per player (Goal Rush: 0 or 1; otherwise all 0). */
  teams: number[];
  /** Goal Rush: per-team goals `[team0, team1]`; otherwise per-player points. */
  score: number[];
  /** Bitmask of players knocked out or spectating. */
  out: number;
  /** Hot Potato: index of the player holding the potato, or -1. */
  it: number;
  /**
   * Secondary timer (s): Hot Potato fuse or the pause before the next potato;
   * Goal Rush kickoff pause after a goal; unused (0) in Target Hop.
   */
  aux: number;
  /** Target Hop: `[x, z, value, gen]` per target slot, flattened (value 0 = respawning). */
  targets: number[];
  /** Bitmask of winners (results only; 0 = a draw or no winner yet). */
  win: number;
  /** Why the game ended (`end` only). */
  reason?: 'done' | 'cancel';
  /** The latest event, repeated until a newer one replaces it. */
  ev?: LobbyGameEvent;
}

/** A member's report for the leader to validate. */
export interface LobbyGameClaim {
  /** Game id the claim belongs to (stale claims are ignored). */
  id: number;
  /** `tag`: passed the potato to `target`; `hit`: landed on target slot `t` of generation `g`. */
  k: 'tag' | 'hit';
  target?: string;
  t?: number;
  g?: number;
}

const ID_RE = /^[a-z0-9][a-z0-9._:-]{1,63}$/i;
const MAX_ID = 2 ** 31 - 1;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown, lo: number, hi: number): v is number =>
  isNum(v) && Number.isInteger(v) && v >= lo && v <= hi;
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const round1 = (v: number): number => Math.round(v * 10) / 10 || 0;
const round2 = (v: number): number => Math.round(v * 100) / 100 || 0;
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v);

function sanitizeEvent(raw: unknown, players: number): LobbyGameEvent | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (!isInt(r.n, 1, MAX_ID) || !oneOf(LOBBY_GAME_EVENTS, r.k)) return undefined;
  const hi = Math.max(players, LOBBY_GAME_LIMITS.maxTargets) - 1;
  const a = isInt(r.a, -1, hi) ? r.a : -1;
  const b = isInt(r.b, -1, hi) ? r.b : -1;
  return { n: r.n, k: r.k, a, b };
}

function sanitizeTargets(raw: unknown): number[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length % 4 !== 0) return null;
  if (raw.length > LOBBY_GAME_LIMITS.maxTargets * 4 || !raw.every(isNum)) return null;
  const L = LOBBY_GAME_LIMITS;
  const out: number[] = [];
  for (let i = 0; i < raw.length; i += 4) {
    let x = raw[i] as number;
    let z = raw[i + 1] as number;
    const d = Math.hypot(x, z);
    if (d > L.targetRadius) {
      x = (x / d) * L.targetRadius;
      z = (z / d) * L.targetRadius;
    }
    const value = clamp(Math.round(raw[i + 2] as number), 0, L.maxTargetValue);
    const gen = clamp(Math.round(raw[i + 3] as number), 0, MAX_ID);
    out.push(round2(x), round2(z), value, gen);
  }
  return out;
}

/**
 * Validates and clamps an untrusted game snapshot.
 *
 * - Unknown kind/phase/op, a bad id, or a player list that is empty, too
 *   long, repeats an id or holds a malformed id drops the whole snapshot.
 * - Per-player arrays must match the player list (teams) or the game's
 *   scoring shape (two team scores for Goal Rush, one per player otherwise).
 * - Timers, scores, masks and target coordinates are clamped to range.
 *
 * @param raw - The `game` field of a parsed frame.
 * @returns The clean snapshot, or null when it must be dropped.
 * @example
 * const game = sanitizeLobbyGame(frame.game);
 */
export function sanitizeLobbyGame(raw: unknown): LobbyGameWire | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const L = LOBBY_GAME_LIMITS;
  if (!oneOf(LOBBY_GAME_OPS, r.op) || !oneOf(LOBBY_GAME_KINDS, r.kind) || !oneOf(LOBBY_GAME_PHASES, r.phase))
    return null;
  if (!isInt(r.id, 1, MAX_ID) || !isNum(r.left)) return null;
  const players = r.players;
  if (!Array.isArray(players) || players.length < 1 || players.length > L.maxPlayers) return null;
  if (!players.every((p) => typeof p === 'string' && ID_RE.test(p))) return null;
  if (new Set(players).size !== players.length) return null;
  const n = players.length;
  const teams = r.teams;
  if (!Array.isArray(teams) || teams.length !== n || !teams.every((t) => t === 0 || t === 1)) return null;
  const scoreLen = r.kind === 'goal' ? 2 : n;
  const score = r.score;
  if (!Array.isArray(score) || score.length !== scoreLen || !score.every(isNum)) return null;
  const targets = sanitizeTargets(r.targets);
  if (!targets) return null;
  const mask = (1 << n) - 1;
  const out: LobbyGameWire = {
    op: r.op,
    id: r.id,
    kind: r.kind,
    phase: r.phase,
    left: round1(clamp(r.left, 0, L.maxSeconds)),
    players: players.slice() as string[],
    teams: teams.slice() as number[],
    score: (score as number[]).map((s) => clamp(Math.round(s), 0, L.maxScore)),
    out: isNum(r.out) ? Math.round(r.out) & mask : 0,
    it: isInt(r.it, -1, n - 1) ? r.it : -1,
    aux: isNum(r.aux) ? round1(clamp(r.aux, 0, L.maxSeconds)) : 0,
    targets: r.kind === 'targets' ? targets : [],
    win: isNum(r.win) ? Math.round(r.win) & mask : 0,
  };
  if (r.op === 'end' && (r.reason === 'done' || r.reason === 'cancel')) out.reason = r.reason;
  const ev = sanitizeEvent(r.ev, n);
  if (ev) out.ev = ev;
  return out;
}

/**
 * Validates an untrusted member claim.
 *
 * @param raw - The `claim` field of a parsed frame.
 * @returns The clean claim, or null when malformed.
 */
export function sanitizeLobbyClaim(raw: unknown): LobbyGameClaim | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isInt(r.id, 1, MAX_ID)) return null;
  if (r.k === 'tag') {
    if (typeof r.target !== 'string' || !ID_RE.test(r.target)) return null;
    return { id: r.id, k: 'tag', target: r.target };
  }
  if (r.k === 'hit') {
    if (!isInt(r.t, 0, LOBBY_GAME_LIMITS.maxTargets - 1) || !isInt(r.g, 0, MAX_ID)) return null;
    return { id: r.id, k: 'hit', t: r.t, g: r.g };
  }
  return null;
}
