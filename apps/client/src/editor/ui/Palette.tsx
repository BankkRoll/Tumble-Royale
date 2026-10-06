/**
 * Build palette: level parts, course markers and the obstacle library
 * (filtered to what the round's type allows). Picking an entry arms it; the
 * next click in the 3D view places it.
 */
import type { JSX } from 'react';
import { LEVEL_PARTS, OBSTACLE_GROUPS, obstacleAllowed, type CustomRoundType } from '@tumble/content/custom';
import { getObstacleModule } from '@tumble/sim/obstacles';
import type { Placing } from '../store.ts';
import { Section, useActions, useEditor } from './kit.tsx';

const same = (a: Placing, b: Placing): boolean => JSON.stringify(a) === JSON.stringify(b);

function PaletteButton(props: { item: Placing; label: string; disabled?: boolean }): JSX.Element {
  const placing = useEditor((s) => s.placing);
  const { setPlacing } = useActions();
  const on = same(placing, props.item);
  return (
    <button
      type="button"
      className={`ed-chip${on ? ' is-on' : ''}`}
      aria-pressed={on}
      disabled={props.disabled}
      onClick={() => setPlacing(on ? null : props.item)}
    >
      {props.label}
    </button>
  );
}

/** The build palette. */
export function Palette(): JSX.Element {
  const type = useEditor((s) => s.round.type) as CustomRoundType;
  const placing = useEditor((s) => s.placing);
  const readOnly = useEditor((s) => s.viewing !== null);
  const { select } = useActions();
  return (
    <div className="ed-palette">
      <p className="ed-hint" role="status">
        {readOnly
          ? 'Viewing a shared round. Make a copy to build on it.'
          : placing
            ? 'Click in the view to place it. Hold Shift to place several.'
            : 'Pick something, then click in the view to place it.'}
      </p>
      <Section title="Level parts">
        <div className="ed-chips">
          {LEVEL_PARTS.map((p) => (
            <PaletteButton key={p.id} item={{ kind: 'part', id: p.id }} label={p.label} disabled={readOnly} />
          ))}
        </div>
      </Section>
      <Section title="Markers">
        <div className="ed-chips">
          <button type="button" className="ed-chip" onClick={() => select([{ kind: 'spawn' }])}>
            Spawn
          </button>
          <PaletteButton
            item={{ kind: 'marker', marker: 'checkpoint' }}
            label="Checkpoint"
            disabled={readOnly || type !== 'race'}
          />
          <PaletteButton
            item={{ kind: 'marker', marker: 'finish' }}
            label="Finish"
            disabled={readOnly || type !== 'race'}
          />
          <PaletteButton
            item={{ kind: 'marker', marker: 'void' }}
            label="Fall-out zone"
            disabled={readOnly}
          />
        </div>
      </Section>
      {OBSTACLE_GROUPS.map((g) => {
        const types = g.types.filter((t) => obstacleAllowed(t, type) && getObstacleModule(t));
        if (types.length === 0) return null;
        return (
          <Section key={g.label} title={g.label}>
            <div className="ed-chips">
              {types.map((t) => (
                <PaletteButton
                  key={t}
                  item={{ kind: 'obstacle', type: t }}
                  label={getObstacleModule(t)!.displayName}
                  disabled={readOnly}
                />
              ))}
            </div>
          </Section>
        );
      })}
    </div>
  );
}
