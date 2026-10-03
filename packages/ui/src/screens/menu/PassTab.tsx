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
import { Bar, Coin, ItemArt } from '../../components/bits.tsx';
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

/** Readable label for a currency reward. */
export function rewardLabel(r: PassReward): string {
  if (r.item) return r.item.name;
  if (!r.currency) return '';
  const k = r.currency.kind;
  return `${formatNumber(r.currency.amount)} ${k === 'xp' ? 'XP' : k === 'gems' ? 'Gems' : 'Gumballs'}`;
}

interface Selection {
  tier: number;
  track: Track;
}

function rewardAt(pass: SeasonPassData, sel: Selection): PassReward | undefined {
  return pass.tiers[sel.tier - 1]?.[sel.track];
}

function RewardCard({
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
  const unlocked = tier <= pass.currentTier;
  const locked = track === 'premium' && !pass.premium;
  const claimable = unlocked && !locked && !reward.claimed;
  const label = rewardLabel(reward);
  const item = reward.item;
  return (
    <button
      type="button"
      className={[
        'tr-pr',
        `tr-pr--${track}`,
        item ? `tr-rar-frame tr-rar-frame--${item.rarity}` : 'tr-pr--currency',
        big ? 'is-milestone' : '',
        claimable ? 'is-claimable' : '',
        reward.claimed ? 'is-claimed' : '',
        locked ? 'is-locked' : '',
        !unlocked ? 'is-future' : '',
        selected ? 'is-selected' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={item ? { ['--art-a' as string]: item.art[0], ['--art-b' as string]: item.art[1] } : undefined}
      data-nav=""
      data-tier={tier}
      data-track={track}
      aria-pressed={selected}
      aria-label={`Tier ${tier} ${track} reward: ${label}${reward.claimed ? ', claimed' : claimable ? ', ready to claim' : locked ? ', premium' : ''}`}
      onClick={() => {
        onSelect();
        if (!claimable) return;
        playCue('ui.claim');
        if (item) playCue(`ui.rarity.${item.rarity}`);
        uiEvents.emit('claimPassTier', { tier, track });
      }}
    >
      <span className="tr-pr-art">
        {item ? (
          <ItemArt item={item} className="tr-pr-thumb" />
        ) : reward.currency ? (
          <span className="tr-pr-coin">
            <Coin currency={reward.currency.kind} />
          </span>
        ) : null}
      </span>
      <span className="tr-pr-name">{label}</span>
      {item && (
        <span className={`tr-pr-rarity tr-rarity-text--${item.rarity}`}>
          {big ? `${rarityLabels[item.rarity]} · ${SLOT_NAMES[item.slot]}` : rarityLabels[item.rarity]}
        </span>
      )}
      {reward.claimed && (
        <span className="tr-pr-state is-claimed" aria-hidden>
          <Icon name="check" size="0.9em" />
        </span>
      )}
      {locked && !reward.claimed && (
        <span className="tr-pr-state is-locked" aria-hidden>
          <Icon name="lock" size="1em" />
        </span>
      )}
      {claimable && <span className="tr-pr-claim">Claim</span>}
      {big && <span className="tr-pr-ribbon">Tier {tier}</span>}
    </button>
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

function Preview({ pass, sel }: { pass: SeasonPassData; sel: Selection }): JSX.Element | null {
  const loadout = useActiveLoadout();
  const reward = rewardAt(pass, sel);
  if (!reward) return null;
  const item = reward.item;
  const unlocked = sel.tier <= pass.currentTier;
  const locked = sel.track === 'premium' && !pass.premium;
  const claimable = unlocked && !locked && !reward.claimed;
  const owned = item?.owned ?? false;
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
        {item && <span className="tr-small tr-muted">{SLOT_NAMES[item.slot]}</span>}
      </div>
      <b className="tr-title tr-h3 tr-pass-preview-name">{rewardLabel(reward)}</b>
      {item?.description && <span className="tr-small tr-muted tr-clamp-2">{item.description}</span>}
      <div className="tr-row" style={{ gap: '0.5em', flexWrap: 'wrap' }}>
        {claimable ? (
          <Button
            size="sm"
            variant="mint"
            cue={null}
            data-testid="pass-claim"
            onClick={() => {
              playCue('ui.claim');
              uiEvents.emit('claimPassTier', { tier: sel.tier, track: sel.track });
            }}
          >
            Claim
          </Button>
        ) : reward.claimed && item && owned ? (
          isEquipped(loadout, item) ? (
            <span className="tr-chip tr-chip--mint">Equipped</span>
          ) : item.slot === 'colors' || item.slot === 'pattern' ? (
            <span className="tr-chip tr-chip--mint">In your locker</span>
          ) : (
            <Button
              size="sm"
              variant="mint"
              onClick={() => uiEvents.emit('equip', { slot: item.slot, itemId: item.id })}
            >
              Equip
            </Button>
          )
        ) : reward.claimed ? (
          <span className="tr-chip tr-chip--mint">Claimed</span>
        ) : locked ? (
          <span className="tr-chip tr-chip--grape">
            <Icon name="lock" size="1em" /> Premium track
          </span>
        ) : (
          <span className="tr-chip">Reach tier {sel.tier} to unlock</span>
        )}
      </div>
    </div>
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
      {!afford && <small className="tr-muted">Gems coming soon</small>}
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
          <span className="tr-label">
            Season {pass.seasonNumber} · ends in {formatRemaining(pass.endsAt - now)}
          </span>
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
