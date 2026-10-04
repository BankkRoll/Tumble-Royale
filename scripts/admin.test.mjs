import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { formatErrors, formatRefunds, loadEnv, parseArgs, run, toRequest } from './admin.mjs';

function capture() {
  const out = [];
  const err = [];
  return { out, err, io: { out: (s) => out.push(s), err: (s) => err.push(s) } };
}

describe('toRequest', () => {
  const req = (argv) => {
    const { args, opts } = parseArgs(argv);
    return toRequest(args, opts, () => '{"id":"p1","title":"Hi"}');
  };

  it('maps every command to its admin route', () => {
    assert.deepEqual(req(['bans', 'list', '--user', 'u1', '--all']), {
      method: 'GET',
      path: '/internal/bans?userId=u1&active=0',
    });
    assert.deepEqual(
      req(['bans', 'add', 'u1', '--reason', 'cheating', '--hours', '24', '--scope', 'ranked']),
      {
        method: 'POST',
        path: '/internal/bans',
        body: { userId: 'u1', reason: 'cheating', scope: 'ranked', durationHours: 24 },
      },
    );
    assert.equal(req(['bans', 'remove', 'b/1']).path, '/internal/bans/b%2F1');
    assert.deepEqual(req(['reports', 'resolve', 'r1', '--status=dismissed']).body, { status: 'dismissed' });
    assert.deepEqual(req(['news', 'publish', 'post.json']).body, { id: 'p1', title: 'Hi' });
    assert.deepEqual(req(['news', 'hide', 'p1']), {
      method: 'PATCH',
      path: '/internal/news/p1',
      body: { hidden: true },
    });
    assert.deepEqual(
      req(['flags', 'set', 'new_menu', 'on', '--rollout', '25', '--payload', '{"v":2}']).body,
      {
        enabled: true,
        rolloutPercent: 25,
        payload: { v: 2 },
      },
    );
    assert.equal(req(['ledger', 'check', 'u1']).path, '/internal/ledger/u1');
    assert.equal(
      req(['user', 'lookup', 'Bouncy', 'Noodle#0042']).path,
      '/internal/users/lookup?q=Bouncy%20Noodle%230042',
    );
    assert.deepEqual(req(['user', 'rename', 'u1', 'Polite', 'Name']).body, { displayName: 'Polite Name' });
  });

  it('maps the refund commands', () => {
    const list = req([
      'refunds',
      'list',
      '--status',
      'pending',
      '--kind',
      'real_money',
      '--user',
      'u1',
      '--limit',
      '5',
    ]);
    assert.equal(list.method, 'GET');
    assert.equal(list.path, '/internal/refunds?status=pending&kind=real_money&userId=u1&limit=5');
    assert.equal(list.format, formatRefunds);
    assert.equal(req(['refunds', 'list']).path, '/internal/refunds');
    assert.deepEqual(req(['refunds', 'approve', 'r/1', '--note', 'wrong pack']), {
      method: 'POST',
      path: '/internal/refunds/r%2F1/approve',
      body: { note: 'wrong pack' },
    });
    assert.deepEqual(req(['refunds', 'approve', 'r1']).body, {});
    assert.deepEqual(req(['refunds', 'deny', 'r1', '--reason', 'Gems spent']), {
      method: 'POST',
      path: '/internal/refunds/r1/deny',
      body: { reason: 'Gems spent' },
    });
    assert.throws(() => req(['refunds', 'deny', 'r1']), /--reason/);
    assert.throws(() => req(['refunds', 'approve']), /refundId/);
    assert.throws(() => req(['refunds', 'list', '--limit', '0']), /--limit/);
  });

  it('formats the refund queue', () => {
    assert.equal(formatRefunds({ total: 0, refunds: [] }), 'No refunds match.');
    const text = formatRefunds({
      total: 3,
      refunds: [
        {
          id: 'r1',
          kind: 'real_money',
          status: 'pending',
          currency: 'usd',
          amount: 999,
          offerId: 'gems.1100',
          createdAt: '2026-10-04T12:00:00.000Z',
          displayName: 'Bouncy',
          tag: '0042',
          userId: 'u1',
          playerReason: 'wrong pack',
        },
      ],
    });
    assert.match(text, /^1 of 3 refunds:/);
    assert.match(text, /r1 {2}pending .*\$9\.99 {2}gems\.1100 {2}Bouncy#0042/);
    assert.match(text, /"wrong pack"/);
  });

  it('maps the console staff and audit commands', () => {
    assert.deepEqual(req(['staff', 'grant', 'u1', '--role', 'admin']), {
      method: 'PUT',
      path: '/internal/staff/u1',
      body: { role: 'admin' },
    });
    assert.deepEqual(req(['staff', 'grant', 'u1']).body, { role: 'moderator' });
    assert.deepEqual(req(['staff', 'revoke', 'u1']), { method: 'DELETE', path: '/internal/staff/u1' });
    assert.deepEqual(req(['staff', 'list']), { method: 'GET', path: '/internal/staff' });
    assert.equal(
      req(['audit', '--action', 'player.', '--target', 'u1', '--limit', '5']).path,
      '/internal/audit?action=player.&targetId=u1&limit=5',
    );
    assert.equal(req(['audit']).path, '/internal/audit');
    assert.throws(() => req(['staff', 'grant', 'u1', '--role', 'owner']), /--role/);
    assert.throws(() => req(['staff', 'grant']), /userId/);
  });

  it('rejects bad usage', () => {
    for (const argv of [
      ['bans', 'add', 'u1'],
      ['bans', 'add', 'u1', '--reason', 'x', '--hours', '-3'],
      ['flags', 'set', 'k', 'maybe'],
      ['flags', 'set', 'k', 'on', '--rollout', '101'],
      ['flags', 'set', 'k', 'on', '--payload', '{nope'],
      ['user', 'rename', 'u1'],
      ['nope'],
    ])
      assert.throws(() => req(argv), /./, argv.join(' '));
    assert.throws(() => parseArgs(['--token']), /needs a value/);
  });
});

describe('live-ops commands', () => {
  const NOW = Date.parse('2026-10-04T12:00:00.000Z');
  const req = (argv) => {
    const { args, opts } = parseArgs(argv);
    return toRequest(args, opts, () => '', NOW);
  };

  it('maps playlist commands, with "none" clearing a time', () => {
    assert.deepEqual(req(['playlists', 'list']), { method: 'GET', path: '/internal/playlists' });
    assert.deepEqual(
      req([
        'playlists',
        'set',
        'chaos-mode',
        '--starts',
        '2026-12-01T18:00:00Z',
        '--ends',
        'none',
        '--featured',
        'on',
      ]),
      {
        method: 'PUT',
        path: '/internal/playlists/chaos-mode',
        body: { startsAt: '2026-12-01T18:00:00.000Z', endsAt: null, featured: true },
      },
    );
    assert.deepEqual(req(['playlists', 'hide', 'duos']).body, { hidden: true });
    assert.deepEqual(req(['playlists', 'show', 'duos']).body, { hidden: false });
    assert.deepEqual(req(['playlists', 'reset', 'duos']), {
      method: 'DELETE',
      path: '/internal/playlists/duos',
    });
  });

  it('maps event commands', () => {
    assert.deepEqual(req(['events', 'list']), { method: 'GET', path: '/internal/live-events' });
    assert.deepEqual(
      req([
        'events',
        'set',
        'moonlit-mischief',
        '--starts',
        '2026-10-10T00:00:00Z',
        '--ends',
        '2026-10-20T00:00Z',
      ]),
      {
        method: 'PUT',
        path: '/internal/live-events/moonlit-mischief',
        body: { startsAt: '2026-10-10T00:00:00.000Z', endsAt: '2026-10-20T00:00:00.000Z' },
      },
    );
    assert.deepEqual(req(['events', 'set', 'moonlit-mischief', '--ends', '2026-11-05T00:00:00Z']).body, {
      endsAt: '2026-11-05T00:00:00.000Z',
    });
    assert.deepEqual(req(['events', 'disable', 'moonlit-mischief']).body, { enabled: false });
    assert.deepEqual(req(['events', 'enable', 'moonlit-mischief']).body, { enabled: true });
    assert.deepEqual(req(['events', 'reset', 'frostbite-frolic']), {
      method: 'DELETE',
      path: '/internal/live-events/frostbite-frolic',
    });
    for (const argv of [
      ['events', 'set', 'moonlit-mischief'],
      ['events', 'set', 'moonlit-mischief', '--ends', 'none'],
      ['events', 'set', 'moonlit-mischief', '--starts', 'soon'],
      ['events', 'disable'],
      ['events', 'reset'],
    ])
      assert.throws(() => req(argv), /./, argv.join(' '));
  });

  it('schedules maintenance relative to now or at fixed times', () => {
    assert.deepEqual(req(['maintenance', 'on', '--in', '10', '--for', '30', '--message', 'Patch day']).body, {
      enabled: true,
      startsAt: '2026-10-04T12:10:00.000Z',
      endsAt: '2026-10-04T12:40:00.000Z',
      message: 'Patch day',
    });
    assert.deepEqual(req(['maintenance', 'on']).body, { enabled: true, startsAt: null, endsAt: null });
    assert.deepEqual(req(['maintenance', 'on', '--for', '15']).body.endsAt, '2026-10-04T12:15:00.000Z');
    assert.deepEqual(req(['maintenance', 'off']), { method: 'DELETE', path: '/internal/maintenance' });
    assert.deepEqual(req(['maintenance', 'status']), { method: 'GET', path: '/status' });
  });

  it('builds the errors view query', () => {
    assert.equal(req(['errors', 'top']).path, '/internal/errors/top');
    assert.equal(
      req(['errors', 'top', '--hours', '6', '--limit', '5', '--server']).path,
      '/internal/errors/top?hours=6&limit=5&source=server',
    );
  });

  it('rejects bad live-ops usage', () => {
    for (const argv of [
      ['playlists', 'set', 'duos'],
      ['playlists', 'set', 'duos', '--ends', 'next week'],
      ['playlists', 'set', 'duos', '--hidden', 'yes'],
      ['playlists', 'hide'],
      ['maintenance', 'on', '--in', '-5'],
      ['maintenance', 'on', '--in', '5', '--starts', '2026-12-01T00:00:00Z'],
      ['maintenance', 'on', '--for', '5', '--ends', '2026-12-01T00:00:00Z'],
      ['errors', 'top', '--hours', '1.5'],
    ])
      assert.throws(() => req(argv), /./, argv.join(' '));
  });

  it('prints errors top as a readable list', () => {
    assert.equal(formatErrors({ source: 'client', since: 'x', errors: [] }), 'No client errors since x.');
    const text = formatErrors({
      source: 'client',
      since: '2026-10-03T12:00:00.000Z',
      errors: [
        {
          type: 'TypeError',
          message: 'boom',
          occurrences: 42,
          players: 3,
          lastSeen: '2026-10-04T11:00:00.000Z',
          releases: 'v1',
        },
      ],
    });
    assert.match(text, /42x {2}TypeError: boom/);
    assert.match(text, /3 players · v1 · last 2026-10-04T11:00:00.000Z/);
  });
});

describe('run', () => {
  let server;
  let url = '';
  const seen = [];
  before(async () => {
    server = createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== 'Bearer good') {
        res.writeHead(401).end(JSON.stringify({ error: 'unauthorized', message: 'Invalid admin token' }));
      } else if (req.url === '/internal/flags') {
        res.end(
          JSON.stringify({
            flags: [
              { key: 'a', enabled: true },
              { key: 'b', enabled: false },
            ],
          }),
        );
      } else if (req.url?.startsWith('/internal/bans/')) {
        res.writeHead(204).end();
      } else if (req.url === '/internal/reports') {
        res.writeHead(503).end(JSON.stringify({ error: 'admin_disabled', message: 'off' }));
      } else {
        res
          .writeHead(400)
          .end(JSON.stringify({ error: 'invalid_request', message: 'bad', details: [{ path: 'x' }] }));
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((r) => server.close(r)));

  it('prints the response and filters flags get <key>', async () => {
    const c = capture();
    assert.equal(
      await run(['flags', 'get', 'b', '--api-url', url], { ...c.io, env: { ADMIN_TOKEN: 'good' } }),
      0,
    );
    assert.deepEqual(JSON.parse(c.out[0]), { flags: [{ key: 'b', enabled: false }] });
    assert.equal(seen.at(-1).auth, 'Bearer good');
  });

  it('handles empty 204 bodies', async () => {
    const c = capture();
    assert.equal(await run(['bans', 'remove', 'b1', '--api-url', url, '--token', 'good'], c.io), 0);
    assert.equal(c.out[0], 'ok (HTTP 204)');
  });

  it('explains a wrong token, disabled admin and validation errors', async () => {
    let c = capture();
    assert.equal(await run(['flags', 'get', '--api-url', url, '--token', 'bad'], c.io), 1);
    assert.match(c.err[0], /rejected the admin token/);
    c = capture();
    assert.equal(await run(['reports', 'list', '--api-url', url, '--token', 'good'], c.io), 1);
    assert.match(c.err[0], /admin routes are disabled/);
    c = capture();
    assert.equal(await run(['ledger', 'check', 'u1', '--api-url', url, '--token', 'good'], c.io), 1);
    assert.match(c.err[0], /HTTP 400 invalid_request: bad/);
    assert.match(c.err[1], /"path": "x"/);
  });

  it('reports an unreachable API and a missing token', async () => {
    let c = capture();
    assert.equal(await run(['flags', 'get', '--api-url', 'http://127.0.0.1:1', '--token', 't'], c.io), 3);
    assert.match(c.err[0], /cannot reach the API at http:\/\/127\.0\.0\.1:1/);
    c = capture();
    assert.equal(await run(['flags', 'get'], { ...c.io, env: {} }), 2);
    assert.match(c.err[0], /no admin token/);
  });

  it('prints usage', async () => {
    const c = capture();
    assert.equal(await run(['--help'], c.io), 0);
    assert.match(c.out[0], /^Usage: pnpm admin/);
    assert.equal(await run([], c.io), 2);
  });
});

describe('loadEnv', () => {
  it('reads deploy/.env under the development files and the real environment', () => {
    const root = mkdtempSync(join(tmpdir(), 'tumble-admin-env-'));
    try {
      mkdirSync(join(root, 'deploy'));
      mkdirSync(join(root, 'apps/api'), { recursive: true });
      writeFileSync(
        join(root, 'deploy/.env'),
        'PUBLIC_API_URL=https://play.example/api\nADMIN_TOKEN=prod\nA=deploy\n',
      );
      assert.deepEqual(loadEnv(root, {}), {
        PUBLIC_API_URL: 'https://play.example/api',
        ADMIN_TOKEN: 'prod',
        A: 'deploy',
      });
      writeFileSync(join(root, '.env'), 'A=root\nB=root\n');
      writeFileSync(join(root, 'apps/api/.env'), 'B=api\n');
      assert.deepEqual(loadEnv(root, { ADMIN_TOKEN: 'shell' }), {
        PUBLIC_API_URL: 'https://play.example/api',
        ADMIN_TOKEN: 'shell',
        A: 'root',
        B: 'api',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
