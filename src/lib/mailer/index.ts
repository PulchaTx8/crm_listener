import nodemailer from 'nodemailer';

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  from?: string;
  /**
   * Extra RFC 5322 headers. Groundwork for Block 29d, which will set
   * List-Unsubscribe and List-Unsubscribe-Post when sending campaigns. They
   * belong on the message rather than on the transport because the URL is per
   * recipient.
   */
  headers?: Record<string, string>;
};
export type MailResult = { id: string };

export interface Mailer {
  send(msg: MailMessage): Promise<MailResult>;
}

// Development/test impl: sends nothing, just records.
export class DevMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  private seq = 0;
  async send(msg: MailMessage): Promise<MailResult> {
    this.sent.push(msg);
    this.seq += 1;
    return { id: `dev-${this.seq}` };
  }
}

// SMTP impl for production (Resend/any SMTP). Configured via SMTP_URL + MAIL_FROM.
export class SmtpMailer implements Mailer {
  private readonly transport: nodemailer.Transporter;

  constructor(
    smtpUrl: string,
    private readonly defaultFrom: string,
  ) {
    this.transport = nodemailer.createTransport(smtpUrl);
  }

  async send(msg: MailMessage): Promise<MailResult> {
    const info = await this.transport.sendMail({
      from: msg.from ?? this.defaultFrom,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      headers: msg.headers,
    });
    return { id: info.messageId };
  }
}
