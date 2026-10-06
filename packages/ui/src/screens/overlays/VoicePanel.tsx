/**
 * Voice chat UI:
 *
 * - {@link VoiceSection}: Settings → Voice. The opt-in toggle (with a
 *   first-use explanation before the browser's microphone prompt), push-to-talk
 *   or open mic with a live level meter, microphone picker, volumes, relay
 *   only, team voice, Streamer Mode options and the room's players with
 *   per-player volume, mute and report.
 * - {@link VoiceRoster}: the in-show HUD list of who is in the room and who
 *   is speaking.
 * - {@link VoiceSpeaking}: the small speaking mark beside a name in party
 *   lists.
 *
 * Speaking is shown by an icon and text for screen readers, never by colour
 * or motion alone.
 */
import { useCallback, useEffect, type JSX } from 'react';
import { Button, Segmented, Slider, Toggle } from '../../components/controls.tsx';
import { maskedName } from '../../names.ts';
import { uiEvents } from '../../store/events.ts';
import { social } from '../../store/social.ts';
import { ui, useUI } from '../../store/uiStore.ts';
import { useVoice, VOICE_UNAVAILABLE_TEXT, type VoicePeerView, type VoiceStatus } from '../../store/voice.ts';
import { keyLabel } from './SettingsSheet.tsx';

/** What the first-use dialog says before the browser asks for the microphone. */
export const VOICE_INTRO_TEXT =
  'Voice chat connects you directly to the players in your party (and, if you allow it, your team in team rounds). ' +
  'Your browser will ask for your microphone next. Push-to-talk is on by default. ' +
  'Players you talk to can see your IP address unless you turn on "Relay only". ' +
  'Nothing you say is recorded; you can mute or report anyone from Settings → Voice.';

const STATUS_TEXT: Record<VoiceStatus, string> = {
  off: 'Off',
  requesting: 'Waiting for microphone permission…',
  connecting: 'Connecting…',
  live: 'On',
  denied: 'Microphone blocked',
  error: 'Not working',
};

/**
 * Display name for a voice peer, honouring Streamer Mode's "hide voice names".
 *
 * @returns A function from a peer to the name to show.
 */
export function useVoiceName(): (p: { userId: string; name: string }) => string {
  const hide = useUI((s) => s.settings.gameplay.streamerMode && s.settings.voice.streamerHideNames);
  return useCallback((p) => (hide ? maskedName(p.userId) : p.name), [hide]);
}

/**
 * Asks to switch voice on: the first time, explains what voice does (and
 * that the microphone prompt follows) and waits for the player to agree.
 */
export function requestVoiceOn(): void {
  const s = ui.getState();
  if (s.settings.voice.introSeen) return void uiEvents.emit('voiceToggle', { on: true });
  s.showDialog({
    id: 'voice-intro',
    kind: 'confirm',
    title: 'Turn on voice chat?',
    body: VOICE_INTRO_TEXT,
    icon: '🎙️',
    buttons: [
      { id: 'cancel', label: 'Not now', variant: 'secondary', autofocus: true },
      { id: 'confirm', label: 'Turn on voice', variant: 'go' },
    ],
  });
  const off = uiEvents.on('dialogResult', ({ dialogId, buttonId }) => {
    if (dialogId !== 'voice-intro') return;
    off();
    if (buttonId !== 'confirm') return;
    ui.getState().updateSettings('voice', { introSeen: true });
    uiEvents.emit('voiceToggle', { on: true });
  });
}

function Row(props: { label: string; hint?: string; children: JSX.Element }): JSX.Element {
  return (
    <div className="tr-settings-row">
      <div className="tr-col" style={{ gap: '0.1em', minWidth: 0 }}>
        <span>{props.label}</span>
        {props.hint && <small className="tr-muted">{props.hint}</small>}
      </div>
      {props.children}
    </div>
  );
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;

/** Microphone level meter with the open-mic threshold marked. */
function MicMeter(props: { threshold: number }): JSX.Element {
  const level = useVoice((s) => s.micLevel);
  const transmitting = useVoice((s) => s.transmitting);
  return (
    <div
      className="tr-voice-meter"
      role="meter"
      aria-label="Microphone level"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(level * 100)}
    >
      <div
        className="tr-voice-meter-fill"
        style={{ width: pct(level) }}
        data-on={transmitting || undefined}
      />
      <div className="tr-voice-meter-mark" style={{ left: pct(props.threshold) }} aria-hidden="true" />
    </div>
  );
}

/** One peer's row: name, speaking state, volume, mute, report. */
function PeerRow({ p }: { p: VoicePeerView }): JSX.Element {
  const name = useVoiceName()(p);
  const volume = useUI((s) => s.settings.voice.peerVolume[p.userId] ?? 1);
  const muted = useUI((s) => s.settings.voice.peerMuted[p.userId] ?? false);
  const up = ui.getState().updateSettings;
  const v = ui.getState().settings.voice;
  return (
    <li className="tr-voice-peer" data-speaking={p.speaking || undefined}>
      <div className="tr-row" style={{ gap: '0.4em', minWidth: 0 }}>
        <VoiceSpeaking speaking={p.speaking} muted={muted} />
        <b className="tr-voice-peer-name">{name}</b>
        {p.connection !== 'connected' && (
          <small className="tr-muted">
            {p.connection === 'failed' ? 'Could not connect' : 'Connecting…'}
          </small>
        )}
      </div>
      <div className="tr-row" style={{ gap: '0.4em' }}>
        <Slider
          label={`${name} volume`}
          value={volume}
          min={0}
          max={1}
          step={0.05}
          format={pct}
          onChange={(nv) => up('voice', { peerVolume: { ...v.peerVolume, [p.userId]: nv } })}
        />
        <Button
          variant={muted ? 'secondary' : 'ghost'}
          size="sm"
          aria-pressed={muted}
          onClick={() => up('voice', { peerMuted: { ...v.peerMuted, [p.userId]: !muted } })}
        >
          {muted ? 'Unmute' : 'Mute'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => social.getState().openReport({ userId: p.userId, name, tag: p.tag, key: p.userId })}
        >
          Report
        </Button>
      </div>
    </li>
  );
}

/** Settings → Voice. */
export function VoiceSection(): JSX.Element {
  const v = useUI((s) => s.settings.voice);
  const pttKey = useUI((s) => s.settings.controls.keybinds.pushToTalk?.[0] ?? '');
  const streamer = useUI((s) => s.settings.gameplay.streamerMode);
  const available = useVoice((s) => s.available);
  const reason = useVoice((s) => s.unavailableReason);
  const status = useVoice((s) => s.status);
  const message = useVoice((s) => s.message);
  const relay = useVoice((s) => s.relayAvailable);
  const teamAllowed = useVoice((s) => s.teamVoiceAllowed);
  const devices = useVoice((s) => s.devices);
  const room = useVoice((s) => s.room);
  const peers = useVoice((s) => s.peers);
  const up = ui.getState().updateSettings;
  useEffect(() => uiEvents.emit('voiceRefresh'), []);
  const on = status !== 'off' && status !== 'denied' && status !== 'error';

  if (!available && !on)
    return (
      <div className="tr-voice-off" role="status">
        <p>{VOICE_UNAVAILABLE_TEXT[reason ?? 'offline']}</p>
      </div>
    );
  return (
    <>
      <Row
        label="Voice chat"
        hint={
          on
            ? `${STATUS_TEXT[status]}${room ? ` · ${room.kind === 'team' ? 'Team' : 'Party'} room` : ' · waiting for a party'}`
            : 'Off by default. Talk with your party; nothing is recorded.'
        }
      >
        <Toggle
          label="Voice chat"
          checked={on}
          onChange={(next) => (next ? requestVoiceOn() : uiEvents.emit('voiceToggle', { on: false }))}
        />
      </Row>
      {message && (
        <p className="tr-voice-message" role="alert">
          {message}
        </p>
      )}
      <Row
        label="Talk mode"
        hint={
          v.mode === 'ptt'
            ? `Hold ${keyLabel(pttKey) || 'the push-to-talk key'} (rebind in Controls)`
            : 'Sends whenever you are louder than the line'
        }
      >
        <Segmented
          label="Talk mode"
          value={v.mode}
          options={[
            { value: 'ptt', label: 'Push to talk' },
            { value: 'open', label: 'Open mic' },
          ]}
          onChange={(mode) => up('voice', { mode })}
        />
      </Row>
      {v.mode === 'open' && (
        <Row label="Open mic sensitivity" hint="Talk and watch the meter cross the line">
          <div className="tr-col" style={{ gap: '0.3em', alignItems: 'flex-end' }}>
            <Slider
              label="Open mic sensitivity"
              value={v.threshold}
              min={0.1}
              max={0.9}
              step={0.01}
              format={pct}
              onChange={(threshold) => up('voice', { threshold })}
            />
            {on && <MicMeter threshold={v.threshold} />}
          </div>
        </Row>
      )}
      <Row label="Microphone">
        <select
          className="tr-input tr-voice-device"
          aria-label="Microphone"
          value={v.inputDeviceId}
          onChange={(e) => up('voice', { inputDeviceId: e.target.value })}
        >
          <option value="">Browser default</option>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Voice volume">
        <Slider
          label="Voice volume"
          value={v.volume}
          min={0}
          max={1}
          step={0.05}
          format={pct}
          onChange={(volume) => up('voice', { volume })}
        />
      </Row>
      <Row label="Noise suppression">
        <Toggle
          label="Noise suppression"
          checked={v.noiseSuppression}
          onChange={(noiseSuppression) => up('voice', { noiseSuppression })}
        />
      </Row>
      <Row label="Echo cancellation">
        <Toggle
          label="Echo cancellation"
          checked={v.echoCancellation}
          onChange={(echoCancellation) => up('voice', { echoCancellation })}
        />
      </Row>
      <Row
        label="Relay only (hide my IP)"
        hint={
          relay
            ? 'Connects through the server so players never see your IP address. Adds a little delay.'
            : 'This server has no relay, so this is unavailable.'
        }
      >
        <Toggle
          label="Relay only"
          checked={v.relayOnly && relay}
          disabled={!relay}
          onChange={(relayOnly) => up('voice', { relayOnly })}
        />
      </Row>
      <Row
        label="Team voice"
        hint={
          teamAllowed
            ? 'In team rounds, also talk to teammates outside your party (up to 8 per squad)'
            : 'Needs a linked account at least 3 days old. Party voice still works.'
        }
      >
        <Toggle
          label="Team voice"
          checked={v.teamVoice && teamAllowed}
          disabled={!teamAllowed}
          onChange={(teamVoice) => up('voice', { teamVoice })}
        />
      </Row>
      <Row
        label="Streamer Mode: hide voice names"
        hint={streamer ? 'Streamer Mode is on' : 'Applies while Streamer Mode is on'}
      >
        <Toggle
          label="Streamer Mode: hide voice names"
          checked={v.streamerHideNames}
          onChange={(streamerHideNames) => up('voice', { streamerHideNames })}
        />
      </Row>
      <Row
        label="Streamer Mode: don't play voice"
        hint="Others can still hear you; speaking marks still show"
      >
        <Toggle
          label="Streamer Mode: don't play voice"
          checked={v.streamerMute}
          onChange={(streamerMute) => up('voice', { streamerMute })}
        />
      </Row>
      {on && (
        <section className="tr-voice-room" aria-label="Players in voice">
          <h3 className="tr-h4">{peers.length ? 'In voice with you' : 'Nobody else is in voice yet'}</h3>
          {peers.length > 0 && (
            <ul className="tr-voice-peers">
              {peers.map((p) => (
                <PeerRow key={p.userId} p={p} />
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}

/**
 * Speaking mark: a speaker icon while talking, a crossed one when muted
 * locally, with screen-reader text either way.
 */
export function VoiceSpeaking(props: { speaking: boolean; muted?: boolean }): JSX.Element {
  const label = props.muted ? 'Muted' : props.speaking ? 'Speaking' : 'In voice';
  return (
    <span
      className="tr-voice-dot"
      data-speaking={(props.speaking && !props.muted) || undefined}
      data-muted={props.muted || undefined}
      title={label}
    >
      <span aria-hidden="true">{props.muted ? '🔇' : props.speaking ? '🔊' : '🎙️'}</span>
      <span className="tr-sr-only">{label}</span>
    </span>
  );
}

/**
 * The speaking mark for a party member, or nothing when they are not in the
 * player's voice room. Pass the player's own id to show the local mic.
 */
export function PartyVoiceMark(props: { userId: string; isSelf: boolean }): JSX.Element | null {
  const peer = useVoice((s) => s.peers.find((p) => p.userId === props.userId));
  const self = useVoice((s) => (s.status === 'live' ? s.selfSpeaking : null));
  const muted = useUI((s) => s.settings.voice.peerMuted[props.userId] ?? false);
  if (props.isSelf) return self === null ? null : <VoiceSpeaking speaking={self} />;
  return peer ? <VoiceSpeaking speaking={peer.speaking} muted={muted} /> : null;
}

/** In-show list of the voice room (team or party), with who is speaking. */
export function VoiceRoster(): JSX.Element | null {
  const status = useVoice((s) => s.status);
  const room = useVoice((s) => s.room);
  const peers = useVoice((s) => s.peers);
  const selfSpeaking = useVoice((s) => s.selfSpeaking);
  const transmitting = useVoice((s) => s.transmitting);
  const mode = useUI((s) => s.settings.voice.mode);
  const muted = useUI((s) => s.settings.voice.peerMuted);
  const name = useVoiceName();
  if (status !== 'live' || !room) return null;
  return (
    <div className="tr-voice-roster" aria-label={`${room.kind === 'team' ? 'Team' : 'Party'} voice`}>
      <div className="tr-voice-roster-self" data-on={transmitting || undefined}>
        <VoiceSpeaking speaking={selfSpeaking} />
        <span>{transmitting ? 'Talking' : mode === 'ptt' ? 'Push to talk' : 'Mic open'}</span>
      </div>
      <ul>
        {peers.map((p) => (
          <li key={p.userId} data-speaking={p.speaking || undefined}>
            <VoiceSpeaking speaking={p.speaking} muted={muted[p.userId] ?? false} />
            <span>{name(p)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
