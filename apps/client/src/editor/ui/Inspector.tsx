/**
 * Inspector for the selection: transform fields for anything, piece styling,
 * trigger settings, the spawn grid, and generated param forms for obstacles.
 */
import type { JSX } from 'react';
import { PIECE_COLOR_KEYS } from '@tumble/content/custom';
import { StaticPieceSchema } from '@tumble/shared';
import { getObstacleModule } from '@tumble/sim/obstacles';
import { paramFields } from '../forms.ts';
import { setObstacleParam, updateObstacle, updatePiece, updateTrigger, type ItemRef } from '../model.ts';
import { NumberInput, Row, Section, Vec3Input, useActions, useEditor, useFieldId } from './kit.tsx';
import { ParamField } from './ParamField.tsx';

const SHAPES = StaticPieceSchema.shape.shape.options;
const SURFACES = StaticPieceSchema.shape.surface.unwrap().options;
const PATTERNS = StaticPieceSchema.shape.pattern.unwrap().options;

type Rot = { yaw?: number; pitch?: number; roll?: number } | undefined;

function RotationFields(props: {
  value: Rot;
  onCommit(r: { yaw: number; pitch: number; roll: number }): void;
  yawOnly?: boolean;
  disabled?: boolean;
}): JSX.Element {
  const r = { yaw: props.value?.yaw ?? 0, pitch: props.value?.pitch ?? 0, roll: props.value?.roll ?? 0 };
  const keys = props.yawOnly ? (['yaw'] as const) : (['yaw', 'pitch', 'roll'] as const);
  return (
    <div className="ed-row">
      <span className="ed-row-label">Turn (°)</span>
      <div className="ed-vec3">
        {keys.map((k) => (
          <NumberInput
            key={k}
            value={r[k]}
            min={-360}
            max={360}
            ariaLabel={`Turn ${k}`}
            disabled={props.disabled}
            onCommit={(n) => props.onCommit({ ...r, [k]: n })}
          />
        ))}
      </div>
    </div>
  );
}

function Select<T extends string>(props: {
  label: string;
  value: T;
  options: readonly T[];
  onChange(v: T): void;
  disabled?: boolean;
}): JSX.Element {
  const id = useFieldId('sel');
  return (
    <Row label={props.label} htmlFor={id}>
      <select
        id={id}
        className="ed-input"
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value as T)}
      >
        {props.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </Row>
  );
}

function Check(props: {
  label: string;
  checked: boolean;
  onChange(v: boolean): void;
  disabled?: boolean;
}): JSX.Element {
  const id = useFieldId('chk');
  return (
    <Row label={props.label} htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
      />
    </Row>
  );
}

function PieceInspector({ index }: { index: number }): JSX.Element | null {
  const piece = useEditor((s) => s.round.geometry[index]);
  const disabled = useEditor((s) => s.viewing !== null);
  const { edit } = useActions();
  if (!piece) return null;
  const set = (patch: Parameters<typeof updatePiece>[2], group?: string) =>
    edit((r) => updatePiece(r, index, patch), group ?? null);
  const color = piece.color ?? 'primary';
  return (
    <Section title={`Level part ${index + 1}`}>
      <Vec3Input
        label="Position"
        value={piece.position}
        disabled={disabled}
        onCommit={(position) => set({ position })}
      />
      <RotationFields value={piece.rotation} disabled={disabled} onCommit={(rotation) => set({ rotation })} />
      <Vec3Input
        label="Size"
        value={piece.size}
        min={0.05}
        disabled={disabled}
        onCommit={(size) => set({ size })}
      />
      <Select
        label="Shape"
        value={piece.shape}
        options={SHAPES}
        disabled={disabled}
        onChange={(shape) => set({ shape })}
      />
      <Select
        label="Surface"
        value={piece.surface ?? 'normal'}
        options={SURFACES}
        disabled={disabled}
        onChange={(surface) => set({ surface })}
      />
      <Select
        label="Colour"
        value={PIECE_COLOR_KEYS.includes(color) ? color : 'custom'}
        options={[...PIECE_COLOR_KEYS, 'custom']}
        disabled={disabled}
        onChange={(c) => set({ color: c === 'custom' ? '#ff6fb5' : c })}
      />
      {!PIECE_COLOR_KEYS.includes(color) ? (
        <Row label="Custom colour">
          <input
            type="color"
            value={color}
            disabled={disabled}
            onChange={(e) => set({ color: e.target.value }, `color-${index}`)}
          />
        </Row>
      ) : null}
      <Select
        label="Pattern"
        value={piece.pattern ?? 'none'}
        options={PATTERNS}
        disabled={disabled}
        onChange={(pattern) => set({ pattern })}
      />
      <Row label="Bevel (m)">
        <NumberInput
          value={piece.bevel ?? 0.15}
          min={0}
          max={2}
          disabled={disabled}
          onCommit={(bevel) => set({ bevel })}
        />
      </Row>
      <Check
        label="Grab edge"
        checked={piece.grabbable ?? false}
        disabled={disabled}
        onChange={(grabbable) => set({ grabbable })}
      />
      <Check
        label="Decoration only (no collision)"
        checked={piece.decorative ?? false}
        disabled={disabled}
        onChange={(decorative) => set({ decorative })}
      />
    </Section>
  );
}

function ObstacleInspector({ id }: { id: string }): JSX.Element | null {
  const o = useEditor((s) => s.round.obstacles?.find((x) => x.id === id));
  const disabled = useEditor((s) => s.viewing !== null);
  const { edit } = useActions();
  if (!o) return null;
  const mod = getObstacleModule(o.type);
  const params = (o.params ?? {}) as Record<string, unknown>;
  return (
    <Section title={mod?.displayName ?? o.type} aside={<code className="ed-id">{o.id}</code>}>
      <Vec3Input
        label="Position"
        value={o.position}
        disabled={disabled}
        onCommit={(position) => edit((r) => updateObstacle(r, id, { position }))}
      />
      <RotationFields
        value={o.rotation}
        disabled={disabled}
        onCommit={(rotation) => edit((r) => updateObstacle(r, id, { rotation }))}
      />
      {mod ? (
        <div className="ed-params" aria-label="Obstacle settings">
          {paramFields(o.type).map((spec) => (
            <ParamField
              key={spec.key}
              spec={spec}
              value={params[spec.key]}
              disabled={disabled}
              onChange={(value) =>
                edit((r) => setObstacleParam(r, id, spec.key, value), `param-${id}-${spec.key}`)
              }
            />
          ))}
        </div>
      ) : (
        <p className="ed-field-error">Unknown obstacle type</p>
      )}
    </Section>
  );
}

function TriggerInspector({ id }: { id: string }): JSX.Element | null {
  const t = useEditor((s) => s.round.triggers?.find((x) => x.id === id));
  const disabled = useEditor((s) => s.viewing !== null);
  const { edit } = useActions();
  if (!t) return null;
  const title =
    t.kind === 'checkpoint' ? `Checkpoint ${t.index ?? 0}` : t.kind === 'finish' ? 'Finish' : 'Fall-out zone';
  return (
    <Section title={title} aside={<code className="ed-id">{t.id}</code>}>
      <Vec3Input
        label="Position"
        value={t.position}
        disabled={disabled}
        onCommit={(position) =>
          edit((r) => {
            const d = {
              x: position.x - t.position.x,
              y: position.y - t.position.y,
              z: position.z - t.position.z,
            };
            return updateTrigger(r, id, {
              position,
              respawn: (t.respawn ?? []).map((p) => ({ x: p.x + d.x, y: p.y + d.y, z: p.z + d.z })),
            });
          })
        }
      />
      <RotationFields
        value={t.rotation}
        yawOnly
        disabled={disabled}
        onCommit={(rotation) => edit((r) => updateTrigger(r, id, { rotation }))}
      />
      <Vec3Input
        label="Size"
        value={t.size}
        min={0.1}
        disabled={disabled}
        onCommit={(size) => edit((r) => updateTrigger(r, id, { size }))}
      />
      {t.kind === 'checkpoint' ? (
        <>
          <Row label="Number">
            <NumberInput
              value={t.index ?? 1}
              min={1}
              max={99}
              disabled={disabled}
              onCommit={(index) => edit((r) => updateTrigger(r, id, { index: Math.round(index) }))}
            />
          </Row>
          <Row label="Respawn yaw (°)">
            <NumberInput
              value={t.respawnYaw ?? 0}
              min={-360}
              max={360}
              disabled={disabled}
              onCommit={(respawnYaw) => edit((r) => updateTrigger(r, id, { respawnYaw }))}
            />
          </Row>
          <p className="ed-hint">{(t.respawn ?? []).length} respawn spots move with the checkpoint.</p>
        </>
      ) : null}
    </Section>
  );
}

function SpawnInspector(): JSX.Element {
  const spawn = useEditor((s) => s.round.spawn);
  const disabled = useEditor((s) => s.viewing !== null);
  const { edit } = useActions();
  const set = (patch: Partial<typeof spawn>) => edit((r) => ({ ...r, spawn: { ...r.spawn, ...patch } }));
  return (
    <Section title="Spawn">
      <p className="ed-hint">A full show is 100 players; every green dot must stand on solid ground.</p>
      <Vec3Input
        label="Centre"
        value={spawn.origin}
        disabled={disabled}
        onCommit={(origin) => set({ origin })}
      />
      <Row label="Facing (°)">
        <NumberInput
          value={spawn.yaw ?? 0}
          min={-360}
          max={360}
          disabled={disabled}
          onCommit={(yaw) => set({ yaw })}
        />
      </Row>
      <Row label="Columns">
        <NumberInput
          value={spawn.cols ?? 8}
          min={1}
          max={20}
          disabled={disabled}
          onCommit={(cols) => set({ cols: Math.round(cols) })}
        />
      </Row>
      <Row label="Spacing (m)">
        <NumberInput
          value={spawn.spacing ?? 1.4}
          min={1}
          max={3}
          disabled={disabled}
          onCommit={(spacing) => set({ spacing })}
        />
      </Row>
    </Section>
  );
}

/** The inspector for whatever is selected. */
export function Inspector(): JSX.Element {
  const selection = useEditor((s) => s.selection);
  const { deleteSelection, duplicate } = useActions();
  const readOnly = useEditor((s) => s.viewing !== null);
  if (selection.length === 0)
    return (
      <div className="ed-inspector ed-empty">
        <p>Select something to edit it. Shift-click adds to the selection.</p>
      </div>
    );
  if (selection.length > 1)
    return (
      <div className="ed-inspector">
        <Section title={`${selection.length} selected`}>
          <p className="ed-hint">Drag the gizmo to move or turn them together.</p>
          <div className="ed-chips">
            <button type="button" className="ed-chip" disabled={readOnly} onClick={duplicate}>
              Duplicate
            </button>
            <button
              type="button"
              className="ed-chip ed-chip--danger"
              disabled={readOnly}
              onClick={deleteSelection}
            >
              Delete
            </button>
          </div>
        </Section>
      </div>
    );
  const ref = selection[0] as ItemRef;
  return (
    <div className="ed-inspector">
      {ref.kind === 'geometry' ? <PieceInspector index={ref.index} /> : null}
      {ref.kind === 'obstacle' ? <ObstacleInspector id={ref.id} /> : null}
      {ref.kind === 'trigger' ? <TriggerInspector id={ref.id} /> : null}
      {ref.kind === 'spawn' ? <SpawnInspector /> : null}
    </div>
  );
}
