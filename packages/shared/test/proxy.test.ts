import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { EnvIssues } from '../src/env.ts';
import { clientIp, parseTrustProxy, trustFunction, type TrustProxy } from '../src/proxy.ts';

const req = (remoteAddress: string | undefined, xff?: string): IncomingMessage =>
  ({
    socket: { remoteAddress },
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  }) as unknown as IncomingMessage;

const ip = (trust: TrustProxy, remote: string | undefined, xff?: string) =>
  clientIp(req(remote, xff), trustFunction(trust));

const value = (raw: string | undefined): TrustProxy => {
  const r = parseTrustProxy(raw);
  if ('error' in r) throw new Error(r.error);
  return r.value;
};

describe('parseTrustProxy', () => {
  it.each([undefined, '', '  ', 'false', '0'])('treats %j as no proxy', (raw) => {
    expect(value(raw)).toBe(false);
  });

  it('parses hop counts and address lists', () => {
    expect(value('1')).toBe(1);
    expect(value(' 2 ')).toBe(2);
    expect(value('10.0.0.0/8, 127.0.0.1 ,::1,fd00::/8')).toEqual([
      '10.0.0.0/8',
      '127.0.0.1',
      '::1',
      'fd00::/8',
    ]);
    expect(value('loopback,uniquelocal')).toEqual(['loopback', 'uniquelocal']);
  });

  it('refuses true, absurd hop counts and garbage', () => {
    expect(parseTrustProxy('true')).toMatchObject({ error: expect.stringContaining('forge') });
    expect(parseTrustProxy('11')).toMatchObject({ error: expect.stringContaining('at most') });
    expect(parseTrustProxy('10.0.0.0/99')).toHaveProperty('error');
    expect(parseTrustProxy('not-an-ip')).toHaveProperty('error');
  });
});

describe('EnvIssues.trustProxy', () => {
  it('defaults to no proxy and reports bad values with the variable name', () => {
    expect(new EnvIssues({}).trustProxy()).toBe(false);
    expect(new EnvIssues({ TRUST_PROXY: '1' }).trustProxy()).toBe(1);
    const issues = new EnvIssues({ TRUST_PROXY: 'true' });
    expect(issues.trustProxy()).toBe(false);
    expect(issues.list.map((i) => i.name)).toEqual(['TRUST_PROXY']);
  });
});

describe('clientIp', () => {
  it('ignores X-Forwarded-For entirely when no proxy is trusted', () => {
    expect(ip(false, '203.0.113.9', '1.2.3.4')).toBe('203.0.113.9');
    expect(ip(false, '2001:db8::7', '1.2.3.4, 5.6.7.8')).toBe('2001:db8::7');
  });

  it('takes the entry the trusted hops appended, not the forgeable left-most one', () => {
    // Client forges "6.6.6.6"; the one trusted load balancer appends the real address.
    expect(ip(1, '10.0.0.2', '6.6.6.6, 198.51.100.7')).toBe('198.51.100.7');
    // Two chained proxies (CDN → ingress): the CDN appended the client, the ingress appended the CDN.
    expect(ip(2, '10.0.0.3', '6.6.6.6, 198.51.100.7, 172.16.4.4')).toBe('198.51.100.7');
    // Fewer entries than hops: the furthest address there is.
    expect(ip(3, '10.0.0.3', '198.51.100.7')).toBe('198.51.100.7');
    expect(ip(1, '10.0.0.2')).toBe('10.0.0.2');
  });

  it('walks a CIDR list from the socket leftwards, stopping at the first untrusted hop', () => {
    const trust: TrustProxy = ['10.0.0.0/8', '172.16.0.0/12'];
    expect(ip(trust, '10.1.2.3', '6.6.6.6, 198.51.100.7, 172.16.4.4')).toBe('198.51.100.7');
    // A request straight from the internet: its own header is not believed.
    expect(ip(trust, '198.51.100.7', '10.9.9.9')).toBe('198.51.100.7');
    // A client faking an internal hop in the header does not extend the chain past it.
    expect(ip(trust, '10.1.2.3', '6.6.6.6, 10.5.5.5')).toBe('6.6.6.6');
  });

  it('handles IPv6 sockets, IPv6 clients and IPv4-mapped addresses', () => {
    expect(ip(['fd00::/8'], 'fd00::1', '2001:db8::42')).toBe('2001:db8::42');
    expect(ip(['::1'], '::1', '2001:db8::42, 198.51.100.7')).toBe('198.51.100.7');
    // Dual-stack sockets report IPv4 peers as ::ffff:a.b.c.d; an IPv4 CIDR still matches them.
    expect(ip(['10.0.0.0/8'], '::ffff:10.0.0.2', '2001:db8::42')).toBe('2001:db8::42');
    expect(ip(['loopback'], '::ffff:127.0.0.1', '198.51.100.7')).toBe('198.51.100.7');
    expect(ip(1, '::1', ' 2001:db8::42 ')).toBe('2001:db8::42');
  });

  it('reports a closed socket as unknown', () => {
    expect(ip(1, undefined, '1.2.3.4')).toBe('unknown');
  });
});
