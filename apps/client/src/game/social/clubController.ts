/**
 * The signed-in player's club: loads it into the UI's club store, keeps it
 * current from realtime events and runs the club intents.
 *
 * Responsibilities:
 * - `GET /clubs/me` into the store (roster with presence, role, requests,
 *   invites), refetched on `club_update` and on every gateway reconnect;
 * - club chat: the Club tab of the chat widget and the club page's own input,
 *   live lines from `club_chat` plus the history once per club;
 * - invites and join requests as notifications and toasts, removals
 *   (kicked, disbanded) as a toast and a reset;
 * - discovery, the weekly goals and every member action, with clear toasts
 *   for the API's refusals;
 * - `503 feature_disabled`: the section says clubs are switched off instead
 *   of showing an error.
 */
import {
  clubs,
  social,
  ui,
  type ClubCardView,
  type ClubGoalsView,
  type ClubJoinRequestView,
  type MyClubView,
  type NotificationItem,
} from '@tumble/ui';
import {
  ApiError,
  type ApiClient,
  type ApiClubCard,
  type ApiClubChatLine,
  type ApiMyClub,
  type ApiParty,
} from '../api.ts';
import type { TypedMessage } from '../online/jsonSocket.ts';
import { chatHint, setChatRoute, setClubChat } from './chatRouter.ts';
import { uiPresence } from './friendsState.ts';
import type { RealtimeLike } from './socialController.ts';
import { socialErrorText } from './socialController.ts';
import { otherPlayerName, type OtherPlayer } from './streamerNames.ts';

/** What the controller needs from the account. */
export interface ClubHost {
  userId(): string | null;
  /** A party came back from the API (Party up made one). */
  applyParty(p: ApiParty): void;
  notify(
    kind: NotificationItem['kind'],
    title: string,
    body?: string,
    action?: NotificationItem['action'],
  ): void;
}

/**
 * A club card for the UI.
 *
 * @param c - API card.
 */
export function cardFromApi(c: ApiClubCard): ClubCardView {
  return {
    id: c.id,
    name: c.name,
    tag: c.tag,
    description: c.description,
    emblem: c.emblem,
    joinMode: c.joinMode,
    memberCount: c.memberCount,
    maxMembers: c.maxMembers,
  };
}

/**
 * `GET /clubs/me` for the UI store.
 *
 * @param r - API answer.
 * @param selfId - The local player, marked `isSelf` on the roster.
 */
export function clubFromApi(
  r: ApiMyClub,
  selfId: string | null,
): {
  club: MyClubView | null;
  role: ApiMyClub['role'];
  joinRequests: ClubJoinRequestView[];
  invites: { club: ClubCardView; from: { userId: string; name: string; tag: string } | null }[];
  pending: ClubCardView[];
} {
  return {
    club: r.club
      ? {
          ...cardFromApi(r.club),
          members: r.club.members.map((m) => ({
            userId: m.userId,
            name: m.displayName,
            tag: m.tag,
            level: m.level,
            role: m.role,
            presence: m.userId === selfId ? 'inMenu' : uiPresence(m.presence),
            isSelf: m.userId === selfId,
          })),
        }
      : null,
    role: r.role,
    joinRequests: (r.joinRequests ?? []).map((j) => ({
      userId: j.userId,
      name: j.displayName,
      tag: j.tag,
      level: j.level,
      at: Date.parse(j.at),
    })),
    invites: r.invites.map((i) => ({ club: cardFromApi(i.club), from: i.from })),
    pending: r.requests.map((q) => cardFromApi(q.club)),
  };
}

const isDisabled = (err: unknown): boolean => err instanceof ApiError && err.code === 'feature_disabled';

/**
 * Club features of the signed-in account.
 *
 * @example
 * const clubs = new ClubController(api, realtime, host);
 * clubs.bind();
 * await clubs.refresh();
 */
export class ClubController {
  private readonly offs: (() => void)[] = [];
  private historyFor: string | null = null;
  private searchSeq = 0;

  constructor(
    private readonly api: ApiClient,
    private readonly rt: RealtimeLike,
    private readonly host: ClubHost,
  ) {}

  /** Wires realtime events and the club chat route. */
  bind(): void {
    this.offs.push(
      this.rt.on('club_update', () => void this.refresh()),
      this.rt.on('club_chat', (m) => this.onChat(m)),
      this.rt.on('club_removed', (m) => {
        const name = String(m.name ?? 'your club');
        ui.getState().pushToast({
          kind: 'warning',
          title: m.reason === 'kicked' ? `You were removed from ${name}` : `${name} was disbanded`,
        });
        void this.refresh();
      }),
      this.rt.on('club_invite', (m) => this.onInvite(m)),
      this.rt.on('club_request', (m) => {
        const from = m.from as OtherPlayer | undefined;
        ui.getState().pushToast({
          kind: 'social',
          title: `${otherPlayerName(from, 'Someone')} wants to join your club`,
        });
        void this.refresh();
      }),
      this.rt.on('socket_open', () => void this.refresh()),
    );
  }

  /** Reloads the club, invites and requests (sign-in, reconnect, `club_update`). */
  async refresh(): Promise<void> {
    const store = clubs.getState();
    if (store.status !== 'ready') store.setStatus('loading');
    try {
      const v = clubFromApi(await this.api.myClub(), this.host.userId());
      clubs.getState().setLoaded(v);
      this.syncChat(v.club?.id ?? null);
    } catch (err) {
      if (isDisabled(err)) {
        clubs.getState().setStatus('disabled');
        this.syncChat(null);
      } else clubs.getState().setStatus('error', socialErrorText(err));
    }
  }

  /** Club tab, chat route and history follow the club the player is in. */
  private syncChat(clubId: string | null): void {
    setClubChat(clubId !== null);
    setChatRoute('club', clubId ? (text) => this.chat(text) : null);
    if (clubId === this.historyFor) return;
    if (this.historyFor) social.getState().dispatchChat({ type: 'clear', target: 'club' });
    this.historyFor = clubId;
    if (clubId)
      void this.api
        .clubChatHistory()
        .then((h) => {
          for (const l of h.lines) this.pushLine(l);
        })
        .catch(() => undefined);
  }

  private pushLine(l: ApiClubChatLine): void {
    const self = l.from.userId === this.host.userId();
    const tag = l.from.club ?? clubs.getState().club?.tag;
    social.getState().pushChat({
      id: `c:${l.id}`,
      channel: 'club',
      from: {
        userId: l.from.userId,
        name: l.from.name,
        tag: l.from.tag,
        key: l.from.userId,
        ...(tag ? { club: tag } : {}),
      },
      text: l.text,
      ...(l.masked ? { masked: l.masked } : {}),
      ...(self ? { self: true } : {}),
      at: l.at,
    });
  }

  private onChat(m: TypedMessage): void {
    if (typeof m.id !== 'string' || typeof m.text !== 'string' || !m.from) return;
    if (m.clubId !== clubs.getState().club?.id) return;
    this.pushLine(m as unknown as ApiClubChatLine);
  }

  private onInvite(m: TypedMessage): void {
    const clubId = String(m.clubId ?? '');
    if (!clubId) return;
    const from = m.from as OtherPlayer | undefined;
    const title = `${otherPlayerName(from, 'A friend')} invited you to ${String(m.name ?? 'a club')} [${String(m.tag ?? '')}]`;
    this.host.notify('invite', title, undefined, { kind: 'clubInvite', clubId });
    ui.getState().pushToast({
      kind: 'social',
      title,
      durationMs: 0,
      actions: [
        { id: `club-join:${clubId}`, label: 'Join club' },
        { id: `club-decline:${clubId}`, label: 'Not now' },
      ],
    });
    void this.refresh();
  }

  /**
   * Handles a club toast button.
   *
   * @returns True when the action was a club one.
   */
  handleToastAction(actionId: string): boolean {
    const [kind, clubId] = actionId.split(':') as [string, string | undefined];
    if ((kind === 'club-join' || kind === 'club-decline') && clubId) {
      void this.answerInvite(clubId, kind === 'club-join');
      return true;
    }
    return false;
  }

  private fail(title: string, err: unknown): void {
    if (isDisabled(err)) clubs.getState().setStatus('disabled');
    ui.getState().pushToast({ kind: 'warning', title, body: socialErrorText(err) });
  }

  /** Runs one member action with the busy flag, a refresh after and a toast on failure. */
  private async act(title: string, run: () => Promise<unknown>, done?: string): Promise<boolean> {
    clubs.getState().setBusy(true);
    try {
      await run();
      if (done) ui.getState().pushToast({ kind: 'success', title: done });
      return true;
    } catch (err) {
      this.fail(title, err);
      return false;
    } finally {
      clubs.getState().setBusy(false);
      await this.refresh();
    }
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /** Founds a club. */
  async create(body: Parameters<ApiClient['createClub']>[0]): Promise<void> {
    if (await this.act("Couldn't found the club", () => this.api.createClub(body), `${body.name} is open!`))
      clubs.getState().setTab('roster');
  }

  /** Joins (or asks to join) a club. */
  async join(clubId: string): Promise<void> {
    let status: string | null = null;
    await this.act("Couldn't join that club", async () => {
      status = (await this.api.joinClub(clubId)).status;
    });
    if (status === 'requested')
      ui.getState().pushToast({ kind: 'social', title: 'Request sent', body: 'An officer will let you in.' });
    else if (status === 'joined') ui.getState().pushToast({ kind: 'success', title: 'Welcome to the club!' });
  }

  /** Withdraws a join request. */
  cancelRequest(clubId: string): Promise<boolean> {
    return this.act("Couldn't cancel that request", () => this.api.cancelClubRequest(clubId));
  }

  /** Answers an invite (sheet, notification or toast). */
  async answerInvite(clubId: string, accept: boolean): Promise<void> {
    await this.act(
      accept ? "Couldn't join that club" : "Couldn't decline",
      () => this.api.answerClubInvite(clubId, accept),
      accept ? 'Welcome to the club!' : undefined,
    );
  }

  /** Officers: answers a join request. */
  answerRequest(userId: string, accept: boolean): Promise<boolean> {
    return this.act("Couldn't answer that request", () => this.api.answerClubRequest(userId, accept));
  }

  /** Officers: invites a friend. */
  invite(userId: string): Promise<boolean> {
    return this.act("Couldn't send the invite", () => this.api.inviteToClub(userId), 'Invite sent');
  }

  /** Edits the club. */
  edit(patch: Record<string, unknown>): Promise<boolean> {
    return this.act("Couldn't save the club", () => this.api.editClub(patch), 'Club saved');
  }

  /** Kicks, promotes, demotes or hands over to a member. */
  member(userId: string, action: 'kick' | 'officer' | 'member' | 'transfer'): Promise<boolean> {
    const run =
      action === 'kick'
        ? () => this.api.kickFromClub(userId)
        : action === 'transfer'
          ? () => this.api.transferClub(userId)
          : () => this.api.setClubRole(userId, action);
    return this.act("Couldn't update that member", run);
  }

  /** Leaves (or, as owner, disbands) the club. */
  async leave(disband: boolean): Promise<void> {
    if (
      await this.act(disband ? "Couldn't disband the club" : "Couldn't leave the club", () =>
        disband ? this.api.disbandClub() : this.api.leaveClub(),
      )
    )
      clubs.getState().setTab('roster');
  }

  /** Searches clubs (latest query wins) and refreshes the recommended list. */
  async search(query: string): Promise<void> {
    const seq = ++this.searchSeq;
    clubs.getState().setDiscovery({ query, loading: true });
    try {
      const [found, rec] = await Promise.all([
        this.api.searchClubs(query),
        this.api.recommendedClubs().catch(() => ({ clubs: [] })),
      ]);
      if (seq !== this.searchSeq) return;
      clubs.getState().setDiscovery({
        query,
        results: found.clubs.map(cardFromApi),
        recommended: rec.clubs.map(cardFromApi),
        loading: false,
      });
    } catch (err) {
      if (seq !== this.searchSeq) return;
      clubs.getState().setDiscovery({ query, results: [], loading: false });
      this.fail("Club search isn't working right now", err);
    }
  }

  /** Loads the recommended clubs (the section opened without a club). */
  async recommended(): Promise<void> {
    try {
      const rec = await this.api.recommendedClubs();
      clubs.getState().setDiscovery({ recommended: rec.clubs.map(cardFromApi) });
    } catch {
      // Discovery is a nicety; search still works.
    }
  }

  /** Loads the weekly goals. */
  async goals(): Promise<void> {
    const prev = clubs.getState().goals.data;
    clubs.getState().setGoals({ status: 'loading', data: prev });
    try {
      const g = await this.api.clubGoals();
      const data: ClubGoalsView = {
        week: g.week,
        refreshesAt: Date.parse(g.refreshesAt),
        eligible: g.eligible,
        goals: g.goals,
        contributions: g.contributions.map((c) => ({
          userId: c.userId,
          name: c.displayName,
          tag: c.tag,
          shows: c.shows,
          rounds: c.rounds,
          crowns: c.crowns,
        })),
      };
      clubs.getState().setGoals({ status: 'ready', data });
      for (const s of g.settled)
        ui.getState().pushToast({
          kind: 'reward',
          title: 'Club goal paid out',
          body: `${s.title}: +${s.xp} XP, +${s.gumballs} Gumballs`,
        });
    } catch (err) {
      clubs.getState().setGoals({ status: 'error', data: prev });
      if (isDisabled(err)) clubs.getState().setStatus('disabled');
    }
  }

  /** Claims a completed goal. */
  async claim(week: string, goalId: string): Promise<void> {
    if (
      await this.act(
        "Couldn't collect that goal",
        () => this.api.claimClubGoal(week, goalId),
        'Club goal collected!',
      )
    )
      await this.goals();
  }

  /** Invites an online club mate into the party. */
  async partyUp(userId: string): Promise<void> {
    try {
      const { party } = await this.api.clubPartyUp(userId);
      this.host.applyParty(party);
      ui.getState().pushToast({ kind: 'social', title: 'Party invite sent!' });
    } catch (err) {
      this.fail("Couldn't invite them", err);
    }
  }

  /** Reports a club. */
  async report(clubId: string, reason: string, details?: string): Promise<void> {
    try {
      await this.api.reportClub(clubId, reason, details);
      ui.getState().pushToast({
        kind: 'success',
        title: 'Report sent',
        body: 'Thanks. Our moderators will take a look.',
      });
    } catch (err) {
      this.fail("Couldn't send the report", err);
    }
  }

  /**
   * Club chat (gateway when connected, else HTTP).
   *
   * @param text - Message.
   */
  chat(text: string): void {
    const t = text.trim();
    if (!t || !clubs.getState().club) return;
    if (this.rt.connected) this.rt.send({ type: 'club_chat', text: t });
    else
      void this.api
        .clubChat(t)
        .then((r) => this.pushLine(r.message))
        .catch((err) => chatHint(socialErrorText(err)));
  }

  /** Removes listeners and forgets the club (sign-out). */
  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    setChatRoute('club', null);
    setClubChat(false);
    this.historyFor = null;
    clubs.getState().reset();
  }
}
