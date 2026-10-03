/**
 * Presentational building blocks: sticker panels, progress bars, round-type
 * badges, currency pills, rarity item cards, the logo and round gumdrops.
 */
import { type CSSProperties, type JSX, type ReactNode } from 'react';
import { useUI } from '../store/uiStore.ts';
import { SLOT_NAMES, type CosmeticItem, type Currency, type RoundType } from '../store/types.ts';
import { rarityLabels, roundTypeStyle } from '../theme/tokens.ts';
import { formatNumber, useCountUp } from './hooks.ts';
import { Icon } from './icons/index.tsx';
import { ItemPreview } from './ItemPreview.tsx';

export { ItemSilhouette } from './ItemPreview.tsx';

/** Props for `Panel`. */
export interface PanelProps {
  children: ReactNode;
  /** Degrees of sticker tilt. */
  tilt?: number;
  tone?: 'cream' | 'sky' | 'grape' | 'ink';
  /** Entrance animation. */
  enter?: 'up' | 'pop' | 'fade' | 'left' | 'right' | 'drop' | 'none';
  /** Entrance delay in ms (stagger). */
  delay?: number;
  className?: string;
  style?: CSSProperties;
  interactive?: boolean;
  tight?: boolean;
}

const ENTER_CLASS: Record<NonNullable<PanelProps['enter']>, string> = {
  up: 'tr-enter',
  pop: 'tr-enter-pop',
  fade: 'tr-enter-fade',
  left: 'tr-enter-left',
  right: 'tr-enter-right',
  drop: 'tr-enter-drop',
  none: '',
};

/** Die-cut sticker panel. */
export function Panel({
  children,
  tilt = 0,
  tone = 'cream',
  enter = 'up',
  delay = 0,
  className,
  style,
  interactive = true,
  tight,
}: PanelProps): JSX.Element {
  const cls = [
    'tr-panel',
    tone !== 'cream' ? `tr-panel--${tone}` : '',
    tight ? 'tr-panel--tight' : '',
    ENTER_CLASS[enter],
    interactive ? 'tr-interactive' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className={cls}
      style={{
        ['--tilt' as string]: `${tilt}deg`,
        animationDelay: delay ? `${delay}ms` : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Props for `Bar`. */
export interface BarProps {
  /** 0..1 */
  value: number;
  color?: string;
  large?: boolean;
  label?: string;
  className?: string;
}

/** Candy-striped progress bar. */
export function Bar({ value, color, large, label, className }: BarProps): JSX.Element {
  return (
    <div
      className={`tr-bar${large ? ' tr-bar--lg' : ''}${className ? ` ${className}` : ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      style={color ? { ['--fill' as string]: color } : undefined}
    >
      <i style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

/** Round type badge (RACE / SURVIVAL / …). */
export function TypeBadge({
  type,
  className,
  style,
}: {
  type: RoundType;
  className?: string;
  style?: CSSProperties;
}): JSX.Element {
  const t = roundTypeStyle[type];
  return (
    <span
      className={`tr-type-badge${className ? ` ${className}` : ''}`}
      style={{ ['--badge' as string]: t.color, ...style }}
    >
      <span aria-hidden>{t.icon}</span>
      {t.label}
    </span>
  );
}

/** Coin glyph for a currency. */
export function Coin({ currency }: { currency: Currency | 'crown' | 'crownShards' | 'xp' }): JSX.Element {
  if (currency === 'xp')
    return (
      <span className="tr-coin-xp" aria-hidden>
        <Icon name="star" size="1.5em" />
      </span>
    );
  const variant =
    currency === 'gems'
      ? ' tr-coin--gem'
      : currency === 'crown'
        ? ' tr-coin--crown'
        : currency === 'crownShards'
          ? ' tr-coin--shard'
          : '';
  return <span className={`tr-coin${variant}`} aria-hidden />;
}

/** Props for `CurrencyPill`. */
export interface CurrencyPillProps {
  currency: Currency | 'crown';
  amount: number;
  /** Animate changes (count up). */
  animate?: boolean;
  onAdd?: () => void;
}

/** Wallet pill with animated count. */
export function CurrencyPill({ currency, amount, animate = true, onAdd }: CurrencyPillProps): JSX.Element {
  const shown = useCountUp(amount, animate ? 900 : 0);
  const label = currency === 'gems' ? 'Gems' : currency === 'crown' ? 'Crowns' : 'Gumballs';
  return (
    <span className="tr-currency" aria-label={`${label}: ${amount}`}>
      <Coin currency={currency} />
      <span>{formatNumber(shown)}</span>
      {onAdd && (
        <button
          type="button"
          className="tr-currency-add tr-interactive"
          data-nav=""
          aria-label={`Get ${label}`}
          onClick={onAdd}
        >
          +
        </button>
      )}
    </span>
  );
}

/** Price label. */
export function Price({
  currency,
  amount,
  original,
}: {
  currency: Currency | 'crownShards';
  amount: number;
  original?: number;
}): JSX.Element {
  const label = currency === 'gems' ? 'Gems' : currency === 'crownShards' ? 'Crown Shards' : 'Gumballs';
  return (
    <span className="tr-price" aria-label={`${amount} ${label}`}>
      <Coin currency={currency} />
      {original !== undefined && <s className="tr-muted">{formatNumber(original)}</s>}
      <b>{formatNumber(amount)}</b>
    </span>
  );
}

/**
 * A cosmetic's picture.
 *
 * @deprecated Use {@link ItemPreview} (same behaviour, shown on the player's Tumbler).
 */
export function ItemArt({
  item,
  className = 'tr-item-icon',
}: {
  item: CosmeticItem;
  className?: string;
}): JSX.Element {
  return <ItemPreview item={item} className={className} />;
}

/** Props for `ItemCard`. */
export interface ItemCardProps {
  item: CosmeticItem;
  selected?: boolean;
  equipped?: boolean;
  footer?: ReactNode;
  onClick?: () => void;
  onFocus?: () => void;
  delay?: number;
  size?: 'sm' | 'md' | 'lg';
}

/** Rarity-framed cosmetic card. */
export function ItemCard({
  item,
  selected,
  equipped,
  footer,
  onClick,
  onFocus,
  delay = 0,
  size = 'md',
}: ItemCardProps): JSX.Element {
  return (
    <button
      type="button"
      className={`tr-item tr-item--${item.rarity} tr-item--${size}${selected ? ' is-selected' : ''}${!item.owned && !footer ? ' is-locked' : ''}`}
      style={{
        animationDelay: `${delay}ms`,
        ['--art-a' as string]: item.art[0],
        ['--art-b' as string]: item.art[1],
      }}
      data-nav=""
      onClick={onClick}
      onFocus={onFocus}
      onMouseEnter={onFocus}
      aria-label={`${item.name}, ${rarityLabels[item.rarity]}${item.owned ? '' : ', not owned'}`}
    >
      <span className="tr-item-art">
        <ItemPreview item={item} className="tr-item-icon" />
      </span>
      <span className="tr-item-name tr-ellipsis">{item.name}</span>
      <span className="tr-item-rarity">
        {SLOT_NAMES[item.slot]} · {rarityLabels[item.rarity]}
      </span>
      {equipped && (
        <span className="tr-item-equipped" aria-label="Equipped">
          <Icon name="check" size="0.8em" />
        </span>
      )}
      {!item.owned && !footer && (
        <span className="tr-item-lock" aria-hidden>
          <Icon name="lock" size="1em" />
        </span>
      )}
      {footer && <span className="tr-item-footer">{footer}</span>}
    </button>
  );
}

/** Round progress gumdrops (●●○○○). */
export function RoundDots({
  index,
  count,
  finalLast = true,
}: {
  index: number;
  count: number;
  finalLast?: boolean;
}): JSX.Element {
  return (
    <span className="tr-dots" aria-label={`Round ${index + 1} of ${count}`}>
      {Array.from({ length: count }, (_, i) => (
        <i
          key={i}
          className={`${i < index ? 'is-done' : ''}${i === index ? ' is-current' : ''}${finalLast && i === count - 1 ? ' is-final' : ''}`}
        />
      ))}
    </span>
  );
}

/** Props for `Logo`. */
export interface LogoProps {
  /** Letters drop in one by one. */
  animated?: boolean;
  size?: 'sm' | 'lg';
}

/** TUMBLE ROYALE sticker logo with a crown on the O. */
export function Logo({ animated = true, size = 'lg' }: LogoProps): JSX.Element {
  const words = ['TUMBLE', 'ROYALE'];
  let i = 0;
  return (
    <div className={`tr-logo tr-logo--${size}${animated ? ' is-animated' : ''}`} aria-label="Tumble Royale">
      {words.map((w, wi) => (
        <div key={w} className={`tr-logo-word tr-logo-word--${wi}`} aria-hidden>
          {w.split('').map((ch, ci) => {
            const delay = i++ * 55;
            return (
              <span
                key={ci}
                className="tr-logo-letter"
                style={{ animationDelay: `${delay}ms`, ['--r' as string]: `${((ci * 37) % 9) - 4}deg` }}
              >
                {ch}
                {wi === 1 && ci === 1 && <span className="tr-logo-crown">👑</span>}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Animated number. */
export function CountUp({
  value,
  from,
  durationMs = 700,
  delayMs,
  onStep,
}: {
  value: number;
  from?: number;
  durationMs?: number;
  delayMs?: number;
  onStep?: (v: number) => void;
}): JSX.Element {
  const v = useCountUp(value, durationMs, { from, delayMs, onStep });
  return <>{formatNumber(v)}</>;
}

/** Rotating tips carousel. */
export function TipCarousel({
  tips,
  intervalMs = 5000,
  now,
}: {
  tips: readonly string[];
  intervalMs?: number;
  now: number;
}): JSX.Element | null {
  if (tips.length === 0) return null;
  const idx = Math.floor(now / intervalMs) % tips.length;
  return (
    <div className="tr-tip" key={idx}>
      <span className="tr-tip-icon" aria-hidden>
        <Icon name="star" size="1.2em" />
      </span>
      <span>{tips[idx]}</span>
    </div>
  );
}

/**
 * Small "BOT" chip next to a bot's name (results, player wall, spectate
 * banner, profile cards). Hidden when Settings → Gameplay → Show bot tags is
 * off; renders nothing for humans.
 *
 * @example
 * <b>{name}</b> <BotTag isBot={player.isBot} />
 */
export function BotTag({
  isBot,
  className,
}: {
  isBot: boolean | undefined;
  className?: string;
}): JSX.Element | null {
  const show = useUI((s) => s.settings.gameplay.botTags);
  if (!isBot || !show) return null;
  return (
    <span
      className={`tr-bot-tag${className ? ` ${className}` : ''}`}
      aria-label="Bot"
      title="Computer-controlled player"
    >
      BOT
    </span>
  );
}
