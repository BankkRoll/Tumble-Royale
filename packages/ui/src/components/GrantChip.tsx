/**
 * A reward pill for the login ladder, achievements and challenge cards: a
 * coin or star glyph with the amount, or a cosmetic's preview and name.
 */
import type { JSX } from 'react';
import type { GrantView } from '../store/types.ts';
import { Coin } from './bits.tsx';
import { formatNumber } from './hooks.ts';
import { ItemPreview } from './ItemPreview.tsx';

const LABEL = { xp: 'XP', gumballs: 'Gumballs', gems: 'Gems', crownShards: 'Crown Shards' } as const;

/**
 * Plain-text description of a reward (tooltips, screen readers).
 *
 * @param g - The reward.
 * @example
 * grantText({ kind: 'gems', amount: 20 }); // '20 Gems'
 */
export function grantText(g: GrantView): string {
  return g.kind === 'item' ? g.item.name : `${formatNumber(g.amount)} ${LABEL[g.kind]}`;
}

/**
 * One reward pill.
 *
 * @param props.grant - The reward.
 * @param props.compact - Glyph and amount only (tight ladders).
 */
export function GrantChip({ grant, compact }: { grant: GrantView; compact?: boolean }): JSX.Element {
  if (grant.kind === 'item') {
    return (
      <span className={`tr-grant tr-grant--item tr-rar-frame--${grant.item.rarity}`} title={grant.item.name}>
        <ItemPreview item={grant.item} className="tr-grant-art" />
        {!compact && <small className="tr-ellipsis">{grant.item.name}</small>}
      </span>
    );
  }
  return (
    <span className={`tr-grant tr-grant--${grant.kind}`} title={grantText(grant)}>
      <Coin currency={grant.kind} />
      <b>{formatNumber(grant.amount)}</b>
      {!compact && <small>{LABEL[grant.kind]}</small>}
    </span>
  );
}
