/**
 * The dressing room: the layout Store and Locker share. The left ~40% (top
 * on phones) is a clear stage where the game frames the real 3D lobby Tumbler
 * (`dressingRoom` intent); dragging there spins it, wheel/pinch zooms
 * (`turntable` intent). Items, filters and the docked item detail live in the
 * side column, so nothing opaque ever covers the character.
 *
 * Esc / gamepad B closes back to the Play tab; leaving restores the equipped
 * look (the game handles `dressingRoom { active: false }`).
 */
import { useEffect, useRef, type JSX, type ReactNode } from 'react';
import { playCue } from '../../audio-cues.ts';
import { Button } from '../../components/controls.tsx';
import { ItemArt, Price } from '../../components/bits.tsx';
import { uiEvents } from '../../store/events.ts';
import { ui, useUI } from '../../store/uiStore.ts';
import { SLOT_NAMES, type CosmeticItem, type Currency, type Loadout } from '../../store/types.ts';
import { rarityLabels } from '../../theme/tokens.ts';
import { Icon } from '../../components/icons/index.tsx';

/**
 * Mounted dressing rooms. Tabs cross-fade, so the outgoing Store can unmount
 * after the incoming Locker mounted; the stage only closes when the last one goes.
 */
let dressingMounts = 0;

/**
 * Whether an item is part of a loadout (colours/patterns are free-form, never "equipped").
 *
 * @param loadout - Active loadout.
 * @param item - Item.
 */
export function isEquipped(loadout: Loadout | undefined, item: CosmeticItem): boolean {
  if (!loadout) return false;
  if (item.slot === 'emote') return loadout.emotes.includes(item.id);
  if (item.slot === 'colors' || item.slot === 'pattern') return false;
  return loadout.items[item.slot] === item.id;
}

/** Slots whose try-on is an animation rather than a look. */
const ANIMATED = new Set(['emote', 'celebration', 'victory']);

/** Stage drag/zoom → `turntable` intents, coalesced to one per animation frame. */
function useTurntable(): {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onWheel: (e: React.WheelEvent) => void;
} {
  const acc = useRef({ rotate: 0, zoom: 0, raf: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef(0);
  const flush = (): void => {
    const a = acc.current;
    if (a.raf) return;
    a.raf = requestAnimationFrame(() => {
      a.raf = 0;
      if (a.rotate !== 0 || a.zoom !== 0) uiEvents.emit('turntable', { rotate: a.rotate, zoom: a.zoom });
      a.rotate = 0;
      a.zoom = 0;
    });
  };
  useEffect(() => () => cancelAnimationFrame(acc.current.raf), []);
  return {
    onPointerDown: (e) => {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      pinch.current = 0;
    },
    onPointerMove: (e) => {
      const p = pointers.current.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      p.x = e.clientX;
      p.y = e.clientY;
      if (pointers.current.size >= 2) {
        const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch.current > 0) acc.current.zoom += (d - pinch.current) / 60;
        pinch.current = d;
      } else acc.current.rotate += dx * 0.012;
      flush();
    },
    onPointerUp: (e) => {
      pointers.current.delete(e.pointerId);
      pinch.current = 0;
    },
    onWheel: (e) => {
      acc.current.zoom += e.deltaY < 0 ? 1 : -1;
      flush();
    },
  };
}

/** Props for {@link DressingRoom}. */
export interface DressingRoomProps {
  /** Side column content (items, filters, detail). */
  children: ReactNode;
  /** Name of the item being previewed, or null when the equipped look shows. */
  tryingOn: string | null;
  /** Restores the equipped look. */
  onReset: () => void;
  className?: string;
  /** Docked under the Tumbler inside the stage (e.g. the pass reward preview). */
  stageFooter?: ReactNode;
}

/** Store/Locker layout with the 3D stage area. */
export function DressingRoom({
  children,
  tryingOn,
  onReset,
  className = '',
  stageFooter,
}: DressingRoomProps): JSX.Element {
  const turntable = useTurntable();
  useEffect(() => {
    if (dressingMounts++ === 0) uiEvents.emit('dressingRoom', { active: true });
    const onKey = (e: KeyboardEvent): void => {
      const s = ui.getState();
      if (e.code !== 'Escape' || s.dialog || s.overlay !== 'none' || s.screen !== 'menu') return;
      e.preventDefault();
      playCue('ui.back');
      s.setMenuTab('play');
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (--dressingMounts === 0) uiEvents.emit('dressingRoom', { active: false });
    };
  }, []);
  return (
    <div className={`tr-dressing ${className}`}>
      <div
        className="tr-dressing-stage tr-interactive"
        aria-label="Your Tumbler — drag to spin, scroll to zoom"
        onPointerDown={turntable.onPointerDown}
        onPointerMove={turntable.onPointerMove}
        onPointerUp={turntable.onPointerUp}
        onPointerCancel={turntable.onPointerUp}
        onWheel={turntable.onWheel}
      >
        <div className="tr-dressing-chips">
          {tryingOn ? (
            <>
              <span className="tr-chip tr-chip--grape tr-enter-pop" data-testid="trying-on">
                Trying on: {tryingOn}
              </span>
              <Button size="sm" variant="secondary" cue="ui.back" onClick={onReset}>
                <Icon name="refresh" size="1em" /> Reset
              </Button>
            </>
          ) : (
            <span className="tr-chip tr-chip--ink">Your look</span>
          )}
        </div>
        {stageFooter ?? (
          <span className="tr-dressing-hint tr-small" aria-hidden>
            Drag to spin · Scroll to zoom
          </span>
        )}
      </div>
      <div className="tr-dressing-side">{children}</div>
    </div>
  );
}

/** Props for {@link ItemDetail}. */
export interface ItemDetailProps {
  item: CosmeticItem;
  equipped: boolean;
  /** Store price when the item is for sale. */
  price?: { currency: Currency | 'crownShards'; amount: number; original?: number };
  /** Why the item can't be bought right now (e.g. Gems coming soon). */
  priceNote?: string;
  canAfford?: boolean;
  onBuy?: () => void;
  onEquip: () => void;
  /** Locker: unowned items link to the store. */
  onGetInStore?: () => void;
  /** Bundle contents. */
  bundle?: CosmeticItem[];
}

/** Docked item detail (never a modal over the stage). */
export function ItemDetail({
  item,
  equipped,
  price,
  priceNote,
  canAfford = true,
  onBuy,
  onEquip,
  onGetInStore,
  bundle,
}: ItemDetailProps): JSX.Element {
  return (
    <div key={item.id} className={`tr-panel tr-item-detail tr-item-detail--${item.rarity} tr-enter-pop`}>
      <div
        className="tr-item-detail-art"
        style={{ ['--art-a' as string]: item.art[0], ['--art-b' as string]: item.art[1] }}
      >
        <ItemArt item={item} />
      </div>
      <div className="tr-col tr-grow" style={{ gap: '0.3em', minWidth: 0 }}>
        <span className={`tr-rarity-band tr-rarity-band--${item.rarity}`}>{rarityLabels[item.rarity]}</span>
        <span className="tr-chip">{SLOT_NAMES[item.slot]}</span>
        <b className="tr-title tr-h3 tr-ellipsis">{item.name}</b>
        {item.description && <span className="tr-small tr-muted tr-clamp-2">{item.description}</span>}
        {ANIMATED.has(item.slot) && <span className="tr-small">Playing on your Tumbler</span>}
        {bundle && bundle.length > 0 && (
          <div className="tr-row tr-wrap">
            {bundle.map((b) => (
              <span key={b.id} className="tr-chip tr-small">
                {b.name}
              </span>
            ))}
          </div>
        )}
        <div className="tr-row tr-wrap" style={{ gap: '0.5em' }}>
          {item.owned ? (
            equipped ? (
              <span className="tr-chip tr-chip--mint">
                <Icon name="check" size="0.9em" /> Equipped
              </span>
            ) : (
              <Button size="sm" variant="mint" cue="ui.confirm" onClick={onEquip}>
                {price ? 'Equip now' : 'Equip'}
              </Button>
            )
          ) : price ? (
            <>
              <Price
                currency={price.currency}
                amount={price.amount}
                {...(price.original !== undefined ? { original: price.original } : {})}
              />
              <Button size="sm" variant="go" disabled={!canAfford || !onBuy} onClick={onBuy}>
                Buy
              </Button>
              {priceNote && <span className="tr-small tr-muted">{priceNote}</span>}
            </>
          ) : onGetInStore ? (
            <Button size="sm" variant="premium" onClick={onGetInStore}>
              Find in Store
            </Button>
          ) : (
            <span className="tr-chip">
              <Icon name="lock" size="1em" /> Earn it from the Season Pass or challenges
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** The loadout currently equipped (for equipped badges). */
export function useActiveLoadout(): Loadout | undefined {
  return useUI((s) => s.inventory?.loadouts[s.inventory.activeLoadout]);
}
