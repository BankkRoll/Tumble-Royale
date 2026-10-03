/**
 * Season Pass: header with tier progress, horizontal free/premium tier track,
 * claim with flip reveal, premium upsell. docs/design/SCREENS.md §5.3.
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import { playCue } from '../../audio-cues.ts';
import { Bar, Coin, Panel } from '../../components/bits.tsx';
import { Button } from '../../components/controls.tsx';
import { formatNumber, formatRemaining, useNow } from '../../components/hooks.ts';
import { uiEvents } from '../../store/events.ts';
import { useUI } from '../../store/uiStore.ts';
import { scrollIntoNearest } from '../../nav/navigation.ts';
import type { PassReward } from '../../store/types.ts';

function RewardCard({
  reward,
  track,
  tier,
  unlocked,
  locked,
}: {
  reward: PassReward | undefined;
  track: 'free' | 'premium';
  tier: number;
  unlocked: boolean;
  locked: boolean;
}): JSX.Element {
  const [flipping, setFlipping] = useState(false);
  if (!reward) return <div className={`tr-pass-reward tr-pass-reward--${track} is-empty`} />;
  const claimable = unlocked && !locked && !reward.claimed;
  const label = reward.item
    ? reward.item.name
    : reward.currency
      ? `${formatNumber(reward.currency.amount)} ${reward.currency.kind === 'xp' ? 'XP' : reward.currency.kind === 'gems' ? 'Gems' : 'Gumballs'}`
      : '';
  return (
    <button
      type="button"
      className={`tr-pass-reward tr-pass-reward--${track}${reward.item ? ` tr-pass-reward--${reward.item.rarity}` : ''}${claimable ? ' is-claimable' : ''}${reward.claimed ? ' is-claimed' : ''}${locked ? ' is-locked' : ''}${flipping ? ' is-flipping' : ''}`}
      style={
        reward.item
          ? { ['--art-a' as string]: reward.item.art[0], ['--art-b' as string]: reward.item.art[1] }
          : undefined
      }
      data-nav=""
      aria-label={`Tier ${tier} ${track} reward: ${label}${reward.claimed ? ', claimed' : claimable ? ', claim' : ''}`}
      onClick={() => {
        if (!claimable) return;
        setFlipping(true);
        playCue('ui.claim');
        if (reward.item) playCue(`ui.rarity.${reward.item.rarity}`);
        uiEvents.emit('claimPassTier', { tier, track });
      }}
    >
      <span className="tr-pass-reward-icon">
        {reward.item ? reward.item.icon : reward.currency ? <Coin currency={reward.currency.kind} /> : null}
      </span>
      <span className="tr-pass-reward-name tr-ellipsis">{label}</span>
      {reward.claimed && <span className="tr-pass-tick">✓</span>}
      {locked && <span className="tr-pass-lock">🔒</span>}
      {claimable && <span className="tr-pass-claim">Claim!</span>}
    </button>
  );
}

/** Season Pass tab. */
export function PassTab(): JSX.Element {
  const pass = useUI((s) => s.pass);
  const now = useNow(60_000);
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = trackRef.current?.querySelector<HTMLElement>('.is-current');
    if (el) scrollIntoNearest(el, true);
  }, [pass?.currentTier]);

  if (!pass) return <Panel className="tr-pass">Loading the season…</Panel>;
  return (
    <div className="tr-pass">
      <Panel tone="grape" tilt={-0.6} className="tr-pass-head">
        <div className="tr-col tr-grow" style={{ gap: '0.3em' }}>
          <span className="tr-label" style={{ color: '#fff' }}>
            Season {pass.seasonNumber} · ends in {formatRemaining(pass.endsAt - now)}
          </span>
          <h2 className="tr-title tr-h2">{pass.seasonName}</h2>
          <div className="tr-row">
            <span className="tr-pass-tier-num">
              Tier <b>{pass.currentTier}</b> / {pass.tiers.length}
            </span>
            <Bar
              value={pass.tierProgress}
              color="var(--lemon)"
              label="Progress to next tier"
              className="tr-grow"
            />
          </div>
        </div>
        {!pass.premium && (
          <Button
            variant="primary"
            size="lg"
            cue="ui.confirm"
            onClick={() => uiEvents.emit('buyPremiumPass')}
          >
            Unlock Premium <Coin currency="gems" /> {formatNumber(pass.premiumPrice)}
          </Button>
        )}
        {pass.premium && <span className="tr-chip tr-chip--lemon">★ Premium active</span>}
      </Panel>
      <Panel tilt={0.3} delay={80} className="tr-pass-track-panel">
        <div className="tr-row tr-small" aria-hidden>
          <span className="tr-chip">▲ Free track</span>
          <span className="tr-chip tr-chip--grape">▼ Premium track</span>
        </div>
        <div className="tr-pass-track tr-scroll" ref={trackRef}>
          {pass.tiers.map((t) => {
            const unlocked = t.tier <= pass.currentTier;
            return (
              <div
                key={t.tier}
                className={`tr-pass-col${t.tier === pass.currentTier ? ' is-current' : ''}${unlocked ? ' is-unlocked' : ''}`}
              >
                <RewardCard reward={t.free} track="free" tier={t.tier} unlocked={unlocked} locked={false} />
                <span className="tr-pass-tier">
                  {t.tier === pass.currentTier ? <span className="tr-pass-pin">📍</span> : null}
                  {t.tier}
                </span>
                <RewardCard
                  reward={t.premium}
                  track="premium"
                  tier={t.tier}
                  unlocked={unlocked}
                  locked={!pass.premium}
                />
              </div>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}
