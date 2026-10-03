/**
 * Locker: slot rail, rarity filter + search, item grid with try-on/equip,
 * loadouts and the colour/pattern editor. docs/design/SCREENS.md §5.1.
 */
import { useMemo, useState, type JSX } from 'react';
import { playCue } from '../../audio-cues.ts';
import { ItemCard, Panel } from '../../components/bits.tsx';
import { Button, Swatch } from '../../components/controls.tsx';
import { TumblerAvatar } from '../../components/TumblerAvatar.tsx';
import { uiEvents } from '../../store/events.ts';
import { ui, useUI } from '../../store/uiStore.ts';
import {
  COSMETIC_SLOTS,
  RARITIES,
  type CosmeticItem,
  type CosmeticSlot,
  type Loadout,
  type PatternId,
  type Rarity,
  type TumblerColors,
} from '../../store/types.ts';
import { rarityLabels, tumblerSwatches } from '../../theme/tokens.ts';

const SLOT_META: Record<CosmeticSlot, { label: string; icon: string }> = {
  colors: { label: 'Colours', icon: '🎨' },
  pattern: { label: 'Pattern', icon: '🦓' },
  face: { label: 'Face', icon: '😎' },
  upper: { label: 'Upper', icon: '👕' },
  lower: { label: 'Lower', icon: '👖' },
  headwear: { label: 'Headwear', icon: '🎩' },
  back: { label: 'Back', icon: '🎒' },
  emote: { label: 'Emotes', icon: '💃' },
  celebration: { label: 'Celebration', icon: '🎉' },
  victory: { label: 'Victory', icon: '🏆' },
  nameplate: { label: 'Nameplate', icon: '🏷️' },
  banner: { label: 'Banner', icon: '🚩' },
  trail: { label: 'Trail', icon: '✨' },
  footsteps: { label: 'Footsteps', icon: '👣' },
};

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

function isEquipped(loadout: Loadout | undefined, item: CosmeticItem): boolean {
  if (!loadout) return false;
  if (item.slot === 'emote') return loadout.emotes.includes(item.id);
  if (item.slot === 'colors' || item.slot === 'pattern') return false;
  return loadout.items[item.slot] === item.id;
}

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
  const [slot, setSlot] = useState<CosmeticSlot>('headwear');
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
  const selected = items.find((i) => i.id === selectedId) ?? null;
  const editor = slot === 'colors' || slot === 'pattern';

  const tryOn = (item: CosmeticItem): void => {
    setSelectedId(item.id);
    uiEvents.emit('tryOn', { slot: item.slot, itemId: item.id });
  };

  return (
    <div className="tr-locker">
      <Panel tilt={-0.5} className="tr-locker-rail tr-scroll" tight>
        <div role="tablist" aria-label="Slots" className="tr-col" style={{ gap: '0.3em' }}>
          {COSMETIC_SLOTS.map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={s === slot}
              className={`tr-rail-btn${s === slot ? ' is-active' : ''}`}
              data-nav=""
              onClick={() => {
                playCue('ui.tab');
                setSlot(s);
                setSelectedId(null);
                uiEvents.emit('tryOn', { slot: s, itemId: null });
              }}
            >
              <span aria-hidden>{SLOT_META[s].icon}</span>
              <span className="tr-rail-label">{SLOT_META[s].label}</span>
            </button>
          ))}
        </div>
      </Panel>

      <Panel tilt={0.4} delay={60} className="tr-locker-main">
        <div className="tr-panel-head">
          <h2 className="tr-title tr-h3 tr-grow">{SLOT_META[slot].label}</h2>
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
            🎲 Randomize
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
                placeholder="🔎 Search"
                value={query}
                data-nav=""
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search items"
              />
            </div>
            {items.length === 0 ? (
              <div className="tr-empty">
                <span aria-hidden>🕳️</span>
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
                    delay={Math.min(i * 35, 500)}
                    onClick={() => tryOn(item)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </Panel>

      {selected && !editor && (
        <Panel
          key={selected.id}
          tilt={-1}
          enter="right"
          className={`tr-locker-detail tr-item-detail--${selected.rarity}`}
        >
          <div
            className="tr-locker-detail-art"
            style={{ ['--art-a' as string]: selected.art[0], ['--art-b' as string]: selected.art[1] }}
          >
            <span>{selected.icon}</span>
          </div>
          <span className={`tr-rarity-band tr-rarity-band--${selected.rarity}`}>
            {rarityLabels[selected.rarity]}
          </span>
          <h3 className="tr-title tr-h3">{selected.name}</h3>
          {selected.description && <p className="tr-small">{selected.description}</p>}
          {selected.set && <span className="tr-chip">Set: {selected.set}</span>}
          {selected.owned ? (
            isEquipped(loadout, selected) ? (
              <span className="tr-chip tr-chip--mint">✓ Equipped</span>
            ) : (
              <Button
                variant="mint"
                block
                cue="ui.confirm"
                autoFocusNav
                onClick={() => uiEvents.emit('equip', { slot: selected.slot, itemId: selected.id })}
              >
                Equip
              </Button>
            )
          ) : (
            <Button variant="premium" block onClick={() => ui.getState().setMenuTab('store')}>
              Get in Store
            </Button>
          )}
        </Panel>
      )}
    </div>
  );
}
