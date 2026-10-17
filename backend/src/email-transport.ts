import nodemailer, { type Transporter } from 'nodemailer'
import { config } from './config'

export interface EmailMessage {
  from: { address: string; name?: string | null }
  to: string
  subject: string
  text: string
}

export interface SmtpAccepted { messageId: string | null }
export interface EmailTransport { send(message: EmailMessage): Promise<SmtpAccepted> }

export function assertSmtpConfigured(): void {
  if (!config.SMTP_USER || !config.SMTP_PASS) {
    throw new Error('SMTP_USER and SMTP_PASS are required to start the email worker. Configure Ethereal SMTP credentials.')
  }
}

export function createEtherealTransport(): EmailTransport {
  assertSmtpConfigured()
  const transport: Transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  })
  return {
    async send(message) {
      const info = await transport.sendMail({
        from: message.from.name ? { name: message.from.name, address: message.from.address } : message.from.address,
        to: message.to,
        subject: message.subject,
        text: message.text,
      })
      const previewUrl = nodemailer.getTestMessageUrl(info)
      if (previewUrl) console.info(`Ethereal preview: ${previewUrl}`)
      return { messageId: info.messageId ?? null }
    },
  }
}
