/**
 * Round picker for private shows, grouped by round type. Used by the setup
 * view and, for the host, by the live lobby settings.
 */
import type { JSX } from 'react';
import { playCue } from '../../audio-cues.ts';
import { Icon } from '../../components/icons/index.tsx';
import { useUI } from '../../store/uiStore.ts';
import type { RoundType } from '../../store/types.ts';
import { roundTypeStyle } from '../../theme/tokens.ts';

const TYPE_ORDER: RoundType[] = ['race', 'survival', 'team', 'hunt', 'logic', 'final'];

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
  const all = picked.length === catalog.length;
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
            onChange(all ? [] : catalog.map((r) => r.id));
          }}
        >
          {all ? 'Clear all' : 'Pick all'}
        </button>
      </div>
      <div className="tr-pshow-round-list tr-scroll">
        {TYPE_ORDER.map((type) => {
          const rounds = catalog.filter((r) => r.type === type);
          if (rounds.length === 0) return null;
          const style = roundTypeStyle[type];
          return (
            <div key={type} className="tr-pshow-group" style={{ ['--type' as string]: style.color }}>
              <span className="tr-pshow-group-label">{style.label}</span>
              <div className="tr-row tr-wrap" style={{ gap: '0.35em' }}>
                {rounds.map((r) => {
                  const on = picked.includes(r.id);
                  return (
                    <button
                      key={r.id}
                      type="button"
                      className={`tr-round-pick${on ? ' is-on' : ''}`}
                      aria-pressed={on}
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
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
