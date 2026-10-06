/**
 * Every host config (the client image's Caddyfile, Netlify / Cloudflare
 * `_headers`, `vercel.json`) sends one Content-Security-Policy and frame
 * protection on every response, so no page (game, invites, sign-in returns,
 * store, editor, console, status) can be framed or run another origin's
 * scripts, and page-specific rules never send a second, weaker copy.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

interface VercelConfig {
  headers: { source: string; headers: { key: string; value: string }[] }[];
}

function policies() {
  const caddy = read('../../deploy/docker/client.Caddyfile');
  const siteWide = caddy.slice(caddy.indexOf(':8080 {'), caddy.indexOf('handle'));
  const caddyCsp = /Content-Security-Policy "([^"]+)"/.exec(siteWide)?.[1];

  const headers = read('public/_headers');
  const all = headers.slice(headers.indexOf('\n/*\n'), headers.indexOf('\n/admin\n'));
  const pagesCsp = /Content-Security-Policy: (.+)$/m.exec(all)?.[1];

  const vercel = JSON.parse(read('vercel.json')) as VercelConfig;
  const everything = vercel.headers.find((h) => h.source === '/(.*)')?.headers ?? [];
  const vercelCsp = everything.find((h) => h.key === 'Content-Security-Policy')?.value;

  return { caddy, siteWide, caddyCsp, headers, all, pagesCsp, vercel, everything, vercelCsp };
}

const directives = (csp: string) =>
  new Map(
    csp.split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name!, values] as const;
    }),
  );

describe('security headers', () => {
  it('send the same policy from every host', () => {
    const p = policies();
    expect(p.caddyCsp).toBeTruthy();
    expect(p.pagesCsp).toBe(p.caddyCsp);
    expect(p.vercelCsp).toBe(p.caddyCsp);
  });

  it('forbid framing and foreign scripts', () => {
    const csp = directives(policies().caddyCsp!);
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
    expect(csp.get('script-src')).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(csp.get('object-src')).toEqual(["'none'"]);
    expect(csp.get('base-uri')).toEqual(["'self'"]);
    expect(csp.get('default-src')).toEqual(["'self'"]);
    for (const values of csp.values()) {
      expect(values).not.toContain("'unsafe-eval'");
      expect(values).not.toContain('*');
    }
    expect(csp.get('script-src')).not.toContain("'unsafe-inline'");
  });

  it('apply X-Frame-Options DENY to every path on every host', () => {
    const p = policies();
    expect(p.siteWide).toContain('X-Frame-Options "DENY"');
    expect(p.all).toContain('X-Frame-Options: DENY');
    expect(p.everything).toContainEqual({ key: 'X-Frame-Options', value: 'DENY' });
  });

  it('switch zod to no-eval mode before the bundles of pages that validate content', () => {
    for (const page of ['index.html', 'editor.html']) {
      const html = read(page);
      const noEval = html.indexOf('<script src="/no-eval.js"></script>');
      expect(noEval, page).toBeGreaterThan(-1);
      expect(noEval, page).toBeLessThan(html.indexOf('<script type="module"'));
    }
    expect(read('public/no-eval.js')).toContain('jitless: true');
  });

  it('never repeat the policy or frame header in page rules', () => {
    const p = policies();
    const caddyPages = p.caddy.slice(p.caddy.indexOf('handle'));
    expect(caddyPages).not.toMatch(/Content-Security-Policy|X-Frame-Options/);
    const pageRules = p.headers.slice(p.headers.indexOf('\n/admin\n'));
    expect(pageRules).not.toMatch(/Content-Security-Policy|X-Frame-Options/);
    for (const rule of p.vercel.headers.filter((h) => h.source !== '/(.*)'))
      expect(rule.headers.map((h) => h.key)).not.toContain('Content-Security-Policy');
  });
});
