/**
 * Admin console voice moderation: voice reports show their room/time
 * metadata (never a recording), and moderators can mute voice from the
 * report queue and the player page.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ACTION_META, reportActionBody, REASON_LABELS, SCOPE_LABELS } from '../src/admin/format.ts';
import type { ReportRow } from '../src/admin/types.ts';
import { playerActions } from '../src/admin/views/PlayerView.tsx';
import { BulkBar, describeAction, ReportRowView } from '../src/admin/views/ReportsView.tsx';

const NOW = Date.parse('2026-10-06T12:00:00Z');

describe('voice moderation in the admin console', () => {
  it('labels voice reports and shows the voice evidence line as metadata', () => {
    const report: ReportRow = {
      id: 'r1',
      reason: 'voice',
      details: 'yelling slurs',
      status: 'open',
      matchId: null,
      createdAt: new Date(NOW - 60_000).toISOString(),
      evidence: [
        {
          channel: 'voice',
          text: 'Shared a party voice room for about 6 min (no audio is recorded)',
          at: NOW - 120_000,
        },
      ],
      reporter: { id: 'u-rep', displayName: 'Kind', tag: '0002' },
      target: { id: 'u-tgt', displayName: 'Loud', tag: '0003', openReports: 1, activeSanctions: [] },
    };
    const html = renderToStaticMarkup(
      <table>
        <tbody>
          <ReportRowView report={report} selected={false} onToggle={() => undefined} now={NOW} />
        </tbody>
      </table>,
    );
    expect(html).toContain(REASON_LABELS.voice!);
    expect(html).toContain('Evidence (1)');
    expect(html).toContain('voice room (no recording)');
    expect(SCOPE_LABELS.voice).toBe('Voice muted');
  });

  it('offers a timed voice mute in bulk', () => {
    expect(ACTION_META.voice_mute.danger).toBe(true);
    expect(renderToStaticMarkup(<BulkBar count={1} onAction={vi.fn()} onClear={vi.fn()} />)).toContain(
      'Mute voice',
    );
    expect(describeAction('voice_mute', 2, 1)).toMatch(/voice chat for 1 player/);
    expect(reportActionBody(['r1'], 'voice_mute', ' abuse ', 24)).toEqual({
      reportIds: ['r1'],
      action: 'voice_mute',
      reason: 'abuse',
      durationHours: 24,
    });
  });

  it('mutes voice from the player page with the voice ban scope', async () => {
    const send = vi.fn(async () => undefined);
    const actions = playerActions('Loud#0003', 'u-tgt', send, () => undefined);
    await actions.voiceMute.run('abuse in voice', 72);
    expect(send).toHaveBeenCalledWith('POST', '/internal/bans', {
      userId: 'u-tgt',
      scope: 'voice',
      reason: 'abuse in voice',
      durationHours: 72,
    });
  });
});
