/**
 * End-to-end netcode check under the Phase 2 acceptance conditions:
 * 150 ms RTT + ~2% loss. An in-test authoritative loop (capsule sim, jitter
 * buffers, snapshot encoder) talks through NetworkConditioners to the real
 * client PredictionController + RemoteEntities on a virtual clock.
 */
import { describe, expect, it } from 'vitest';
import {
  BitReader,
  BitWriter,
  EntityTable,
  InputJitterBuffer,
  MsgType,
  NetworkConditioner,
  ObstacleTable,
  PositionQuantizer,
  SnapshotDecoder,
  SnapshotEncoder,
  createCharacterFullState,
  createDecodedSnapshot,
  createNetRoundStatus,
  readInputBatch,
  simTickOf,
  writeInputBatch,
  type InputBatchHeader,
  type InputHistory,
  type MatchPlayerInfo,
} from '@tumble/netcode';
import { createCapsuleMatchSim, createDevRound } from '@tumble/netcode/dev';
import { Button, loadRapier, type CharacterInput } from '@tumble/sim';
import { Rng, RoundPhase, SIM_STEPS_PER_TICK } from '@tumble/shared';
import { PredictionController } from '../src/net/PredictionController.ts';
import { RemoteEntities } from '../src/net/RemoteEntities.ts';

const LOCAL = 0;

describe('prediction + interpolation under 150 ms RTT and 2% loss', () => {
  it('keeps local movement uncorrected in normal play and remotes continuous', async () => {
    const R = await loadRapier();
    const round = createDevRound();
    const players: MatchPlayerInfo[] = [0, 1, 2, 3].map((id) => ({ id, name: `p${id}`, isBot: id !== LOCAL, team: -1 }));
    // Spread players so bots never bump the local player (contacts with interpolated proxies are a separate, expected source of corrections).
    const server = createCapsuleMatchSim({ R, round, seed: 1, stage: 0, players, mode: 'authority' });
    const client = createCapsuleMatchSim({ R, round, seed: 1, stage: 0, players, mode: 'predict', localPlayerId: LOCAL });
    server.setPhase(RoundPhase.Playing, 0);

    let now = 0;
    const clock = (): number => now;
    const q = new PositionQuantizer(round.bounds);
    const link = { latencyMs: 75, jitterMs: 10, loss: 0.01, ordered: true };

    // --- server side ---------------------------------------------------------
    const jitter = new InputJitterBuffer();
    const encoder = new SnapshotEncoder();
    const table = new EntityTable();
    const obstacles = new ObstacleTable(['blinker']);
    const status = createNetRoundStatus();
    const sw = new BitWriter(2048);
    const sr = new BitReader();
    const batch: CharacterInput[] = [0, 1, 2].map(() => ({ moveX: 0, moveZ: 0, yaw: 0, buttons: 0, emote: 0 }));
    const header: InputBatchHeader = { newestSeq: 0, clientTick: 0, ackSnapshotId: -1, count: 0 };
    const st = createCharacterFullState();
    const botRng = new Rng(3);
    const botInput: CharacterInput = { moveX: 0, moveZ: 1, yaw: 0, buttons: 0, emote: 0 };
    let serverTick = 0;

    // --- client side ---------------------------------------------------------
    const decoder = new SnapshotDecoder();
    const decoded = createDecodedSnapshot();
    const cw = new BitWriter(256);
    const cr = new BitReader();
    const remotes = new RemoteEntities(LOCAL);
    let anchorServerMs = 0;
    let anchorMatch = 0;

    const toServer = new NetworkConditioner({ ...link, seed: 1 }, (d) => {
      sr.reset(d);
      sr.readBits(8);
      readInputBatch(sr, batch, header);
      encoder.ack(header.ackSnapshotId);
      for (let i = header.count - 1; i >= 0; i--) jitter.push(header.newestSeq - i, batch[i]!, now);
    }, clock);
    const toClient = new NetworkConditioner({ ...link, seed: 2 }, (d) => {
      cr.reset(d);
      expect(cr.readBits(8)).toBe(MsgType.Snapshot);
      if (decoder.decode(cr, q, decoded) !== 'ok') return;
      anchorServerMs = decoded.serverTick * (1000 / 30);
      anchorMatch = decoded.matchTime;
      remotes.onSnapshot(decoded, now, decoded.serverTick * (1000 / 30));
      for (let i = 0; i < decoded.entityCount; i++) {
        const e = decoded.entities[i]!;
        if (e.id === LOCAL && prediction.reconcile(decoded.ackedInputSeq, e, decoded.matchTime) && now > 3000) steadyCorrections++;
      }
    }, clock);

    const prediction = new PredictionController(client, LOCAL, {
      matchTime: () => anchorMatch + (now - anchorServerMs) / 1000,
      rttMs: () => 150,
      sendInput: (seq: number, history: InputHistory) => {
        const n = history.collectRecent(seq, 3, batch);
        writeInputBatch(cw.reset(), { newestSeq: seq, clientTick: seq, ackSnapshotId: decoder.newestId, count: n }, batch);
        toServer.send(cw.finish());
      },
    });
    prediction.setPhase(RoundPhase.Playing);

    // Local input: run in long straight lines and gentle turns, jump now and then.
    const rng = new Rng(9);
    let heading = 0;
    let jumpHold = 0;
    const sample = (): CharacterInput => {
      if (rng.chance(0.01)) heading += rng.range(-1, 1);
      const me = prediction.latestState();
      // Stay on the 80 m arena: falling off respawns (a legitimate teleport, not a netcode pop).
      if (me && Math.hypot(me.pos.x, me.pos.z) > 25) heading = Math.atan2(-me.pos.x, -me.pos.z);
      if (jumpHold > 0) jumpHold--;
      else if (rng.chance(0.01)) jumpHold = 10;
      return { moveX: 0, moveZ: 1, yaw: heading, buttons: jumpHold > 0 ? Button.Jump : 0, emote: 0 };
    };

    const renderPos = { x: 0, y: 0, z: 0 };
    const prevRender = { x: NaN, y: 0, z: 0 };
    let maxLocalJump = 0;
    const remotePrev = new Map<number, { x: number; z: number }>();
    let maxRemoteStep = 0;
    const FRAME = 1000 / 60;
    const TICK = 1000 / 30;
    let nextFrame = 0;
    let nextTick = TICK;
    let steadyCorrections = 0;

    for (now = 0; now < 30_000; now += 1) {
      toServer.update();
      toClient.update();
      if (now >= nextTick) {
        nextTick += TICK;
        serverTick++;
        for (let s = 0; s < SIM_STEPS_PER_TICK; s++) {
          const inp = { moveX: 0, moveZ: 0, yaw: 0, buttons: 0, emote: 0 };
          jitter.next(inp);
          server.setInput(LOCAL, inp);
          for (let b = 1; b <= 3; b++) {
            server.getPlayerState(b, st);
            botInput.yaw = Math.hypot(st.pos.x, st.pos.z) > 25 ? Math.atan2(-st.pos.x, -st.pos.z) : Math.sin(now / 1500 + b) * 2;
            botInput.buttons = botRng.chance(0.01) ? Button.Jump : 0;
            server.setInput(b, botInput);
          }
          server.step();
          server.events.drain();
        }
        table.clear();
        for (const p of players) if (server.getPlayerState(p.id, st)) table.set(p.id, st, q, simTickOf(serverTick));
        obstacles.update(server.getObstacleNetStates());
        encoder.encode(sw.reset(), {
          snapshotId: serverTick & 0xffff,
          serverTick,
          epoch: 1,
          matchTime: server.time,
          entities: table,
          obstacles,
          status,
          leaders: [],
          quantizer: q,
        }, { playerId: LOCAL, spectateTarget: -1, ackedInputSeq: jitter.lastConsumedSeq });
        toClient.send(sw.finish());
      }
      if (now >= nextFrame) {
        nextFrame += FRAME;
        prediction.advance(FRAME, sample);
        remotes.update(now, client);
        prediction.renderPosition(renderPos);
        if (now > 3000) {
          if (!Number.isNaN(prevRender.x)) {
            maxLocalJump = Math.max(maxLocalJump, Math.hypot(renderPos.x - prevRender.x, renderPos.z - prevRender.z));
          }
          remotes.forEach((e) => {
            const prev = remotePrev.get(e.id);
            if (prev) maxRemoteStep = Math.max(maxRemoteStep, Math.hypot(e.pos.x - prev.x, e.pos.z - prev.z));
            remotePrev.set(e.id, { x: e.pos.x, z: e.pos.z });
          });
        }
        prevRender.x = renderPos.x;
        prevRender.y = renderPos.y;
        prevRender.z = renderPos.z;
      }
    }

    // Locally simulated time must sit ahead of the server by about RTT/2 + buffer.
    const lead = client.time - server.time;
    console.log(
      `[prediction] corrections=${prediction.corrections} (steady ${steadyCorrections}), replayed=${prediction.replayed}, ` +
        `maxCorrection=${prediction.maxCorrection.toFixed(3)}m, maxLocalFrameStep=${maxLocalJump.toFixed(3)}m, ` +
        `maxRemoteFrameStep=${maxRemoteStep.toFixed(3)}m, lead=${(lead * 1000).toFixed(0)}ms timeError=${(prediction.timeError * 1000).toFixed(1)}ms, ` +
        `jitter missed=${jitter.missed} underruns=${jitter.underruns}, delay=${remotes.clock.delayMs.toFixed(0)}ms`,
    );
    // 9.5 m/s at 60 fps ≈ 0.16 m/frame: anything well above that is a visible pop.
    expect(maxLocalJump).toBeLessThan(0.2);
    expect(maxRemoteStep).toBeLessThan(0.35);
    // Normal play: corrections only where packet loss defeated the 3× input redundancy.
    expect(steadyCorrections).toBeLessThan(10);
    expect(Math.abs(prediction.timeError)).toBeLessThan(0.01);
    expect(lead * 1000).toBeGreaterThan(60);
    expect(lead * 1000).toBeLessThan(250);
    server.dispose();
    client.dispose();
  }, 60_000);
});
