/**
 * The public status page from the staff side: what players see right now,
 * and the incidents behind it. Moderators read; admins open incidents, post
 * updates and resolve them. Every write is audited by the API.
 */
import {
  INCIDENT_IMPACTS,
  INCIDENT_LIMITS,
  INCIDENT_STATUS_LABELS,
  INCIDENT_STATUSES,
  OVERALL_LABELS,
  STATE_LABELS,
  componentName,
  type ComponentState,
  type IncidentImpact,
  type IncidentStatus,
  type PublicIncident,
  type StatusSummary,
} from '@tumble/shared/status';
import { useState } from 'react';
import { Badge, StateBlock, useConsole, useLoad } from '../components.tsx';
import { isAdmin, relativeTime, shortTime } from '../format.ts';

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info';

/**
 * Badge tone for a component or overall state.
 *
 * @param state - State.
 */
export function stateTone(state: ComponentState): Tone {
  switch (state) {
    case 'operational':
      return 'good';
    case 'degraded':
    case 'partial_outage':
      return 'warn';
    case 'major_outage':
      return 'bad';
    case 'maintenance':
      return 'info';
    default:
      return 'neutral';
  }
}

const IMPACT_TONE: Record<IncidentImpact, Tone> = { minor: 'warn', major: 'warn', critical: 'bad' };

/** The status view. */
export function StatusView() {
  const { api, actor } = useConsole();
  const summary = useLoad('/status/summary', () => api.request<StatusSummary>('GET', '/status/summary'));
  const incidents = useLoad('/internal/status/incidents', () =>
    api.request<{ incidents: PublicIncident[] }>('GET', '/internal/status/incidents?state=all&limit=50'),
  );
  const reload = () => {
    summary.reload();
    incidents.reload();
  };
  const components = summary.data?.components.map((c) => c.id) ?? ['website', 'api', 'store', 'chat'];
  return (
    <section aria-labelledby="status-title">
      <header className="adm-view-head">
        <h1 id="status-title">Status page</h1>
        <a className="adm-btn adm-btn--ghost" href="/status" target="_blank" rel="noopener">
          Open public page
        </a>
      </header>
      <div className="adm-grid">
        <section className="adm-card">
          <header>
            <h2>What players see</h2>
          </header>
          <StateBlock state={summary} empty="" isEmpty={() => false}>
            {(s) => (
              <>
                <p>
                  <Badge tone={stateTone(s.overall)}>{OVERALL_LABELS[s.overall]}</Badge>
                </p>
                <ul className="adm-list">
                  {s.components.map((c) => (
                    <li key={c.id}>
                      {c.name} <Badge tone={stateTone(c.state)}>{STATE_LABELS[c.state]}</Badge>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </StateBlock>
        </section>
        {isAdmin(actor.role) ? (
          <OpenIncidentForm components={components} onDone={reload} />
        ) : (
          <section className="adm-card">
            <div className="adm-state">Opening and updating incidents needs the admin role.</div>
          </section>
        )}
        <section className="adm-card adm-card--wide">
          <header>
            <h2>Incidents</h2>
          </header>
          <StateBlock state={incidents} empty="No incidents yet." isEmpty={(d) => d.incidents.length === 0}>
            {(d) => (
              <div className="adm-stack">
                {d.incidents.map((i) => (
                  <IncidentCard key={i.id} incident={i} components={components} onDone={reload} />
                ))}
              </div>
            )}
          </StateBlock>
        </section>
      </div>
    </section>
  );
}

function ComponentPicker(props: { all: string[]; value: string[]; onChange(next: string[]): void }) {
  return (
    <fieldset className="adm-field">
      <legend>Affected components (none = the whole service)</legend>
      <div className="adm-inline-form">
        {props.all.map((id) => (
          <label key={id}>
            <input
              type="checkbox"
              checked={props.value.includes(id)}
              onChange={(e) =>
                props.onChange(e.target.checked ? [...props.value, id] : props.value.filter((x) => x !== id))
              }
            />{' '}
            {componentName(id)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function OpenIncidentForm(props: { components: string[]; onDone(): void }) {
  const { api, confirm } = useConsole();
  const [title, setTitle] = useState('');
  const [impact, setImpact] = useState<IncidentImpact>('minor');
  const [status, setStatus] = useState<IncidentStatus>('investigating');
  const [picked, setPicked] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const valid = title.trim().length >= 3 && message.trim().length > 0;
  return (
    <section className="adm-card">
      <header>
        <h2>Open an incident</h2>
      </header>
      <form
        className="adm-stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          confirm({
            title: 'Publish incident',
            body: 'It appears on the public status page and in the feeds at once.',
            confirmLabel: 'Publish',
            reason: 'none',
            run: async () => {
              await api.request('POST', '/internal/status/incidents', {
                title: title.trim(),
                impact,
                status,
                components: picked,
                message: message.trim(),
              });
              setTitle('');
              setMessage('');
              setPicked([]);
              props.onDone();
            },
            done: 'Incident published',
          });
        }}
      >
        <label className="adm-field">
          <span>Title (public)</span>
          <input
            value={title}
            maxLength={INCIDENT_LIMITS.titleMax}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <div className="adm-inline-form">
          <label className="adm-field">
            <span>Impact</span>
            <select value={impact} onChange={(e) => setImpact(e.target.value as IncidentImpact)}>
              {INCIDENT_IMPACTS.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </label>
          <label className="adm-field">
            <span>Status</span>
            <select value={status} onChange={(e) => setStatus(e.target.value as IncidentStatus)}>
              {INCIDENT_STATUSES.filter((x) => x !== 'resolved').map((x) => (
                <option key={x} value={x}>
                  {INCIDENT_STATUS_LABELS[x]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <ComponentPicker all={props.components} value={picked} onChange={setPicked} />
        <label className="adm-field">
          <span>First update (public, plain text)</span>
          <textarea
            rows={3}
            value={message}
            maxLength={INCIDENT_LIMITS.messageMax}
            onChange={(e) => setMessage(e.target.value)}
          />
        </label>
        <div className="adm-actions">
          <button type="submit" className="adm-btn adm-btn--primary" disabled={!valid}>
            Publish…
          </button>
        </div>
      </form>
    </section>
  );
}

/**
 * One incident with its timeline and, for admins on an open incident, the
 * update and resolve controls.
 *
 * @param props.incident - The incident.
 * @param props.components - Component ids that can be picked.
 * @param props.onDone - Called after a write succeeded.
 */
export function IncidentCard(props: { incident: PublicIncident; components: string[]; onDone(): void }) {
  const { api, actor, confirm, now } = useConsole();
  const i = props.incident;
  const [status, setStatus] = useState<IncidentStatus>(i.status === 'resolved' ? 'monitoring' : i.status);
  const [message, setMessage] = useState('');
  const resolved = i.status === 'resolved';
  return (
    <article className="adm-card" data-testid="adm-incident">
      <header>
        <h3>{i.title}</h3>
        <div>
          <Badge tone={IMPACT_TONE[i.impact]}>{i.impact}</Badge>{' '}
          <Badge tone={resolved ? 'good' : 'warn'}>{INCIDENT_STATUS_LABELS[i.status]}</Badge>
        </div>
      </header>
      <p className="adm-muted">
        {i.components.length ? i.components.map(componentName).join(', ') : 'All services'} · started{' '}
        <span title={shortTime(i.startedAt)}>{relativeTime(i.startedAt, now())}</span>
        {i.resolvedAt && ` · resolved ${shortTime(i.resolvedAt)}`}
      </p>
      <ol className="adm-stack">
        {i.updates.map((u, n) => (
          <li key={n}>
            <strong>{INCIDENT_STATUS_LABELS[u.status]}</strong>{' '}
            <span className="adm-muted">{shortTime(u.at)}</span>
            <div className="adm-quote">{u.message}</div>
          </li>
        ))}
      </ol>
      {isAdmin(actor.role) && (
        <form
          className="adm-stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (!message.trim()) return;
            confirm({
              title: `Post a ${INCIDENT_STATUS_LABELS[status].toLowerCase()} update`,
              body: resolved ? 'This reopens the incident on the public page.' : 'Players see it at once.',
              confirmLabel: 'Post update',
              reason: 'none',
              run: async () => {
                await api.request('POST', `/internal/status/incidents/${encodeURIComponent(i.id)}/updates`, {
                  status,
                  message: message.trim(),
                });
                setMessage('');
                props.onDone();
              },
              done: 'Update posted',
            });
          }}
        >
          <div className="adm-inline-form">
            <label className="adm-field">
              <span>Status</span>
              <select value={status} onChange={(e) => setStatus(e.target.value as IncidentStatus)}>
                {INCIDENT_STATUSES.map((x) => (
                  <option key={x} value={x}>
                    {INCIDENT_STATUS_LABELS[x]}
                  </option>
                ))}
              </select>
            </label>
            <label className="adm-field adm-col-wide">
              <span>Update (public, plain text)</span>
              <input
                value={message}
                maxLength={INCIDENT_LIMITS.messageMax}
                onChange={(e) => setMessage(e.target.value)}
              />
            </label>
          </div>
          <div className="adm-actions">
            <button type="submit" className="adm-btn" disabled={!message.trim()}>
              Post update…
            </button>
            {!resolved && (
              <button
                type="button"
                className="adm-btn adm-btn--primary"
                onClick={() =>
                  confirm({
                    title: `Resolve "${i.title}"`,
                    body: 'Posts a resolved update and moves it to past incidents.',
                    confirmLabel: 'Resolve',
                    reason: 'none',
                    run: async () => {
                      await api.request(
                        'POST',
                        `/internal/status/incidents/${encodeURIComponent(i.id)}/resolve`,
                        message.trim() ? { message: message.trim() } : {},
                      );
                      setMessage('');
                      props.onDone();
                    },
                    done: 'Incident resolved',
                  })
                }
              >
                Resolve…
              </button>
            )}
          </div>
        </form>
      )}
    </article>
  );
}
