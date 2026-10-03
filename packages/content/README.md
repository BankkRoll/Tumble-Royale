# @tumble/content

Game data only: no logic beyond lookups and validation. Every value is checked
by a zod schema, so bad data fails tests rather than a live show.

## Modules

| Import                        | Contents                                                                                                                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@tumble/content/rounds`      | `ROUNDS`, `getRound(id)`, `roundCatalog()`, `showRoundCatalog()` (excludes dev rounds such as `test-arena`). One folder per round; builders register rounds in `group-1.ts` to `group-4.ts`. |
| `@tumble/content/shows`       | Playlists: Main Show, Duos, Squads, Chaos Mode, Ranked, First Show. Each lists its round pool, weights and qualification curve.                                                              |
| `@tumble/content/themes`      | `getTheme(id)` for the 10 themes: palette, sky, fog, lighting, decor, colour grade, weather.                                                                                                 |
| `@tumble/content/cosmetics`   | 225-item catalog with rarities and prices, `DEFAULT_LOADOUT`, seeded `randomLoadout`, `validateLoadout`.                                                                                     |
| `@tumble/content/progression` | XP curve and levels, show rewards, challenges, the 100-tier season pass.                                                                                                                     |
| `@tumble/content/tuning`      | `CHARACTER_TUNING` and `SURFACE_TUNING`, with a rationale per value. Keep in sync with `DEFAULT_TUNING` in `@tumble/sim/character`.                                                          |

The round schema itself lives in `@tumble/shared` (re-exported here).

## Adding a round

Write `src/rounds/<id>/index.ts` with `defineRound({...})`, add it to a
group list, and preview it at `/level.html?round=<id>`. Positions are
bounding-box centres, ramps rise toward +Z, wedge ridges run along Z, tori
lie flat, and rotations are yaw/pitch/roll in degrees. Design intent for the
20 launch rounds is in `docs/design/LEVELS.md`.

## Testing

```sh
pnpm --filter @tumble/content test
```

The round tests build every round and every variation in a real match sim
with zero warnings. They also check every obstacle's params against its
module schema with no stripped keys, and confirm ground under every spawn and
respawn, waypoint connectivity to the finish, and bounds containment.
