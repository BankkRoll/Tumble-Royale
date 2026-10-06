/**
 * One generated obstacle-param control, by field kind (see `forms.ts`).
 * Changed params show a reset button that returns them to the module default.
 */
import { useEffect, useState, type JSX } from 'react';
import { readField, type FieldSpec } from '../forms.ts';
import { DraftInput, Vec3Input, useFieldId } from './kit.tsx';

type V3 = { x: number; y: number; z: number };

/**
 * Renders a param control.
 *
 * @param props.spec - Generated field.
 * @param props.value - Stored value, or undefined when the default applies.
 * @param props.onChange - Commits a value (`undefined` resets to the default).
 */
export function ParamField(props: {
  spec: FieldSpec;
  value: unknown;
  onChange(value: unknown): void;
  disabled?: boolean;
}): JSX.Element {
  const { spec } = props;
  const id = useFieldId(`param-${spec.key}`);
  const overridden = props.value !== undefined;
  const current = overridden ? props.value : spec.default;
  const reset = overridden ? (
    <button
      type="button"
      className="ed-reset"
      title="Back to the default"
      aria-label={`Reset ${spec.label}`}
      disabled={props.disabled}
      onClick={() => props.onChange(undefined)}
    >
      ↺
    </button>
  ) : null;
  const label = (
    <label htmlFor={id} className={overridden ? 'is-changed' : undefined}>
      {spec.label}
    </label>
  );

  let control: JSX.Element;
  switch (spec.kind) {
    case 'boolean':
      control = (
        <input
          id={id}
          type="checkbox"
          checked={current === true}
          disabled={props.disabled}
          onChange={(e) => props.onChange(e.target.checked)}
        />
      );
      break;
    case 'enum':
      control = (
        <select
          id={id}
          className="ed-input"
          value={String(current ?? spec.options[0])}
          disabled={props.disabled}
          onChange={(e) => props.onChange(e.target.value)}
        >
          {spec.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
      break;
    case 'vec3':
      return (
        <div className="ed-param">
          <Vec3Input
            label={spec.label}
            value={(current as V3 | undefined) ?? { x: 0, y: 0, z: 0 }}
            disabled={props.disabled}
            onCommit={(v) => props.onChange(v)}
          />
          {reset}
        </div>
      );
    case 'points':
      return (
        <PointsField {...props} spec={spec} current={(current as V3[] | undefined) ?? []} reset={reset} />
      );
    case 'json':
      return <JsonField id={id} label={label} reset={reset} {...props} current={current} />;
    default:
      control = (
        <DraftInput
          id={id}
          value={current === undefined ? '' : String(current)}
          inputMode={spec.kind === 'number' ? 'decimal' : 'text'}
          disabled={props.disabled}
          className={spec.kind === 'number' ? 'ed-input ed-input--num' : 'ed-input'}
          validate={(raw) => {
            const r = readField(spec, raw);
            return r.ok ? null : r.error;
          }}
          onCommit={(raw) => {
            const r = readField(spec, raw);
            if (r.ok) props.onChange(r.value);
          }}
        />
      );
  }
  return (
    <div className="ed-row ed-param">
      {label}
      <div className="ed-row-control">
        {control}
        {reset}
      </div>
    </div>
  );
}

function PointsField(props: {
  spec: Extract<FieldSpec, { kind: 'points' }>;
  current: V3[];
  onChange(value: unknown): void;
  reset: JSX.Element | null;
  disabled?: boolean;
}): JSX.Element {
  const pts = props.current;
  return (
    <fieldset className="ed-points">
      <legend>
        {props.spec.label} {props.reset}
      </legend>
      {pts.map((p, i) => (
        <div key={i} className="ed-point">
          <Vec3Input
            label={`#${i + 1}`}
            value={p}
            disabled={props.disabled}
            onCommit={(v) => props.onChange(pts.map((q, j) => (j === i ? v : q)))}
          />
          <button
            type="button"
            className="ed-reset"
            aria-label={`Remove point ${i + 1}`}
            disabled={props.disabled || pts.length <= 1}
            onClick={() => props.onChange(pts.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="ed-chip"
        disabled={props.disabled || pts.length >= 16}
        onClick={() => {
          const last = pts.at(-1) ?? { x: 0, y: 0, z: 0 };
          props.onChange([...pts, { ...last, z: last.z + 4 }]);
        }}
      >
        Add point
      </button>
    </fieldset>
  );
}

function JsonField(props: {
  id: string;
  label: JSX.Element;
  reset: JSX.Element | null;
  spec: FieldSpec;
  current: unknown;
  onChange(value: unknown): void;
  disabled?: boolean;
}): JSX.Element {
  const text = JSON.stringify(props.current ?? null, null, 1);
  const [draft, setDraft] = useState(text);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(text), [text]);
  return (
    <div className="ed-row ed-param ed-param--json">
      {props.label}
      <div className="ed-row-control">
        <textarea
          id={props.id}
          className="ed-input ed-json"
          rows={3}
          value={draft}
          disabled={props.disabled}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft === text) return;
            const r = readField(props.spec, draft);
            setError(r.ok ? null : r.error);
            if (r.ok) props.onChange(r.value);
          }}
        />
        {props.reset}
        {error ? (
          <span className="ed-field-error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </div>
  );
}
