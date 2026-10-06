/**
 * Incident feeds for subscribers: JSON Feed 1.1 and Atom 1.0. Both carry
 * incident text as plain text only (`content_text`, `type="text"`), so a feed
 * reader never renders operator input as HTML.
 */
import type { MaintenanceStatus } from '@tumble/shared/liveops';
import { INCIDENT_STATUS_LABELS, componentName, type PublicIncident } from '@tumble/shared/status';

/** Where the feeds point. */
export interface FeedLinks {
  /** The status page (`https://play.example.com/status`). */
  page: string;
  /** This API's public base (`https://play.example.com/api`). */
  api: string;
}

const FEED_TITLE = 'Tumble Royale status';

function entryText(i: PublicIncident): string {
  const affected = i.components.length ? i.components.map(componentName).join(', ') : 'All services';
  const updates = i.updates.map((u) => `${INCIDENT_STATUS_LABELS[u.status]} (${u.at})\n${u.message}`);
  return [`Impact: ${i.impact}. Affected: ${affected}.`, ...updates].join('\n\n');
}

const entryTitle = (i: PublicIncident) =>
  i.status === 'resolved' ? `Resolved: ${i.title}` : `${INCIDENT_STATUS_LABELS[i.status]}: ${i.title}`;

const newest = (incidents: readonly PublicIncident[], fallback: string) =>
  incidents.reduce((m, i) => (i.updatedAt > m ? i.updatedAt : m), incidents.length ? '' : fallback);

/** A scheduled or running maintenance window as a feed entry. */
interface MaintenanceEntry {
  id: string;
  title: string;
  text: string;
  published: string;
}

/**
 * The maintenance window as a feed entry, so subscribers hear about planned
 * downtime too; null when none is scheduled or running.
 *
 * @param m - The window with its phase now.
 * @param nowIso - Publication time of a window without a start.
 */
export function maintenanceEntry(
  m: MaintenanceStatus | null | undefined,
  nowIso: string,
): MaintenanceEntry | null {
  if (!m || m.phase === 'off') return null;
  const window = [
    m.startsAt ? `From ${m.startsAt}` : 'Started now',
    m.endsAt ? `until ${m.endsAt}` : 'until further notice',
  ];
  return {
    id: `urn:tumble:maintenance:${m.startsAt ?? 'now'}`,
    title: m.phase === 'scheduled' ? 'Scheduled maintenance' : 'Maintenance in progress',
    text: `${m.message}\n\n${window.join(' ')}.`,
    published: m.startsAt ?? nowIso,
  };
}

/**
 * A JSON Feed 1.1 document of incidents.
 *
 * @param incidents - Incidents, newest first.
 * @param links - Public URLs.
 * @param maintenance - The maintenance window entry, listed first.
 * @returns The feed object (serialise with `JSON.stringify`).
 */
export function jsonFeed(
  incidents: readonly PublicIncident[],
  links: FeedLinks,
  maintenance: MaintenanceEntry | null = null,
): Record<string, unknown> {
  return {
    version: 'https://jsonfeed.org/version/1.1',
    title: FEED_TITLE,
    home_page_url: links.page,
    feed_url: `${links.api}/status/feed.json`,
    description: 'Incidents and maintenance updates for Tumble Royale.',
    items: [
      ...(maintenance
        ? [
            {
              id: maintenance.id,
              url: links.page,
              title: maintenance.title,
              content_text: maintenance.text,
              date_published: maintenance.published,
              tags: ['maintenance'],
            },
          ]
        : []),
      ...incidents.map((i) => ({
        id: `urn:uuid:${i.id}`,
        url: `${links.page}#incident-${i.id}`,
        title: entryTitle(i),
        content_text: entryText(i),
        date_published: i.startedAt,
        date_modified: i.updatedAt,
        tags: [i.impact, i.status],
      })),
    ],
  };
}

/**
 * Escapes text for XML element content and attribute values.
 *
 * @param s - Raw text.
 * @returns Text safe inside `<x>…</x>` and `a="…"`.
 */
export function xmlEscape(s: string): string {
  return (
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      // XML 1.0 forbids most control characters even when escaped.
      // eslint-disable-next-line no-control-regex -- removing them is the point
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
  );
}

/**
 * An Atom 1.0 document of incidents.
 *
 * @param incidents - Incidents, newest first.
 * @param links - Public URLs.
 * @param nowIso - `updated` of an empty feed.
 * @param maintenance - The maintenance window entry, listed first.
 * @returns The XML text.
 */
export function atomFeed(
  incidents: readonly PublicIncident[],
  links: FeedLinks,
  nowIso: string,
  maintenance: MaintenanceEntry | null = null,
): string {
  const e = xmlEscape;
  const planned = maintenance
    ? [
        `  <entry>
    <id>${e(maintenance.id)}</id>
    <title type="text">${e(maintenance.title)}</title>
    <link rel="alternate" type="text/html" href="${e(links.page)}"/>
    <published>${e(maintenance.published)}</published>
    <updated>${e(maintenance.published)}</updated>
    <category term="maintenance"/>
    <content type="text">${e(maintenance.text)}</content>
  </entry>`,
      ]
    : [];
  const entries = incidents.map(
    (i) => `  <entry>
    <id>urn:uuid:${e(i.id)}</id>
    <title type="text">${e(entryTitle(i))}</title>
    <link rel="alternate" type="text/html" href="${e(`${links.page}#incident-${i.id}`)}"/>
    <published>${e(i.startedAt)}</published>
    <updated>${e(i.updatedAt)}</updated>
    <category term="${e(i.impact)}"/>
    <content type="text">${e(entryText(i))}</content>
  </entry>`,
  );
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${e(links.page)}</id>
  <title type="text">${FEED_TITLE}</title>
  <updated>${e(newest(incidents, nowIso))}</updated>
  <author><name>Tumble Royale</name></author>
  <link rel="self" type="application/atom+xml" href="${e(`${links.api}/status/feed.atom`)}"/>
  <link rel="alternate" type="text/html" href="${e(links.page)}"/>
${[...planned, ...entries].join('\n')}
</feed>
`;
}
