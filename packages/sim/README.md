# @tumble/sim

The simulation core. The game server runs it authoritatively and the client
runs the same code to predict the local player. Headless by design: no DOM,
no three.js, no wall clock, no `Math.random()` (enforced by lint).

## Modules

Each folder is importable on its own as `@tumble/sim/<folder>`.

| Import                  | Contents                                                                                                                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@tumble/sim`           | `loadRapier`, `createWorld`, `FixedStepper`, `EventSink`/`SimEvent`, `SurfaceRegistry`, the character and obstacle contract types, `runDeterminismScenario`                                                                                                                    |
| `@tumble/sim/character` | `createTumblerController` / `TumblerController`: velocity-targeted capsule with platform riding, coyote time and jump buffering, dive, grab, ledge climb, stun. `CharacterTuning`, `DEFAULT_TUNING`. Full state restore for rewind and replay.                                 |
| `@tumble/sim/obstacles` | The obstacle library (sets A, B and C), `OBSTACLE_REGISTRY`, `getObstacleModule`. Moving parts are pure `pose(t)` functions; non-pure state (tiles, doors, tilt) replicates through `getNetState`/`setNetState`.                                                               |
| `@tumble/sim/match`     | `createMatchSim`: one round in a Rapier world (level colliders, obstacles, triggers, characters, rules, bots), in `authority`, `predict` or `offline` mode. `setTime` snaps obstacles for prediction rewinds. Includes a test kit with a simple controller and test obstacles. |
| `@tumble/sim/rounds`    | Rule modules per qualification mode: finish, survive, team score, hold item, last standing, crown grab.                                                                                                                                                                        |
| `@tumble/sim/show`      | `ShowDirector` (round selection, round lifecycle, eliminations, show summary), `createOfflineShow` for single-player shows against bots, the playlist schema.                                                                                                                  |
| `@tumble/sim/bots`      | Bot brains that produce the same `CharacterInput` humans send: waypoint graphs, obstacle-aware timing, behaviours per round type, skill tiers, a name generator.                                                                                                               |

## Step order

Obstacles set their next kinematic pose, then `controller.step`, then
`world.step`, then `controller.postStep`, then triggers and rules. Platform
riding reads the kinematic pose change, so changing this order breaks riding.
Spawn and teleport positions are feet positions.

## Testing

```sh
pnpm --filter @tumble/sim test
```

The suite covers Rapier determinism, controller feel (jumps, gaps, slopes,
riding, stuns), bit-exact rewind and replay, every obstacle's pose
determinism and colliders, round rules, full show flow, and bots finishing
courses.
