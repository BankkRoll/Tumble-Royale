/**
 * Small building blocks shared by the editor panels: the store context and
 * hook, labelled rows, and inputs that commit on Enter/blur with inline
 * errors.
 */
import { createContext, useContext, useEffect, useState, type JSX, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import type { EditorState } from '../store.ts';

/** The editor store, provided by the app root. */
export const EditorContext = createContext<StoreApi<EditorState> | null>(null);

/**
 * Selects from the editor store.
 *
 * @param selector - Picks the slice a component renders.
 */
export function useEditor<T>(selector: (s: EditorState) => T): T {
  const store = useContext(EditorContext);
  if (!store) throw new Error('useEditor outside <EditorContext.Provider>');
  return useStore(store, selector);
}

/** The store's actions (stable references). */
export function useActions(): EditorState {
  const store = useContext(EditorContext);
  if (!store) throw new Error('useActions outside <EditorContext.Provider>');
  return store.getState();
}

/** A titled panel section. */
export function Section(props: { title: string; children: ReactNode; aside?: ReactNode }): JSX.Element {
  return (
    <section className="ed-section" aria-label={props.title}>
      <header className="ed-section-head">
        <h2>{props.title}</h2>
        {props.aside}
      </header>
      {props.children}
    </section>
  );
}

/** A labelled control row. */
export function Row(props: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
  error?: string | null;
}): JSX.Element {
  return (
    <div className={`ed-row${props.error ? ' ed-row--error' : ''}`}>
      <label htmlFor={props.htmlFor}>{props.label}</label>
      <div className="ed-row-control">
        {props.children}
        {props.error ? (
          <span className="ed-field-error" role="alert">
            {props.error}
          </span>
        ) : null}
      </div>
    </div>
  );
}

let idSeq = 0;
/** A stable id for a label/input pair. */
export function useFieldId(prefix: string): string {
  const [id] = useState(() => `${prefix}-${++idSeq}`);
  return id;
}

/**
 * Text input that keeps its own draft and commits on Enter or blur.
 *
 * @param props.validate - Returns an error for a draft that cannot be committed.
 */
export function DraftInput(props: {
  id?: string;
  value: string;
  onCommit(value: string): void;
  validate?: (value: string) => string | null;
  inputMode?: 'decimal' | 'numeric' | 'text';
  placeholder?: string;
  maxLength?: number;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}): JSX.Element {
  const [draft, setDraft] = useState(props.value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(props.value);
    setError(null);
  }, [props.value]);
  const commit = () => {
    if (draft === props.value) return;
    const e = props.validate?.(draft) ?? null;
    setError(e);
    if (!e) props.onCommit(draft);
  };
  return (
    <>
      <input
        id={props.id}
        className={props.className ?? 'ed-input'}
        value={draft}
        inputMode={props.inputMode}
        placeholder={props.placeholder}
        maxLength={props.maxLength}
        disabled={props.disabled}
        aria-label={props.ariaLabel}
        aria-invalid={error ? true : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            setDraft(props.value);
            setError(null);
          }
        }}
      />
      {error ? (
        <span className="ed-field-error" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}

const numberError = (min?: number, max?: number) => (raw: string) => {
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n)) return 'Enter a number';
  if (min !== undefined && n < min) return `At least ${min}`;
  if (max !== undefined && n > max) return `At most ${max}`;
  return null;
};

/** Number input committing on Enter/blur. */
export function NumberInput(props: {
  id?: string;
  value: number;
  onCommit(value: number): void;
  min?: number;
  max?: number;
  ariaLabel?: string;
  disabled?: boolean;
}): JSX.Element {
  return (
    <DraftInput
      id={props.id}
      value={String(props.value)}
      inputMode="decimal"
      ariaLabel={props.ariaLabel}
      disabled={props.disabled}
      validate={numberError(props.min, props.max)}
      onCommit={(v) => props.onCommit(Number(v))}
      className="ed-input ed-input--num"
    />
  );
}

/** Three number inputs for a vector. */
export function Vec3Input(props: {
  label: string;
  value: { x: number; y: number; z: number };
  onCommit(value: { x: number; y: number; z: number }): void;
  min?: number;
  disabled?: boolean;
}): JSX.Element {
  return (
    <div className="ed-row">
      <span className="ed-row-label">{props.label}</span>
      <div className="ed-vec3">
        {(['x', 'y', 'z'] as const).map((k) => (
          <NumberInput
            key={k}
            value={props.value[k]}
            min={props.min}
            disabled={props.disabled}
            ariaLabel={`${props.label} ${k.toUpperCase()}`}
            onCommit={(n) => props.onCommit({ ...props.value, [k]: n })}
          />
        ))}
      </div>
    </div>
  );
}
