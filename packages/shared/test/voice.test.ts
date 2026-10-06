import { describe, expect, it } from 'vitest';
import { FLAG_DEFAULTS, FLAG_KEYS, flagEnabled, isAnalyticsEvent } from '../src/liveops.ts';
import {
  isAudioOnlySdp,
  sanitizeVoiceMessage,
  VOICE_LIMITS,
  voiceOfferer,
  voiceSquads,
} from '../src/social/voice.ts';

const CID = 'tab_abcdef12';
const TO = '0b8a3c1e-1d2f-4c5b-9a6e-7f8091a2b3c4';
const SDP =
  'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n';

describe('voice flag and analytics', () => {
  it('voice.enabled is the one flag that defaults off', () => {
    expect(FLAG_KEYS).toContain('voice.enabled');
    expect(FLAG_DEFAULTS['voice.enabled'].enabled).toBe(false);
    expect(flagEnabled(null, 'voice.enabled')).toBe(false);
    expect(flagEnabled({ 'voice.enabled': { enabled: true, payload: null } }, 'voice.enabled')).toBe(true);
  });

  it('allow-lists voice.join and voice.leave', () => {
    expect(isAnalyticsEvent('voice.join')).toBe(true);
    expect(isAnalyticsEvent('voice.leave')).toBe(true);
  });
});

describe('isAudioOnlySdp', () => {
  it('accepts audio-only descriptions and refuses video, data channels and junk', () => {
    expect(isAudioOnlySdp(SDP)).toBe(true);
    expect(isAudioOnlySdp(`${SDP}m=video 9 UDP/TLS/RTP/SAVPF 96\r\n`)).toBe(false);
    expect(isAudioOnlySdp(`${SDP}m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n`)).toBe(false);
    expect(isAudioOnlySdp('v=0\r\ns=-\r\n')).toBe(false);
    expect(isAudioOnlySdp('hello')).toBe(false);
  });
});

describe('sanitizeVoiceMessage', () => {
  it('keeps only known fields of joins and leaves', () => {
    expect(sanitizeVoiceMessage({ type: 'voice_join', cid: CID, team: 'yes', extra: 1 })).toEqual({
      type: 'voice_join',
      cid: CID,
      team: false,
    });
    expect(sanitizeVoiceMessage({ type: 'voice_leave', cid: CID })).toEqual({
      type: 'voice_leave',
      cid: CID,
    });
  });

  it('rejects bad tab ids, recipients and kinds', () => {
    expect(sanitizeVoiceMessage({ type: 'voice_join', cid: 'x' })).toBeNull();
    expect(sanitizeVoiceMessage({ type: 'voice_signal', cid: CID, to: 'nope', kind: 'restart' })).toBeNull();
    expect(sanitizeVoiceMessage({ type: 'voice_signal', cid: CID, to: TO, kind: 'shout' })).toBeNull();
    expect(sanitizeVoiceMessage({ type: 'voice_hack', cid: CID })).toBeNull();
    expect(sanitizeVoiceMessage(null)).toBeNull();
  });

  it('requires an audio-only SDP under the size cap for offers and answers', () => {
    expect(
      sanitizeVoiceMessage({ type: 'voice_signal', cid: CID, to: TO, kind: 'offer', sdp: SDP }),
    ).toMatchObject({
      sdp: SDP,
    });
    expect(sanitizeVoiceMessage({ type: 'voice_signal', cid: CID, to: TO, kind: 'answer' })).toBeNull();
    const big = SDP + 'a=x\r\n'.repeat(VOICE_LIMITS.maxSdpLength / 5);
    expect(
      sanitizeVoiceMessage({ type: 'voice_signal', cid: CID, to: TO, kind: 'offer', sdp: big }),
    ).toBeNull();
    expect(
      sanitizeVoiceMessage({
        type: 'voice_signal',
        cid: CID,
        to: TO,
        kind: 'offer',
        sdp: `${SDP}m=video 9 X 1\r\n`,
      }),
    ).toBeNull();
  });

  it('validates trickled candidates, including end-of-candidates', () => {
    const ok = {
      candidate: 'candidate:1 1 udp 2122260223 192.168.1.2 54321 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    };
    expect(
      sanitizeVoiceMessage({ type: 'voice_signal', cid: CID, to: TO, kind: 'ice', candidate: ok }),
    ).toMatchObject({
      candidate: ok,
    });
    expect(
      sanitizeVoiceMessage({
        type: 'voice_signal',
        cid: CID,
        to: TO,
        kind: 'ice',
        candidate: { candidate: '', sdpMid: null, sdpMLineIndex: null },
      }),
    ).not.toBeNull();
    for (const bad of [
      { ...ok, candidate: 'evil' },
      { ...ok, candidate: `candidate:${'x'.repeat(600)}` },
      { ...ok, sdpMLineIndex: -1 },
      { ...ok, sdpMid: 5 },
    ])
      expect(
        sanitizeVoiceMessage({ type: 'voice_signal', cid: CID, to: TO, kind: 'ice', candidate: bad }),
      ).toBeNull();
  });
});

describe('voiceOfferer', () => {
  it('picks exactly one side of every pair', () => {
    expect(voiceOfferer('a', 'b')).toBe(true);
    expect(voiceOfferer('b', 'a')).toBe(false);
  });
});

describe('voiceSquads', () => {
  it('caps squads and keeps parties together', () => {
    const players = [
      ...Array.from({ length: 6 }, (_, i) => ({ userId: `s${i}`, team: 0 })),
      ...['p1', 'p2', 'p3', 'p4'].map((userId) => ({ userId, team: 0, partyId: 'P' })),
      { userId: 'q1', team: 0, partyId: 'Q' },
      { userId: 'q2', team: 0, partyId: 'Q' },
      { userId: 'other', team: 1 },
      { userId: 'none', team: -1 },
    ];
    const squads = voiceSquads(players, 8);
    const team0 = squads.get(0)!;
    expect(team0.every((s) => s.length <= 8)).toBe(true);
    expect(team0.flat().sort()).toEqual([...players.slice(0, 12).map((p) => p.userId)].sort());
    const home = (id: string) => team0.findIndex((s) => s.includes(id));
    expect(new Set(['p1', 'p2', 'p3', 'p4'].map(home)).size).toBe(1);
    expect(home('q1')).toBe(home('q2'));
    expect(squads.get(1)).toEqual([['other']]);
    expect(squads.has(-1)).toBe(false);
  });

  it('is deterministic for the same roster', () => {
    const players = Array.from({ length: 20 }, (_, i) => ({
      userId: `u${i}`,
      team: i % 2,
      partyId: i < 4 ? 'P' : null,
    }));
    expect(voiceSquads(players)).toEqual(voiceSquads(players));
  });
});
