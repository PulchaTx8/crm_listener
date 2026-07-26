import nodemailer from 'nodemailer';

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  from?: string;
};
export type MailResult = { id: string };

export interface Mailer {
  send(msg: MailMessage): Promise<MailResult>;
}

// Impl de desenvolvimento/teste: não envia nada, só registra.
export class DevMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  private seq = 0;
  async send(msg: MailMessage): Promise<MailResult> {
    this.sent.push(msg);
    this.seq += 1;
    return { id: `dev-${this.seq}` };
  }
}

// Impl SMTP para produção (Resend/qualquer SMTP). Config via SMTP_URL + MAIL_FROM.
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
    });
    return { id: info.messageId };
  }
}
