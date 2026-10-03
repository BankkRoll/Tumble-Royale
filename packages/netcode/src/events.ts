/**
 * Codec for messages carried on the reliable channel: gameplay {@link SimEvent}s
 * (compact, table-driven binary) and low-frequency msgpackr messages.
 *
 * Event positions travel as float32 rather than round-bounds quantised values so
 * events stay decodable regardless of which round's bounds a client has loaded.
 */
import type { SimEvent } from '@tumble/sim';
import { BitReader, BitWriter } from './bits.ts';
import { packLowFreq, unpackLowFreq, type LowFreqMessage } from './protocol.ts';
import { Packr } from 'msgpackr';

/** A message delivered by the reliable channel. */
export type ReliableMessage =
  | { kind: 'sim'; /** Server sim tick the event was emitted on. */ tick: number; event: SimEvent }
  | { kind: 'msg'; msg: LowFreqMessage };

type FieldKind = 'uint' | 'int' | 'f32' | 'vec' | 'str' | 'ostr' | readonly string[];
type EventSchema = readonly [
  type: SimEvent['type'],
  fields: readonly (readonly [name: string, kind: FieldKind])[],
];

/**
 * Wire table for SimEvents. The index in this array is the wire id, so only
 * ever APPEND entries. Types missing from the table (added to the union later)
 * still travel via the msgpack fallback id.
 */
const EVENT_SCHEMAS: readonly EventSchema[] = [
  [
    'jump',
    [
      ['player', 'uint'],
      ['pos', 'vec'],
    ],
  ],
  [
    'land',
    [
      ['player', 'uint'],
      ['pos', 'vec'],
      ['impact', 'f32'],
    ],
  ],
  [
    'dive',
    [
      ['player', 'uint'],
      ['pos', 'vec'],
    ],
  ],
  ['getUp', [['player', 'uint']]],
  [
    'stun',
    [
      ['player', 'uint'],
      ['pos', 'vec'],
      ['strength', 'f32'],
    ],
  ],
  [
    'bounce',
    [
      ['player', 'uint'],
      ['pos', 'vec'],
      ['obstacle', 'ostr'],
    ],
  ],
  [
    'grabStart',
    [
      ['player', 'uint'],
      ['target', 'int'],
      ['targetKind', ['player', 'prop', 'ledge']],
    ],
  ],
  [
    'grabEnd',
    [
      ['player', 'uint'],
      ['target', 'int'],
      ['reason', ['release', 'broken', 'stamina']],
    ],
  ],
  [
    'emote',
    [
      ['player', 'uint'],
      ['emote', 'uint'],
    ],
  ],
  [
    'fellOut',
    [
      ['player', 'uint'],
      ['pos', 'vec'],
    ],
  ],
  [
    'respawn',
    [
      ['player', 'uint'],
      ['pos', 'vec'],
    ],
  ],
  [
    'checkpoint',
    [
      ['player', 'uint'],
      ['index', 'uint'],
    ],
  ],
  [
    'finish',
    [
      ['player', 'uint'],
      ['tick', 'uint'],
      ['subTick', 'f32'],
    ],
  ],
  [
    'qualified',
    [
      ['player', 'uint'],
      ['place', 'uint'],
    ],
  ],
  [
    'eliminated',
    [
      ['player', 'uint'],
      ['place', 'uint'],
    ],
  ],
  [
    'tileFell',
    [
      ['obstacle', 'str'],
      ['tile', 'uint'],
    ],
  ],
  [
    'tileWarn',
    [
      ['obstacle', 'str'],
      ['tile', 'uint'],
    ],
  ],
  [
    'obstacleCue',
    [
      ['obstacle', 'str'],
      ['cue', 'str'],
      ['pos', 'vec'],
    ],
  ],
  [
    'teleport',
    [
      ['player', 'uint'],
      ['from', 'vec'],
      ['to', 'vec'],
    ],
  ],
  [
    'score',
    [
      ['team', 'int'],
      ['player', 'int'],
      ['delta', 'f32'],
      ['total', 'f32'],
    ],
  ],
  [
    'propPickup',
    [
      ['player', 'uint'],
      ['prop', 'int'],
    ],
  ],
  [
    'propDrop',
    [
      ['player', 'uint'],
      ['prop', 'int'],
    ],
  ],
];

const FALLBACK_ID = 255;
const schemaIndex = new Map<string, number>(EVENT_SCHEMAS.map((s, i) => [s[0], i]));
const fallbackPackr = new Packr({ useRecords: false });

const ReliableKind = { Sim: 0, Msg: 1 } as const;

/** Writes one SimEvent (type id + fields). */
export function writeSimEvent(w: BitWriter, e: SimEvent): void {
  const id = schemaIndex.get(e.type);
  if (id === undefined) {
    w.writeBits(FALLBACK_ID, 8);
    w.writeByteArray(fallbackPackr.pack(e));
    return;
  }
  w.writeBits(id, 8);
  // Field access by name is the point of the table; the union has no common index signature.
  const rec = e as unknown as Record<string, unknown>;
  for (const [name, kind] of EVENT_SCHEMAS[id]![1]) writeField(w, kind, rec[name]);
}

/**
 * Reads one SimEvent.
 *
 * @returns The event, or `null` for an unknown id / malformed payload.
 */
export function readSimEvent(r: BitReader): SimEvent | null {
  const id = r.readBits(8);
  if (id === FALLBACK_ID) {
    try {
      const v: unknown = fallbackPackr.unpack(r.readByteArray());
      // Fallback events come from a newer sim union; their shape is the sender's SimEvent.
      return typeof v === 'object' && v !== null && 'type' in v ? (v as SimEvent) : null;
    } catch {
      return null;
    }
  }
  const schema = EVENT_SCHEMAS[id];
  if (!schema) return null;
  const rec: Record<string, unknown> = { type: schema[0] };
  for (const [name, kind] of schema[1]) {
    const v = readField(r, kind);
    if (v !== undefined) rec[name] = v;
  }
  // The record was built from this type's schema, so it matches that union member.
  return r.overflow ? null : (rec as unknown as SimEvent);
}

function writeField(w: BitWriter, kind: FieldKind, v: unknown): void {
  if (typeof kind !== 'string') {
    const i = kind.indexOf(String(v));
    w.writeBits(i < 0 ? 0 : i, 4);
    return;
  }
  switch (kind) {
    case 'uint':
      w.writeVarUint(Number(v) || 0);
      return;
    case 'int':
      w.writeVarInt(Number(v) || 0);
      return;
    case 'f32':
      w.writeFloat32(Number(v) || 0);
      return;
    case 'vec': {
      const p = v as { x: number; y: number; z: number } | undefined;
      w.writeFloat32(p?.x ?? 0);
      w.writeFloat32(p?.y ?? 0);
      w.writeFloat32(p?.z ?? 0);
      return;
    }
    case 'str':
      w.writeString(String(v ?? ''), 128);
      return;
    case 'ostr':
      w.writeBool(typeof v === 'string');
      if (typeof v === 'string') w.writeString(v, 128);
      return;
  }
}

function readField(r: BitReader, kind: FieldKind): unknown {
  if (typeof kind !== 'string') return kind[r.readBits(4)] ?? kind[0];
  switch (kind) {
    case 'uint':
      return r.readVarUint();
    case 'int':
      return r.readVarInt();
    case 'f32':
      return r.readFloat32();
    case 'vec':
      return { x: r.readFloat32(), y: r.readFloat32(), z: r.readFloat32() };
    case 'str':
      return r.readString();
    case 'ostr':
      return r.readBool() ? r.readString() : undefined;
  }
}

const scratchWriter = new BitWriter(512);

/**
 * Serialises a reliable message to a standalone payload for {@link ReliableEndpoint.send}.
 *
 * @returns A new byte array owned by the caller.
 */
export function encodeReliableMessage(m: ReliableMessage): Uint8Array {
  if (m.kind === 'msg') {
    const body = packLowFreq(m.msg);
    const out = new Uint8Array(body.length + 1);
    out[0] = ReliableKind.Msg;
    out.set(body, 1);
    return out;
  }
  const w = scratchWriter.reset();
  w.writeBits(ReliableKind.Sim, 8);
  w.writeVarUint(m.tick);
  writeSimEvent(w, m.event);
  return w.finish().slice();
}

const scratchReader = new BitReader();

/**
 * Parses a payload produced by {@link encodeReliableMessage}.
 *
 * @returns The message, or `null` if malformed.
 */
export function decodeReliableMessage(payload: Uint8Array): ReliableMessage | null {
  if (payload.length === 0) return null;
  if (payload[0] === ReliableKind.Msg) {
    const msg = unpackLowFreq(payload.subarray(1));
    return msg ? { kind: 'msg', msg } : null;
  }
  if (payload[0] !== ReliableKind.Sim) return null;
  const r = scratchReader.reset(payload);
  r.readBits(8);
  const tick = r.readVarUint();
  const event = readSimEvent(r);
  return event && !r.overflow ? { kind: 'sim', tick, event } : null;
}
