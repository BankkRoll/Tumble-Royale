/**
 * @tumble/netcode — everything that crosses the wire, shared by the game
 * server, the browser client and the bot swarm.
 *
 * Responsibilities:
 * - bit packing ({@link BitWriter}/{@link BitReader}) and quantisation;
 * - the binary protocol (handshake, inputs, snapshots, reliable channel, ping)
 *   plus msgpackr low-frequency messages — documented in `PROTOCOL.md`;
 * - delta-compressed, interest-managed snapshots ({@link SnapshotEncoder}/{@link SnapshotDecoder});
 * - timing: {@link ClockSync}, {@link InputJitterBuffer}, {@link InterpolationClock},
 *   {@link SnapshotInterpolator}, {@link InputHistory};
 * - {@link NetworkConditioner} for simulated bad networks.
 *
 * Headless and clock-free: every time source is injected. The Rapier-backed
 * stand-in match sim lives in the separate `@tumble/netcode/dev` entry.
 */
export * from './bits.ts';
export * from './quantize.ts';
export * from './protocol.ts';
export * from './input.ts';
export * from './events.ts';
export * from './reliable.ts';
export * from './snapshot.ts';
export * from './clock.ts';
export * from './jitter.ts';
export * from './history.ts';
export * from './interpolation.ts';
export * from './conditioner.ts';
export * from './state.ts';
export type * from './simTypes.ts';
