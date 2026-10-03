/**
 * Season Pass as a premium progression track, built on the dressing room:
 *
 * - left stage: the real 3D Tumbler wearing (or performing) the selected
 *   reward — the next marquee reward by default — with a preview card
 *   (name, rarity, slot, which track/tier unlocks it, Claim / Equip);
 * - right: season header (tier, progress, Claim all, premium state), then a
 *   full-height track: FREE lane, a progress spine with every tier number and
 *   the current-tier marker, PREMIUM lane. Every 10th tier is a big milestone
 *   card. Snap scrolling, mouse wheel scrolls sideways, milestone jump chips,
 *   arrow keys / d-pad move between rewards.
 *
 * docs/design/SCREENS.md §5.3.
 */
import { useEffect, useMemo, useRef, useState, type JSX, type WheelEvent } from 'react';
import { playCue } from '../../audio-cues.ts';
import { Bar, Coin } from '../../components/bits.tsx';
import {
  CURRENCY_LABELS,
  CurrencyPreview,
  ItemPreview,
  MOTION_SLOTS,
} from '../../components/ItemPreview.tsx';
import { Button } from '../../components/controls.tsx';
import { formatNumber, formatRemaining, useNow } from '../../components/hooks.ts';
import { Icon } from '../../components/icons/index.tsx';
import { uiEvents } from '../../store/events.ts';
import { useUI } from '../../store/uiStore.ts';
import { SLOT_NAMES, type PassReward, type PassTier, type SeasonPassData } from '../../store/types.ts';

/** Re-exported for screens that imported slot names from here. */
export { SLOT_NAMES };
import { rarityLabels } from '../../theme/tokens.ts';
import { DressingRoom, isEquipped, useActiveLoadout } from './DressingRoom.tsx';
import { nextMarquee } from './PlayTab.tsx';

type Track = 'free' | 'premium';

/** Whether a tier is a big milestone card. */
const isMilestone = (tier: number): boolean => tier % 10 === 0;

/** Readable label for a reward: the item name, or `250 Gumballs`. */
export function rewardLabel(r: PassReward): string {
  if (r.item) return r.item.name;
  if (!r.currency) return '';
  return `${formatNumber(r.currency.amount)} ${CURRENCY_LABELS[r.currency.kind]}`;
}

/** What kind of reward it is: `Hat · Epic` for items, the currency name otherwise. */
export function rewardKind(r: PassReward): string {
  if (r.item) return `${SLOT_NAMES[r.item.slot]} · ${rarityLabels[r.item.rarity]}`;
  return r.currency ? CURRENCY_LABELS[r.currency.kind] : '';
}

interface Selection {
  tier: number;
  track: Track;
}

function rewardAt(pass: SeasonPassData, sel: Selection): PassReward | undefined {
  return pass.tiers[sel.tier - 1]?.[sel.track];
}

/** Where a reward stands for this player. */
export type RewardState = 'claimed' | 'claimable' | 'premium' | 'future';

/**
 * State of one pass reward.
 *
 * @param pass - Season pass.
 * @param tier - Tier number.
 * @param track - Free or premium lane.
 * @param reward - The reward.
 */
export function rewardState(
  pass: SeasonPassData,
  tier: number,
  track: Track,
  reward: PassReward,
): RewardState {
  if (reward.claimed) return 'claimed';
  if (track === 'premium' && !pass.premium) return 'premium';
  return tier <= pass.currentTier ? 'claimable' : 'future';
}

/** Short status line for a reward card. */
function stateLabel(state: RewardState, tier: number, pass: SeasonPassData): string {
  switch (state) {
    case 'claimed':
      return 'Claimed';
    case 'claimable':
      return 'Ready to claim';
    case 'premium':
      return tier <= pass.currentTier ? 'Premium: unlock to claim' : 'Premium';
    case 'future': {
      const n = tier - pass.currentTier;
      return n === 1 ? 'Next tier' : `${n} tiers to go`;
    }
  }
}

function claim(tier: number, track: Track, reward: PassReward): void {
  playCue('ui.claim');
  if (reward.item) playCue(`ui.rarity.${reward.item.rarity}`);
  uiEvents.emit('claimPassTier', { tier, track });
}

/** One reward on the track: tier and lane, the reward on the player's Tumbler, its kind and state. */
export function RewardCard({
  reward,
  track,
  tier,
  pass,
  selected,
  onSelect,
}: {
  reward: PassReward | undefined;
  track: Track;
  tier: number;
  pass: SeasonPassData;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  const big = isMilestone(tier);
  if (!reward)
    return <div className={`tr-pr tr-pr--${track} is-empty${big ? ' is-milestone' : ''}`} aria-hidden />;
  const state = rewardState(pass, tier, track, reward);
  const item = reward.item;
  const label = rewardLabel(reward);
  const status = stateLabel(state, tier, pass);
  return (
    <div
      className={[
        'tr-pr',
        `tr-pr--${track}`,
        item ? `tr-rar-frame tr-rar-frame--${item.rarity}` : 'tr-pr--currency',
        big ? 'is-milestone' : '',
        `is-${state}`,
        state === 'premium' ? 'is-locked' : '',
        selected ? 'is-selected' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={item ? { ['--art-a' as string]: item.art[0], ['--art-b' as string]: item.art[1] } : undefined}
      data-tier={tier}
      data-track={track}
      data-state={state}
    >
      <button
        type="button"
        className="tr-pr-hit"
        data-nav=""
        aria-pressed={selected}
        aria-label={`Tier ${tier}, ${track === 'free' ? 'free' : 'premium'} track: ${label}, ${rewardKind(reward)}, ${status}`}
        onClick={onSelect}
      >
        <span className="tr-pr-top">
          <span className="tr-pr-tier">Tier {tier}</span>
          <span className={`tr-pr-lane tr-pr-lane--${track}`}>
            {track === 'premium' && !pass.premium && <Icon name="lock" size="0.85em" />}
            {track === 'free' ? 'Free' : 'Premium'}
          </span>
        </span>
        <span className="tr-pr-art">
          {item ? (
            <ItemPreview item={item} className="tr-pr-thumb" />
          ) : reward.currency ? (
            <CurrencyPreview kind={reward.currency.kind} amount={reward.currency.amount} />
          ) : null}
        </span>
        {item && <span className="tr-pr-name">{label}</span>}
        {item && <span className={`tr-pr-rarity tr-rarity-text--${item.rarity}`}>{rewardKind(reward)}</span>}
        <span className={`tr-pr-status is-${state}`}>
          {state === 'claimed' && <Icon name="check" size="0.85em" />}
          {state === 'premium' && <Icon name="lock" size="0.85em" />}
          {state !== 'claimable' && status}
        </span>
      </button>
      {state === 'claimable' && (
        <button
          type="button"
          className="tr-pr-claim"
          data-nav=""
          data-testid="pass-card-claim"
          aria-label={`Claim tier ${tier} ${track} reward: ${label}`}
          onClick={() => {
            onSelect();
            claim(tier, track, reward);
          }}
        >
          Claim
        </button>
      )}
    </div>
  );
}
function TierColumn({
  t,
  pass,
  sel,
  onSelect,
}: {
  t: PassTier;
  pass: SeasonPassData;
  sel: Selection | null;
  onSelect: (s: Selection) => void;
}): JSX.Element {
  const current = t.tier === pass.currentTier + 1;
  const done = t.tier <= pass.currentTier;
  const big = isMilestone(t.tier);
  return (
    <div
      className={`tr-tier${big ? ' is-milestone' : ''}${done ? ' is-done' : ''}${current ? ' is-current' : ''}`}
      data-tier-col={t.tier}
    >
      <RewardCard
        reward={t.free}
        track="free"
        tier={t.tier}
        pass={pass}
        selected={sel?.tier === t.tier && sel.track === 'free'}
        onSelect={() => onSelect({ tier: t.tier, track: 'free' })}
      />
      <div className="tr-tier-node">
        <span className="tr-tier-spine" aria-hidden>
          {current && <i style={{ width: `${pass.tierProgress * 100}%` }} />}
        </span>
        <span className="tr-tier-num">{t.tier}</span>
        {current && <span className="tr-tier-you">You</span>}
      </div>
      <RewardCard
        reward={t.premium}
        track="premium"
        tier={t.tier}
        pass={pass}
        selected={sel?.tier === t.tier && sel.track === 'premium'}
        onSelect={() => onSelect({ tier: t.tier, track: 'premium' })}
      />
    </div>
  );
}

/** Slots the 3D stage can show on the Tumbler; everything else gets a flat preview in the detail. */
const ON_STAGE = new Set([
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

/** Docked detail for the selected reward: what it is, which slot it fills, and what to do next. */
function Preview({ pass, sel }: { pass: SeasonPassData; sel: Selection }): JSX.Element | null {
  const loadout = useActiveLoadout();
  const reward = rewardAt(pass, sel);
  if (!reward) return null;
  const item = reward.item;
  const state = rewardState(pass, sel.tier, sel.track, reward);
  const owned = item?.owned ?? false;
  const toGo = sel.tier - pass.currentTier;
  return (
    <div
      key={`${sel.tier}:${sel.track}`}
      className={`tr-panel tr-pass-preview tr-enter-pop${item ? ` tr-rar-edge--${item.rarity}` : ''}`}
      data-testid="pass-preview"
    >
      <div className="tr-row" style={{ gap: '0.5em', flexWrap: 'wrap' }}>
        <span className={`tr-lane-chip tr-lane-chip--${sel.track}`}>
          {sel.track === 'free' ? 'Free' : 'Premium'} · Tier {sel.tier}
        </span>
        {item && (
          <span className={`tr-rarity-band tr-rarity-band--${item.rarity}`}>{rarityLabels[item.rarity]}</span>
        )}
        <span className="tr-chip">{item ? SLOT_NAMES[item.slot] : rewardKind(reward)}</span>
      </div>
      <div className="tr-row" style={{ gap: '0.7em', alignItems: 'center' }}>
        {(!item || !ON_STAGE.has(item.slot)) && (
          <span className="tr-pass-preview-art">
            {item ? (
              <ItemPreview item={item} />
            ) : reward.currency ? (
              <CurrencyPreview kind={reward.currency.kind} amount={reward.currency.amount} />
            ) : null}
          </span>
        )}
        <div className="tr-col" style={{ gap: '0.25em', minWidth: 0 }}>
          <b className="tr-title tr-h3 tr-pass-preview-name">{rewardLabel(reward)}</b>
          {item?.description && <span className="tr-small tr-muted tr-clamp-2">{item.description}</span>}
          {item && ON_STAGE.has(item.slot) && (
            <span className="tr-small">
              {MOTION_SLOTS.has(item.slot) ? 'Playing on your Tumbler' : 'Shown on your Tumbler'}
            </span>
          )}
        </div>
      </div>
      <div className="tr-row" style={{ gap: '0.5em', flexWrap: 'wrap' }}>
        {state === 'claimable' ? (
          <Button
            size="sm"
            variant="mint"
            cue={null}
            data-testid="pass-claim"
            onClick={() => claim(sel.tier, sel.track, reward)}
          >
            Claim
          </Button>
        ) : state === 'claimed' && item && owned ? (
          isEquipped(loadout, item) ? (
            <span className="tr-chip tr-chip--mint">Equipped</span>
          ) : item.slot === 'colors' || item.slot === 'pattern' ? (
            <span className="tr-chip tr-chip--mint">In your Locker</span>
          ) : (
            <Button
              size="sm"
              variant="mint"
              onClick={() => uiEvents.emit('equip', { slot: item.slot, itemId: item.id })}
            >
              Equip
            </Button>
          )
        ) : state === 'claimed' ? (
          <span className="tr-chip tr-chip--mint">Claimed</span>
        ) : state === 'premium' ? (
          <span className="tr-chip tr-chip--grape">
            <Icon name="lock" size="1em" /> Premium track
            {toGo > 0 ? ` · ${toGo} ${toGo === 1 ? 'tier' : 'tiers'} to go` : ''}
          </span>
        ) : (
          <span className="tr-chip">
            Reach tier {sel.tier} to unlock · {toGo} {toGo === 1 ? 'tier' : 'tiers'} to go
          </span>
        )}
      </div>
    </div>
  );
}

/** The next tier's rewards, so the next unlock is always visible in the header. */
function NextUnlock({
  pass,
  onShow,
}: {
  pass: SeasonPassData;
  onShow: (s: Selection) => void;
}): JSX.Element | null {
  const next = pass.tiers[pass.currentTier];
  if (!next) return null;
  const pick: Selection = next.free
    ? { tier: next.tier, track: 'free' }
    : { tier: next.tier, track: 'premium' };
  const reward = rewardAt(pass, pick);
  if (!reward) return null;
  return (
    <button
      type="button"
      className="tr-pass-next"
      data-nav=""
      data-testid="pass-next"
      onClick={() => onShow(pick)}
    >
      <span className="tr-pass-next-art">
        {reward.item ? (
          <ItemPreview item={reward.item} />
        ) : reward.currency ? (
          <CurrencyPreview kind={reward.currency.kind} amount={reward.currency.amount} />
        ) : null}
      </span>
      <span className="tr-col" style={{ gap: '0.1em', minWidth: 0, alignItems: 'flex-start' }}>
        <small className="tr-muted">Next unlock · Tier {next.tier}</small>
        <b className="tr-ellipsis">{rewardLabel(reward)}</b>
        <small>{rewardKind(reward)}</small>
      </span>
    </button>
  );
}
/** How close to the end a season must be before the next one is announced. */
export const NEXT_SEASON_TEASE_MS = 14 * 86_400_000;

/**
 * Season time left; in the last {@link NEXT_SEASON_TEASE_MS} also when the
 * next season starts and that unclaimed rewards will be auto-granted.
 */
export function SeasonClock({ pass, now }: { pass: SeasonPassData; now: number }): JSX.Element {
  const left = pass.endsAt - now;
  const next = pass.nextSeason;
  return (
    <span className="tr-col" style={{ gap: '0.2em' }} data-testid="season-clock">
      <span className="tr-label">
        Season {pass.seasonNumber} · ends in {formatRemaining(left)}
      </span>
      {next && left <= NEXT_SEASON_TEASE_MS && (
        <span className="tr-chip tr-chip--lemon" style={{ alignSelf: 'flex-start' }}>
          Season {next.number} starts in {formatRemaining(next.startsAt - now)} · unclaimed rewards are added
          automatically
        </span>
      )}
    </span>
  );
}

function PremiumState({ pass }: { pass: SeasonPassData }): JSX.Element {
  const gems = useUI((s) => s.profile?.gems ?? 0);
  if (pass.premium)
    return (
      <span className="tr-chip tr-chip--lemon">
        <Icon name="star" size="1em" /> Premium active
      </span>
    );
  const afford = gems >= pass.premiumPrice;
  return (
    <div className="tr-pass-premium">
      <Button
        variant="premium"
        size="sm"
        disabled={!afford}
        cue="ui.confirm"
        data-testid="pass-premium"
        onClick={() => uiEvents.emit('buyPremiumPass')}
      >
        Unlock Premium <Coin currency="gems" /> {formatNumber(pass.premiumPrice)}
      </Button>
      {!afford && (
        <small className="tr-muted">
          Need {formatNumber(pass.premiumPrice - gems)} more Gems — earn them from weekly challenges, daily
          Crowns and free-track tiers
        </small>
      )}
    </div>
  );
}

/** Season Pass tab. */
export function PassTab(): JSX.Element {
  const pass = useUI((s) => s.pass);
  const now = useNow(60_000);
  const trackRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<Selection | null>(null);

  const claimables = useMemo(() => {
    const out: Selection[] = [];
    if (!pass) return out;
    for (const t of pass.tiers) {
      if (t.tier > pass.currentTier) break;
      if (t.free && !t.free.claimed) out.push({ tier: t.tier, track: 'free' });
      if (pass.premium && t.premium && !t.premium.claimed) out.push({ tier: t.tier, track: 'premium' });
    }
    return out;
  }, [pass]);

  // Default selection: the next marquee reward.
  const fallback = useMemo<Selection | null>(() => {
    if (!pass) return null;
    const m = nextMarquee(pass);
    if (!m) return { tier: Math.min(pass.tiers.length, pass.currentTier + 1), track: 'free' };
    return { tier: m.tier, track: pass.tiers[m.tier - 1]?.free === m.reward ? 'free' : 'premium' };
  }, [pass]);
  const active = sel ?? fallback;
  const reward = pass && active ? rewardAt(pass, active) : undefined;

  useEffect(() => {
    const item = reward?.item;
    if (!item) {
      uiEvents.emit('tryOnBundle', { items: [] });
      return;
    }
    uiEvents.emit('tryOn', { slot: item.slot, itemId: item.id });
  }, [reward?.item?.id]);

  const scrollToTier = (tier: number, smooth = true): void => {
    const el = trackRef.current?.querySelector<HTMLElement>(`[data-tier-col="${tier}"]`);
    const track = trackRef.current;
    if (!el || !track) return;
    track.scrollTo({ left: el.offsetLeft - track.clientWidth * 0.3, behavior: smooth ? 'smooth' : 'auto' });
  };
  useEffect(() => {
    if (pass) scrollToTier(Math.max(1, pass.currentTier), false);
  }, [pass?.currentTier]);

  if (!pass) return <div className="tr-panel tr-empty">Loading the season…</div>;

  const onWheel = (e: WheelEvent<HTMLDivElement>): void => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    e.currentTarget.scrollLeft += e.deltaY;
  };
  const select = (s: Selection): void => {
    playCue('ui.click');
    setSel(s);
  };
  const reset = (): void => {
    setSel(null);
    uiEvents.emit('tryOnBundle', { items: [] });
  };

  return (
    <DressingRoom
      className="tr-pass"
      tryingOn={reward?.item && !reward.item.owned ? reward.item.name : null}
      onReset={reset}
      stageFooter={active ? <Preview pass={pass} sel={active} /> : undefined}
    >
      <div className="tr-panel tr-pass-head">
        <div className="tr-col tr-grow" style={{ gap: '0.35em', minWidth: 0 }}>
          <SeasonClock pass={pass} now={now} />
          <h2 className="tr-title tr-h2 tr-pass-title">{pass.seasonName.replace(/^Season \d+:\s*/, '')}</h2>
          <div className="tr-row" style={{ gap: '0.7em' }}>
            <span className="tr-pass-tier-badge">
              <small>Tier</small>
              <b>{pass.currentTier}</b>
            </span>
            <div className="tr-col tr-grow" style={{ gap: '0.2em' }}>
              <Bar value={pass.tierProgress} color="var(--lemon)" large label="Progress to next tier" />
              <small className="tr-muted">
                {pass.currentTier >= pass.tiers.length
                  ? 'Pass complete!'
                  : `${Math.round(pass.tierProgress * 100)}% to tier ${pass.currentTier + 1} · play shows and finish challenges to earn XP`}
              </small>
            </div>
          </div>
          <NextUnlock
            pass={pass}
            onShow={(s) => {
              select(s);
              scrollToTier(s.tier);
            }}
          />
        </div>
        <div className="tr-col tr-pass-actions">
          <Button
            variant="mint"
            size="sm"
            cue={null}
            disabled={claimables.length === 0}
            data-testid="pass-claim-all"
            onClick={() => {
              playCue('ui.claim');
              for (const c of claimables) uiEvents.emit('claimPassTier', c);
            }}
          >
            <Icon name="gift" size="1.1em" /> Claim all
            {claimables.length > 0 ? ` (${claimables.length})` : ''}
          </Button>
          <PremiumState pass={pass} />
        </div>
      </div>
      <div className="tr-panel tr-pass-board">
        <div className="tr-pass-jumps" role="toolbar" aria-label="Jump to tier">
          <button
            type="button"
            className="tr-jump is-current"
            data-nav=""
            onClick={() => scrollToTier(Math.max(1, pass.currentTier))}
          >
            Current
          </button>
          {pass.tiers
            .filter((t) => isMilestone(t.tier))
            .map((t) => (
              <button
                key={t.tier}
                type="button"
                className={`tr-jump${t.tier <= pass.currentTier ? ' is-done' : ''}`}
                data-nav=""
                onClick={() => scrollToTier(t.tier)}
              >
                {t.tier}
              </button>
            ))}
        </div>
        <div className="tr-pass-lanes">
          <div className="tr-lane-labels" aria-hidden>
            <span className="tr-lane-label tr-lane-label--free">Free</span>
            <span className="tr-lane-label tr-lane-label--spine">Tier</span>
            <span className="tr-lane-label tr-lane-label--premium">
              Premium
              {!pass.premium && <Icon name="lock" size="1em" />}
            </span>
          </div>
          <div className="tr-pass-track" ref={trackRef} onWheel={onWheel} data-testid="pass-track">
            {pass.tiers.map((t) => (
              <TierColumn key={t.tier} t={t} pass={pass} sel={active} onSelect={select} />
            ))}
          </div>
        </div>
      </div>
    </DressingRoom>
  );
}
