/**
 * One preview for every cosmetic and reward, used by the Locker, Store, Crown
 * Shard shop, Season Pass, item details and the rewards screen so they all
 * read the same way.
 *
 * Responsibilities:
 * - Body items (skins, faces, wearables) and animations show the player's own
 *   Tumbler — their active loadout with the item applied — using the game's
 *   3D thumbnail when it has one, else a 2D portrait in the wearer's colours.
 * - Emotes, celebrations and victory poses get a pose and a motion badge.
 * - Nameplates and banners render as the real plate/banner with the
 *   player's name; trails and footsteps get a swatch in the item's colours.
 * - Currency and XP rewards render as one consistent amount card.
 */
import { useEffect, type CSSProperties, type JSX } from 'react';
import { uiEvents } from '../store/events.ts';
import { useUI } from '../store/uiStore.ts';
import type {
  AvatarHat,
  CosmeticItem,
  CosmeticSlot,
  Currency,
  FaceExpression,
  ProfileBanner,
  ProfileNameplate,
  Rarity,
  TumblerColors,
} from '../store/types.ts';
import { rarityColors } from '../theme/tokens.ts';
import { formatNumber } from './hooks.ts';
import { Icon } from './icons/index.tsx';
import { TumblerAvatar, type AvatarPose } from './TumblerAvatar.tsx';

// -----------------------------------------------------------------------------
// Wearer
// -----------------------------------------------------------------------------

/** The Tumbler previews are drawn on. */
export interface Wearer {
  colors: TumblerColors;
  hat: AvatarHat;
  /** Shown on nameplate and banner previews. */
  name: string;
}

const FALLBACK_COLORS: TumblerColors = {
  primary: '#ff6fb5',
  secondary: '#ffd23f',
  tertiary: '#7c5cff',
  pattern: 'plain',
};

/**
 * The player's current look: the active loadout's colours and hat, falling
 * back to the profile, then to the starter colours.
 *
 * @returns The wearer for previews.
 */
export function useWearer(): Wearer {
  const colors = useUI(
    (s) => s.inventory?.loadouts[s.inventory.activeLoadout]?.colors ?? s.profile?.colors ?? FALLBACK_COLORS,
  );
  const hat = useUI((s) => {
    const inv = s.inventory;
    const id = inv?.loadouts[inv.activeLoadout]?.items.headwear;
    const look = id ? inv?.items.find((i) => i.id === id)?.look : undefined;
    return look?.kind === 'wearable' ? (look.hat ?? 'none') : (s.profile?.hat ?? 'none');
  });
  const name = useUI((s) => s.profile?.name ?? 'You');
  return { colors, hat, name };
}

// -----------------------------------------------------------------------------
// Thumbnails
// -----------------------------------------------------------------------------

const requested = new Set<string>();
let pending: string[] = [];
let flushQueued = false;

/** Batches thumbnail requests from every preview mounted in the same tick into one intent. */
function requestThumbnail(id: string): void {
  // Deduplicate within one batch only: the renderer may evict (LRU) and needs a re-request later.
  if (requested.has(id)) return;
  requested.add(id);
  pending.push(id);
  if (flushQueued) return;
  flushQueued = true;
  queueMicrotask(() => {
    flushQueued = false;
    const ids = pending;
    pending = [];
    requested.clear();
    if (ids.length > 0) uiEvents.emit('needThumbnails', { ids });
  });
}

/** Slots drawn on the Tumbler's body (3D thumbnail or 2D portrait). */
const BODY_SLOTS = new Set<CosmeticSlot>([
  'colors',
  'pattern',
  'face',
  'upper',
  'lower',
  'headwear',
  'back',
  'emote',
  'celebration',
  'victory',
]);
/** Slots that are an animation rather than a look. */
export const MOTION_SLOTS: ReadonlySet<CosmeticSlot> = new Set(['emote', 'celebration', 'victory']);

/** Clip → 2D pose and expression for the portrait fallback. */
const CLIP_POSE: Readonly<Record<string, [AvatarPose, FaceExpression]>> = {
  wave: ['wave', 'happy'],
  dance: ['armsUp', 'grin'],
  laugh: ['hips', 'grin'],
  flex: ['flex', 'determined'],
  facepalm: ['facepalm', 'sad'],
  spin: ['spin', 'dizzy'],
  'jumping-jacks': ['armsUp', 'happy'],
  bow: ['bow', 'sleepy'],
  shrug: ['shrug', 'happy'],
  cheer: ['armsUp', 'cheer'],
  'fist-pump': ['wave', 'determined'],
  backflip: ['spin', 'grin'],
  'victory-superstar': ['armsUp', 'cheer'],
  'victory-hero': ['hips', 'determined'],
  'victory-twirl': ['spin', 'grin'],
};

/** Neutral rarity-tinted Tumbler silhouette, for previews of items with no look data. */
export function ItemSilhouette({
  rarity = 'common',
  className,
}: {
  rarity?: Rarity;
  className?: string;
}): JSX.Element {
  const c = rarityColors[rarity];
  return (
    <svg className={`tr-item-silhouette${className ? ` ${className}` : ''}`} viewBox="0 0 40 48" aria-hidden>
      <path
        d="M9 44c-1.5 0-2.5-1.2-2.3-2.7C8 28 10 6 20 6s12 22 13.3 35.3c.2 1.5-.8 2.7-2.3 2.7z"
        fill={c}
        opacity=".6"
      />
      <ellipse cx="20" cy="20" rx="7.5" ry="6" fill="#fff" opacity=".6" />
    </svg>
  );
}

// -----------------------------------------------------------------------------
// Nameplates & banners
// -----------------------------------------------------------------------------

/**
 * CSS background for a banner motif.
 *
 * @param b - Banner art (defaults to the starter confetti banner).
 */
export function bannerStyle(b: Omit<ProfileBanner, 'name'> | undefined): CSSProperties {
  const [a, c, d] = b?.colors ?? ['#ff6fb5', '#ffd23f', '#5ce1e6'];
  const motif: Record<ProfileBanner['motif'], string> = {
    confetti: `radial-gradient(circle at 20% 30%, ${c} 0 6%, transparent 7%), radial-gradient(circle at 70% 60%, ${d} 0 5%, transparent 6%), radial-gradient(circle at 45% 80%, #fff 0 4%, transparent 5%), radial-gradient(circle at 85% 20%, ${c} 0 4%, transparent 5%)`,
    clouds: `radial-gradient(ellipse 30% 40% at 25% 70%, ${d} 0 60%, transparent 61%), radial-gradient(ellipse 25% 35% at 70% 40%, ${d} 0 60%, transparent 61%)`,
    stripes: `repeating-linear-gradient(115deg, transparent 0 18px, ${c}55 18px 36px)`,
    stars: `radial-gradient(circle at 15% 25%, ${d} 0 2%, transparent 3%), radial-gradient(circle at 55% 70%, ${d} 0 2.5%, transparent 3.5%), radial-gradient(circle at 80% 35%, #fff 0 2%, transparent 3%), radial-gradient(circle at 35% 55%, #fff 0 1.5%, transparent 2.5%)`,
    candy: `radial-gradient(circle at 20% 40%, ${c} 0 9%, transparent 10%), radial-gradient(circle at 75% 55%, ${d} 0 8%, transparent 9%)`,
    waves: `repeating-radial-gradient(circle at 50% 140%, ${c}66 0 14px, transparent 14px 28px)`,
  };
  return { background: `${motif[b?.motif ?? 'confetti']}, linear-gradient(135deg, ${a}, ${c})` };
}

/**
 * Name#tag in a nameplate's style.
 *
 * @example
 * <Nameplate name="Sprinkles" tag="1234" plate={profile.nameplate} />
 */
export function Nameplate({
  name,
  tag,
  plate,
}: {
  name: string;
  tag?: string;
  plate?: Omit<ProfileNameplate, 'name'>;
}): JSX.Element {
  const style = plate
    ? ({
        ['--np-bg' as string]: plate.bg,
        ['--np-bg2' as string]: plate.bg2,
        ['--np-fg' as string]: plate.text,
        ['--np-border' as string]: plate.border,
      } as CSSProperties)
    : undefined;
  return (
    <span className={`tr-nameplate tr-nameplate--${plate?.style ?? 'pill'}`} style={style}>
      <b>{name}</b>
      {tag && <small>#{tag}</small>}
    </span>
  );
}

// -----------------------------------------------------------------------------
// Swatches
// -----------------------------------------------------------------------------

function TrailSwatch({
  effect,
  colors,
  wearer,
}: {
  effect: string;
  colors: string[];
  wearer: Wearer;
}): JSX.Element {
  const dots = Array.from({ length: 7 }, (_, i) => {
    const t = i / 6;
    return {
      x: 8 + t * 54,
      y: 52 - Math.sin(t * Math.PI * 0.9) * 26,
      r: 2.5 + t * 4,
      c: colors[i % colors.length]!,
    };
  });
  const star = effect === 'stars' || effect === 'sparkle';
  return (
    <span className="tr-ip-swatch">
      <svg viewBox="0 0 100 70" aria-hidden>
        {effect === 'rainbow'
          ? colors.map((c, i) => (
              <path
                key={i}
                d={`M6 ${56 - i * 5} Q36 ${14 - i * 5} 66 ${40 - i * 5}`}
                fill="none"
                stroke={c}
                strokeWidth="5"
                strokeLinecap="round"
              />
            ))
          : dots.map((d, i) =>
              star ? (
                <path
                  key={i}
                  d={`M${d.x} ${d.y - d.r * 1.4} L${d.x + d.r * 0.45} ${d.y - d.r * 0.4} L${d.x + d.r * 1.4} ${d.y} L${d.x + d.r * 0.45} ${d.y + d.r * 0.4} L${d.x} ${d.y + d.r * 1.4} L${d.x - d.r * 0.45} ${d.y + d.r * 0.4} L${d.x - d.r * 1.4} ${d.y} L${d.x - d.r * 0.45} ${d.y - d.r * 0.4} Z`}
                  fill={d.c}
                  stroke="#2b1a5e"
                  strokeWidth="1"
                />
              ) : (
                <circle
                  key={i}
                  cx={d.x}
                  cy={d.y}
                  r={d.r}
                  fill={effect === 'bubbles' ? `${d.c}aa` : d.c}
                  stroke="#2b1a5e"
                  strokeWidth="1"
                />
              ),
            )}
      </svg>
      <TumblerAvatar
        colors={wearer.colors}
        hat={wearer.hat}
        expression="grin"
        pose="armsUp"
        size="44%"
        blink={false}
      />
    </span>
  );
}

function FootstepsSwatch({ wearer }: { wearer: Wearer }): JSX.Element {
  const fill = wearer.colors.primary;
  return (
    <span className="tr-ip-swatch">
      <svg viewBox="0 0 100 70" aria-hidden>
        {[0, 1, 2, 3].map((i) => {
          const x = 18 + i * 20;
          const y = i % 2 === 0 ? 50 : 34;
          return (
            <g key={i} transform={`rotate(-70 ${x} ${y})`}>
              <ellipse cx={x} cy={y} rx="6" ry="9" fill={fill} stroke="#2b1a5e" strokeWidth="2" />
            </g>
          );
        })}
        <g fill="none" stroke="#2b1a5e" strokeWidth="2.2" strokeLinecap="round">
          <path d="M84 16 q5 6 0 12" />
          <path d="M90 11 q8 11 0 22" />
        </g>
      </svg>
    </span>
  );
}

// -----------------------------------------------------------------------------
// Previews
// -----------------------------------------------------------------------------

/** Props for {@link ItemPreview}. */
export interface ItemPreviewProps {
  item: CosmeticItem;
  /** Extra class on the root (sizing). */
  className?: string;
  /** Use only the 2D portrait (never the 3D thumbnail), e.g. for tiny chips. */
  flat?: boolean;
}

/** Applies a body item to the wearer for the 2D portrait. */
function dressed(item: CosmeticItem, wearer: Wearer): { colors: TumblerColors; hat: AvatarHat } {
  const look = item.look;
  let colors = wearer.colors;
  let hat = wearer.hat;
  if (look?.kind === 'skin') {
    colors = {
      ...colors,
      ...(look.colors
        ? { primary: look.colors[0], secondary: look.colors[1], tertiary: look.colors[2] }
        : {}),
      ...(look.pattern ? { pattern: look.pattern } : {}),
    };
  } else if (look?.kind === 'wearable' && item.slot === 'headwear') hat = look.hat ?? 'none';
  return { colors, hat };
}

/**
 * A cosmetic shown on the player's own Tumbler (or as the real nameplate,
 * banner, trail or footstep swatch). Reads the wearer from the UI store.
 *
 * @example
 * <ItemPreview item={offer.item} className="tr-item-icon" />
 */
export function ItemPreview({ item, className, flat }: ItemPreviewProps): JSX.Element {
  const wearer = useWearer();
  const body = BODY_SLOTS.has(item.slot);
  const thumb = useUI((s) => (body && !flat ? s.thumbnails[item.id] : undefined));
  useEffect(() => {
    if (body && !flat && !thumb) requestThumbnail(item.id);
  }, [item.id, thumb, body, flat]);
  const cls = `tr-ip tr-ip--${item.slot}${className ? ` ${className}` : ''}`;
  const look = item.look;
  const motion = MOTION_SLOTS.has(item.slot);

  if (body) {
    const [pose, expression] =
      look?.kind === 'pose' ? (CLIP_POSE[look.clip] ?? ['wave', 'happy']) : (['idle', 'happy'] as const);
    const d = dressed(item, wearer);
    return (
      <span className={cls} data-preview="wearer">
        {thumb ? (
          <img className="tr-item-thumb" src={thumb} alt="" draggable={false} />
        ) : (
          <TumblerAvatar
            colors={d.colors}
            hat={d.hat}
            pose={pose}
            expression={expression}
            size="78%"
            blink={false}
            title={`Your Tumbler with ${item.name}`}
          />
        )}
        {motion && (
          <span className="tr-ip-motion" aria-hidden>
            <Icon name="play" size="0.9em" />
          </span>
        )}
      </span>
    );
  }
  if (look?.kind === 'nameplate')
    return (
      <span className={cls} data-preview="nameplate">
        <Nameplate name={wearer.name} plate={look.plate} />
      </span>
    );
  if (look?.kind === 'banner')
    return (
      <span className={cls} data-preview="banner">
        <span className="tr-ip-banner" style={bannerStyle(look.banner)}>
          <b>{wearer.name}</b>
        </span>
      </span>
    );
  if (look?.kind === 'trail')
    return (
      <span className={cls} data-preview="trail">
        <TrailSwatch effect={look.effect} colors={look.colors} wearer={wearer} />
      </span>
    );
  if (item.slot === 'footsteps')
    return (
      <span className={cls} data-preview="footsteps">
        <FootstepsSwatch wearer={wearer} />
      </span>
    );
  return (
    <span className={cls} data-preview="silhouette">
      <ItemSilhouette rarity={item.rarity} />
    </span>
  );
}

/** A non-cosmetic reward kind. */
export type CurrencyKind = Currency | 'xp' | 'crownShards';

/** Display name of a currency reward. */
export const CURRENCY_LABELS: Readonly<Record<CurrencyKind, string>> = {
  gumballs: 'Gumballs',
  gems: 'Gems',
  xp: 'XP',
  crownShards: 'Crown Shards',
};

/**
 * The one card design for currency and XP rewards: amount large, coin, label.
 *
 * @example
 * <CurrencyPreview kind="gems" amount={50} />
 */
export function CurrencyPreview({
  kind,
  amount,
  className,
}: {
  kind: CurrencyKind;
  amount: number;
  className?: string;
}): JSX.Element {
  const coin =
    kind === 'xp' ? (
      <span className="tr-coin-xp" aria-hidden>
        <Icon name="star" size="1.5em" />
      </span>
    ) : (
      <span
        className={`tr-coin${kind === 'gems' ? ' tr-coin--gem' : kind === 'crownShards' ? ' tr-coin--shard' : ''}`}
        aria-hidden
      />
    );
  return (
    <span
      className={`tr-ip tr-ip--currency tr-ip--${kind}${className ? ` ${className}` : ''}`}
      data-preview="currency"
    >
      <span className="tr-ip-coin">{coin}</span>
      <b className="tr-ip-amount">{formatNumber(amount)}</b>
      <span className="tr-ip-unit">{CURRENCY_LABELS[kind]}</span>
    </span>
  );
}
