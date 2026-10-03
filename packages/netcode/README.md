# @tumble/netcode

Wire protocol and timing for server-authoritative play. The wire format and
bit budgets are specified in [PROTOCOL.md](PROTOCOL.md).

## Public API

- **Bit packing and quantisation:** `BitWriter`, `BitReader`, `PositionQuantizer` (16 bits per axis within round bounds), `packQuat`/`unpackQuat` (smallest-three), velocity, yaw and axis helpers.
- **Messages:** codecs for Hello, Welcome, InputBatch (60 Hz, last 3 inputs redundant), Snapshot, Reliable, Ping/Pong and Kick.
- **Snapshots:** `SnapshotEncoder`/`SnapshotDecoder` with per-entity delta masks against the client's last acked snapshot, plus a priority accumulator for interest management within a per-packet byte budget.
- **Reliable channel:** `ReliableEndpoint`, with sequence numbers, cumulative acks and retransmits, for gameplay events and low-frequency msgpack messages.
- **Timing:** `ClockSync` (NTP-style), `InputJitterBuffer`, `SnapshotInterpolator` (hermite, brief extrapolation), `InputHistory`.
- **Testing aids:** `NetworkConditioner` (latency, jitter, loss, duplication, reorder). `@tumble/netcode/dev` has a capsule stand-in `MatchSim` for load tests.

## Testing

```sh
pnpm --filter @tumble/netcode test
```

The tests fuzz the bit packer, bound quantisation error, check delta and full
encodings agree, deliver reliable messages under 20% loss with reordering,
and confirm clock sync converges under jitter.
