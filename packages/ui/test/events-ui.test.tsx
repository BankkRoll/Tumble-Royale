/**
 * Server-rendered checks for limited-time events: the Play tab tile and the
 * event screen in every state (live, upcoming, ended, offline, switched off,
 * maintenance), claim buttons only where a claim can succeed, and the
 * Challenges tab switch.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { ChallengesTab } from '../src/screens/menu/ChallengesTab.tsx';
import {
  claimableCount,
  EventCard,
  EventScreen,
  eventCountdown,
  featuredEvent,
} from '../src/screens/menu/EventsView.tsx';
import { ui } from '../src/store/uiStore.ts';
import type { EventsData, LiveEventView } from '../src/store/types.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;

const NOW = Date.now();
const HOUR = 3_600_000;

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');
}

function event(over: Partial<LiveEventView> = {}): LiveEventView {
  return {
    id: 'moonlit-mischief',
    name: 'Moonlit Mischief',
    description: 'The fairground stays open after dark.',
    art: ['#5b2a86', '#ff8a3d'],
    icon: 'swirl',
    startsAt: NOW - 24 * HOUR,
    // A minute of slack: useNow reads the clock again at render.
    endsAt: NOW + 50 * HOUR + 60_000,
    phase: 'live',
    playlists: ['Chaos Mode'],
    multiplier: 2,
    perShow: 20,
    points: 300,
    tiers: [
      { tier: 1, points: 100, rewards: [{ kind: 'gumballs', amount: 150 }], state: 'claimed' },
      { tier: 2, points: 250, rewards: [{ kind: 'gems', amount: 20 }], state: 'claimable' },
      { tier: 3, points: 450, rewards: [{ kind: 'xp', amount: 2500 }], state: 'locked' },
    ],
    challenges: [
      {
        id: 'mm-crown-event-1',
        title: 'Win a Crown in Chaos Mode',
        metric: 'crowns',
        progress: 1,
        goal: 1,
        points: 300,
        xp: 3000,
        eventPlaylistsOnly: true,
        claimed: false,
      },
      {
        id: 'mm-play-25',
        title: 'Play 25 shows during the event',
        metric: 'showsPlayed',
        progress: 4,
        goal: 25,
        points: 200,
        xp: 2000,
        eventPlaylistsOnly: false,
        claimed: false,
      },
    ],
    ...over,
  };
}

function setEvents(data: Partial<EventsData> & { list: LiveEventView[] }): void {
  ui.getState().setEvents({ enabled: true, online: true, ...data });
}

beforeEach(() => {
  ui.getState().setLiveOps({ flags: {}, maintenance: null });
  ui.getState().setEvents(null);
  ui.getState().setChallengesView('board');
});

describe('event helpers', () => {
  it('counts down to the end, or to the start for a teaser', () => {
    expect(eventCountdown(event(), NOW)).toBe('Ends in 2d 2h');
    expect(eventCountdown(event({ phase: 'upcoming', startsAt: NOW + 90_000 }), NOW)).toBe('Starts in 1:30');
    expect(eventCountdown(event({ phase: 'ended' }), NOW)).toBe('Ended');
  });

  it('spotlights the live event, then the next one, then the last one', () => {
    const live = event();
    const soon = event({ id: 'b', phase: 'upcoming' });
    const over = event({ id: 'c', phase: 'ended' });
    expect(featuredEvent([over, live, soon])?.id).toBe(live.id);
    expect(featuredEvent([over, soon])?.id).toBe('b');
    expect(featuredEvent([over])?.id).toBe('c');
    expect(featuredEvent([])).toBeNull();
    expect(claimableCount(live)).toBe(2);
  });
});

describe('event tile', () => {
  it('shows the live event with its countdown and claimables', () => {
    setEvents({ list: [event()] });
    const html = renderToStaticMarkup(<EventCard />);
    expect(html).toContain('data-testid="event-card"');
    expect(text(html)).toContain('Live event');
    expect(text(html)).toContain('Moonlit Mischief');
    expect(text(html)).toContain('Ends in 2d 2h');
    expect(text(html)).toContain('300 / 450 points to tier 3');
    expect(text(html)).toContain('2 event rewards to claim');
  });

  it('teases an upcoming event', () => {
    setEvents({ list: [event({ phase: 'upcoming', startsAt: NOW + 3 * 24 * HOUR + 60_000, points: 0 })] });
    const t = text(renderToStaticMarkup(<EventCard />));
    expect(t).toContain('Coming soon');
    expect(t).toContain('Starts in 3d 0h');
  });

  it('hides when events are off, ended or unknown', () => {
    expect(renderToStaticMarkup(<EventCard />)).toBe('');
    setEvents({ list: [event({ phase: 'ended' })] });
    expect(renderToStaticMarkup(<EventCard />)).toBe('');
    setEvents({ list: [event()], enabled: false });
    expect(renderToStaticMarkup(<EventCard />)).toBe('');
    setEvents({ list: [event()] });
    ui.getState().setLiveOps({ flags: { 'events.enabled': false } });
    expect(renderToStaticMarkup(<EventCard />)).toBe('');
  });

  it('never counts claimables offline', () => {
    setEvents({ list: [event()], online: false });
    expect(text(renderToStaticMarkup(<EventCard />))).not.toContain('to claim');
  });
});

describe('event screen', () => {
  it('shows the live track with claim buttons only on claimable rows', () => {
    setEvents({ list: [event()] });
    const html = renderToStaticMarkup(<EventScreen />);
    expect(html).toContain('data-phase="live"');
    expect(html).toMatch(/data-testid="event-tier-1" data-state="claimed"/);
    expect(html).toMatch(/data-testid="event-tier-2" data-state="claimable"/);
    expect(html).toMatch(/data-testid="event-tier-3" data-state="locked"/);
    expect(html.match(/data-testid="event-tier-claim"/g)).toHaveLength(1);
    expect(html.match(/data-testid="event-challenge-claim"/g)).toHaveLength(1);
    const t = text(html);
    expect(t).toContain('2x points in Chaos Mode');
    expect(t).toContain('150 points to tier 3');
    expect(t).toContain('featured shows only');
    expect(html).not.toContain('event-offline');
  });

  it('previews an upcoming event without claims', () => {
    setEvents({ list: [event({ phase: 'upcoming', startsAt: NOW + 5 * HOUR, points: 0 })] });
    const html = renderToStaticMarkup(<EventScreen />);
    expect(html).toContain('data-testid="event-upcoming"');
    expect(html).not.toContain('event-tier-claim');
    expect(html).not.toContain('event-challenge-claim');
    expect(text(html)).toMatch(/Starts in 0[45]:[0-5]\d:\d\d/);
  });

  it('explains an ended event pays out on its own', () => {
    setEvents({ list: [event({ phase: 'ended' })] });
    const html = renderToStaticMarkup(<EventScreen />);
    expect(html).toContain('data-testid="event-ended"');
    expect(text(html)).toContain('Ended');
  });

  it('shows the event offline, explaining progress needs online play', () => {
    setEvents({ list: [event()], online: false });
    const html = renderToStaticMarkup(<EventScreen />);
    expect(html).toContain('data-testid="event-offline"');
    expect(text(html)).toContain('Event progress needs online play');
    expect(html).not.toContain('event-tier-claim');
    expect(html).not.toContain('event-challenge-claim');
  });

  it('says when events are switched off', () => {
    setEvents({ list: [event()], enabled: false });
    expect(renderToStaticMarkup(<EventScreen />)).toContain('data-testid="event-disabled"');
    setEvents({ list: [event()] });
    ui.getState().setLiveOps({ flags: { 'events.enabled': false } });
    expect(renderToStaticMarkup(<EventScreen />)).toContain('data-testid="event-disabled"');
  });

  it('holds claims during maintenance', () => {
    setEvents({ list: [event()] });
    ui.getState().setLiveOps({
      maintenance: { phase: 'active', message: 'Patch day', startsAt: null, endsAt: null },
    });
    const html = renderToStaticMarkup(<EventScreen />);
    expect(html).toContain('data-testid="event-maintenance"');
    expect(html).not.toContain('event-tier-claim');
  });

  it('lets the player pick between several events', () => {
    setEvents({
      list: [event(), event({ id: 'frostbite-frolic', name: 'Frostbite Frolic', phase: 'upcoming' })],
    });
    const t = text(renderToStaticMarkup(<EventScreen />));
    expect(t).toContain('Frostbite Frolic');
    expect(t).toContain('Moonlit Mischief');
  });

  it('is empty without events', () => {
    expect(renderToStaticMarkup(<EventScreen />)).toContain('data-testid="event-empty"');
  });
});

describe('challenges tab switch', () => {
  it('offers the event next to the board and opens it', () => {
    setEvents({ list: [event()] });
    expect(text(renderToStaticMarkup(<ChallengesTab />))).toContain('Moonlit Mischief');
    ui.getState().openEvents();
    expect(ui.getState().menuTab).toBe('challenges');
    expect(renderToStaticMarkup(<ChallengesTab />)).toContain('data-testid="event-screen"');
  });

  it('has no switch without events', () => {
    expect(renderToStaticMarkup(<ChallengesTab />)).not.toContain('Challenges or event');
  });
});
