/**
 * Builds a lil-gui editor for an obstacle's params by walking its zod schema:
 * numbers → number fields, booleans → checkboxes, enums/literal unions →
 * dropdowns, nested number objects (vectors) → sub-folders. Arrays (path
 * points, keyframes) are shown read-only as a count.
 */
import type GUI from 'lil-gui';

/** The slice of zod 4's internal definition we read; kept structural so zod internals stay untyped here. */
interface ZodDefLike {
  type: string;
  innerType?: ZodLike;
  in?: ZodLike;
  entries?: Record<string, string | number>;
  options?: ZodLike[];
  values?: unknown[];
  shape?: Record<string, ZodLike>;
}

interface ZodLike {
  _zod?: { def: ZodDefLike };
}

/** Strips default/optional/pipe wrappers. */
function unwrap(s: ZodLike | undefined): ZodDefLike | undefined {
  let def = s?._zod?.def;
  for (let i = 0; def && i < 8; i++) {
    if ((def.type === 'default' || def.type === 'optional' || def.type === 'nullable' || def.type === 'prefault') && def.innerType) {
      def = def.innerType._zod?.def;
    } else if (def.type === 'pipe' && def.in) {
      def = def.in._zod?.def;
    } else break;
  }
  return def;
}

/** Dropdown options for an enum or a union of literals, if the schema is one. */
function choicesOf(def: ZodDefLike | undefined): (string | number)[] | null {
  if (!def) return null;
  if (def.type === 'enum' && def.entries) return Object.values(def.entries);
  if (def.type === 'union' && def.options) {
    const out: (string | number)[] = [];
    for (const o of def.options) {
      const v = o._zod?.def.values?.[0];
      if (typeof v === 'string' || typeof v === 'number') out.push(v);
      else return null;
    }
    return out;
  }
  return null;
}

/**
 * Adds controllers for `params` (mutated in place) under `folder`.
 *
 * @param folder - Parent GUI folder.
 * @param schema - The module's zod schema.
 * @param params - Parsed params object to edit.
 * @param onChange - Called after any edit is committed.
 */
export function buildParamControls(folder: GUI, schema: unknown, params: Record<string, unknown>, onChange: () => void): void {
  const shape = unwrap(schema as ZodLike)?.shape ?? {};
  for (const key of Object.keys(params)) {
    const value = params[key];
    const def = unwrap(shape[key]);
    const choices = choicesOf(def);
    if (choices) {
      folder.add(params, key, choices).onFinishChange(onChange);
    } else if (typeof value === 'number') {
      folder.add(params, key).step(0.05).onFinishChange(onChange);
    } else if (typeof value === 'boolean') {
      folder.add(params, key).onFinishChange(onChange);
    } else if (Array.isArray(value)) {
      const info = { [key]: `${value.length} items (edit in round data)` };
      folder.add(info, key).disable();
    } else if (value && typeof value === 'object') {
      const sub = folder.addFolder(key);
      const obj = value as Record<string, unknown>;
      for (const k of Object.keys(obj)) if (typeof obj[k] === 'number') sub.add(obj, k).step(0.1).onFinishChange(onChange);
      sub.close();
    }
  }
}
