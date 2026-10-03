/**
 * Pluggable outbound email. Development uses {@link ConsoleMailer}; production
 * can drop in an SMTP or provider-API implementation of {@link Mailer}.
 */

/** An outbound email. */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Sends email. */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Logs messages instead of sending them (dev). */
export class ConsoleMailer implements Mailer {
  async send(message: MailMessage): Promise<void> {
    console.log(`[mail] to=${message.to} subject="${message.subject}"\n${message.text}`);
  }
}

/** Collects messages in memory (tests). */
export class MemoryMailer implements Mailer {
  /** Every message sent so far. */
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
}
