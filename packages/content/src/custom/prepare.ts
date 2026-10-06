/**
 * Turning a validated custom round into the definition a show plays, and the
 * starter round the editor opens with.
 */
import type { RoundDefinition, RoundDefinitionInput } from '@tumble/shared';
import { CUSTOM_MODE_BY_TYPE, CUSTOM_ROUND_PLAYERS, type CustomRoundType } from './limits.ts';
import { validateCustomRound, type CustomRoundIssue } from './validate.ts';

/** Result of {@link playableCustomRound}. */
export type PlayableCustomRound =
  | { ok: true; round: RoundDefinition; botRoute: 'route' | 'gaps' | 'roam' }
  | { ok: false; issues: CustomRoundIssue[] };

/**
 * Validates a custom round and fixes the fields a show controls: the id, the
 * player range (shows fill to the cap), no variations or custom rules card,
 * and generated bot legs when none were authored.
 *
 * Game servers and clients both run this on the same stored definition, so
 * the prediction sim and the authoritative sim build the same round.
 *
 * @param input - Untrusted definition.
 * @param id - Id to play it under (`custom:<CODE>`, or the playtest id).
 * @returns The playable round, or the errors that stop it.
 * @example
 * const r = playableCustomRound(json.definition, customRoundId(code));
 * if (r.ok) catalog.set(r.round.id, r.round);
 */
export function playableCustomRound(input: unknown, id: string): PlayableCustomRound {
  const v = validateCustomRound(input);
  if (!v.ok || !v.round) return { ok: false, issues: v.issues.filter((i) => i.severity === 'error') };
  const { rulesCard: _card, ...rest } = v.round;
  const generated = v.nav?.botNav ?? [];
  return {
    ok: true,
    round: {
      ...rest,
      id,
      players: { ...CUSTOM_ROUND_PLAYERS },
      variations: [],
      botNav: rest.botNav.length > 0 ? rest.botNav : generated,
    },
    botRoute: rest.botNav.length > 0 ? 'route' : (v.nav?.status ?? 'roam'),
  };
}

/**
 * A small playable round to start from: a start pad, a walkway with a gap,
 * a checkpoint and a finish (races) or a single arena (other types).
 *
 * @param type - Round type.
 * @returns A definition that passes {@link validateCustomRound}.
 */
export function starterRound(type: CustomRoundType = 'race'): RoundDefinitionInput {
  const race = type === 'race';
  const floor = (x: number, top: number, z: number, sx: number, sz: number, color = 'primary') => ({
    shape: 'box' as const,
    position: { x, y: top - 0.5, z },
    size: { x: sx, y: 1, z: sz },
    color,
    bevel: 0.3,
  });
  const geometry = race
    ? [
        floor(0, 0, 0, 16, 16, 'safe'),
        floor(0, 0, 22, 8, 24),
        floor(0, 0, 40, 10, 6, 'accent'),
        floor(0, 0, 54, 16, 16, 'safe'),
      ]
    : [floor(0, 0, 0, 36, 36)];
  return {
    id: 'custom:draft',
    name: race
      ? 'My Race'
      : type === 'survival'
        ? 'My Survival'
        : type === 'hunt'
          ? 'My Hunt'
          : 'My Logic Round',
    type,
    theme: 'candy',
    objective: race
      ? 'Reach the finish!'
      : type === 'hunt'
        ? 'Score points to qualify!'
        : 'Stay on your feet!',
    tips: [],
    players: { ...CUSTOM_ROUND_PLAYERS },
    qualification: {
      mode: CUSTOM_MODE_BY_TYPE[type],
      ratio: race ? 0.6 : 0.5,
      ...(type === 'hunt' ? { scoreGoal: 5 } : {}),
    },
    duration: { seconds: race ? 120 : 90, overtimeSeconds: 0 },
    killY: -12,
    bounds: { min: { x: -60, y: -20, z: -40 }, max: { x: 60, y: 40, z: 100 } },
    spawn: { origin: { x: 0, y: 0.1, z: 0 }, yaw: 0, cols: 12, spacing: 1.2 },
    geometry,
    obstacles: race
      ? [
          {
            id: 'cp-1-gate',
            type: 'checkpointGate',
            position: { x: 0, y: 0, z: 40 },
            params: { index: 1, width: 10 },
          },
          { id: 'finish-arch', type: 'finishLine', position: { x: 0, y: 0, z: 56 }, params: { width: 16 } },
        ]
      : type === 'hunt'
        ? [{ id: 'comets', type: 'cometField', position: { x: 0, y: 0, z: 0 }, params: {} }]
        : type === 'logic'
          ? [
              {
                id: 'puzzle',
                type: 'puzzleFloor',
                position: { x: 0, y: 0, z: 0 },
                params: { cols: 5, rows: 5 },
              },
            ]
          : [{ id: 'sweeper', type: 'sweeperArm', position: { x: 0, y: 0, z: 0 }, params: {} }],
    triggers: race
      ? [
          {
            id: 'cp-1',
            kind: 'checkpoint',
            index: 1,
            position: { x: 0, y: 2, z: 40 },
            size: { x: 10, y: 4, z: 2 },
            respawn: [-3, 0, 3].map((dx) => ({ x: dx, y: 0.1, z: 42 })),
          },
          { id: 'finish', kind: 'finish', position: { x: 0, y: 2, z: 56 }, size: { x: 16, y: 4, z: 3 } },
        ]
      : [],
    flyover: {
      path: [
        { x: 20, y: 24, z: race ? 70 : 30 },
        { x: -24, y: 26, z: race ? 28 : 0 },
        { x: 0, y: 8, z: -14 },
      ],
      lookAt: [{ x: 0, y: 0, z: race ? 28 : 0 }],
      duration: 6,
    },
    cameraMode: 'orbit',
    music: race ? 'mus_candy_sugarrush' : 'mus_logic_ticktock',
    fallBehavior: race ? 'respawnCheckpoint' : 'eliminate',
    botNav: [],
    variations: [],
    decorSeed: 1,
    designNotes: '',
  };
}
