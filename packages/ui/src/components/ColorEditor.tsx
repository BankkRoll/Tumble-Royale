/**
 * Tumbler skin editor shared by the welcome screen and the locker: one
 * segmented picker for which part to paint (body, pattern, face plate), its
 * swatches plus a custom colour, then every pattern previewed in the current
 * colours.
 */
import { useState, type JSX } from 'react';
import { playCue } from '../audio-cues.ts';
import type { PatternId, TumblerColors } from '../store/types.ts';
import { tumblerSwatches } from '../theme/tokens.ts';
import { Swatch } from './controls.tsx';
import { TumblerAvatar } from './TumblerAvatar.tsx';

/** Every skin pattern, in picker order. */
export const PATTERN_IDS: readonly PatternId[] = [
  'plain',
  'stripes',
  'dots',
  'checker',
  'zigzag',
  'stars',
  'gradient',
  'galaxy',
  'camo',
];

type Part = 'primary' | 'secondary' | 'tertiary';

const PARTS: { key: Part; label: string }[] = [
  { key: 'primary', label: 'Body' },
  { key: 'secondary', label: 'Pattern' },
  { key: 'tertiary', label: 'Face' },
];

const FACE_SWATCHES: readonly string[] = [
  '#fff7ea',
  '#ffffff',
  '#ffe8a3',
  '#d8f7ff',
  '#ffd6f2',
  '#e8ffe0',
  '#2b1a5e',
];
const DEFAULT_FACE = '#fff7ea';

/** Props for {@link ColorEditor}. */
export interface ColorEditorProps {
  colors: TumblerColors;
  onChange: (colors: TumblerColors) => void;
  /** Pattern tile preview size (CSS length). */
  tileSize?: string;
}

/**
 * Body / pattern / face colours and the pattern picker.
 *
 * @example
 * <ColorEditor colors={colors} onChange={setColors} />
 */
export function ColorEditor({ colors, onChange, tileSize = '2.8em' }: ColorEditorProps): JSX.Element {
  const [part, setPart] = useState<Part>('primary');
  const set = (patch: Partial<TumblerColors>): void => onChange({ ...colors, ...patch });
  const current = colors[part] ?? DEFAULT_FACE;
  const swatches = part === 'tertiary' ? FACE_SWATCHES : tumblerSwatches;
  const custom = !swatches.includes(current);
  return (
    <div className="tr-color-editor">
      <section className="tr-col" style={{ gap: '0.5em' }} aria-label="Colours">
        <div className="tr-seg tr-color-parts" role="group" aria-label="Part to colour">
          {PARTS.map((p) => (
            <button
              key={p.key}
              type="button"
              aria-pressed={p.key === part}
              data-nav=""
              onClick={() => {
                playCue('ui.toggle');
                setPart(p.key);
              }}
            >
              <i
                className="tr-color-part-dot"
                style={{ background: colors[p.key] ?? DEFAULT_FACE }}
                aria-hidden
              />
              {p.label}
            </button>
          ))}
        </div>
        <div className="tr-swatch-grid tr-swatch-grid--wide">
          {swatches.map((c) => (
            <Swatch key={c} color={c} selected={current === c} onSelect={() => set({ [part]: c })} />
          ))}
          <label
            className={`tr-swatch tr-swatch--custom${custom ? ' is-on' : ''}`}
            style={{ ['--c' as string]: custom ? current : undefined }}
            title="Custom colour"
          >
            <input
              type="color"
              value={current}
              aria-label={`Custom ${PARTS.find((p) => p.key === part)?.label.toLowerCase()} colour`}
              data-nav=""
              onChange={(e) => set({ [part]: e.target.value })}
            />
          </label>
        </div>
      </section>
      <section className="tr-col" style={{ gap: '0.5em' }} aria-label="Pattern">
        <span className="tr-label">Pattern</span>
        <div className="tr-pattern-grid">
          {PATTERN_IDS.map((p) => (
            <button
              key={p}
              type="button"
              className={`tr-pattern-tile${colors.pattern === p ? ' is-on' : ''}`}
              aria-pressed={colors.pattern === p}
              data-nav=""
              onClick={() => {
                playCue('ui.click');
                set({ pattern: p });
              }}
            >
              <TumblerAvatar colors={{ ...colors, pattern: p }} size={tileSize} blink={false} noShadow />
              <small>{p}</small>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
