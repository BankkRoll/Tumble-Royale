/**
 * Achievements (Profile → Achievements): overall and per-category progress,
 * then one card per achievement with its progress bar, tier, rewards and
 * unlock date. Locked hidden achievements show only "???". Filters: category
 * and locked/unlocked. Online accounts only; offline shows an explainer.
 */
import { useMemo, useState, type JSX } from 'react';
import { Bar } from '../../components/bits.tsx';
import { Segmented } from '../../components/controls.tsx';
import { GrantChip } from '../../components/GrantChip.tsx';
import { formatNumber } from '../../components/hooks.ts';
import { Icon } from '../../components/icons/index.tsx';
import { useUI } from '../../store/uiStore.ts';
import type { AchievementEntry } from '../../store/types.ts';

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI'];

type Show = 'all' | 'unlocked' | 'locked';

/** Locked goals first, the closest to done on top; unlocked ones after, in catalogue order. */
function byCloseness(a: AchievementEntry, b: AchievementEntry): number {
  if (a.unlocked !== b.unlocked) return a.unlocked ? 1 : -1;
  const pa = a.progress !== null && a.target ? a.progress / a.target : -1;
  const pb = b.progress !== null && b.target ? b.progress / b.target : -1;
  return pb - pa;
}

function AchievementCard({ a, delay }: { a: AchievementEntry; delay: number }): JSX.Element {
  const secret = a.hidden && !a.unlocked;
  const value = a.progress !== null && a.target ? a.progress / a.target : 0;
  return (
    <article
      className={`tr-ach${a.unlocked ? ' is-unlocked' : ''}${secret ? ' is-secret' : ''}`}
      style={{ animationDelay: `${delay}ms` }}
      data-testid={`achievement-${a.id}`}
      data-state={a.unlocked ? 'unlocked' : 'locked'}
    >
      <span className="tr-ach-badge" aria-hidden>
        <Icon name={a.unlocked ? 'medal' : secret ? 'eye' : 'lock'} size="1.8em" />
        {a.tier && <small>{ROMAN[a.tier.tier - 1] ?? a.tier.tier}</small>}
      </span>
      <div className="tr-col tr-grow" style={{ gap: '0.3em', minWidth: 0 }}>
        <div className="tr-row" style={{ gap: '0.4em', minWidth: 0 }}>
          <b className="tr-ach-title tr-ellipsis">{a.title}</b>
          {a.hidden && a.unlocked && <span className="tr-chip tr-chip--grape tr-ach-secret">Secret</span>}
        </div>
        <small className="tr-muted">{a.description}</small>
        {a.unlocked ? (
          <small className="tr-ach-date">
            <Icon name="check" size="0.9em" /> Unlocked{' '}
            {a.unlockedAt
              ? new Date(a.unlockedAt).toLocaleDateString(undefined, {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })
              : ''}
          </small>
        ) : secret ? null : (
          <div className="tr-ach-progress">
            <Bar value={value} color="var(--lemon)" label={`${a.title} progress`} />
            <small className="tr-nowrap">
              {formatNumber(a.progress ?? 0)} / {formatNumber(a.target ?? 0)}
            </small>
          </div>
        )}
        {a.rewards.length > 0 && (
          <span className="tr-ach-rewards">
            {a.rewards.map((g, i) => (
              <GrantChip key={i} grant={g} />
            ))}
          </span>
        )}
      </div>
    </article>
  );
}

/** Achievements view. */
export function AchievementsView(): JSX.Element {
  const data = useUI((s) => s.achievements);
  const [category, setCategory] = useState<string>('all');
  const [show, setShow] = useState<Show>('all');
  const groups = useMemo(() => {
    if (!data) return [];
    return data.categories
      .filter((c) => category === 'all' || c.id === category)
      .map((c) => ({
        ...c,
        list: data.list
          .filter((a) => a.category === c.id)
          .filter((a) => show === 'all' || (show === 'unlocked') === a.unlocked)
          .sort(byCloseness),
      }))
      .filter((g) => g.list.length > 0);
  }, [data, category, show]);

  if (!data) {
    return (
      <div className="tr-panel tr-empty" data-testid="achievements-offline">
        <Icon name="medal" size="2.4em" />
        <b>Achievements are tracked online</b>
        <small className="tr-muted">Play online shows to unlock achievements and their rewards.</small>
      </div>
    );
  }
  const pct = data.total > 0 ? data.unlocked / data.total : 0;
  return (
    <div className="tr-panel tr-achievements" data-testid="achievements">
      <header className="tr-ach-summary">
        <div className="tr-col tr-grow" style={{ gap: '0.3em' }}>
          <h2 className="tr-title tr-h3">Achievements</h2>
          <Bar value={pct} color="var(--mint)" large label="Achievements unlocked" />
        </div>
        <span className="tr-ach-count">
          <b className="tr-title tr-h2">{data.unlocked}</b>
          <small className="tr-muted">/ {data.total}</small>
        </span>
      </header>
      <div className="tr-row tr-wrap tr-ach-filters">
        <div className="tr-seg tr-scroll-x" role="group" aria-label="Category">
          <button
            type="button"
            aria-pressed={category === 'all'}
            data-nav=""
            onClick={() => setCategory('all')}
          >
            All
          </button>
          {data.categories.map((c) => (
            <button
              key={c.id}
              type="button"
              aria-pressed={category === c.id}
              data-nav=""
              onClick={() => setCategory(c.id)}
            >
              {c.name} {c.unlocked}/{c.total}
            </button>
          ))}
        </div>
        <Segmented<Show>
          label="Show"
          value={show}
          onChange={setShow}
          options={[
            { value: 'all', label: 'All' },
            { value: 'unlocked', label: 'Unlocked' },
            { value: 'locked', label: 'Locked' },
          ]}
        />
      </div>
      <div className="tr-ach-groups tr-scroll">
        {groups.length === 0 && <p className="tr-muted tr-empty">Nothing here yet. Keep playing!</p>}
        {groups.map((g) => (
          <section key={g.id} className="tr-ach-group" aria-label={g.name}>
            <header className="tr-ch-head">
              <h3 className="tr-title tr-ach-group-title">{g.name}</h3>
              <span className="tr-chip tr-chip--ink">
                {g.unlocked}/{g.total}
              </span>
            </header>
            <div className="tr-ach-grid">
              {g.list.map((a, i) => (
                <AchievementCard key={a.id} a={a} delay={Math.min(i, 10) * 30} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
