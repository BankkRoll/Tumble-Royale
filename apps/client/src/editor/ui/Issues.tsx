/**
 * Live validation: errors (which block Test play and sharing) and warnings,
 * each one selecting what it is about, plus the budgets that keep a round
 * playable at 100 players and how bots will cope.
 */
import type { JSX } from 'react';
import { CUSTOM_ROUND_LIMITS, type CustomRoundIssue } from '@tumble/content/custom';
import type { EditorPanel } from '../store.ts';
import type { ItemRef } from '../model.ts';
import { useActions, useEditor } from './kit.tsx';

/** What clicking an issue does: select its item, or open the panel it is about. */
export function issueTarget(issue: CustomRoundIssue): { select: ItemRef } | { panel: EditorPanel } | null {
  const t = issue.target;
  if (!t) return null;
  if (t.kind === 'settings') return { panel: 'round' };
  return { select: t };
}

function Budget(props: { label: string; used: number; max: number; unit?: string }): JSX.Element {
  const pct = Math.min(100, Math.round((props.used / props.max) * 100));
  const tone = props.used > props.max ? 'over' : pct > 80 ? 'near' : 'ok';
  return (
    <div className={`ed-budget ed-budget--${tone}`}>
      <span>{props.label}</span>
      <meter min={0} max={props.max} value={Math.min(props.used, props.max)} aria-label={props.label} />
      <span className="ed-budget-num">
        {props.used}/{props.max}
        {props.unit ?? ''}
      </span>
    </div>
  );
}

const BOTS: Record<string, string> = {
  route: 'Bots run straight lines between checkpoints, jumping the gaps on the way.',
  gaps: 'Bots run straight between checkpoints and will fall at a gap they cannot jump. Add checkpoints to steer them.',
  roam: 'Bots roam, dodge and chase points on their own in this round type.',
};

/** The issues and budgets panel. */
export function Issues(): JSX.Element {
  const v = useEditor((s) => s.validation);
  const { select, setPanel } = useActions();
  const errors = v.issues.filter((i) => i.severity === 'error');
  const warnings = v.issues.filter((i) => i.severity === 'warning');
  const L = CUSTOM_ROUND_LIMITS;
  return (
    <section className="ed-issues" aria-label="Checks">
      <header className="ed-section-head">
        <h2>Checks</h2>
        <span
          className={`ed-badge ${errors.length > 0 ? 'ed-badge--bad' : 'ed-badge--good'}`}
          data-testid="issue-summary"
        >
          {errors.length > 0 ? `${errors.length} error${errors.length === 1 ? '' : 's'}` : 'Ready to play'}
        </span>
      </header>
      {v.issues.length > 0 ? (
        <ul className="ed-issue-list">
          {[...errors, ...warnings].map((issue, i) => {
            const target = issueTarget(issue);
            return (
              <li key={`${issue.code}-${i}`} className={`ed-issue ed-issue--${issue.severity}`}>
                <button
                  type="button"
                  disabled={!target}
                  onClick={() => {
                    if (!target) return;
                    if ('select' in target) select([target.select]);
                    else setPanel(target.panel);
                  }}
                >
                  <span className="ed-issue-kind">{issue.severity === 'error' ? 'Error' : 'Warning'}</span>
                  {issue.message}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="ed-hint">No problems found.</p>
      )}
      {v.nav ? (
        <p className="ed-hint" data-testid="bot-route">
          {BOTS[v.nav.status]}
        </p>
      ) : null}
      <div className="ed-budgets">
        <Budget label="Level parts" used={v.stats.geometry} max={L.maxGeometry} />
        <Budget label="Obstacles" used={v.stats.obstacles} max={L.maxObstacles} />
        <Budget label="Physics parts" used={v.stats.colliders} max={L.maxObstacleColliders} />
        <Budget label="Size" used={Math.ceil(v.stats.bytes / 1024)} max={L.maxBytes / 1024} unit=" KB" />
      </div>
    </section>
  );
}
