/**
 * Collection log (Profile → Collection): every cosmetic in the game, owned
 * or not, with completion overall and for the current filter, filters by
 * slot, rarity and ownership, and a detail panel naming where the selected
 * item comes from (shop, pass tier, achievement, challenge, event…).
 */
import { useMemo, useState, type JSX } from 'react';
import { Bar, ItemCard } from '../../components/bits.tsx';
import { Segmented } from '../../components/controls.tsx';
import { ItemPreview } from '../../components/ItemPreview.tsx';
import { Icon, type IconName } from '../../components/icons/index.tsx';
import { useUI } from '../../store/uiStore.ts';
import {
  COSMETIC_SLOTS,
  RARITIES,
  SLOT_NAMES,
  type CollectionData,
  type CollectionEntryView,
  type CollectionSourceView,
  type CosmeticSlot,
  type Rarity,
} from '../../store/types.ts';
import { rarityLabels } from '../../theme/tokens.ts';

type Owned = 'all' | 'owned' | 'missing';

/** Filters for {@link filterCollection}. */
export interface CollectionFilters {
  slot: CosmeticSlot | 'all';
  rarity: Rarity | 'all';
  owned: Owned;
}

/**
 * The entries matching the filters, and how many of them are owned.
 *
 * @param data - The full log.
 * @param f - Slot, rarity and ownership filters.
 * @example
 * filterCollection(log, { slot: 'headwear', rarity: 'all', owned: 'missing' }).entries;
 */
export function filterCollection(
  data: CollectionData,
  f: CollectionFilters,
): { entries: CollectionEntryView[]; owned: number; total: number } {
  const inScope = data.entries.filter(
    (e) => (f.slot === 'all' || e.item.slot === f.slot) && (f.rarity === 'all' || e.item.rarity === f.rarity),
  );
  return {
    entries: inScope.filter((e) => f.owned === 'all' || e.item.owned === (f.owned === 'owned')),
    owned: inScope.filter((e) => e.item.owned).length,
    total: inScope.length,
  };
}

const SOURCE_ICON: Record<CollectionSourceView['kind'], IconName> = {
  default: 'gift',
  store: 'store',
  pass: 'pass',
  achievement: 'medal',
  challenge: 'challenges',
  event: 'calendar',
  shards: 'crown',
  tutorial: 'flag',
};

function Detail({ e }: { e: CollectionEntryView }): JSX.Element {
  return (
    <aside className="tr-collection-detail" data-testid="collection-detail" aria-live="polite">
      <span className={`tr-collection-detail-art tr-rar-frame tr-rar-frame--${e.item.rarity}`}>
        <ItemPreview item={e.item} className="tr-item-icon" />
      </span>
      <div className="tr-col" style={{ gap: '0.25em', minWidth: 0 }}>
        <b className="tr-title tr-h3 tr-ellipsis">{e.item.name}</b>
        <small className={`tr-rarity-text--${e.item.rarity}`}>
          {SLOT_NAMES[e.item.slot]} · {rarityLabels[e.item.rarity]}
        </small>
        <small className={e.item.owned ? 'tr-collection-owned' : 'tr-muted'}>
          <Icon name={e.item.owned ? 'check' : 'lock'} size="0.9em" />{' '}
          {e.item.owned
            ? e.acquiredAt
              ? `Owned since ${new Date(e.acquiredAt).toLocaleDateString()}`
              : 'Owned'
            : 'Not owned yet'}
        </small>
        <span className="tr-label">Where it comes from</span>
        <ul className="tr-collection-sources">
          {e.sources.map((s, i) => (
            <li key={i} className={`tr-collection-source tr-collection-source--${s.kind}`}>
              <Icon name={SOURCE_ICON[s.kind]} size="1.1em" /> {s.label}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

/** Collection log view. */
export function CollectionView(): JSX.Element {
  const data = useUI((s) => s.collection);
  const [filters, setFilters] = useState<CollectionFilters>({ slot: 'all', rarity: 'all', owned: 'all' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const view = useMemo(() => (data ? filterCollection(data, filters) : null), [data, filters]);
  if (!data || !view) {
    return (
      <div className="tr-panel tr-empty" data-testid="collection-empty">
        Your collection is loading…
      </div>
    );
  }
  const selected = view.entries.find((e) => e.item.id === selectedId) ?? view.entries[0] ?? null;
  const set = (patch: Partial<CollectionFilters>): void => setFilters((f) => ({ ...f, ...patch }));
  const filtered = filters.slot !== 'all' || filters.rarity !== 'all';
  return (
    <div className="tr-panel tr-collection" data-testid="collection">
      <header className="tr-ach-summary">
        <div className="tr-col tr-grow" style={{ gap: '0.3em' }}>
          <h2 className="tr-title tr-h3">Collection</h2>
          <Bar value={data.percent / 100} color="var(--grape)" large label="Collection complete" />
          {filtered && (
            <small className="tr-muted" data-testid="collection-scope">
              This filter: {view.owned} / {view.total}
            </small>
          )}
        </div>
        <span className="tr-ach-count" data-testid="collection-percent">
          <b className="tr-title tr-h2">{data.percent}%</b>
          <small className="tr-muted">
            {data.owned} / {data.total}
          </small>
        </span>
      </header>
      <div className="tr-row tr-wrap tr-ach-filters">
        <label className="tr-collection-select">
          <span className="tr-label">Slot</span>
          <select
            className="tr-input"
            value={filters.slot}
            data-nav=""
            onChange={(ev) => set({ slot: ev.target.value as CollectionFilters['slot'] })}
          >
            <option value="all">All slots</option>
            {COSMETIC_SLOTS.map((s) => (
              <option key={s} value={s}>
                {SLOT_NAMES[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="tr-collection-select">
          <span className="tr-label">Rarity</span>
          <select
            className="tr-input"
            value={filters.rarity}
            data-nav=""
            onChange={(ev) => set({ rarity: ev.target.value as CollectionFilters['rarity'] })}
          >
            <option value="all">All rarities</option>
            {RARITIES.map((r) => (
              <option key={r} value={r}>
                {rarityLabels[r]}
              </option>
            ))}
          </select>
        </label>
        <Segmented<Owned>
          label="Ownership"
          value={filters.owned}
          onChange={(owned) => set({ owned })}
          options={[
            { value: 'all', label: 'All' },
            { value: 'owned', label: 'Owned' },
            { value: 'missing', label: 'Missing' },
          ]}
        />
      </div>
      <div className="tr-collection-body">
        <div className="tr-collection-grid tr-scroll" data-testid="collection-grid">
          {view.entries.length === 0 && <p className="tr-muted tr-empty">No items match these filters.</p>}
          {view.entries.map((e, i) => (
            <ItemCard
              key={e.item.id}
              item={e.item}
              size="sm"
              selected={selected?.item.id === e.item.id}
              delay={Math.min(i, 24) * 12}
              onClick={() => setSelectedId(e.item.id)}
              onFocus={() => setSelectedId(e.item.id)}
            />
          ))}
        </div>
        {selected && <Detail e={selected} />}
      </div>
    </div>
  );
}
