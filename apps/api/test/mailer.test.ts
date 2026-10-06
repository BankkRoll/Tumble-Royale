import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import {
  ConsoleMailer,
  createMailer,
  DisabledMailer,
  SmtpMailer,
  type MailTransport,
} from '../src/auth/mailer.ts';
import { loadConfig } from '../src/config.ts';
import { TEST_BINDING, testEnv } from './helpers.ts';

const PROD = testEnv({
  NODE_ENV: 'production',
  PUBLIC_WEB_URL: 'https://play.example.com',
  ALLOW_MEMORY_STORE: '1',
  ALLOW_EMBEDDED_DB: '1',
});

function fakeTransport(): MailTransport & { sent: Parameters<MailTransport['sendMail']>[0][] } {
  const sent: Parameters<MailTransport['sendMail']>[0][] = [];
  return {
    sent,
    async sendMail(mail) {
      sent.push(mail);
      return { messageId: 'x' };
    },
  };
}

describe('mailer selection', () => {
  it('uses the console in development and test', () => {
    expect(createMailer(loadConfig(testEnv({ NODE_ENV: 'development' })))).toBeInstanceOf(ConsoleMailer);
    expect(createMailer(loadConfig(testEnv()))).toBeInstanceOf(ConsoleMailer);
  });

  it('disables email in production without SMTP', () => {
    expect(createMailer(loadConfig(PROD))).toBeInstanceOf(DisabledMailer);
  });

  it('uses SMTP whenever SMTP_URL is set, with a sender derived from the web origin', async () => {
    const config = loadConfig({ ...PROD, SMTP_URL: 'smtp://user:pass@smtp.example.com:587' });
    expect(config.smtp).toEqual({
      url: 'smtp://user:pass@smtp.example.com:587',
      from: 'Tumble Royale <no-reply@play.example.com>',
    });
    const transport = fakeTransport();
    const mailer = createMailer(config, transport);
    expect(mailer).toBeInstanceOf(SmtpMailer);
    await mailer.send({ to: 'a@b.co', subject: 'Hi', text: 'Hello' });
    expect(transport.sent).toEqual([
      { from: 'Tumble Royale <no-reply@play.example.com>', to: 'a@b.co', subject: 'Hi', text: 'Hello' },
    ]);
  });

  it('honours SMTP_FROM', () => {
    const config = loadConfig({ ...PROD, SMTP_URL: 'smtps://smtp.example.com', SMTP_FROM: 'Hi <hi@x.io>' });
    expect(config.smtp?.from).toBe('Hi <hi@x.io>');
  });

  it('builds a real nodemailer transport from the URL without connecting', () => {
    expect(() => new SmtpMailer('smtp://user:pass@127.0.0.1:2525', 'a@b.co')).not.toThrow();
  });
});

describe('email sign-in without a mailer', () => {
  const built = buildApp(loadConfig({ ...PROD, PGLITE_DIR: 'memory://', RATE_LIMIT_MAX: '1000' }), {
    logger: false,
  });
  afterAll(async () => (await built).close());

  it('reports email as disabled and refuses to start a magic link', async () => {
    const { app } = await built;
    expect((await app.inject({ method: 'GET', url: '/auth/providers' })).json()).toMatchObject({
      email: false,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/auth/email/start',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'a@b.co', binding: TEST_BINDING }),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('provider_disabled');
  });
});

describe('email delivery failure', () => {
  it('reports email_failed and forgets the unsent link', async () => {
    const failing = { id: 'smtp' as const, send: () => Promise.reject(new Error('relay down')) };
    const { app, ctx, close } = await buildApp(loadConfig(testEnv({ RATE_LIMIT_MAX: '1000' })), {
      mailer: failing,
      logger: false,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/email/start',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email: 'a@b.co', binding: TEST_BINDING }),
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe('email_failed');
      expect(ctx.mailer.id).toBe('smtp');
    } finally {
      await close();
    }
  });
});
