/**
 * Round replay file format (see docs/design/REPLAYS.md).
 *
 * Responsibilities:
 * - the versioned container: magic, format version, JSON header (game
 *   version, round, seed, players + loadouts, obstacle/string tables), the
 *   delta-encoded frame stream, the event stream and a checksum;
 * - quantisation constants shared by the recorder and the timeline decoder;
 * - the event schema: every `SimEvent` kind as a compact field list;
 * - header validation for files loaded from disk.
 *
 * Pure: no DOM, no three, no sim instances.
 */
import type { SimEvent } from '@tumble/sim';
import { ByteReader, ByteWriter, ReplayDecodeError } from './codec.ts';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** File magic: "TRPL". */
export const REPLAY_MAGIC = 0x4c505254;
/** Bumped on any incompatible change to the container or streams. */
export const REPLAY_FORMAT_VERSION = 1;
/**
 * Game version stamped into recordings. Kept equal to the root package.json
 * version (a test enforces it) so a file says which build made it.
 */
export const GAME_VERSION = '0.1.0';
/** Recorded samples per second of round time. */
export const REPLAY_RATE = 20;
/** File extension for saved replays. */
export const REPLAY_EXTENSION = '.tumblereplay';

/** Positions: centimetres. */
export const POS_SCALE = 100;
/** Yaw/pitch: 4096 steps per turn. */
export const ANGLE_STEPS = 4096;
/** State times and event times: centiseconds. */
export const TIME_SCALE = 100;
/** Event scalars (impact, strength, score deltas): hundredths. */
export const EVENT_NUM_SCALE = 100;
/** Non-integer obstacle net states (props): hundredths (cm, 0.01 of a quaternion). */
export const NET_FLOAT_SCALE = 100;

/** Per-player frame mask bits: which fields follow. */
export const PlayerField = {
  Pos: 1,
  Yaw: 2,
  // 4 is unused: velocity is derived from positions on playback (bots jitter it every sample).
  State: 8,
  Flags: 16,
  Misc: 32,
  /** Presence flipped (appeared or disappeared). */
  Presence: 64,
} as const;

/** Camera track mask bits. */
export const CameraField = {
  ModeTarget: 1,
  Yaw: 2,
  Pitch: 4,
} as const;

/** Recorded live camera behaviour (the "your view" replay camera). */
export const CameraModeCode = {
  Follow: 0,
  Spectate: 1,
  Celebrate: 2,
  Flyover: 3,
} as const;

/** Obstacle net-state value encodings. */
export const NetKind = {
  Int: 0,
  Float: 1,
} as const;

// -----------------------------------------------------------------------------
// Header
// -----------------------------------------------------------------------------

/** One recorded participant. */
export interface ReplayPlayer {
  id: number;
  name: string;
  isBot: boolean;
  team: number;
  /** Cosmetic loadout as the session had it (render loadout JSON). */
  loadout: unknown;
}

/** Round outcome as known when the recording closed (null while live). */
export interface ReplayOutcome {
  qualified: number[];
  eliminated: number[];
}

/** Everything needed to rebuild the round and interpret the streams. */
export interface ReplayHeader {
  format: number;
  gameVersion: string;
  /** Netcode protocol of the recording build (informational). */
  protocolVersion: number;
  /** ISO timestamp of the recording start. */
  recordedAt: string;
  online: boolean;
  showName: string;
  roundId: string;
  roundName: string;
  roundType: string;
  /** 0-based round index within the show. */
  roundIndex: number;
  isFinal: boolean;
  seed: number;
  stage: number;
  variationId: string | null;
  qualifyTarget: number;
  /** Local player id, or -1 when the round was spectated. */
  localId: number;
  /** Samples per second. */
  rate: number;
  /** Round time of tick 0 (negative during the countdown). */
  startTime: number;
  players: ReplayPlayer[];
  /** Obstacle ids with replicated state; the frame stream refers to them by index. */
  obstacles: string[];
  /** String table referenced by events (obstacle ids, cue names). */
  strings: string[];
  frameCount: number;
  eventCount: number;
  /** Seconds from tick 0 to the last frame. */
  duration: number;
  outcome: ReplayOutcome | null;
}

/** A complete recording: header plus the two encoded streams. */
export interface ReplayData {
  header: ReplayHeader;
  frames: Uint8Array;
  events: Uint8Array;
}

/** Why a file was rejected. */
export type ReplayFileProblem = 'magic' | 'version' | 'corrupt' | 'header';

/** Thrown by {@link decodeReplayFile}. */
export class ReplayFileError extends Error {
  constructor(
    readonly problem: ReplayFileProblem,
    message: string,
  ) {
    super(message);
    this.name = 'ReplayFileError';
  }
}

// -----------------------------------------------------------------------------
// Event schema
// -----------------------------------------------------------------------------

/** Field encodings: integers, hundredths, cm positions, string-table refs, enums. */
type FieldKind = 'int' | 'num' | 'pos' | 'str' | 'optStr' | readonly string[];

type EventFields = readonly (readonly [key: string, kind: FieldKind])[];

const GRAB_KINDS = ['player', 'prop', 'ledge'] as const;
const GRAB_END = ['release', 'broken', 'stamina'] as const;

/**
 * Wire layout of every event kind. The array index is the wire code, so new
 * kinds go at the end; reordering needs a format bump.
 */
const EVENT_SCHEMA: readonly (readonly [SimEvent['type'], EventFields])[] = [
  [
    'jump',
    [
      ['player', 'int'],
      ['pos', 'pos'],
    ],
  ],
  [
    'land',
    [
      ['player', 'int'],
      ['pos', 'pos'],
      ['impact', 'num'],
    ],
  ],
  [
    'dive',
    [
      ['player', 'int'],
      ['pos', 'pos'],
    ],
  ],
  ['getUp', [['player', 'int']]],
  [
    'stun',
    [
      ['player', 'int'],
      ['pos', 'pos'],
      ['strength', 'num'],
    ],
  ],
  [
    'bounce',
    [
      ['player', 'int'],
      ['pos', 'pos'],
      ['obstacle', 'optStr'],
    ],
  ],
  [
    'grabStart',
    [
      ['player', 'int'],
      ['target', 'int'],
      ['targetKind', GRAB_KINDS],
    ],
  ],
  [
    'grabEnd',
    [
      ['player', 'int'],
      ['target', 'int'],
      ['reason', GRAB_END],
    ],
  ],
  [
    'emote',
    [
      ['player', 'int'],
      ['emote', 'int'],
    ],
  ],
  [
    'fellOut',
    [
      ['player', 'int'],
      ['pos', 'pos'],
    ],
  ],
  [
    'respawn',
    [
      ['player', 'int'],
      ['pos', 'pos'],
    ],
  ],
  [
    'checkpoint',
    [
      ['player', 'int'],
      ['index', 'int'],
    ],
  ],
  [
    'finish',
    [
      ['player', 'int'],
      ['tick', 'int'],
      ['subTick', 'num'],
    ],
  ],
  [
    'qualified',
    [
      ['player', 'int'],
      ['place', 'int'],
    ],
  ],
  [
    'eliminated',
    [
      ['player', 'int'],
      ['place', 'int'],
    ],
  ],
  [
    'tileFell',
    [
      ['obstacle', 'str'],
      ['tile', 'int'],
    ],
  ],
  [
    'tileWarn',
    [
      ['obstacle', 'str'],
      ['tile', 'int'],
    ],
  ],
  [
    'obstacleCue',
    [
      ['obstacle', 'str'],
      ['cue', 'str'],
      ['pos', 'pos'],
    ],
  ],
  [
    'teleport',
    [
      ['player', 'int'],
      ['from', 'pos'],
      ['to', 'pos'],
    ],
  ],
  [
    'score',
    [
      ['team', 'int'],
      ['player', 'int'],
      ['delta', 'num'],
      ['total', 'num'],
    ],
  ],
  [
    'propPickup',
    [
      ['player', 'int'],
      ['prop', 'int'],
    ],
  ],
  [
    'propDrop',
    [
      ['player', 'int'],
      ['prop', 'int'],
    ],
  ],
];

const EVENT_CODE = new Map<string, number>(EVENT_SCHEMA.map(([type], i) => [type, i]));

/** Interns strings for the header's string table. */
export class StringTable {
  readonly list: string[] = [];
  private readonly index = new Map<string, number>();

  /** @returns The string's table index (added on first use). */
  intern(s: string): number {
    let i = this.index.get(s);
    if (i === undefined) {
      i = this.list.length;
      this.list.push(s);
      this.index.set(s, i);
    }
    return i;
  }
}

function q(v: number, scale: number): number {
  const n = Math.round((Number.isFinite(v) ? v : 0) * scale);
  return Number.isSafeInteger(n) ? n : 0;
}

/**
 * True when the event kind has a wire encoding.
 *
 * @param e - Event.
 */
export function isRecordableEvent(e: SimEvent): boolean {
  return EVENT_CODE.has(e.type);
}

/**
 * Writes an event's code and fields (not its time).
 *
 * @param w - Destination.
 * @param e - Event (must be {@link isRecordableEvent}).
 * @param strings - String table for obstacle ids and cue names.
 */
export function writeEvent(w: ByteWriter, e: SimEvent, strings: StringTable): void {
  const code = EVENT_CODE.get(e.type);
  if (code === undefined) throw new RangeError(`Unrecordable event ${e.type}`);
  w.u8(code);
  const rec = e as unknown as Record<string, unknown>;
  for (const [key, kind] of (EVENT_SCHEMA[code] as (typeof EVENT_SCHEMA)[number])[1]) {
    const v = rec[key];
    if (kind === 'int') w.svarint(q(v as number, 1));
    else if (kind === 'num') w.svarint(q(v as number, EVENT_NUM_SCALE));
    else if (kind === 'pos') {
      const p = (v ?? { x: 0, y: 0, z: 0 }) as { x: number; y: number; z: number };
      w.svarint(q(p.x, POS_SCALE));
      w.svarint(q(p.y, POS_SCALE));
      w.svarint(q(p.z, POS_SCALE));
    } else if (kind === 'str') w.varint(strings.intern(String(v ?? '')));
    else if (kind === 'optStr') w.varint(v === undefined ? 0 : strings.intern(String(v)) + 1);
    else w.varint(Math.max(0, kind.indexOf(v as string)));
  }
}

/**
 * Reads an event written by {@link writeEvent}.
 *
 * @param r - Source.
 * @param strings - The header's string table.
 * @returns A fresh event object.
 */
export function readEvent(r: ByteReader, strings: readonly string[]): SimEvent {
  const code = r.u8();
  const spec = EVENT_SCHEMA[code];
  if (!spec) throw new ReplayDecodeError(`Unknown event code ${code}`);
  const out: Record<string, unknown> = { type: spec[0] };
  const str = (i: number): string => {
    const s = strings[i];
    if (s === undefined) throw new ReplayDecodeError(`Bad string ref ${i}`);
    return s;
  };
  for (const [key, kind] of spec[1]) {
    if (kind === 'int') out[key] = r.svarint();
    else if (kind === 'num') out[key] = r.svarint() / EVENT_NUM_SCALE;
    else if (kind === 'pos') {
      const x = r.svarint() / POS_SCALE;
      const y = r.svarint() / POS_SCALE;
      const z = r.svarint() / POS_SCALE;
      out[key] = { x, y, z };
    } else if (kind === 'str') out[key] = str(r.varint());
    else if (kind === 'optStr') {
      const i = r.varint();
      if (i > 0) out[key] = str(i - 1);
    } else out[key] = kind[r.varint()] ?? kind[0];
  }
  return out as unknown as SimEvent;
}

// -----------------------------------------------------------------------------
// Container
// -----------------------------------------------------------------------------

/** FNV-1a over a byte range: cheap corruption detection, not security. */
function fnv1a(bytes: Uint8Array, end: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < end; i++) {
    h ^= bytes[i] as number;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Serialises a recording into the versioned file layout.
 *
 * @param data - Recording.
 * @returns File bytes.
 * @example
 * const bytes = encodeReplayFile(recorder.finish(outcome));
 * download(new Blob([bytes]), `round${REPLAY_EXTENSION}`);
 */
export function encodeReplayFile(data: ReplayData): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(data.header));
  const w = new ByteWriter(json.length + data.frames.length + data.events.length + 32);
  w.u32(REPLAY_MAGIC);
  w.u16(REPLAY_FORMAT_VERSION);
  w.u32(json.length);
  w.bytes(json);
  w.u32(data.frames.length);
  w.bytes(data.frames);
  w.u32(data.events.length);
  w.bytes(data.events);
  const body = w.snapshot();
  w.u32(fnv1a(body, body.length));
  return w.finish();
}

/**
 * Parses and validates a replay file.
 *
 * @param bytes - File contents.
 * @returns The recording.
 * @throws {@link ReplayFileError} when the file is not a replay, comes from an
 * unsupported format version, is truncated/corrupt or has an invalid header.
 */
export function decodeReplayFile(bytes: Uint8Array): ReplayData {
  if (bytes.length < 10) throw new ReplayFileError('magic', 'Not a Tumble Royale replay');
  const r = new ByteReader(bytes);
  if (r.u32() !== REPLAY_MAGIC) throw new ReplayFileError('magic', 'Not a Tumble Royale replay');
  const version = r.u16();
  if (version !== REPLAY_FORMAT_VERSION)
    throw new ReplayFileError(
      'version',
      version > REPLAY_FORMAT_VERSION
        ? 'This replay was saved by a newer version of the game'
        : 'This replay was saved by an older, unsupported version of the game',
    );
  try {
    const json = r.bytes(r.u32());
    const frames = r.bytes(r.u32()).slice();
    const events = r.bytes(r.u32()).slice();
    const end = r.offset;
    const sum = r.u32();
    if (sum !== fnv1a(bytes, end)) throw new ReplayFileError('corrupt', 'The replay file is damaged');
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(json));
    } catch {
      throw new ReplayFileError('header', 'The replay header is unreadable');
    }
    return { header: validateReplayHeader(parsed), frames, events };
  } catch (err) {
    if (err instanceof ReplayFileError) throw err;
    if (err instanceof ReplayDecodeError)
      throw new ReplayFileError('corrupt', 'The replay file is truncated');
    throw err;
  }
}

function fail(field: string): never {
  throw new ReplayFileError('header', `Invalid replay header (${field})`);
}

function num(o: Record<string, unknown>, k: string, int = false): number {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isFinite(v) || (int && !Number.isInteger(v))) fail(k);
  return v;
}

function str(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== 'string') fail(k);
  return v;
}

function bool(o: Record<string, unknown>, k: string): boolean {
  const v = o[k];
  if (typeof v !== 'boolean') fail(k);
  return v;
}

function ints(v: unknown, k: string): number[] {
  if (!Array.isArray(v) || !v.every((x) => Number.isInteger(x))) fail(k);
  return v as number[];
}

function strings(v: unknown, k: string): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) fail(k);
  return v as string[];
}

/**
 * Checks an untrusted header (loaded from a file) field by field.
 *
 * @param raw - Parsed JSON.
 * @returns The typed header.
 * @throws {@link ReplayFileError} naming the first bad field.
 */
export function validateReplayHeader(raw: unknown): ReplayHeader {
  if (!raw || typeof raw !== 'object') fail('root');
  const o = raw as Record<string, unknown>;
  if (num(o, 'format', true) !== REPLAY_FORMAT_VERSION) fail('format');
  const playersRaw = o.players;
  if (!Array.isArray(playersRaw) || playersRaw.length === 0 || playersRaw.length > 255) fail('players');
  const players: ReplayPlayer[] = playersRaw.map((p: unknown, i) => {
    if (!p || typeof p !== 'object') fail(`players[${i}]`);
    const po = p as Record<string, unknown>;
    return {
      id: num(po, 'id', true),
      name: str(po, 'name').slice(0, 64),
      isBot: bool(po, 'isBot'),
      team: num(po, 'team', true),
      loadout: po.loadout ?? null,
    };
  });
  if (new Set(players.map((p) => p.id)).size !== players.length) fail('players (duplicate id)');
  const rate = num(o, 'rate');
  if (rate <= 0 || rate > 120) fail('rate');
  const variation = o.variationId;
  if (variation !== null && typeof variation !== 'string') fail('variationId');
  let outcome: ReplayOutcome | null = null;
  if (o.outcome !== null && o.outcome !== undefined) {
    if (typeof o.outcome !== 'object') fail('outcome');
    const oc = o.outcome as Record<string, unknown>;
    outcome = {
      qualified: ints(oc.qualified, 'outcome.qualified'),
      eliminated: ints(oc.eliminated, 'outcome.eliminated'),
    };
  }
  const frameCount = num(o, 'frameCount', true);
  if (frameCount < 1) fail('frameCount');
  return {
    format: REPLAY_FORMAT_VERSION,
    gameVersion: str(o, 'gameVersion'),
    protocolVersion: num(o, 'protocolVersion', true),
    recordedAt: str(o, 'recordedAt'),
    online: bool(o, 'online'),
    showName: str(o, 'showName'),
    roundId: str(o, 'roundId'),
    roundName: str(o, 'roundName'),
    roundType: str(o, 'roundType'),
    roundIndex: num(o, 'roundIndex', true),
    isFinal: bool(o, 'isFinal'),
    seed: num(o, 'seed', true) >>> 0,
    stage: num(o, 'stage', true),
    variationId: variation as string | null,
    qualifyTarget: num(o, 'qualifyTarget', true),
    localId: num(o, 'localId', true),
    rate,
    startTime: num(o, 'startTime'),
    players,
    obstacles: strings(o.obstacles, 'obstacles'),
    strings: strings(o.strings, 'strings'),
    frameCount,
    eventCount: num(o, 'eventCount', true),
    duration: num(o, 'duration'),
    outcome,
  };
}

/**
 * True when a recording from `version` should play on this build without a
 * warning (same major.minor; content can shift between minors).
 *
 * @param version - Header game version.
 */
export function sameGameVersion(version: string): boolean {
  const a = version.split('.');
  const b = GAME_VERSION.split('.');
  return a[0] === b[0] && a[1] === b[1];
}

/**
 * Suggested download name for a recording.
 *
 * @param h - Header.
 */
export function replayFileName(h: ReplayHeader): string {
  const slug =
    h.roundName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'round';
  const stamp = h.recordedAt.replace(/[:.]/g, '-').slice(0, 19);
  return `${slug}-${stamp}${REPLAY_EXTENSION}`;
}
