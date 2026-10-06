/**
 * Validation of player-made rounds.
 *
 * One function, run unchanged by the editor (inline errors, publish gate),
 * the API (publish, server-side: never trusts the editor) and game servers
 * (before a shared round is played). It checks, in order:
 *
 * 1. Size: the serialised definition fits {@link CUSTOM_ROUND_LIMITS.maxBytes}.
 * 2. Schema: `RoundDefinitionSchema` (defaults applied).
 * 3. Editor rules: supported round type and qualification mode, budgets,
 *    known and allowed obstacles with valid params, unique ids, filtered text,
 *    everything inside `bounds`, a kill plane under the course.
 * 4. Playability: every spawn slot of a full lobby on solid ground; races
 *    have a finish reachable from the spawn (see `support.ts`), hunts a
 *    scoring obstacle, logic rounds a puzzle.
 *
 * Errors block publishing and playing; warnings are shown but allowed.
 */
import {
  MAX_PLAYERS,
  RoundDefinitionSchema,
  containsProfanity,
  sanitizeChatText,
  type RoundDefinition,
  type Vec3,
} from '@tumble/shared';
import { getObstacleModule } from '@tumble/sim/obstacles';
import { ROUNDS } from '../rounds/index.ts';
import {
  CUSTOM_MODE_BY_TYPE,
  CUSTOM_ROUND_LIMITS,
  CUSTOM_ROUND_TYPES,
  type CustomRoundType,
} from './limits.ts';
import { generateBotNav, type GeneratedNav } from './nav.ts';
import { LOGIC_OBSTACLES, SCORING_OBSTACLES, obstacleAllowed, obstacleColliderCost } from './palette.ts';
import {
  reachableSurfaces,
  spawnGrid,
  surfaceTouches,
  surfaceUnder,
  walkableSurfaces,
  type Surface,
} from './support.ts';

/** What an issue points at, so the editor can select it. */
export type IssueTarget =
  | { kind: 'geometry'; index: number }
  | { kind: 'obstacle'; id: string }
  | { kind: 'trigger'; id: string }
  | { kind: 'spawn' }
  | { kind: 'settings'; field: string };

/** One validation finding. */
export interface CustomRoundIssue {
  severity: 'error' | 'warning';
  /** Stable machine code, e.g. `finish_unreachable`. */
  code: string;
  message: string;
  /** Dotted path into the definition, when the issue is about one field. */
  path?: string;
  target?: IssueTarget;
}

/** Counters the editor shows next to the budgets. */
export interface CustomRoundStats {
  bytes: number;
  geometry: number;
  obstacles: number;
  triggers: number;
  colliders: number;
}

/** Result of {@link validateCustomRound}. */
export interface CustomRoundValidation {
  /** No errors (warnings allowed). */
  ok: boolean;
  issues: CustomRoundIssue[];
  /** The parsed round (defaults applied) when the schema accepted it, even with rule errors. */
  round: RoundDefinition | null;
  stats: CustomRoundStats;
  /** Generated bot legs (races) when the round parsed. */
  nav: GeneratedNav | null;
}

/** Palette keys a piece colour may name (anything else must be `#rrggbb`). */
export const PIECE_COLOR_KEYS: readonly string[] = [
  'primary',
  'secondary',
  'accent',
  'danger',
  'safe',
  'neutral',
  'interact',
  'pattern',
  'structure',
  'trim',
  'ink',
];

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,48}$/;
const ALLOWED_TRIGGERS: ReadonlySet<string> = new Set(['checkpoint', 'finish', 'void']);

let musicIds: ReadonlySet<string> | null = null;

/** Music tracks a custom round may name: every track a built-in round uses. */
export function customRoundMusic(): ReadonlySet<string> {
  musicIds ??= new Set(ROUNDS.map((r) => r.music).sort());
  return musicIds;
}

const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DEPTH = 12;

/** True for JSON-shaped data without prototype keys, nested at most {@link MAX_DEPTH} deep. */
function plainData(v: unknown, depth: number): boolean {
  if (v === null || typeof v !== 'object') return true;
  if (depth > MAX_DEPTH) return false;
  if (Array.isArray(v)) return v.every((x) => plainData(x, depth + 1));
  for (const key of Object.keys(v)) {
    if (UNSAFE_KEYS.has(key)) return false;
    if (!plainData((v as Record<string, unknown>)[key], depth + 1)) return false;
  }
  return true;
}

/**
 * Checks player-facing text: printable, within `max`, and free of the words
 * the chat filter masks.
 *
 * @param text - Untrusted text.
 * @param max - Length cap (characters).
 * @returns The cleaned text, or the reason it was refused.
 * @example
 * checkCustomText('  Hop  Hop ', 32); // { ok: true, text: 'Hop Hop' }
 */
export function checkCustomText(
  text: unknown,
  max: number,
): { ok: true; text: string } | { ok: false; reason: 'empty' | 'length' | 'profanity' } {
  if (typeof text !== 'string') return { ok: false, reason: 'empty' };
  if ([...text.trim()].length > max) return { ok: false, reason: 'length' };
  const clean = sanitizeChatText(text, max);
  if (!clean) return { ok: false, reason: 'empty' };
  if (containsProfanity(clean)) return { ok: false, reason: 'profanity' };
  return { ok: true, text: clean };
}

/** Validates obstacle params with the module's own schema. */
function obstacleParams(
  o: RoundDefinition['obstacles'][number],
): { ok: true; params: Record<string, unknown> } | { ok: false; message: string } {
  const mod = getObstacleModule(o.type);
  if (!mod) return { ok: false, message: `Unknown obstacle type "${o.type}"` };
  const r = mod.schema.safeParse(o.params);
  if (!r.success) {
    const first = r.error.issues[0];
    return {
      ok: false,
      message: `${mod.displayName}: ${first ? `${first.path.join('.') || 'params'} ${first.message}` : 'invalid params'}`,
    };
  }
  return { ok: true, params: r.data as Record<string, unknown> };
}

function inside(p: Vec3, b: RoundDefinition['bounds'], pad = 0): boolean {
  return (
    p.x >= b.min.x - pad &&
    p.x <= b.max.x + pad &&
    p.y >= b.min.y - pad &&
    p.y <= b.max.y + pad &&
    p.z >= b.min.z - pad &&
    p.z <= b.max.z + pad
  );
}

/**
 * Validates a custom round definition.
 *
 * @param input - Untrusted round definition (as authored; schema defaults optional).
 * @returns Issues, stats and, when the schema accepted it, the parsed round.
 * @example
 * const v = validateCustomRound(doc.round);
 * if (!v.ok) showErrors(v.issues.filter((i) => i.severity === 'error'));
 */
export function validateCustomRound(input: unknown): CustomRoundValidation {
  const L = CUSTOM_ROUND_LIMITS;
  const issues: CustomRoundIssue[] = [];
  const stats: CustomRoundStats = { bytes: 0, geometry: 0, obstacles: 0, triggers: 0, colliders: 0 };
  const err = (code: string, message: string, extra: Partial<CustomRoundIssue> = {}) =>
    issues.push({ severity: 'error', code, message, ...extra });
  const warn = (code: string, message: string, extra: Partial<CustomRoundIssue> = {}) =>
    issues.push({ severity: 'warning', code, message, ...extra });
  const done = (round: RoundDefinition | null, nav: GeneratedNav | null = null): CustomRoundValidation => ({
    ok: !issues.some((i) => i.severity === 'error'),
    issues,
    round,
    stats,
    nav,
  });

  let json: string;
  try {
    json = JSON.stringify(input) ?? '';
  } catch {
    err('not_json', 'The round is not plain JSON data');
    return done(null);
  }
  stats.bytes = utf8Length(json);
  if (stats.bytes > L.maxBytes) {
    err(
      'too_large',
      `The round is ${Math.ceil(stats.bytes / 1024)} KB; the limit is ${L.maxBytes / 1024} KB`,
    );
    return done(null);
  }
  // SECURITY: shared rounds come from untrusted players; refuse prototype keys
  // before any parser copies them onto fresh objects.
  if (!plainData(input, 0)) {
    err('not_json', 'The round contains keys or nesting that are not allowed');
    return done(null);
  }

  const parsed = RoundDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    for (const i of parsed.error.issues.slice(0, 20))
      err('schema', `${i.path.join('.') || 'round'}: ${i.message}`, { path: i.path.join('.') });
    return done(null);
  }
  const round = parsed.data;
  stats.geometry = round.geometry.length;
  stats.obstacles = round.obstacles.length;
  stats.triggers = round.triggers.length;

  // --- Round settings --------------------------------------------------------
  const type = round.type as CustomRoundType;
  if (!(CUSTOM_ROUND_TYPES as readonly string[]).includes(round.type)) {
    err('round_type', `Custom rounds can be ${CUSTOM_ROUND_TYPES.join(', ')}; not ${round.type}`, {
      target: { kind: 'settings', field: 'type' },
    });
    return done(round);
  }
  const mode = CUSTOM_MODE_BY_TYPE[type];
  if (round.qualification.mode !== mode)
    err('qualification_mode', `A ${type} round qualifies by "${mode}", not "${round.qualification.mode}"`, {
      target: { kind: 'settings', field: 'qualification' },
    });
  if (round.qualification.teams !== 0 || round.spawn.teamOrigins.length > 0)
    err('teams', 'Team rounds cannot be made in the editor', { target: { kind: 'settings', field: 'type' } });
  if (round.qualification.ratio < 0.1 || round.qualification.ratio > 0.9)
    err('qualify_ratio', 'Between 10% and 90% of players must qualify', {
      target: { kind: 'settings', field: 'qualification' },
    });
  if (type === 'hunt') {
    const goal = round.qualification.scoreGoal;
    if (goal === undefined || goal > L.maxScoreGoal)
      err('score_goal', `Hunt rounds need a score target from 1 to ${L.maxScoreGoal}`, {
        target: { kind: 'settings', field: 'qualification' },
      });
  }
  if (round.duration.seconds < L.minSeconds || round.duration.seconds > L.maxSeconds)
    err('duration', `The time limit must be ${L.minSeconds}–${L.maxSeconds} s`, {
      target: { kind: 'settings', field: 'duration' },
    });
  if (round.duration.overtimeSeconds < 0 || round.duration.overtimeSeconds > L.maxOvertime)
    err('overtime', `Overtime must be 0–${L.maxOvertime} s`, {
      target: { kind: 'settings', field: 'duration' },
    });
  if (round.variations.length > 0)
    err('variations', 'Custom rounds cannot have variations', {
      target: { kind: 'settings', field: 'type' },
    });
  if (round.rulesCard !== undefined)
    err('rules_card', 'Custom rounds use the stock rules card for their type', {
      target: { kind: 'settings', field: 'type' },
    });
  if (!customRoundMusic().has(round.music))
    err('music', `Unknown music track "${round.music}"`, { target: { kind: 'settings', field: 'music' } });
  if (round.speedScaleByStage.length > 5 || round.speedScaleByStage.some((s) => s < 0.5 || s > 2))
    err('speed_scale', 'Stage speed scales must be 0.5–2 (at most 5 stages)', {
      target: { kind: 'settings', field: 'speed' },
    });
  if (round.botNav.length > L.maxWaypoints)
    err('waypoints', `At most ${L.maxWaypoints} bot waypoints`, {
      target: { kind: 'settings', field: 'bots' },
    });

  const name = checkCustomText(round.name, L.nameMax);
  if (!name.ok || [...name.text].length < L.nameMin)
    err(
      'name',
      name.ok || name.reason !== 'profanity'
        ? `Name the round (${L.nameMin}–${L.nameMax} characters)`
        : 'That name is not allowed',
      {
        target: { kind: 'settings', field: 'name' },
      },
    );
  const objective = checkCustomText(round.objective, L.objectiveMax);
  if (!objective.ok)
    err(
      'objective',
      objective.reason === 'profanity'
        ? 'That objective text is not allowed'
        : `Write an objective (up to ${L.objectiveMax} characters)`,
      {
        target: { kind: 'settings', field: 'objective' },
      },
    );
  if (round.tips.length > L.maxTips)
    err('tips', `At most ${L.maxTips} tips`, { target: { kind: 'settings', field: 'tips' } });
  round.tips.forEach((tip, i) => {
    const t = checkCustomText(tip, L.tipMax);
    if (!t.ok)
      err(
        'tips',
        t.reason === 'profanity'
          ? `Tip ${i + 1} is not allowed`
          : `Tip ${i + 1} must be 1–${L.tipMax} characters`,
        {
          target: { kind: 'settings', field: 'tips' },
        },
      );
  });
  if (round.designNotes) {
    const notes = checkCustomText(round.designNotes, L.designNotesMax);
    if (!notes.ok && notes.reason !== 'empty')
      err('design_notes', 'Design notes are too long or not allowed', {
        target: { kind: 'settings', field: 'designNotes' },
      });
  }

  // --- Bounds ----------------------------------------------------------------
  const b = round.bounds;
  if (b.max.x - b.min.x > L.maxExtent || b.max.z - b.min.z > L.maxExtent || b.max.y - b.min.y > L.maxHeight)
    err('bounds_size', `The play area may be at most ${L.maxExtent}×${L.maxHeight}×${L.maxExtent} m`, {
      target: { kind: 'settings', field: 'bounds' },
    });
  if (!(b.min.x < b.max.x && b.min.y < b.max.y && b.min.z < b.max.z))
    err('bounds_order', 'Bounds min must be below max on every axis', {
      target: { kind: 'settings', field: 'bounds' },
    });
  if (round.killY < b.min.y)
    err('kill_below_bounds', 'The fall-out height must be inside the bounds', {
      target: { kind: 'settings', field: 'killY' },
    });
  if (!inside(round.spawn.origin, b, -1))
    err('spawn_bounds', 'The spawn is outside the play area', { target: { kind: 'spawn' } });

  // --- Geometry --------------------------------------------------------------
  if (round.geometry.length > L.maxGeometry)
    err('geometry_budget', `${round.geometry.length} level parts; the limit is ${L.maxGeometry}`);
  if (!round.geometry.some((g) => !g.decorative))
    err('no_floor', 'Add at least one solid level part to stand on');
  round.geometry.forEach((g, index) => {
    const target: IssueTarget = { kind: 'geometry', index };
    const s = g.size;
    if (![s.x, s.y, s.z].every((v) => v > 0 && v <= L.maxPieceSize))
      err('piece_size', `Part ${index + 1}: sizes must be above 0 and at most ${L.maxPieceSize} m`, {
        target,
      });
    if (!inside(g.position, b)) err('piece_bounds', `Part ${index + 1} is outside the play area`, { target });
    if (!PIECE_COLOR_KEYS.includes(g.color) && !HEX_COLOR.test(g.color))
      err('piece_color', `Part ${index + 1}: colour must be a palette name or #rrggbb`, { target });
    if (g.bevel < 0 || g.bevel > 2) err('piece_bevel', `Part ${index + 1}: bevel must be 0–2 m`, { target });
  });

  // --- Obstacles -------------------------------------------------------------
  if (round.obstacles.length > L.maxObstacles)
    err('obstacle_budget', `${round.obstacles.length} obstacles; the limit is ${L.maxObstacles}`);
  const ids = new Set<string>();
  const params = new Map<string, Record<string, unknown>>();
  for (const o of round.obstacles) {
    const target: IssueTarget = { kind: 'obstacle', id: o.id };
    if (!ID_RE.test(o.id))
      err('obstacle_id', `Obstacle id "${o.id.slice(0, 48)}" is not allowed`, { target });
    if (ids.has(o.id)) err('duplicate_id', `Two things share the id "${o.id}"`, { target });
    ids.add(o.id);
    if (!getObstacleModule(o.type)) {
      err('obstacle_type', `Unknown obstacle type "${o.type.slice(0, 40)}"`, { target });
      continue;
    }
    if (!obstacleAllowed(o.type, type))
      err(
        'obstacle_not_allowed',
        `${getObstacleModule(o.type)!.displayName} cannot be used in a ${type} round`,
        {
          target,
        },
      );
    if (!inside(o.position, b)) err('obstacle_bounds', `${o.id} is outside the play area`, { target });
    const p = obstacleParams(o);
    if (!p.ok) {
      err('obstacle_params', p.message, { target });
      continue;
    }
    params.set(o.id, p.params);
    stats.colliders += obstacleColliderCost(o.type, p.params);
  }
  if (stats.colliders > L.maxObstacleColliders)
    err(
      'collider_budget',
      `Obstacles build about ${stats.colliders} physics parts; the limit is ${L.maxObstacleColliders}`,
    );
  if (type === 'hunt' && !round.obstacles.some((o) => SCORING_OBSTACLES.has(o.type)))
    err('no_scoring', 'Hunt rounds need a Comet Field or Sunbeam Zones to score from');
  if (type === 'logic' && !round.obstacles.some((o) => LOGIC_OBSTACLES.has(o.type)))
    err('no_puzzle', 'Logic rounds need a Pattern Panic Board or Puzzle Floor');

  // --- Triggers --------------------------------------------------------------
  if (round.triggers.length > L.maxTriggers)
    err('trigger_budget', `${round.triggers.length} triggers; the limit is ${L.maxTriggers}`);
  const cpIndices = new Set<number>();
  let checkpoints = 0;
  for (const t of round.triggers) {
    const target: IssueTarget = { kind: 'trigger', id: t.id };
    if (!ID_RE.test(t.id)) err('trigger_id', `Trigger id "${t.id.slice(0, 48)}" is not allowed`, { target });
    if (ids.has(t.id)) err('duplicate_id', `Two things share the id "${t.id}"`, { target });
    ids.add(t.id);
    if (!ALLOWED_TRIGGERS.has(t.kind))
      err('trigger_kind', `Custom rounds cannot use ${t.kind} triggers`, { target });
    if (![t.size.x, t.size.y, t.size.z].every((v) => v > 0 && v <= L.maxPieceSize * 4))
      err('trigger_size', `${t.id}: sizes must be above 0`, { target });
    if (t.kind !== 'void' && !inside(t.position, b))
      err('trigger_bounds', `${t.id} is outside the play area`, { target });
    if (t.respawn.length > 24) err('respawn_points', `${t.id}: at most 24 respawn points`, { target });
    if (t.kind === 'checkpoint') {
      checkpoints++;
      if (t.index < 1) err('checkpoint_index', `${t.id}: checkpoint numbers start at 1`, { target });
      if (cpIndices.has(t.index))
        err('checkpoint_index', `Two checkpoints are number ${t.index}`, { target });
      cpIndices.add(t.index);
    }
  }
  if (checkpoints > L.maxCheckpoints) err('checkpoint_budget', `At most ${L.maxCheckpoints} checkpoints`);
  const finishes = round.triggers.filter((t) => t.kind === 'finish');
  if (type === 'race' && finishes.length === 0) err('no_finish', 'Races need a finish');
  if (type !== 'race' && finishes.length > 0)
    warn('finish_ignored', `A finish does nothing in a ${type} round`, {
      target: { kind: 'trigger', id: finishes[0]!.id },
    });

  // --- Playability -----------------------------------------------------------
  const surfaces: Surface[] = walkableSurfaces(round, (o) => params.get(o.id) ?? {});
  const lowestTop = surfaces.reduce((m, s) => Math.min(m, s.yMin), Infinity);
  if (Number.isFinite(lowestTop) && round.killY > lowestTop - 2)
    err(
      'kill_too_high',
      `The fall-out height (${round.killY} m) must be at least 2 m below the lowest floor (${lowestTop.toFixed(1)} m)`,
      {
        target: { kind: 'settings', field: 'killY' },
      },
    );

  const slots = spawnGrid(round.spawn, MAX_PLAYERS);
  const under = slots.map((p) => surfaceUnder(surfaces, p));
  const floating = under.filter((i) => i < 0).length;
  if (floating > 0)
    err('spawn_floating', `${floating} of ${MAX_PLAYERS} spawn spots are not on solid ground`, {
      target: { kind: 'spawn' },
    });
  if (slots.some((p) => !inside(p, b)))
    err('spawn_bounds', 'Part of the spawn grid is outside the play area', { target: { kind: 'spawn' } });

  let nav: GeneratedNav | null = null;
  if (type === 'race' && finishes.length > 0 && floating < slots.length) {
    const reach = reachableSurfaces(
      surfaces,
      under.filter((i) => i >= 0),
    );
    const reachable = (t: RoundDefinition['triggers'][number]) =>
      surfaces.some((s, i) => reach[i] && surfaceTouches(s, t));
    if (!finishes.some(reachable))
      err('finish_unreachable', 'The finish cannot be reached from the spawn (a gap or ledge is too big)', {
        target: { kind: 'trigger', id: finishes[0]!.id },
      });
    for (const t of round.triggers)
      if (t.kind === 'checkpoint' && !reachable(t))
        warn('checkpoint_unreachable', `${t.id} looks out of reach`, {
          target: { kind: 'trigger', id: t.id },
        });
    nav = generateBotNav(round, surfaces);
    if (nav.status === 'gaps')
      warn(
        'bot_gaps',
        'Bots run straight between checkpoints and will fall at a gap; add checkpoints around it',
      );
  } else if (type !== 'race') {
    nav = { botNav: [], status: 'roam', blockedLegs: [] };
  }
  return done(round, nav);
}
