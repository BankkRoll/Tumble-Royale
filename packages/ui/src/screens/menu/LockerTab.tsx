/**
 * Locker, as a dressing room: the 3D Tumbler on stage at the left, slot chips,
 * rarity filter + search, the grid of owned items (select = live try-on; an
 * empty slot links to the Store, Pass and Shard shop), loadouts, the
 * colour/pattern editor and a docked detail with Equip. docs/design/SCREENS.md §5.1.
 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import { playCue } from '../../audio-cues.ts';
import { ItemCard } from '../../components/bits.tsx';
import { ColorEditor } from '../../components/ColorEditor.tsx';
import { Button } from '../../components/controls.tsx';
import { Icon } from '../../components/icons/index.tsx';
import { uiEvents } from '../../store/events.ts';
import { ui, useUI } from '../../store/uiStore.ts';
import {
  COSMETIC_SLOTS,
  RARITIES,
  SLOT_NAMES,
  type CosmeticItem,
  type CosmeticSlot,
  type Rarity,
} from '../../store/types.ts';
import { rarityLabels } from '../../theme/tokens.ts';
import { DressingRoom, ItemDetail, isEquipped } from './DressingRoom.tsx';

/** Pattern lives in the Skin editor, so it gets no chip of its own. */
const LOCKER_SLOTS = COSMETIC_SLOTS.filter((s) => s !== 'pattern');

/** Deep links to the pattern slot open the Skin editor, which includes it. */
function lockerSlot(slot: CosmeticSlot | null): CosmeticSlot {
  return !slot || slot === 'pattern' ? 'colors' : slot;
}

/** Friendly empty state for a slot the player owns nothing in yet, with ways to get some. */
export function EmptySlot({ slot }: { slot: CosmeticSlot }): JSX.Element {
  const s = ui.getState();
  return (
    <div className="tr-empty tr-locker-empty" data-testid="locker-empty">
      <Icon name="locker" size="2.4em" />
      <b className="tr-title tr-h3">No {SLOT_NAMES[slot]} items yet</b>
      <p className="tr-small tr-muted">
        Your Locker only holds what you own. Pick some up in the Store, unlock them on the Season Pass or
        trade Crown Shards for royal exclusives.
      </p>
      <div className="tr-row tr-wrap" style={{ gap: '0.5em', justifyContent: 'center' }}>
        <Button size="sm" variant="go" onClick={() => s.openStore('catalog')}>
          Browse the Store
        </Button>
        <Button size="sm" variant="premium" onClick={() => s.setMenuTab('pass')}>
          Season Pass
        </Button>
        <Button size="sm" variant="secondary" onClick={() => s.openStore('shards')}>
          Crown Shard shop
        </Button>
      </div>
    </div>
  );
}

/** Locker tab. */
export function LockerTab(): JSX.Element {
  const inv = useUI((s) => s.inventory);
  const deepSlot = useUI((s) => s.lockerSlot);
  const [slot, setSlot] = useState<CosmeticSlot>(() => lockerSlot(deepSlot));
  useEffect(() => {
    if (!deepSlot) return;
    setSlot(lockerSlot(deepSlot));
    ui.setState({ lockerSlot: null });
  }, [deepSlot]);
  const [rarity, setRarity] = useState<Rarity | 'all'>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const loadout = inv?.loadouts[inv.activeLoadout];

  // The Locker is the player's own collection: unowned items live in the Store, Pass and Shard shop.
  const owned = useMemo(() => (inv?.items ?? []).filter((i) => i.owned), [inv]);
  const inSlot = useMemo(() => owned.filter((i) => i.slot === slot), [owned, slot]);
  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return inSlot.filter(
      (i) => (rarity === 'all' || i.rarity === rarity) && (q === '' || i.name.toLowerCase().includes(q)),
    );
  }, [inSlot, rarity, query]);
  const selected = owned.find((i) => i.id === selectedId) ?? null;
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
          {LOCKER_SLOTS.map((s) => (
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
              {s === 'colors' ? 'Skin' : SLOT_NAMES[s]}
            </button>
          ))}
        </div>
        <div className="tr-panel-head">
          <h2 className="tr-title tr-h3 tr-grow">{slot === 'colors' ? 'Skin' : SLOT_NAMES[slot]}</h2>
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
          <ColorEditor
            colors={loadout.colors}
            onChange={(colors) => uiEvents.emit('customizeColors', { colors })}
          />
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

              <input
                className="tr-input tr-search"
                placeholder="Search"
                value={query}
                data-nav=""
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search items"
              />
            </div>
            {inSlot.length === 0 ? (
              <EmptySlot slot={slot} />
            ) : items.length === 0 ? (
              <div className="tr-empty">
                <Icon name="locker" size="2.4em" />
                <p>None of your {SLOT_NAMES[slot]} items match.</p>
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
        />
      )}
    </DressingRoom>
  );
}
