/**
 * Round picker for private shows, grouped by round type, plus shared custom
 * rounds added by share code. Used by the setup view and, for the host, by
 * the live lobby settings.
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import { playCue } from '../../audio-cues.ts';
import { Icon } from '../../components/icons/index.tsx';
import { Button } from '../../components/controls.tsx';
import { uiEvents } from '../../store/events.ts';
import { useUI } from '../../store/uiStore.ts';
import type { CustomRoundLookup, RoundType } from '../../store/types.ts';
import { roundTypeStyle } from '../../theme/tokens.ts';

const TYPE_ORDER: RoundType[] = ['race', 'survival', 'team', 'hunt', 'logic', 'final'];

/** Most picks a private show takes (the matchmaker's limit). */
const MAX_PICKS = 10;

/**
 * Display name of a picked round: the catalogue's name, or "Custom round
 * CODE" for a shared round this player has not looked up.
 *
 * @param id - Round id.
 * @param catalog - Rounds the pickers know.
 */
export function roundName(id: string, catalog: readonly { id: string; name: string }[]): string {
  const known = catalog.find((r) => r.id === id)?.name;
  if (known) return known;
  return id.startsWith('custom:') ? `Custom round ${id.slice(7)}` : id;
}

/**
 * One-line status under the code field.
 *
 * @param lookup - Last lookup.
 * @param name - Name of the round it found, when it did.
 * @returns The message, or null when there is nothing to say.
 */
export function lookupMessage(lookup: CustomRoundLookup, name?: string): string | null {
  switch (lookup.status) {
    case 'loading':
      return `Looking up ${lookup.code}…`;
    case 'ok':
      return `Added ${name ?? lookup.code}`;
    case 'error':
      return lookup.message;
    default:
      return null;
  }
}

/**
 * "Custom round by code": a code field that asks the game to look the round
 * up; a found round is picked automatically.
 *
 * @param props.picked - Current picks.
 * @param props.onPick - Adds a round id to the picks.
 */
export function CustomRoundByCode({
  picked,
  onPick,
}: {
  picked: string[];
  onPick: (id: string) => void;
}): JSX.Element {
  const [code, setCode] = useState('');
  const lookup = useUI((s) => s.customRoundLookup);
  const catalog = useUI((s) => s.roundCatalog);
  const pending = useRef<string | null>(null);
  useEffect(() => {
    if (lookup.status !== 'ok' || pending.current !== lookup.code) return;
    pending.current = null;
    if (!picked.includes(lookup.id)) onPick(lookup.id);
    setCode('');
  }, [lookup, picked, onPick]);
  const submit = () => {
    const c = code.trim();
    if (!c) return;
    pending.current = c.toUpperCase().replace(/[\s-]+/g, '');
    uiEvents.emit('customRoundLookup', { code: c });
  };
  const found = lookup.status === 'ok' ? catalog.find((r) => r.id === lookup.id) : undefined;
  const message = lookupMessage(lookup, found?.name);
  return (
    <form
      className="tr-pshow-roundcode"
      aria-label="Custom round by code"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="tr-label" htmlFor="tr-custom-round-code">
        Custom round by code
      </label>
      <div className="tr-row" style={{ gap: '0.35em' }}>
        <input
          id="tr-custom-round-code"
          className="tr-input tr-grow"
          value={code}
          maxLength={12}
          placeholder="e.g. K7MQ2X9A"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setCode(e.target.value)}
          data-nav=""
        />
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          disabled={lookup.status === 'loading' || code.trim() === '' || picked.length >= MAX_PICKS}
        >
          Add
        </Button>
      </div>
      {message ? (
        <p
          className={lookup.status === 'error' ? 'tr-field-error' : 'tr-small tr-muted'}
          role={lookup.status === 'error' ? 'alert' : 'status'}
        >
          {message}
        </p>
      ) : null}
    </form>
  );
}

/**
 * Toggleable round chips with a pick-all/clear-all shortcut.
 *
 * @param picked - Selected round ids, in play order.
 * @param onChange - Called with the new selection.
 */
export function RoundPicker({
  picked,
  onChange,
}: {
  picked: string[];
  onChange: (rounds: string[]) => void;
}): JSX.Element {
  const catalog = useUI((s) => s.roundCatalog);
  const builtIn = catalog.filter((r) => !r.custom);
  const custom = catalog.filter((r) => r.custom);
  const all = builtIn.every((r) => picked.includes(r.id)) && builtIn.length > 0;
  const chip = (r: (typeof catalog)[number]) => {
    const on = picked.includes(r.id);
    return (
      <button
        key={r.id}
        type="button"
        className={`tr-round-pick${on ? ' is-on' : ''}`}
        aria-pressed={on}
        title={r.author ? `by ${r.author}` : undefined}
        data-nav=""
        onClick={() => {
          playCue('ui.toggle');
          onChange(on ? picked.filter((x) => x !== r.id) : [...picked, r.id]);
        }}
      >
        {on ? <Icon name="check" size="0.85em" /> : null}
        {r.name}
      </button>
    );
  };
  return (
    <section className="tr-pshow-rounds" aria-label="Rounds">
      <div className="tr-pshow-section-head">
        <span className="tr-label tr-grow">
          Rounds <b className="tr-pshow-count">{picked.length}</b>
          <span className="tr-muted"> / {catalog.length}</span>
        </span>
        <button
          type="button"
          className="tr-link-btn"
          data-nav=""
          onClick={() => {
            playCue('ui.toggle');
            onChange(
              all
                ? picked.filter((id) => custom.some((r) => r.id === id))
                : [...builtIn.map((r) => r.id), ...picked.filter((id) => custom.some((r) => r.id === id))],
            );
          }}
        >
          {all ? 'Clear all' : 'Pick all'}
        </button>
      </div>
      <div className="tr-pshow-round-list tr-scroll">
        {TYPE_ORDER.map((type) => {
          const rounds = builtIn.filter((r) => r.type === type);
          if (rounds.length === 0) return null;
          const style = roundTypeStyle[type];
          return (
            <div key={type} className="tr-pshow-group" style={{ ['--type' as string]: style.color }}>
              <span className="tr-pshow-group-label">{style.label}</span>
              <div className="tr-row tr-wrap" style={{ gap: '0.35em' }}>
                {rounds.map(chip)}
              </div>
            </div>
          );
        })}
        {custom.length > 0 ? (
          <div className="tr-pshow-group tr-pshow-group--custom" data-testid="custom-round-group">
            <span className="tr-pshow-group-label">Custom</span>
            <div className="tr-row tr-wrap" style={{ gap: '0.35em' }}>
              {custom.map(chip)}
            </div>
          </div>
        ) : null}
      </div>
      <CustomRoundByCode
        picked={picked}
        onPick={(id) => {
          if (picked.length < MAX_PICKS) onChange([...picked, id]);
        }}
      />
    </section>
  );
}
