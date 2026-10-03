/**
 * Locker, as a dressing room: the 3D Tumbler on stage at the left, slot chips,
 * rarity filter + search, the item grid (select = live try-on), loadouts, the
 * colour/pattern editor and a docked detail with Equip. docs/design/SCREENS.md §5.1.
 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import { playCue } from '../../audio-cues.ts';
import { ItemCard } from '../../components/bits.tsx';
import { Button, Swatch } from '../../components/controls.tsx';
import { TumblerAvatar } from '../../components/TumblerAvatar.tsx';
import { Icon } from '../../components/icons/index.tsx';
import { uiEvents } from '../../store/events.ts';
import { ui, useUI } from '../../store/uiStore.ts';
import {
  COSMETIC_SLOTS,
  RARITIES,
  SLOT_NAMES,
  type CosmeticItem,
  type CosmeticSlot,
  type PatternId,
  type Rarity,
  type TumblerColors,
} from '../../store/types.ts';
import { rarityLabels, tumblerSwatches } from '../../theme/tokens.ts';
import { DressingRoom, ItemDetail, isEquipped } from './DressingRoom.tsx';

const PATTERN_IDS: PatternId[] = [
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

function ColorEditor({ colors, patternOnly }: { colors: TumblerColors; patternOnly: boolean }): JSX.Element {
  const set = (patch: Partial<TumblerColors>): void =>
    uiEvents.emit('customizeColors', { colors: { ...colors, ...patch } });
  const rows: { key: 'primary' | 'secondary' | 'tertiary'; label: string }[] = [
    { key: 'primary', label: 'Main colour' },
    { key: 'secondary', label: 'Pattern colour' },
    { key: 'tertiary', label: 'Face plate' },
  ];
  return (
    <div className="tr-col tr-color-editor" style={{ gap: '1em' }}>
      {!patternOnly &&
        rows.map((r) => (
          <div key={r.key} className="tr-col" style={{ gap: '0.4em' }}>
            <span className="tr-label">{r.label}</span>
            <div className="tr-swatch-grid tr-swatch-grid--wide">
              {(r.key === 'tertiary'
                ? ['#fff7ea', '#ffffff', '#ffe8a3', '#d8f7ff', '#ffd6f2', '#2b1a5e']
                : tumblerSwatches
              ).map((c) => (
                <Swatch
                  key={c}
                  color={c}
                  selected={(colors[r.key] ?? '#fff7ea') === c}
                  onSelect={() => set({ [r.key]: c })}
                />
              ))}
            </div>
          </div>
        ))}
      <div className="tr-col" style={{ gap: '0.4em' }}>
        <span className="tr-label">Pattern</span>
        <div className="tr-pattern-grid">
          {PATTERN_IDS.map((p) => (
            <button
              key={p}
              type="button"
              className={`tr-pattern-tile${colors.pattern === p ? ' is-on' : ''}`}
              aria-pressed={colors.pattern === p}
              data-nav=""
              onClick={() => set({ pattern: p })}
            >
              <TumblerAvatar colors={{ ...colors, pattern: p }} size="3em" blink={false} noShadow />
              <small>{p}</small>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Locker tab. */
export function LockerTab(): JSX.Element {
  const inv = useUI((s) => s.inventory);
  const deepSlot = useUI((s) => s.lockerSlot);
  const [slot, setSlot] = useState<CosmeticSlot>(() => deepSlot ?? 'headwear');
  useEffect(() => {
    if (!deepSlot) return;
    setSlot(deepSlot);
    ui.setState({ lockerSlot: null });
  }, [deepSlot]);
  const [rarity, setRarity] = useState<Rarity | 'all'>('all');
  const [ownedOnly, setOwnedOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const loadout = inv?.loadouts[inv.activeLoadout];

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (inv?.items ?? []).filter(
      (i) =>
        i.slot === slot &&
        (rarity === 'all' || i.rarity === rarity) &&
        (!ownedOnly || i.owned) &&
        (q === '' || i.name.toLowerCase().includes(q)),
    );
  }, [inv, slot, rarity, ownedOnly, query]);
  const selected = (inv?.items ?? []).find((i) => i.id === selectedId) ?? null;
  const editor = slot === 'colors' || slot === 'pattern';

  const tryOn = (item: CosmeticItem): void => {
    playCue('ui.click');
    setSelectedId(item.id);
    uiEvents.emit('tryOn', { slot: item.slot, itemId: item.id });
  };
  const reset = (): void => {
    setSelectedId(null);
    uiEvents.emit('tryOn', { slot, itemId: null });
  };
  const tryingOn = selected && !isEquipped(loadout, selected) ? selected.name : null;

  return (
    <DressingRoom className="tr-locker" tryingOn={tryingOn} onReset={reset}>
      <div className="tr-panel tr-locker-shelf">
        <div className="tr-slot-chips tr-scroll-x" role="tablist" aria-label="Slots">
          {COSMETIC_SLOTS.map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={s === slot}
              className={`tr-slot-chip${s === slot ? ' is-active' : ''}`}
              data-nav=""
              onClick={() => {
                playCue('ui.tab');
                setSlot(s);
                setSelectedId(null);
                uiEvents.emit('tryOn', { slot: s, itemId: null });
              }}
            >
              {SLOT_NAMES[s]}
            </button>
          ))}
        </div>
        <div className="tr-panel-head">
          <h2 className="tr-title tr-h3 tr-grow">{SLOT_NAMES[slot]}</h2>
          {inv && (
            <div className="tr-row tr-loadouts" aria-label="Loadouts">
              {inv.loadouts.map((l, i) => (
                <button
                  key={i}
                  type="button"
                  className={`tr-loadout${i === inv.activeLoadout ? ' is-active' : ''}`}
                  data-nav=""
                  title={l.name}
                  onClick={() => {
                    playCue('ui.click');
                    uiEvents.emit('selectLoadout', { index: i });
                  }}
                >
                  {i + 1}
                </button>
              ))}
            </div>
          )}
          <Button size="sm" variant="sky" cue="ui.confirm" onClick={() => uiEvents.emit('randomizeOutfit')}>
            <Icon name="dice" size="1.1em" /> Randomize
          </Button>
        </div>
        {editor && loadout ? (
          <ColorEditor colors={loadout.colors} patternOnly={slot === 'pattern'} />
        ) : (
          <>
            <div className="tr-row tr-wrap tr-locker-filters">
              <div className="tr-seg" role="group" aria-label="Rarity">
                <button
                  type="button"
                  aria-pressed={rarity === 'all'}
                  data-nav=""
                  onClick={() => setRarity('all')}
                >
                  All
                </button>
                {RARITIES.map((r) => (
                  <button
                    key={r}
                    type="button"
                    aria-pressed={rarity === r}
                    data-nav=""
                    className={`tr-rarity-chip tr-rarity-chip--${r}`}
                    onClick={() => setRarity(r)}
                  >
                    {rarityLabels[r]}
                  </button>
                ))}
              </div>
              <label className="tr-row tr-small" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={ownedOnly}
                  data-nav=""
                  onChange={(e) => setOwnedOnly(e.target.checked)}
                />{' '}
                Owned only
              </label>
              <input
                className="tr-input tr-search"
                placeholder="Search"
                value={query}
                data-nav=""
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search items"
              />
            </div>
            {items.length === 0 ? (
              <div className="tr-empty">
                <Icon name="locker" size="2.4em" />
                <p>No matches. Try “cone” or “disco”.</p>
              </div>
            ) : (
              <div className="tr-item-grid tr-scroll">
                {items.map((item, i) => (
                  <ItemCard
                    key={item.id}
                    item={item}
                    selected={item.id === selectedId}
                    equipped={isEquipped(loadout, item)}
                    delay={Math.min(i * 25, 300)}
                    onClick={() => tryOn(item)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
      {selected && !editor && (
        <ItemDetail
          item={selected}
          equipped={isEquipped(loadout, selected)}
          onEquip={() => uiEvents.emit('equip', { slot: selected.slot, itemId: selected.id })}
          onGetInStore={() => ui.getState().setMenuTab('store')}
        />
      )}
    </DressingRoom>
  );
}
