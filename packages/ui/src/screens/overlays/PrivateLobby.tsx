/**
 * The live private show lobby, shown inside `PrivateShowDialog` once a lobby
 * exists. Everything here is pushed from the matchmaker; the view only emits
 * intents.
 *
 * Responsibilities:
 * - invite code (copy, streamer-mode reveal) and, for the host, lock/unlock
 *   and a fresh code;
 * - lobby settings: editable by the host (debounced), read-only for members;
 * - players and spectators with crown, ready and away states; the host can
 *   remove (with a confirm) or crown any other member, and lift bans;
 * - the footer: ready toggle and play/spectate switch for members, Start for
 *   the host with its blockers and a force start past the ready check.
 */
import { MAX_PLAYERS } from '@tumble/shared';
import { useEffect, useRef, useState, type JSX } from 'react';
import { Button, Slider, Toggle } from '../../components/controls.tsx';
import { useAccountName } from '../../components/hooks.ts';
import { Icon } from '../../components/icons/index.tsx';
import { TumblerAvatar } from '../../components/TumblerAvatar.tsx';
import { uiEvents } from '../../store/events.ts';
import { ui, useUI } from '../../store/uiStore.ts';
import type { CustomLobbyMember, CustomLobbyOptions, CustomLobbyState } from '../../store/types.ts';
import { PlayerButton } from './PlayerActions.tsx';
import { RoundPicker, roundName } from './RoundPicker.tsx';

/** Settings edits are sent after this much quiet, so a slider drag is one request. */
const SETTINGS_DEBOUNCE_MS = 350;
/** A sent edit that no pushed update confirmed by now was refused or overridden. */
export const SETTINGS_CONFIRM_MS = 4000;
const DEFAULT_SPECTATOR_SLOTS = 2;

/** Whether the host can start, and what to tell them otherwise. */
export interface LobbyStartState {
  canStart: boolean;
  /** Why Start is disabled, or null. */
  reason: string | null;
  /** Players who have not readied up (Start then asks before forcing). */
  waitingOn: string[];
}

/**
 * Mirrors the matchmaker's start blockers so the button explains itself
 * before the host clicks.
 *
 * @param lobby - The lobby.
 * @param nameOf - Display name for a member (Streamer Mode masks strangers).
 * @example lobbyStartState(lobby).reason // "Waiting for players: 1/4"
 */
export function lobbyStartState(
  lobby: CustomLobbyState,
  nameOf: (m: CustomLobbyMember) => string = (m) => m.name,
): LobbyStartState {
  const min = Math.max(1, lobby.options.minPlayers ?? 1);
  const n = lobby.players.length;
  if (n < min) return { canStart: false, reason: `Waiting for players: ${n}/${min}`, waitingOn: [] };
  if (!lobby.options.bots && n < 2)
    return { canStart: false, reason: 'Turn bots on or wait for a second player', waitingOn: [] };
  return {
    canStart: true,
    reason: null,
    waitingOn: lobby.players.filter((p) => !p.isHost && !p.ready).map(nameOf),
  };
}

// -----------------------------------------------------------------------------
// Settings
// -----------------------------------------------------------------------------

type OptionKey = keyof CustomLobbyOptions;

/** When each drafted setting was sent to the matchmaker; null while it still waits for the debounce. */
export type DraftSentAt = Partial<Record<OptionKey, number | null>>;

/**
 * Which host edits survive a pushed lobby update. Any member joining or
 * readying pushes the whole lobby, so dropping the draft on every push made
 * a slider snap back mid-drag. An edit goes once the push shows its value
 * (it landed); it stays while unsent or in flight; and a sent edit that no
 * push confirmed within {@link SETTINGS_CONFIRM_MS} is dropped, since the
 * matchmaker refused it or another change won.
 *
 * @param draft - Edited values over the pushed settings.
 * @param sentAt - Per edited key: send time, or null while debouncing.
 * @param pushed - The latest settings from the matchmaker.
 * @param now - Epoch ms.
 * @returns The edits (and their send times) still to show.
 */
export function reconcileSettingsDraft(
  draft: Partial<CustomLobbyOptions>,
  sentAt: DraftSentAt,
  pushed: CustomLobbyOptions,
  now: number,
): { draft: Partial<CustomLobbyOptions>; sentAt: DraftSentAt } {
  const nextDraft: Partial<Record<OptionKey, unknown>> = {};
  const nextSent: DraftSentAt = {};
  for (const key of Object.keys(draft) as OptionKey[]) {
    const value = draft[key];
    if (JSON.stringify(value) === JSON.stringify(pushed[key])) continue;
    const sent = sentAt[key];
    if (sent !== null && sent !== undefined && now - sent >= SETTINGS_CONFIRM_MS) continue;
    nextDraft[key] = value;
    nextSent[key] = sent ?? null;
  }
  return { draft: nextDraft as Partial<CustomLobbyOptions>, sentAt: nextSent };
}

/** Local draft over the pushed settings, flushed as one `updateCustom` after a pause. */
function useSettingsDraft(options: CustomLobbyOptions) {
  const [draft, setDraft] = useState<Partial<CustomLobbyOptions>>({});
  const sentAt = useRef<DraftSentAt>({});
  const latest = useRef(options);
  latest.current = options;
  const pending = useRef<Partial<CustomLobbyOptions>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expiry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconcile = (): void =>
    setDraft((d) => {
      const r = reconcileSettingsDraft(d, sentAt.current, latest.current, Date.now());
      sentAt.current = r.sentAt;
      return Object.keys(r.draft).length === Object.keys(d).length ? d : r.draft;
    });
  const flush = (): void => {
    timer.current = null;
    const patch = pending.current;
    pending.current = {};
    if (Object.keys(patch).length === 0) return;
    const at = Date.now();
    for (const key of Object.keys(patch) as OptionKey[]) sentAt.current[key] = at;
    uiEvents.emit('updateCustom', { options: patch });
    // A refused patch brings no push at all; let the confirm window lapse on its own.
    if (expiry.current) clearTimeout(expiry.current);
    expiry.current = setTimeout(reconcile, SETTINGS_CONFIRM_MS + 50);
  };
  useEffect(reconcile, [options]);
  useEffect(
    () => () => {
      if (expiry.current) clearTimeout(expiry.current);
      if (timer.current) {
        clearTimeout(timer.current);
        flush();
      }
    },
    [],
  );
  const change = (p: Partial<CustomLobbyOptions>): void => {
    setDraft((d) => ({ ...d, ...p }));
    for (const key of Object.keys(p) as OptionKey[]) sentAt.current[key] = null;
    pending.current = { ...pending.current, ...p };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, SETTINGS_DEBOUNCE_MS);
  };
  return { value: { ...options, ...draft }, change };
}

function HostSettings({ lobby }: { lobby: CustomLobbyState }): JSX.Element {
  const { value: o, change } = useSettingsDraft(lobby.options);
  const [editRounds, setEditRounds] = useState(false);
  const catalog = useUI((s) => s.roundCatalog);
  const slots = o.spectatorSlots ?? (o.spectators ? DEFAULT_SPECTATOR_SLOTS : 0);
  const min = Math.min(o.minPlayers ?? 1, o.maxPlayers);
  return (
    <section className="tr-pshow-rules" aria-label="Show settings">
      <div className="tr-pshow-section-head">
        <span className="tr-label tr-grow">Show settings</span>
        <button type="button" className="tr-link-btn" data-nav="" onClick={() => setEditRounds((v) => !v)}>
          {editRounds ? 'Done' : `Rounds (${o.rounds.length})`}
        </button>
      </div>
      {editRounds ? (
        <RoundPicker
          picked={o.rounds}
          onChange={(rounds) => {
            // An empty show cannot start; keep at least one round picked.
            if (rounds.length > 0) change({ rounds });
          }}
        />
      ) : (
        <p className="tr-small tr-muted tr-ellipsis">
          {o.rounds.map((id) => roundName(id, catalog)).join(' · ') || 'No rounds'}
        </p>
      )}
      <div className="tr-settings-row">
        <span>Fill empty spots with bots</span>
        <Toggle label="Bots" checked={o.bots} onChange={(bots) => change({ bots })} />
      </div>
      <div className="tr-settings-row">
        <span>Max players</span>
        <Slider
          label="Max players"
          value={o.maxPlayers}
          min={Math.max(2, lobby.players.length)}
          max={MAX_PLAYERS}
          step={1}
          format={(v) => String(v)}
          onChange={(maxPlayers) =>
            change({ maxPlayers, ...(min > maxPlayers ? { minPlayers: maxPlayers } : {}) })
          }
        />
      </div>
      <div className="tr-settings-row">
        <span>Players needed to start</span>
        <Slider
          label="Players needed to start"
          value={min}
          min={1}
          max={o.maxPlayers}
          step={1}
          format={(v) => String(v)}
          onChange={(minPlayers) => change({ minPlayers })}
        />
      </div>
      <div className="tr-settings-row">
        <span>Round length</span>
        <Slider
          label="Round length"
          value={o.timerScale}
          min={0.5}
          max={2}
          step={0.25}
          format={(v) => `×${v}`}
          onChange={(timerScale) => change({ timerScale })}
        />
      </div>
      <div className="tr-settings-row">
        <span>Pre-show countdown</span>
        <Slider
          label="Pre-show countdown"
          value={o.countdownSec ?? 10}
          min={0}
          max={60}
          step={5}
          format={(v) => `${v}s`}
          onChange={(countdownSec) => change({ countdownSec })}
        />
      </div>
      <div className="tr-settings-row">
        <span>Allow spectators</span>
        <Toggle
          label="Spectators"
          checked={slots > 0}
          onChange={(on) =>
            change({ spectators: on, spectatorSlots: on ? Math.max(1, DEFAULT_SPECTATOR_SLOTS) : 0 })
          }
        />
      </div>
      {slots > 0 && (
        <div className="tr-settings-row">
          <span>Spectator slots</span>
          <Slider
            label="Spectator slots"
            value={slots}
            min={Math.max(1, lobby.spectators.length)}
            max={10}
            step={1}
            format={(v) => String(v)}
            onChange={(spectatorSlots) => change({ spectatorSlots, spectators: true })}
          />
        </div>
      )}
    </section>
  );
}

function SettingsSummary({ lobby }: { lobby: CustomLobbyState }): JSX.Element {
  const catalog = useUI((s) => s.roundCatalog);
  const o = lobby.options;
  const slots = o.spectatorSlots ?? (o.spectators ? DEFAULT_SPECTATOR_SLOTS : 0);
  const rows: [string, string][] = [
    ['Rounds', o.rounds.map((id) => roundName(id, catalog)).join(' · ') || 'None'],
    ['Max players', String(o.maxPlayers)],
    ['Players needed to start', String(o.minPlayers ?? 1)],
    ['Bots fill empty spots', o.bots ? 'Yes' : 'No'],
    ['Round length', `×${o.timerScale}`],
    ['Pre-show countdown', `${o.countdownSec ?? 10}s`],
    ['Spectator slots', slots > 0 ? String(slots) : 'Off'],
  ];
  return (
    <section className="tr-pshow-rules" aria-label="Show settings">
      <span className="tr-label">Show settings · set by the host</span>
      <dl className="tr-lobby-settings" data-testid="lobby-settings">
        {rows.map(([k, v]) => (
          <div key={k} className="tr-settings-row">
            <dt>{k}</dt>
            <dd className="tr-ellipsis">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// -----------------------------------------------------------------------------
// Members
// -----------------------------------------------------------------------------

function MemberRow({
  m,
  spectator,
  hostView,
  armed,
  onArm,
}: {
  m: CustomLobbyMember;
  spectator: boolean;
  hostView: boolean;
  armed: boolean;
  onArm: (id: string | null) => void;
}): JSX.Element {
  const canManage = hostView && !m.isSelf;
  const name = useAccountName()(m);
  return (
    <div
      className={`tr-lobby-member${m.isSelf ? ' is-self' : ''}${m.away ? ' is-away' : ''}`}
      data-testid="lobby-member"
    >
      <PlayerButton player={{ userId: m.id, name, key: m.id }} disabled={m.isSelf}>
        <TumblerAvatar colors={m.colors} size="2.2em" blink={false} noShadow />
        <span className="tr-grow tr-ellipsis tr-lobby-member-name">
          {m.isHost ? (
            <span className="tr-lobby-crown" aria-label="Host" title="Host">
              <Icon name="crown" size="0.95em" />
            </span>
          ) : null}
          {name}
          {m.isSelf ? <span className="tr-muted"> (you)</span> : null}
        </span>
      </PlayerButton>
      {armed ? (
        <span className="tr-row tr-lobby-confirm" role="group" aria-label={`Remove ${name}?`}>
          <span className="tr-small">Remove?</span>
          <Button
            size="sm"
            variant="danger"
            cue="ui.confirm"
            data-testid="kick-confirm"
            onClick={() => {
              onArm(null);
              uiEvents.emit('kickCustomMember', { userId: m.id });
            }}
          >
            Remove
          </Button>
          <Button size="sm" variant="ghost" cue="ui.back" autoFocusNav onClick={() => onArm(null)}>
            Cancel
          </Button>
        </span>
      ) : (
        <>
          {m.away ? <span className="tr-chip tr-chip--lemon">Reconnecting</span> : null}
          {!spectator &&
            (m.ready ? (
              <span className="tr-chip tr-chip--good">
                <Icon name="check" size="0.85em" /> Ready
              </span>
            ) : (
              <span className="tr-chip">Not ready</span>
            ))}
          {canManage && !spectator && (
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Make ${name} the host`}
              title="Make host"
              onClick={() => uiEvents.emit('transferCustomHost', { userId: m.id })}
            >
              <Icon name="crown" size="1em" />
            </Button>
          )}
          {canManage && (
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Remove ${name}`}
              title="Remove from the show"
              data-testid="kick"
              onClick={() => onArm(m.id)}
            >
              <Icon name="close" size="1em" />
            </Button>
          )}
        </>
      )}
    </div>
  );
}

function Members({ lobby }: { lobby: CustomLobbyState }): JSX.Element {
  const [armed, setArmed] = useState<string | null>(null);
  const nameOf = useAccountName();
  const slots = lobby.options.spectatorSlots ?? (lobby.options.spectators ? DEFAULT_SPECTATOR_SLOTS : 0);
  return (
    <section className="tr-pshow-players" aria-label="Players">
      <span className="tr-label">
        Players · {lobby.players.length}/{lobby.options.maxPlayers}
      </span>
      <div className="tr-lobby-members tr-scroll">
        {lobby.players.map((m) => (
          <MemberRow
            key={m.id}
            m={m}
            spectator={false}
            hostView={lobby.isHost}
            armed={armed === m.id}
            onArm={setArmed}
          />
        ))}
      </div>
      {(slots > 0 || lobby.spectators.length > 0) && (
        <>
          <span className="tr-label">
            <Icon name="eye" size="0.9em" /> Spectators · {lobby.spectators.length}/{slots}
          </span>
          <div className="tr-lobby-members" data-testid="lobby-spectators">
            {lobby.spectators.length === 0 ? (
              <p className="tr-small tr-muted">Nobody is watching yet.</p>
            ) : (
              lobby.spectators.map((m) => (
                <MemberRow
                  key={m.id}
                  m={m}
                  spectator
                  hostView={lobby.isHost}
                  armed={armed === m.id}
                  onArm={setArmed}
                />
              ))
            )}
          </div>
        </>
      )}
      {lobby.isHost && lobby.banned.length > 0 && (
        <>
          <span className="tr-label">Removed · can't rejoin</span>
          <div className="tr-lobby-members" data-testid="lobby-banned">
            {lobby.banned.map((b) => (
              <div key={b.id} className="tr-lobby-member is-banned">
                <span className="tr-grow tr-ellipsis">{nameOf(b)}</span>
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={`Let ${nameOf(b)} rejoin`}
                  onClick={() => uiEvents.emit('unbanCustomMember', { userId: b.id })}
                >
                  Unban
                </Button>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

// -----------------------------------------------------------------------------
// Code + footer
// -----------------------------------------------------------------------------

function CodePanel({ lobby }: { lobby: CustomLobbyState }): JSX.Element {
  const streamer = useUI((s) => s.settings.gameplay.streamerMode);
  const [reveal, setReveal] = useState(false);
  return (
    <section className="tr-pshow-code" aria-label="Invite code">
      <span className="tr-label">
        {lobby.locked ? (
          <>
            <Icon name="lock" size="0.9em" /> Locked · code joins refused
          </>
        ) : (
          'Invite code'
        )}
      </span>
      <div className={`tr-code-big${lobby.locked ? ' is-locked' : ''}`} data-testid="lobby-code">
        {streamer && !reveal ? '••••••' : lobby.code}
      </div>
      <div className="tr-row tr-wrap" style={{ justifyContent: 'center' }}>
        {streamer && (
          <Button size="sm" variant="ghost" onClick={() => setReveal((r) => !r)}>
            {reveal ? 'Hide' : 'Reveal'}
          </Button>
        )}
        <Button
          size="sm"
          variant="sky"
          onClick={() => {
            void navigator.clipboard?.writeText(lobby.code);
            uiEvents.emit('copyInvite', { code: lobby.code });
            ui.getState().pushToast({ kind: 'success', title: 'Code copied!' });
          }}
        >
          <Icon name="copy" size="1em" /> Copy code
        </Button>
        {lobby.isHost && (
          <>
            <Button
              size="sm"
              variant={lobby.locked ? 'mint' : 'secondary'}
              aria-pressed={lobby.locked}
              data-testid="lobby-lock"
              onClick={() => uiEvents.emit('lockCustom', { locked: !lobby.locked })}
            >
              <Icon name="lock" size="1em" /> {lobby.locked ? 'Unlock' : 'Lock'}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              data-testid="lobby-new-code"
              onClick={() => uiEvents.emit('newCustomCode')}
            >
              <Icon name="refresh" size="1em" /> New code
            </Button>
          </>
        )}
      </div>
    </section>
  );
}

function HostFooter({ lobby }: { lobby: CustomLobbyState }): JSX.Element {
  const start = lobbyStartState(lobby, useAccountName());
  const [confirming, setConfirming] = useState(false);
  if (confirming && start.canStart && start.waitingOn.length > 0) {
    return (
      <>
        <span className="tr-small tr-lobby-warn tr-grow" role="alert">
          Not ready: {start.waitingOn.join(', ')}
        </span>
        <Button variant="ghost" cue="ui.back" autoFocusNav onClick={() => setConfirming(false)}>
          Wait
        </Button>
        <Button
          variant="go"
          cue="ui.confirm"
          data-testid="custom-force-start"
          onClick={() => {
            setConfirming(false);
            uiEvents.emit('startCustom', { force: true });
          }}
        >
          Start anyway
        </Button>
      </>
    );
  }
  return (
    <>
      <span className="tr-grow" />
      {start.reason ? (
        <span className="tr-small tr-muted" data-testid="custom-start-reason">
          {start.reason}
        </span>
      ) : start.waitingOn.length > 0 ? (
        <span className="tr-small tr-muted">
          {lobby.players.length - start.waitingOn.length}/{lobby.players.length} ready
        </span>
      ) : null}
      <Button
        variant="go"
        cue="ui.confirm"
        autoFocusNav
        disabled={!start.canStart}
        data-testid="custom-start"
        onClick={() => {
          if (start.waitingOn.length > 0) setConfirming(true);
          else uiEvents.emit('startCustom', {});
        }}
      >
        Start show
      </Button>
    </>
  );
}

function MemberFooter({ lobby }: { lobby: CustomLobbyState }): JSX.Element {
  const self = lobby.players.find((p) => p.isSelf);
  const spectating = !self && lobby.spectators.some((p) => p.isSelf);
  const slots = lobby.options.spectatorSlots ?? (lobby.options.spectators ? DEFAULT_SPECTATOR_SLOTS : 0);
  const seatFree = spectating
    ? lobby.players.length < lobby.options.maxPlayers
    : lobby.spectators.length < slots;
  return (
    <>
      <span className="tr-small tr-muted tr-grow">Waiting for the host to start…</span>
      {(spectating || slots > 0) && (
        <Button
          variant="secondary"
          disabled={!seatFree}
          data-testid="custom-role"
          onClick={() => uiEvents.emit('spectateCustom', { spectator: !spectating })}
        >
          {spectating ? (
            <>
              <Icon name="play" size="1em" /> Play instead
            </>
          ) : (
            <>
              <Icon name="eye" size="1em" /> Spectate
            </>
          )}
        </Button>
      )}
      {self && (
        <Button
          variant={self.ready ? 'mint' : 'go'}
          cue="ui.confirm"
          autoFocusNav
          aria-pressed={self.ready}
          data-testid="custom-ready"
          onClick={() => uiEvents.emit('readyCustom', { ready: !self.ready })}
        >
          {self.ready ? (
            <>
              <Icon name="check" size="1em" /> Ready
            </>
          ) : (
            'Ready up'
          )}
        </Button>
      )}
    </>
  );
}

/**
 * The live lobby: code, settings, members and the footer actions.
 *
 * @param lobby - Current lobby state (pushed from the matchmaker).
 */
export function LobbyView({ lobby }: { lobby: CustomLobbyState }): JSX.Element {
  return (
    <>
      <div className="tr-pshow-body tr-pshow-body--lobby">
        <div className="tr-col" style={{ gap: '0.8em', minHeight: 0 }}>
          <CodePanel lobby={lobby} />
          {lobby.isHost ? <HostSettings lobby={lobby} /> : <SettingsSummary lobby={lobby} />}
        </div>
        <Members lobby={lobby} />
      </div>
      <div className="tr-pshow-foot">
        <Button variant="secondary" cue="ui.back" onClick={() => uiEvents.emit('leaveCustom')}>
          Leave
        </Button>
        {lobby.isHost ? <HostFooter lobby={lobby} /> : <MemberFooter lobby={lobby} />}
      </div>
    </>
  );
}
