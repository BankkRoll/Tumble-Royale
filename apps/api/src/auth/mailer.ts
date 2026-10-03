/**
 * Pluggable outbound email.
 *
 * Responsibilities:
 * - {@link SmtpMailer}: real delivery over SMTP (STARTTLS / implicit TLS,
 *   AUTH PLAIN/LOGIN) via nodemailer, configured by `SMTP_URL` + `SMTP_FROM`;
 * - {@link ConsoleMailer}: the development default, prints links to the log;
 * - {@link DisabledMailer}: production without SMTP, so email sign-in is
 *   reported off by `/auth/providers` instead of silently dropping links;
 * - {@link createMailer}: picks one of the above from the config.
 */
import nodemailer from 'nodemailer';
import type { ApiConfig } from '../config.ts';

/** An outbound email. */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Sends email. */
export interface Mailer {
  /** Which implementation this is; `disabled` turns email sign-in off. */
  readonly id: 'smtp' | 'console' | 'memory' | 'disabled';
  send(message: MailMessage): Promise<void>;
}

/** Logs messages instead of sending them (dev). */
export class ConsoleMailer implements Mailer {
  readonly id = 'console';

  async send(message: MailMessage): Promise<void> {
    console.log(`[mail] to=${message.to} subject="${message.subject}"\n${message.text}`);
  }
}

/** Collects messages in memory (tests). */
export class MemoryMailer implements Mailer {
  readonly id = 'memory';
  /** Every message sent so far. */
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
}

/** Refuses to send: email sign-in is not configured. */
export class DisabledMailer implements Mailer {
  readonly id = 'disabled';

  async send(): Promise<void> {
    throw new Error('Email delivery is not configured (set SMTP_URL)');
  }
}

/** The slice of a nodemailer transport the mailer uses (lets tests stub delivery). */
export interface MailTransport {
  sendMail(mail: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<unknown>;
  verify?(): Promise<unknown>;
}

/**
 * Delivers mail through an SMTP relay.
 *
 * @example
 * const mailer = new SmtpMailer('smtp://user:pass@smtp.example.com:587', 'Tumble Royale <hi@example.com>');
 * await mailer.send({ to: 'a@b.c', subject: 'Hi', text: 'Hello' });
 */
export class SmtpMailer implements Mailer {
  readonly id = 'smtp';
  private readonly transport: MailTransport;

  /**
   * @param url - Connection URL. `smtp://` upgrades with STARTTLS when the
   *   server offers it (add `?requireTLS=true` to insist); `smtps://` uses
   *   implicit TLS (port 465). Credentials go in the userinfo part.
   * @param from - Envelope and header sender.
   * @param transport - Override for tests; defaults to a nodemailer transport.
   */
  constructor(
    url: string,
    private readonly from: string,
    transport?: MailTransport,
  ) {
    this.transport = transport ?? nodemailer.createTransport(url);
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
    });
  }

  /**
   * Opens a connection and authenticates, without sending anything.
   *
   * @throws When the relay is unreachable or rejects the credentials.
   */
  async verify(): Promise<void> {
    await this.transport.verify?.();
  }
}

/**
 * Chooses the mailer for a configuration: SMTP when `SMTP_URL` is set,
 * otherwise the console in development/test and nothing in production.
 *
 * @param config - Parsed configuration.
 * @param transport - Optional SMTP transport override (tests).
 * @returns The mailer to put on the app context.
 */
export function createMailer(config: Pick<ApiConfig, 'env' | 'smtp'>, transport?: MailTransport): Mailer {
  if (config.smtp) return new SmtpMailer(config.smtp.url, config.smtp.from, transport);
  return config.env === 'production' ? new DisabledMailer() : new ConsoleMailer();
}
