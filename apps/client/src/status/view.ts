/**
 * The status page as a pure function of what the API answered: overall
 * state, maintenance, open incidents with their timeline, components with
 * 90 daily uptime bars, and the past 90 days of incidents.
 */
import {
  componentName,
  INCIDENT_STATUS_LABELS,
  OVERALL_LABELS,
  STATE_LABELS,
  type ComponentHistory,
  type ComponentState,
  type OverallState,
  type PublicIncident,
  type PublicMaintenance,
  type StatusHistory,
  type StatusSummary,
} from '@tumble/shared/status';
import { h, type Child, type VNode } from './vdom.ts';

/** Everything the page renders from. */
export interface PageState {
  summary: StatusSummary | null;
  history: StatusHistory | null;
  /** The last summary request failed (the summary, if any, is the last good one). */
  unreachable: boolean;
  /** Epoch ms of the last good summary. */
  lastOk: number | null;
  /** Clock (epoch ms). */
  now: number;
  /** Feed URLs. */
  feeds: { atom: string; json: string };
  /** Formats an instant for people (injected so tests are time-zone proof). */
  formatTime(iso: string): string;
}

const IMPACT_LABELS = { minor: 'Minor', major: 'Major', critical: 'Critical' } as const;

/**
 * "just now", "5 min ago", "in 2 h", "3 d ago".
 *
 * @param iso - Instant.
 * @param now - Clock (ms).
 */
export function relative(iso: string, now: number): string {
  const diff = Date.parse(iso) - now;
  const abs = Math.abs(diff);
  if (!Number.isFinite(abs) || abs < 60_000) return 'just now';
  const [n, unit] =
    abs >= 86_400_000
      ? [Math.floor(abs / 86_400_000), 'd']
      : abs >= 3_600_000
        ? [Math.floor(abs / 3_600_000), 'h']
        : [Math.floor(abs / 60_000), 'min'];
  return diff < 0 ? `${n} ${unit} ago` : `in ${n} ${unit}`;
}

/**
 * Uptime as people read it: `99.95%`, `100%`, or `No data`.
 *
 * @param ratio - 0..1 or null.
 */
export function percent(ratio: number | null): string {
  if (ratio === null) return 'No data';
  if (ratio >= 1) return '100%';
  // Floor rather than round: 99.996% must not read as 100%.
  return `${(Math.floor(ratio * 10_000) / 100).toFixed(2)}%`;
}

const stateClass = (s: ComponentState | OverallState | null) => `st-${s ?? 'none'}`;

function banner(s: PageState): VNode {
  if (!s.summary) {
    if (s.unreachable)
      return h(
        'section',
        { class: 'st-banner st-major_outage', role: 'status', 'data-testid': 'status-unreachable' },
        h('h2', {}, 'We can’t reach the status service'),
        h(
          'p',
          {},
          'That usually means the game’s servers are having trouble too. This page keeps trying on its own.',
        ),
      );
    return h(
      'section',
      { class: 'st-banner st-none', role: 'status', 'data-testid': 'status-loading' },
      h('h2', {}, 'Checking status…'),
    );
  }
  const o = s.summary.overall;
  return h(
    'section',
    { class: `st-banner ${stateClass(o)}`, role: 'status', 'data-testid': `overall-${o}` },
    h('h2', {}, OVERALL_LABELS[o]),
    h(
      'p',
      { class: 'st-sub' },
      s.unreachable && s.lastOk !== null
        ? `Last known status from ${relative(new Date(s.lastOk).toISOString(), s.now)}; the status service isn’t answering right now.`
        : `Updated ${relative(s.summary.generatedAt, s.now)}`,
    ),
  );
}

function maintenanceNotice(kind: 'active' | 'upcoming', m: PublicMaintenance, s: PageState): VNode {
  const when =
    kind === 'active'
      ? m.endsAt
        ? `Expected back ${s.formatTime(m.endsAt)} (${relative(m.endsAt, s.now)}).`
        : 'Until further notice.'
      : `Starts ${m.startsAt ? `${s.formatTime(m.startsAt)} (${relative(m.startsAt, s.now)})` : 'soon'}${
          m.endsAt ? `, expected to end ${s.formatTime(m.endsAt)}` : ''
        }.`;
  return h(
    'section',
    { class: `st-card st-notice st-maintenance`, 'data-testid': `maintenance-${kind}` },
    h('h2', {}, kind === 'active' ? 'Maintenance in progress' : 'Scheduled maintenance'),
    h('p', {}, m.message),
    h('p', { class: 'st-muted' }, when),
  );
}

function incidentCard(i: PublicIncident, s: PageState, open: boolean): VNode {
  const affected = i.components.length ? i.components.map(componentName).join(', ') : 'All services';
  return h(
    'article',
    { class: `st-incident st-impact-${i.impact}`, id: `incident-${i.id}`, 'data-testid': 'incident' },
    h(
      'header',
      {},
      h('h3', {}, i.title),
      h(
        'p',
        { class: 'st-muted' },
        `${IMPACT_LABELS[i.impact]} impact · ${affected} · `,
        open
          ? `started ${relative(i.startedAt, s.now)}`
          : `${s.formatTime(i.startedAt)}${i.resolvedAt ? ` – ${s.formatTime(i.resolvedAt)}` : ''}`,
      ),
    ),
    h(
      'ol',
      { class: 'st-timeline' },
      i.updates.map((u) =>
        h(
          'li',
          {},
          h('strong', {}, INCIDENT_STATUS_LABELS[u.status]),
          ' ',
          h('time', { datetime: u.at }, s.formatTime(u.at)),
          h('p', { class: 'st-update' }, u.message),
        ),
      ),
    ),
  );
}

function bars(c: ComponentHistory, days: readonly string[]): VNode {
  return h(
    'div',
    { class: 'st-bars', role: 'img', 'aria-label': `${c.name}: ${percent(c.uptime)} uptime over 90 days` },
    c.days.map((d, idx) =>
      h('span', {
        class: `st-bar ${stateClass(d.state)}`,
        title: `${days[idx] ?? ''} · ${d.state ? `${STATE_LABELS[d.state]} · ${percent(d.uptime)}` : 'No data'}`,
      }),
    ),
  );
}

function components(s: PageState): VNode | null {
  const sum = s.summary;
  if (!sum) return null;
  const history = new Map((s.history?.components ?? []).map((c) => [c.id, c]));
  const days = s.history?.days ?? [];
  return h(
    'section',
    { class: 'st-card', 'aria-labelledby': 'st-components' },
    h('h2', { id: 'st-components' }, 'Components'),
    h(
      'ul',
      { class: 'st-components' },
      sum.components.map((c) => {
        const hist = history.get(c.id);
        return h(
          'li',
          {
            class: `st-component${c.id.startsWith('gameservers:') ? ' st-region' : ''}`,
            'data-testid': `component-${c.id}`,
          },
          h(
            'div',
            { class: 'st-row' },
            h('span', { class: 'st-name' }, c.name),
            h('span', { class: `st-state ${stateClass(c.state)}` }, STATE_LABELS[c.state]),
          ),
          hist &&
            h(
              'div',
              { class: 'st-history' },
              bars(hist, days),
              h(
                'div',
                { class: 'st-axis st-muted' },
                h('span', {}, '90 days ago'),
                h('span', {}, `${percent(hist.uptime)} uptime`),
                h('span', {}, 'Today'),
              ),
            ),
        );
      }),
    ),
  );
}

function pastIncidents(s: PageState): Child {
  if (!s.history) return null;
  const open = new Set((s.summary?.incidents ?? []).map((i) => i.id));
  const past = s.history.incidents.filter((i) => !open.has(i.id));
  return h(
    'section',
    { class: 'st-card', 'aria-labelledby': 'st-past' },
    h('h2', { id: 'st-past' }, 'Past incidents'),
    past.length === 0
      ? h('p', { class: 'st-muted', 'data-testid': 'no-past-incidents' }, 'No incidents in the last 90 days.')
      : past.map((i) => incidentCard(i, s, false)),
  );
}

/**
 * The whole page body.
 *
 * @param s - Page state.
 * @returns The tree to mount into `#status`.
 */
export function statusPage(s: PageState): VNode {
  const sum = s.summary;
  return h(
    'div',
    { class: 'st-page' },
    h(
      'header',
      { class: 'st-head' },
      h('h1', {}, 'Tumble Royale status'),
      h('a', { href: '/', class: 'st-play' }, 'Play'),
    ),
    banner(s),
    sum?.maintenance.active && maintenanceNotice('active', sum.maintenance.active, s),
    sum?.maintenance.upcoming && maintenanceNotice('upcoming', sum.maintenance.upcoming, s),
    sum &&
      sum.incidents.length > 0 &&
      h(
        'section',
        { class: 'st-card', 'aria-labelledby': 'st-active' },
        h('h2', { id: 'st-active' }, 'Active incidents'),
        sum.incidents.map((i) => incidentCard(i, s, true)),
      ),
    components(s),
    pastIncidents(s),
    h(
      'footer',
      { class: 'st-foot st-muted' },
      'Subscribe: ',
      h('a', { href: s.feeds.atom }, 'Atom feed'),
      ' · ',
      h('a', { href: s.feeds.json }, 'JSON feed'),
      ' · Times are in your time zone; uptime days are UTC.',
    ),
  );
}
