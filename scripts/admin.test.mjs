import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { parseArgs, run, toRequest } from './admin.mjs';

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
