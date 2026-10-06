/**
 * Generated parameter forms: each obstacle module's params schema is
 * turned into field descriptions (via JSON Schema), so a new obstacle or a new
 * param shows up in the editor without editor code.
 */
import { obstacleParamJsonSchema } from '@tumble/content/custom';

interface JsonSchema {
  type?: string | string[];
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
}

/** One editable field. */
export type FieldSpec =
  | {
      kind: 'number';
      key: string;
      label: string;
      integer: boolean;
      min?: number;
      max?: number;
      /** Bounds are exclusive (zod `positive()`): the value must not equal them. */
      exclusiveMin?: boolean;
      default?: number;
    }
  | { kind: 'boolean'; key: string; label: string; default?: boolean }
  | { kind: 'enum'; key: string; label: string; options: string[]; default?: string }
  | { kind: 'text'; key: string; label: string; default?: string }
  | { kind: 'vec3'; key: string; label: string; default?: { x: number; y: number; z: number } }
  | { kind: 'points'; key: string; label: string; default?: { x: number; y: number; z: number }[] }
  | { kind: 'json'; key: string; label: string; default?: unknown };

/**
 * "armLength" → "Arm length", "maxTiltDeg" → "Max tilt (°)".
 *
 * @param key - Param name.
 */
export function humanize(key: string): string {
  const deg = /Deg$/.test(key);
  const base = key
    .replace(/Deg$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
  const text = base.charAt(0).toUpperCase() + base.slice(1);
  return deg ? `${text} (°)` : text;
}

const isVec3 = (s: JsonSchema | undefined): boolean =>
  !!s?.properties &&
  Object.keys(s.properties).sort().join() === 'x,y,z' &&
  ['x', 'y', 'z'].every((k) => s.properties![k]?.type === 'number');

const SAFE_INT = 9_007_199_254_740_991;

function field(key: string, s: JsonSchema): FieldSpec {
  const label = humanize(key);
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
  if (s.enum && s.enum.every((e) => typeof e === 'string'))
    return {
      kind: 'enum',
      key,
      label,
      options: s.enum as string[],
      ...(typeof s.default === 'string' ? { default: s.default } : {}),
    };
  if (type === 'number' || type === 'integer') {
    const min = s.minimum ?? s.exclusiveMinimum;
    const max = s.maximum ?? s.exclusiveMaximum;
    return {
      kind: 'number',
      key,
      label,
      integer: type === 'integer',
      ...(min !== undefined && Math.abs(min) < SAFE_INT ? { min } : {}),
      ...(max !== undefined && Math.abs(max) < SAFE_INT ? { max } : {}),
      ...(s.exclusiveMinimum !== undefined ? { exclusiveMin: true } : {}),
      ...(typeof s.default === 'number' ? { default: s.default } : {}),
    };
  }
  if (type === 'boolean')
    return { kind: 'boolean', key, label, ...(typeof s.default === 'boolean' ? { default: s.default } : {}) };
  if (type === 'string')
    return { kind: 'text', key, label, ...(typeof s.default === 'string' ? { default: s.default } : {}) };
  if (type === 'object' && isVec3(s))
    return {
      kind: 'vec3',
      key,
      label,
      ...(s.default !== undefined ? { default: s.default as { x: number; y: number; z: number } } : {}),
    };
  if (type === 'array' && isVec3(s.items))
    return {
      kind: 'points',
      key,
      label,
      ...(Array.isArray(s.default) ? { default: s.default as { x: number; y: number; z: number }[] } : {}),
    };
  return { kind: 'json', key, label, ...(s.default !== undefined ? { default: s.default } : {}) };
}

const cache = new Map<string, FieldSpec[]>();

/**
 * Fields for an obstacle's params, in declaration order.
 *
 * @param type - Obstacle module id.
 * @returns One spec per param (empty for an unknown type); unrepresentable params become JSON fields.
 * @example
 * paramFields('pendulumHammer')[0]; // { kind: 'number', key: 'pivotHeight', … }
 */
export function paramFields(type: string): FieldSpec[] {
  const hit = cache.get(type);
  if (hit) return hit;
  const json = (obstacleParamJsonSchema(type) ?? {}) as JsonSchema;
  const out = Object.entries(json.properties ?? {}).map(([key, s]) => field(key, s));
  cache.set(type, out);
  return out;
}

/**
 * Parses what a player typed into a field.
 *
 * @param spec - The field.
 * @param raw - Input value (text, or a checkbox state).
 * @returns The value to store, or an error message.
 */
export function readField(
  spec: FieldSpec,
  raw: string | boolean,
): { ok: true; value: unknown } | { ok: false; error: string } {
  switch (spec.kind) {
    case 'boolean':
      return { ok: true, value: raw === true || raw === 'true' };
    case 'enum':
      return spec.options.includes(String(raw))
        ? { ok: true, value: String(raw) }
        : { ok: false, error: 'Pick one of the options' };
    case 'text':
      return { ok: true, value: String(raw) };
    case 'number': {
      const n = Number(raw);
      if (String(raw).trim() === '' || !Number.isFinite(n)) return { ok: false, error: 'Enter a number' };
      if (spec.integer && !Number.isInteger(n)) return { ok: false, error: 'Enter a whole number' };
      if (spec.min !== undefined && (spec.exclusiveMin ? n <= spec.min : n < spec.min))
        return { ok: false, error: spec.exclusiveMin ? `Must be above ${spec.min}` : `At least ${spec.min}` };
      if (spec.max !== undefined && n > spec.max) return { ok: false, error: `At most ${spec.max}` };
      return { ok: true, value: n };
    }
    default: {
      try {
        return { ok: true, value: JSON.parse(String(raw)) as unknown };
      } catch {
        return { ok: false, error: 'Not valid JSON' };
      }
    }
  }
}
