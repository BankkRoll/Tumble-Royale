# @tumble/shared

Types, constants and helpers used by every package. Free of DOM, three.js and
Rapier so it runs anywhere, deterministically.

## Public API

- **Constants** (`constants.ts`): `SIM_HZ` / `SIM_DT` (60 Hz fixed step), `SERVER_TICK_HZ` (30), `SNAPSHOT_HZ`, `GRAVITY_Y`, `MAX_PLAYERS`, `DEFAULT_SHOW_PLAYERS`.
- **Seeded randomness** (`rng.ts`): `Rng` (sfc32: `next`, `range`, `int`, `chance`, `pick`, `shuffle`, `weightedIndex`, `fork`), `hashString`, `hash01`. Use these instead of `Math.random()` anywhere results must match across machines.
- **Math** (`math.ts`): plain `Vec3`/`Quat` types and allocation-free helpers (`quatFromYaw`, `quatFromEulerYXZ`, `quatMul`, `quatSlerp`, `rotateVec`, `damp`, `angleDelta`, …).
- **Collision** (`collision.ts`): `CollisionGroup` bits and `InteractionGroups` presets for every collider role.
- **Game enums** (`game.ts`): `RoundType`, `RoundPhase`, `ShowPhase`, `ThemeId`, `TEAM_COLORS`.
- **Round schema** (`schema/round.ts`): `RoundDefinitionSchema`, `defineRound` and the `RoundDefinition`, `StaticPiece`, `TriggerDef` and `Waypoint` types. It lives here, rather than in `content`, so `sim` can read round data without a dependency cycle.

## Testing

```sh
pnpm --filter @tumble/shared test
```
