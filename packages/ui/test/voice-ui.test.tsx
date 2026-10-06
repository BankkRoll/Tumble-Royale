/**
 * Voice chat UI: off by default and hidden where the server does not offer
 * it, the first-use explanation before the microphone prompt, settings rows
 * for each state, speaking marks that never rely on colour alone, Streamer
 * Mode name hiding and the voice report note.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { viewOpensQuickChat } from '../src/hud/ChatWidget.tsx';
import { Hud } from '../src/hud/Hud.tsx';
import { maskedName } from '../src/names.ts';
import {
  PartyVoiceMark,
  requestVoiceOn,
  VOICE_INTRO_TEXT,
  VoiceRoster,
  VoiceSection,
} from '../src/screens/overlays/VoicePanel.tsx';
import { REPORT_REASONS, VOICE_REPORT_NOTE } from '../src/screens/overlays/PlayerActions.tsx';
import { SettingsSheet } from '../src/screens/overlays/SettingsSheet.tsx';
import { DEFAULT_KEYBINDS, DEFAULT_PAD_BINDS, DEFAULT_SETTINGS } from '../src/store/defaults.ts';
import { uiEvents } from '../src/store/events.ts';
import { PAD_BIND_CONTEXT } from '../src/store/padBinds.ts';
import { ui } from '../src/store/uiStore.ts';
import { voice } from '../src/store/voice.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;
(voice as unknown as { getInitialState: () => unknown }).getInitialState = voice.getState;

const PEER = { userId: 'u-pal', name: 'Pal', tag: '0002', speaking: true, connection: 'connected' as const };

function available(relay = true, teamVoice = true): void {
  voice.getState().setAvailability({ available: true, reason: null, relay, teamVoice });
}

beforeEach(() => {
  voice.getState().reset();
  voice
    .getState()
    .setAvailability({ available: false, reason: 'not_configured', relay: false, teamVoice: false });
});
afterEach(() => ui.setState({ settings: DEFAULT_SETTINGS, dialog: null }));

describe('defaults', () => {
  it('voice is off, push-to-talk, with a bindable key and pad button', () => {
    expect(DEFAULT_SETTINGS.voice.enabled).toBe(false);
    expect(DEFAULT_SETTINGS.voice.mode).toBe('ptt');
    expect(DEFAULT_SETTINGS.voice.relayOnly).toBe(false);
    expect(DEFAULT_SETTINGS.voice.teamVoice).toBe(false);
    expect(DEFAULT_KEYBINDS.pushToTalk[0]).toBe('KeyV');
    expect(DEFAULT_PAD_BINDS.pushToTalk[0]).toBe(10);
    expect(PAD_BIND_CONTEXT.pushToTalk).toBe('always');
    // No other default uses V or L3, and View stays free for quick chat.
    const keys = Object.entries(DEFAULT_KEYBINDS).filter(([a]) => a !== 'pushToTalk');
    expect(keys.some(([, pair]) => pair.includes('KeyV'))).toBe(false);
    const pads = Object.entries(DEFAULT_PAD_BINDS).filter(([a]) => a !== 'pushToTalk');
    expect(pads.some(([, pair]) => pair.includes(10))).toBe(false);
    expect(Object.values(DEFAULT_PAD_BINDS).some((pair) => pair.includes(8))).toBe(false);
    expect(viewOpensQuickChat(DEFAULT_PAD_BINDS)).toBe(true);
  });

  it('View talks instead of opening quick chat when it is bound to push-to-talk', () => {
    expect(viewOpensQuickChat({ pushToTalk: [8, -1] })).toBe(false);
    expect(viewOpensQuickChat({ pushToTalk: [-1, 8] })).toBe(false);
  });
});

describe('Settings → Voice', () => {
  it('has no Voice tab on a server without voice', () => {
    expect(renderToStaticMarkup(<SettingsSheet />)).not.toContain('>Voice<');
  });

  it('shows the Voice tab once the server offers voice, and to a muted player', () => {
    available();
    expect(renderToStaticMarkup(<SettingsSheet />)).toContain('>Voice<');
    voice.getState().setAvailability({ available: false, reason: 'muted', relay: false, teamVoice: false });
    expect(renderToStaticMarkup(<SettingsSheet />)).toContain('>Voice<');
    expect(renderToStaticMarkup(<VoiceSection />)).toContain('disabled on your account');
  });

  it('starts off, explains push-to-talk with the bound key, and keeps relay-only off without a relay', () => {
    available(false, false);
    const html = renderToStaticMarkup(<VoiceSection />);
    expect(html).toContain('Off by default');
    expect(html).toContain('Hold V');
    expect(html).toMatch(
      /aria-label="Voice chat"[^>]*aria-checked="false"|aria-checked="false"[^>]*aria-label="Voice chat"/,
    );
    expect(html).toContain('This server has no relay');
    expect(html).toContain('Needs a linked account');
    expect(html).not.toContain('Open mic sensitivity');
  });

  it('shows the sensitivity meter in open mic, and the room with per-player controls while live', () => {
    available();
    const s = ui.getState().settings;
    ui.setState({ settings: { ...s, voice: { ...s.voice, mode: 'open' } } });
    voice.getState().setStatus('live');
    voice.getState().setRoom({ kind: 'party' }, [PEER]);
    const html = renderToStaticMarkup(<VoiceSection />);
    expect(html).toContain('Open mic sensitivity');
    expect(html).toContain('role="meter"');
    expect(html).toContain('Party room');
    expect(html).toContain('Pal');
    expect(html).toContain('Pal volume');
    expect(html).toContain('>Mute<');
    expect(html).toContain('>Report<');
  });

  it('explains a blocked microphone', () => {
    available();
    voice.getState().setStatus('denied', 'Microphone blocked. Allow it for this site.');
    expect(renderToStaticMarkup(<VoiceSection />)).toContain('role="alert"');
  });

  it('asks first, then switches on only after the player agrees', () => {
    const toggles: boolean[] = [];
    const off = uiEvents.on('voiceToggle', ({ on }) => toggles.push(on));
    requestVoiceOn();
    expect(ui.getState().dialog).toMatchObject({ id: 'voice-intro', body: VOICE_INTRO_TEXT });
    expect(VOICE_INTRO_TEXT).toMatch(/IP address/);
    expect(VOICE_INTRO_TEXT).toMatch(/recorded/);
    uiEvents.emit('dialogResult', { dialogId: 'voice-intro', buttonId: 'cancel' });
    expect(toggles).toEqual([]);
    requestVoiceOn();
    uiEvents.emit('dialogResult', { dialogId: 'voice-intro', buttonId: 'confirm' });
    expect(toggles).toEqual([true]);
    expect(ui.getState().settings.voice.introSeen).toBe(true);
    // Once seen, the toggle goes straight to the microphone prompt.
    requestVoiceOn();
    expect(toggles).toEqual([true, true]);
    off();
  });
});

describe('speaking marks', () => {
  it('shows nothing for party members who are not in voice', () => {
    expect(renderToStaticMarkup(<PartyVoiceMark userId="u-pal" isSelf={false} />)).toBe('');
  });

  it('names the state for screen readers, not only with colour', () => {
    voice.getState().setStatus('live');
    voice.getState().setRoom({ kind: 'party' }, [PEER]);
    const html = renderToStaticMarkup(<PartyVoiceMark userId="u-pal" isSelf={false} />);
    expect(html).toContain('Speaking');
    expect(html).toContain('tr-sr-only');
    expect(html).toContain('data-speaking');
  });

  it('lists the team room in the HUD while live', () => {
    voice.getState().setStatus('live');
    voice.getState().setRoom({ kind: 'team' }, [PEER]);
    const html = renderToStaticMarkup(<VoiceRoster />);
    expect(html).toContain('Team voice');
    expect(html).toContain('Pal');
    expect(renderToStaticMarkup(<Hud />)).toContain('tr-voice-roster');
  });

  it('hides voice names in Streamer Mode', () => {
    const s = ui.getState().settings;
    ui.setState({ settings: { ...s, gameplay: { ...s.gameplay, streamerMode: true } } });
    voice.getState().setStatus('live');
    voice.getState().setRoom({ kind: 'party' }, [PEER]);
    const html = renderToStaticMarkup(<VoiceRoster />);
    expect(html).not.toContain('>Pal<');
    expect(html).toContain(maskedName('u-pal'));
  });
});

describe('voice reports', () => {
  it('offers a voice reason that says nothing is recorded', () => {
    expect(REPORT_REASONS.map((r) => r.id)).toContain('voice');
    expect(VOICE_REPORT_NOTE).toMatch(/never recorded/);
  });
});
