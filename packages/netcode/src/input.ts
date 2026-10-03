/**
 * Input quantisation and the InputBatch message.
 *
 * The client quantises its own input BEFORE predicting with it
 * ({@link quantizeInputInPlace}), so prediction and the server consume
 * bit-identical inputs and never diverge from rounding alone.
 */
import type { CharacterInput } from '@tumble/sim';
import type { BitReader, BitWriter } from './bits.ts';
import { MsgType } from './protocol.ts';
import { dequantizeAxis, dequantizeYaw, quantizeAxis, quantizeYaw } from './quantize.ts';

/** Inputs carried per batch: the newest plus redundant copies of the previous ones. */
export const INPUT_REDUNDANCY = 3;
/** Bits for the button bitfield. */
export const BUTTON_BITS = 4;
/** Bits for the emote slot (0–7). */
export const EMOTE_BITS = 3;
/** Sentinel for "no snapshot received yet" in {@link InputBatchHeader.ackSnapshotId}. */
export const NO_SNAPSHOT = -1;

/** Rounds every field of `input` to the values the wire can carry. */
export function quantizeInputInPlace(input: CharacterInput): CharacterInput {
  input.moveX = dequantizeAxis(quantizeAxis(input.moveX));
  input.moveZ = dequantizeAxis(quantizeAxis(input.moveZ));
  input.yaw = dequantizeYaw(quantizeYaw(input.yaw));
  input.buttons &= (1 << BUTTON_BITS) - 1;
  input.emote = input.emote >= 0 && input.emote < 1 << EMOTE_BITS ? Math.floor(input.emote) : 0;
  return input;
}

/** Writes one input (39 bits). */
export function writeInput(w: BitWriter, input: CharacterInput): void {
  w.writeInt(quantizeAxis(input.moveX), 8);
  w.writeInt(quantizeAxis(input.moveZ), 8);
  w.writeBits(quantizeYaw(input.yaw), 16);
  w.writeBits(input.buttons, BUTTON_BITS);
  w.writeUint(input.emote, EMOTE_BITS);
}

/** Reads one input into `out`. */
export function readInput(r: BitReader, out: CharacterInput): CharacterInput {
  out.moveX = dequantizeAxis(Math.max(-127, r.readInt(8)));
  out.moveZ = dequantizeAxis(Math.max(-127, r.readInt(8)));
  out.yaw = dequantizeYaw(r.readBits(16));
  out.buttons = r.readBits(BUTTON_BITS);
  out.emote = r.readBits(EMOTE_BITS);
  return out;
}

/** True when two inputs encode identically (used for the 1-bit "same as newer" redundancy). */
export function inputsEqual(a: CharacterInput, b: CharacterInput): boolean {
  return (
    quantizeAxis(a.moveX) === quantizeAxis(b.moveX) &&
    quantizeAxis(a.moveZ) === quantizeAxis(b.moveZ) &&
    quantizeYaw(a.yaw) === quantizeYaw(b.yaw) &&
    a.buttons === b.buttons &&
    a.emote === b.emote
  );
}

/** Header fields of an InputBatch. */
export interface InputBatchHeader {
  /** Sequence number of the newest input in the batch (one per client fixed step). */
  newestSeq: number;
  /** Client's local fixed-step tick when the batch was sent (sanity checks and drift diagnostics). */
  clientTick: number;
  /** Newest snapshot id the client decoded, or {@link NO_SNAPSHOT}. */
  ackSnapshotId: number;
  /** Number of inputs in the batch (0 = ack-only). */
  count: number;
}

/**
 * Writes an InputBatch.
 *
 * Layout: `type:8 newestSeq:32 clientTick:32 hasAck:1 [ack:16] count:2`, then
 * inputs newest-first; each input after the first is preceded by a "same as the
 * newer one" bit. Typical: 12 bytes header + 5 bytes + ~1 bit per repeat.
 *
 * @param inputs - Newest first; at most {@link INPUT_REDUNDANCY}.
 */
export function writeInputBatch(
  w: BitWriter,
  header: InputBatchHeader,
  inputs: readonly CharacterInput[],
): void {
  const count = Math.min(header.count, inputs.length, INPUT_REDUNDANCY);
  w.writeBits(MsgType.InputBatch, 8);
  w.writeBits(header.newestSeq, 32);
  w.writeBits(header.clientTick, 32);
  const hasAck = header.ackSnapshotId >= 0;
  w.writeBool(hasAck);
  if (hasAck) w.writeBits(header.ackSnapshotId, 16);
  w.writeBits(count, 2);
  for (let i = 0; i < count; i++) {
    const input = inputs[i]!;
    if (i > 0) {
      const same = inputsEqual(input, inputs[i - 1]!);
      w.writeBool(same);
      if (same) continue;
    }
    writeInput(w, input);
  }
}

/**
 * Reads an InputBatch after its type byte.
 *
 * @param out - At least {@link INPUT_REDUNDANCY} preallocated inputs, filled newest-first.
 * @returns The header (inputs in `out[0 … count-1]`).
 */
export function readInputBatch(
  r: BitReader,
  out: CharacterInput[],
  header: InputBatchHeader,
): InputBatchHeader {
  header.newestSeq = r.readBits(32);
  header.clientTick = r.readBits(32);
  header.ackSnapshotId = r.readBool() ? r.readBits(16) : NO_SNAPSHOT;
  header.count = r.readBits(2);
  for (let i = 0; i < header.count; i++) {
    const dst = out[i]!;
    if (i > 0 && r.readBool()) {
      const src = out[i - 1]!;
      dst.moveX = src.moveX;
      dst.moveZ = src.moveZ;
      dst.yaw = src.yaw;
      dst.buttons = src.buttons;
      dst.emote = src.emote;
      continue;
    }
    readInput(r, dst);
  }
  return header;
}
