/**
 * Interactive primitives: chunky Button, Toggle, Slider, Segmented picker,
 * Swatch. All play UI cues and are keyboard/gamepad navigable (`data-nav`).
 */
import { useRef, type ButtonHTMLAttributes, type JSX, type ReactNode } from 'react';
import { playCue, type UICueName } from '../audio-cues.ts';
import type { ButtonVariant } from '../store/types.ts';
import { squash } from '../theme/motion.ts';

/** Props for `Button`. */
export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant | 'sky';
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Cue on press (default `ui.click`; `null` = silent). */
  cue?: UICueName | null;
  icon?: ReactNode;
  /** Keyboard/gamepad hint chip, e.g. `Esc`, `Q`. */
  hint?: string;
  block?: boolean;
  /** Focus first when the screen opens (gamepad players press A immediately). */
  autoFocusNav?: boolean;
  children?: ReactNode;
}

/**
 * Chunky sticker button.
 * @example <Button variant="go" size="xl" onClick={play}>Play</Button>
 */
export function Button({
  variant = 'primary',
  size = 'md',
  cue = 'ui.click',
  icon,
  hint,
  block,
  autoFocusNav,
  className,
  onClick,
  onMouseEnter,
  onFocus,
  children,
  ...rest
}: ButtonProps): JSX.Element {
  const ref = useRef<HTMLButtonElement>(null);
  const cls = [
    'tr-btn',
    variant !== 'primary' ? `tr-btn--${variant}` : '',
    size !== 'md' ? `tr-btn--${size}` : '',
    block ? 'tr-btn--block' : '',
    !children && icon ? 'tr-btn--icon' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      ref={ref}
      type="button"
      className={cls}
      data-nav=""
      data-autofocus={autoFocusNav ? '' : undefined}
      onClick={(e) => {
        if (cue) playCue(cue);
        if (ref.current) squash(ref.current, 0.6);
        onClick?.(e);
      }}
      onMouseEnter={(e) => {
        if (!rest.disabled) playCue('ui.hover');
        onMouseEnter?.(e);
      }}
      onFocus={(e) => {
        playCue('ui.hover');
        onFocus?.(e);
      }}
      {...rest}
    >
      {icon}
      {children}
      {hint && <span className="tr-btn-key">{hint}</span>}
    </button>
  );
}

/** Props for `Toggle`. */
export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}

/** On/off switch. */
export function Toggle({ checked, onChange, label, disabled }: ToggleProps): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="tr-toggle tr-interactive"
      data-nav=""
      onClick={() => {
        playCue('ui.toggle');
        onChange(!checked);
      }}
    />
  );
}

/** Props for `Slider`. */
export interface SliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  label: string;
  /** Formats the value label; default percentage of [min,max]. */
  format?: (value: number) => string;
}

/** Candy range slider with value label. */
export function Slider({ value, min, max, step = 0.01, onChange, label, format }: SliderProps): JSX.Element {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="tr-row tr-grow" style={{ gap: '0.8em' }}>
      <input
        className="tr-slider"
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        data-nav=""
        style={{ ['--pct' as string]: `${pct}%` }}
        onChange={(e) => {
          playCue('ui.slider');
          onChange(Number(e.target.value));
        }}
      />
      <span className="tr-chip tr-nowrap" style={{ minWidth: '3.6em', justifyContent: 'center' }}>
        {format ? format(value) : `${Math.round(pct)}%`}
      </span>
    </div>
  );
}

/** Props for `Segmented`. */
export interface SegmentedProps<T extends string | number> {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}

/** Pill segmented control. */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: SegmentedProps<T>): JSX.Element {
  return (
    <div className="tr-seg tr-interactive" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          aria-pressed={o.value === value}
          data-nav=""
          onClick={() => {
            playCue('ui.toggle');
            onChange(o.value);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Props for `Swatch`. */
export interface SwatchProps {
  color: string;
  selected: boolean;
  onSelect: () => void;
  label?: string;
}

/** Round colour swatch button. */
export function Swatch({ color, selected, onSelect, label }: SwatchProps): JSX.Element {
  return (
    <button
      type="button"
      className="tr-swatch"
      aria-pressed={selected}
      aria-label={label ?? color}
      data-nav=""
      style={{ ['--c' as string]: color }}
      onClick={(e) => {
        playCue('ui.click');
        squash(e.currentTarget, 1);
        onSelect();
      }}
    />
  );
}
