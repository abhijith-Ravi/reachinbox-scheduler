import { DelayedError, type Job } from 'bullmq'
import type { PrismaClient } from '@prisma/client'
import { config } from './config'
import type { EmailTransport } from './email-transport'
import type { EmailJobData } from './queue'
import type { SenderRateLimiter } from './rate-limit'

export function createEmailProcessor(db: PrismaClient, transport: EmailTransport, limiter: SenderRateLimiter) {
  return async (job: Job<EmailJobData>): Promise<void> => {
    const maxAttempts = job.opts.attempts ?? config.EMAIL_MAX_ATTEMPTS
    const staleBefore = new Date(Date.now() - config.EMAIL_PROCESSING_STALE_MS)
    const claimed = await db.email.updateMany({
      where: {
        id: job.data.emailId,
        attemptCount: { lt: maxAttempts },
        OR: [
          { status: 'SCHEDULED' },
          { status: 'PROCESSING', processingStartedAt: { lt: staleBefore } },
          { status: 'PROCESSING', processingStartedAt: null },
          ...(job.attemptsMade > 0 ? [{ status: 'PROCESSING' as const }] : []),
        ],
      },
      data: { status: 'PROCESSING', processingStartedAt: new Date(), lastError: null },
    })

    if (claimed.count === 0) {
      const current = await db.email.findUnique({ where: { id: job.data.emailId }, select: { status: true, attemptCount: true } })
      if (current?.status === 'SENT' || current?.status === 'FAILED') return
      if (current && current.attemptCount >= maxAttempts) {
        await db.email.updateMany({
          where: { id: job.data.emailId, status: { in: ['SCHEDULED', 'PROCESSING'] } },
          data: { status: 'FAILED', processingStartedAt: null, lastError: 'Maximum email delivery attempts exhausted.' },
        })
        return
      }
      throw new Error('Email is already being processed; BullMQ will retry after the active attempt settles.')
    }

    const email = await db.email.findUnique({ where: { id: job.data.emailId }, include: { sender: true } })
    if (!email) throw new Error(`Email record ${job.data.emailId} no longer exists.`)

    let permit
    try {
      permit = await limiter.reserve(email.senderId, email.id, email.sender.hourlyLimit)
    } catch (error) {
      await db.email.updateMany({
        where: { id: email.id, status: 'PROCESSING' },
        data: { status: 'SCHEDULED', processingStartedAt: null, lastError: `Redis send coordination failed: ${errorMessage(error)}` },
      })
      throw error
    }

    if (!permit.allowed) {
      await db.email.updateMany({
        where: { id: email.id, status: 'PROCESSING' },
        data: { status: 'SCHEDULED', processingStartedAt: null },
      })
      if (!job.token) throw new Error('Cannot defer the email because BullMQ did not provide a lock token.')
      await job.moveToDelayed(Date.now() + Math.max(1, permit.delayMs), job.token)
      throw new DelayedError()
    }

    const started = await db.email.updateMany({
      where: { id: email.id, status: 'PROCESSING', attemptCount: { lt: maxAttempts } },
      data: { attemptCount: { increment: 1 }, lastError: null },
    })
    if (started.count !== 1) {
      await db.email.updateMany({ where: { id: email.id, status: 'PROCESSING' }, data: { status: 'FAILED', processingStartedAt: null, lastError: 'Maximum email delivery attempts exhausted.' } })
      return
    }
    const attemptNumber = email.attemptCount + 1

    try {
      const accepted = await transport.send({
        from: { address: email.sender.email, name: email.sender.name },
        to: email.recipient,
        subject: email.subject,
        text: email.body,
      })
      const completed = await db.email.updateMany({
        where: { id: email.id, status: 'PROCESSING' },
        data: {
          status: 'SENT',
          smtpAcceptedAt: new Date(),
          smtpMessageId: accepted.messageId,
          processingStartedAt: null,
          lastError: null,
        },
      })
      if (completed.count !== 1) throw new Error('Email state changed before SMTP acceptance could be recorded.')
    } catch (error) {
      const message = errorMessage(error)
      await db.email.updateMany({
        where: { id: email.id, status: 'PROCESSING' },
        data: {
          status: attemptNumber >= maxAttempts ? 'FAILED' : 'SCHEDULED',
          processingStartedAt: null,
          lastError: message,
        },
      })
      throw error
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 2000) : 'Unknown error'
}
