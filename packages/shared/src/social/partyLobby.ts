/**
 * Party lobby protocol: the `party_lobby` frames party members exchange
 * through the API realtime gateway so everyone's main-menu platform shows the
 * same Tumblers moving, emoting and re-skinning live.
 *
 * Responsibilities:
 * - the wire shape both directions share ({@link PartyLobbyFrame});
 * - {@link encodeLobbyFrame}: quantised client → server message;
 * - {@link sanitizeLobbyFrame}: the single validation/clamp step the gateway
 *   applies before relaying (and the client re-applies on receipt);
 * - {@link sanitizeLobbyLook}: structural check of a cosmetic loadout (the
 *   API additionally checks catalog slots and ownership);
 * - the hangout extras riding on frames: menu status, who the sender is
 *   grabbing, the leader's ball state and a member's ball bump.
 *
 * Nothing here is persisted; frames are fire-and-forget.
 */

/** Message `type` on the wire, both directions. */
export const PARTY_LOBBY_TYPE = 'party_lobby';

/** Limits shared by the client sender and the gateway. */
export const PARTY_LOBBY_LIMITS = {
  /** Horizontal radius (m) frames are clamped to: the menu platform plus its rim. */
  radius: 6,
  /** Lowest feet height accepted (m). */
  minY: -1,
  /** Highest feet height accepted (m); the bounce pad launches well above head height. */
  maxY: 12,
  /** Fastest planar speed relayed (m/s). */
  maxSpeed: 20,
  /** Largest `|vy|` relayed (m/s). */
  maxVerticalSpeed: 30,
  /** Highest `CharacterState` id (inclusive). */
  maxState: 31,
  /** Largest raw frame accepted (UTF-16 code units of the JSON text). */
  maxBytes: 1536,
  /** Token-bucket burst per user. */
  rateBurst: 20,
  /** Token-bucket refill per user (frames per second). */
  ratePerSecond: 15,
  /** A loadout rides along at most this often per user; extra ones are stripped. */
  lookMinIntervalMs: 1000,
} as const;

/**
 * Pose id for a Tumbler sitting on the floor (AFK in the menu lobby). It sits
 * past the sim's `CharacterState` ids; only the renderer knows it.
 */
export const LOBBY_SIT_STATE = 20;

/** Raw animation clips a lobby frame may name besides catalog emotes (join wave, Play cheer). */
export const LOBBY_CLIP_IDS = ['wave', 'cheer'] as const;

/** Where a member is in the menu, shown above their Tumbler. */
export const LOBBY_STATUSES = ['menu', 'locker', 'store', 'queue', 'away'] as const;
/** A member's menu status. */
export type LobbyStatus = (typeof LOBBY_STATUSES)[number];

/** Largest ball speed relayed (m/s). */
const MAX_BALL_SPEED = 25;

/** Client send cadence. */
export const PARTY_LOBBY_RATE = {
  /** Interval while moving (10 Hz). */
  movingMs: 100,
  /** Smallest gap between any two frames (discrete changes such as an emote). */
  minGapMs: 70,
  /** Keep-alive while standing still, so late joiners and reconnects catch up. */
  heartbeatMs: 2000,
} as const;

/** A cosmetic loadout as it travels in a frame (render `TumblerLoadout` shape). */
export interface LobbyLook {
  colors: [string, string, string];
  pattern: string;
  face: string;
  upper: string | null;
  lower: string | null;
  headwear: string | null;
  back: string | null;
  emotes: [string, string, string, string];
  celebration: string;
  victoryPose: string;
  nameplate: string;
  trail: string | null;
}

/** One member's lobby Tumbler pose. */
export interface LobbyPose {
  /** Feet position on the platform (m). */
  x: number;
  y: number;
  z: number;
  /** Facing yaw (radians, -π..π). */
  yaw: number;
  /** `CharacterState` id. */
  state: number;
  /** Planar speed (m/s), drives the run cycle. */
  speed: number;
  /** Vertical speed (m/s), drives jump/fall poses. */
  vy: number;
  grounded: boolean;
  /** Emote item id while emoting (`emote.wave`), else null. */
  emote: string | null;
}

/** Shared toys and interactions that ride on a frame. */
export interface LobbyExtras {
  /** Menu status (default `menu`). */
  status?: LobbyStatus;
  /** Party member the sender is holding (grab), if any. */
  grab?: string;
  /** Leader only: the shared ball `[x, y, z, vx, vy, vz]`. */
  ball?: [number, number, number, number, number, number];
  /** A member knocked the ball: its new velocity `[vx, vy, vz]` for the leader to apply. */
  bump?: [number, number, number];
}

/** A sanitised frame (client → server body, and the relayed payload). */
export interface PartyLobbyFrame extends LobbyPose, LobbyExtras {
  /** Sender's sequence number (wraps at 2^31; resets on reload). */
  seq: number;
  /** Present only when the sender's equipped look changed (or a member joined). */
  look?: LobbyLook;
}

/** Client → server message. */
export type PartyLobbyMessage = { type: typeof PARTY_LOBBY_TYPE } & PartyLobbyFrame;

/** Server → client event: a fellow member's frame. */
export type PartyLobbyEvent = PartyLobbyMessage & {
  /** Sender. */
  userId: string;
  partyId: string;
};

const SEQ_MOD = 2 ** 31;
const ID_RE = /^[a-z0-9][a-z0-9._:-]{1,63}$/i;
const HEX_RE = /^#[0-9a-f]{6}$/i;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
// `|| 0` folds -0 into 0 so quantised frames compare equal.
const round2 = (v: number): number => Math.round(v * 100) / 100 || 0;
const round1 = (v: number): number => Math.round(v * 10) / 10 || 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v);
const optId = (v: unknown): string | null | undefined => (v === null ? null : isId(v) ? v : undefined);

/** Wraps an angle into -π..π. */
function wrapAngle(a: number): number {
  const w = Math.atan2(Math.sin(a), Math.cos(a));
  return Object.is(w, -0) ? 0 : w;
}

/**
 * Builds the quantised wire message for a pose (centimetres, centiradians,
 * decimetres per second), so frames stay small and identical poses compare equal.
 *
 * @param pose - Local Tumbler pose.
 * @param seq - Sender sequence number.
 * @param look - Equipped loadout, only when it should be (re)announced.
 * @param extras - Status, grab, ball state or bump to include.
 * @returns The `party_lobby` message to send.
 * @example
 * socket.send(encodeLobbyFrame(pose, ++seq));
 */
export function encodeLobbyFrame(
  pose: LobbyPose,
  seq: number,
  look?: LobbyLook | null,
  extras?: LobbyExtras | null,
): PartyLobbyMessage {
  const msg: PartyLobbyMessage = {
    type: PARTY_LOBBY_TYPE,
    seq: ((Math.floor(seq) % SEQ_MOD) + SEQ_MOD) % SEQ_MOD,
    x: round2(pose.x),
    y: round2(pose.y),
    z: round2(pose.z),
    yaw: round2(wrapAngle(pose.yaw)),
    state: pose.state | 0,
    speed: round1(pose.speed),
    vy: round1(pose.vy),
    grounded: pose.grounded,
    emote: pose.emote,
  };
  if (look) msg.look = look;
  if (extras?.status && extras.status !== 'menu') msg.status = extras.status;
  if (extras?.grab) msg.grab = extras.grab;
  if (extras?.ball) {
    const b = extras.ball;
    msg.ball = [round2(b[0]), round2(b[1]), round2(b[2]), round2(b[3]), round2(b[4]), round2(b[5])];
  }
  if (extras?.bump) msg.bump = [round2(extras.bump[0]), round2(extras.bump[1]), round2(extras.bump[2])];
  return msg;
}

function sanitizeBall(raw: unknown): LobbyExtras['ball'] | undefined {
  if (!Array.isArray(raw) || raw.length !== 6 || !raw.every(isNum)) return undefined;
  const L = PARTY_LOBBY_LIMITS;
  let [x, y, z] = raw as number[] as [number, number, number];
  const d = Math.hypot(x, z);
  if (d > L.radius) {
    x = (x / d) * L.radius;
    z = (z / d) * L.radius;
  }
  y = clamp(y, L.minY, L.maxY);
  const v = (i: number) => round2(clamp(raw[i] as number, -MAX_BALL_SPEED, MAX_BALL_SPEED));
  return [round2(x), round2(y), round2(z), v(3), v(4), v(5)];
}

function sanitizeBump(raw: unknown): LobbyExtras['bump'] | undefined {
  if (!Array.isArray(raw) || raw.length !== 3 || !raw.every(isNum)) return undefined;
  const v = (i: number) => round2(clamp(raw[i] as number, -MAX_BALL_SPEED, MAX_BALL_SPEED));
  return [v(0), v(1), v(2)];
}

/**
 * Structural check of a loadout: hex colours and id-shaped strings in every
 * slot. Says nothing about catalog slots or ownership.
 *
 * @param raw - Untrusted value.
 * @returns A clean copy (unknown keys dropped), or null when malformed.
 */
export function sanitizeLobbyLook(raw: unknown): LobbyLook | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const colors = r.colors;
  const emotes = r.emotes;
  if (
    !Array.isArray(colors) ||
    colors.length !== 3 ||
    !colors.every((c) => typeof c === 'string' && HEX_RE.test(c))
  )
    return null;
  if (!Array.isArray(emotes) || emotes.length !== 4 || !emotes.every(isId)) return null;
  const req = [r.pattern, r.face, r.celebration, r.victoryPose, r.nameplate];
  if (!req.every(isId)) return null;
  const upper = optId(r.upper);
  const lower = optId(r.lower);
  const headwear = optId(r.headwear);
  const back = optId(r.back);
  const trail = optId(r.trail);
  if (upper === undefined || lower === undefined || headwear === undefined || back === undefined) return null;
  if (trail === undefined) return null;
  return {
    colors: [colors[0] as string, colors[1] as string, colors[2] as string],
    pattern: r.pattern as string,
    face: r.face as string,
    upper,
    lower,
    headwear,
    back,
    emotes: [emotes[0] as string, emotes[1] as string, emotes[2] as string, emotes[3] as string],
    celebration: r.celebration as string,
    victoryPose: r.victoryPose as string,
    nameplate: r.nameplate as string,
    trail,
  };
}

/**
 * Validates and clamps an untrusted frame.
 *
 * - Non-finite or missing numbers drop the whole frame (nothing sensible to show).
 * - Positions are clamped to the platform disc and height band; speeds and
 *   state to their ranges; yaw wrapped.
 * - An emote that `isEmote` does not recognise (and that is not one of
 *   {@link LOBBY_CLIP_IDS}) is cleared (the pose still relays).
 * - A malformed `look`, status, grab, ball or bump is stripped (the pose still relays).
 *
 * @param raw - Parsed JSON from the socket.
 * @param isEmote - Recognises emote item ids (the API uses the catalog).
 * @returns The clean frame, or null when it must be dropped.
 * @example
 * const frame = sanitizeLobbyFrame(JSON.parse(text), (id) => emotes.has(id));
 */
export function sanitizeLobbyFrame(raw: unknown, isEmote: (id: string) => boolean): PartyLobbyFrame | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const { seq, x, y, z, yaw, state, speed, vy } = r;
  if (!isNum(seq) || !isNum(x) || !isNum(y) || !isNum(z) || !isNum(yaw) || !isNum(state)) return null;
  const L = PARTY_LOBBY_LIMITS;
  let px = x;
  let pz = z;
  const d = Math.hypot(px, pz);
  if (d > L.radius) {
    px = (px / d) * L.radius;
    pz = (pz / d) * L.radius;
  }
  const emote =
    typeof r.emote === 'string' &&
    ((LOBBY_CLIP_IDS as readonly string[]).includes(r.emote) || (isId(r.emote) && isEmote(r.emote)))
      ? r.emote
      : null;
  const frame: PartyLobbyFrame = {
    seq: ((Math.floor(seq) % SEQ_MOD) + SEQ_MOD) % SEQ_MOD,
    x: round2(px),
    y: round2(clamp(y, L.minY, L.maxY)),
    z: round2(pz),
    yaw: round2(wrapAngle(yaw)),
    state: clamp(Math.round(state), 0, L.maxState),
    speed: round1(clamp(isNum(speed) ? speed : 0, 0, L.maxSpeed)),
    vy: round1(clamp(isNum(vy) ? vy : 0, -L.maxVerticalSpeed, L.maxVerticalSpeed)),
    grounded: r.grounded !== false,
    emote,
  };
  if (r.look !== undefined) {
    const look = sanitizeLobbyLook(r.look);
    if (look) frame.look = look;
  }
  if (
    typeof r.status === 'string' &&
    r.status !== 'menu' &&
    (LOBBY_STATUSES as readonly string[]).includes(r.status)
  )
    frame.status = r.status as LobbyStatus;
  if (isId(r.grab)) frame.grab = r.grab;
  const ball = sanitizeBall(r.ball);
  if (ball) frame.ball = ball;
  const bump = sanitizeBump(r.bump);
  if (bump) frame.bump = bump;
  return frame;
}

/**
 * True when `seq` should be applied after `last`: newer, or far enough
 * behind that the sender evidently restarted (reload) rather than a late
 * duplicate.
 *
 * @param seq - Incoming sequence number.
 * @param last - Last applied sequence number, or -1 for none.
 */
export function isNewerLobbySeq(seq: number, last: number): boolean {
  if (last < 0) return true;
  const behind = (last - seq + SEQ_MOD) % SEQ_MOD;
  return behind === 0 ? false : behind > 64;
}
