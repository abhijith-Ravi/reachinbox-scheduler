import type { Queue } from 'bullmq'
import type { PrismaClient } from '@prisma/client'
import { config } from './config'
import { emailJobOptions, type EmailJobData } from './queue'

type Db = Pick<PrismaClient, 'email' | 'emailOutbox'>
type QueueLike = Pick<Queue<EmailJobData>, 'add' | 'getJob'>
const ACTIVE_STATES = ['waiting', 'delayed', 'active', 'paused', 'waiting-children']

export async function enqueueEmailById(db: Db, queue: QueueLike, emailId: string): Promise<void> {
  const email = await db.email.findUnique({ where: { id: emailId } })
  if (!email || !['SCHEDULED', 'PROCESSING'].includes(email.status)) return

  const outbox = await db.emailOutbox.upsert({ where: { emailId }, create: { emailId }, update: {} })
  try {
    const jobId = email.bullmqJobId ?? `email-${email.id}`
    const existing = await queue.getJob(jobId)
    if (existing) {
      const state = await existing.getState()
      if (ACTIVE_STATES.includes(state)) {
        if (email.bullmqJobId !== jobId) await db.email.update({ where: { id: emailId }, data: { bullmqJobId: jobId } })
        if (outbox.status !== 'ENQUEUED') {
          await db.emailOutbox.update({ where: { emailId }, data: { status: 'ENQUEUED', enqueuedAt: new Date(), lastError: null } })
        }
        return
      }
      await existing.remove()
    }
    await queue.add('deliver-email', { emailId }, emailJobOptions(email.id, email.scheduledAt.getTime() - Date.now()))
    await db.email.update({ where: { id: emailId }, data: { bullmqJobId: jobId } })
    await db.emailOutbox.update({ where: { emailId }, data: { status: 'ENQUEUED', attemptCount: { increment: 1 }, enqueuedAt: new Date(), lastError: null } })
  } catch (error) {
    await db.emailOutbox.update({
      where: { emailId },
      data: { status: 'PENDING', attemptCount: { increment: 1 }, lastError: errorMessage(error) },
    }).catch(() => undefined)
    throw error
  }
}

export async function reconcileScheduledEmails(db: Db, queue: QueueLike): Promise<number> {
  const staleBefore = new Date(Date.now() - config.EMAIL_PROCESSING_STALE_MS)
  const records = await db.email.findMany({
    where: { OR: [
      { status: 'SCHEDULED' },
      { status: 'PROCESSING', processingStartedAt: { lt: staleBefore } },
      { status: 'PROCESSING', processingStartedAt: null },
    ] },
    select: { id: true, attemptCount: true, status: true, processingStartedAt: true },
  })
  for (const { id, attemptCount, status, processingStartedAt } of records) {
    const email = await db.email.findUnique({ where: { id } })
    if (!email) continue
    if (attemptCount >= config.EMAIL_MAX_ATTEMPTS) {
      await db.email.updateMany({
        where: { id, status: { in: ['SCHEDULED', 'PROCESSING'] } },
        data: { status: 'FAILED', processingStartedAt: null, lastError: 'Maximum email delivery attempts exhausted during recovery.' },
      })
      continue
    }
    if (status === 'PROCESSING') {
      const existing = await queue.getJob(email.bullmqJobId ?? `email-${id}`)
      const state = existing ? await existing.getState() : 'missing'
      if (existing && ACTIVE_STATES.includes(state)) continue
      await db.email.updateMany({
        where: { id, status: 'PROCESSING', processingStartedAt },
        data: { status: 'SCHEDULED', processingStartedAt: null },
      })
    }
    await enqueueEmailById(db, queue, id)
  }
  return records.length
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 2000) : 'Unknown queue error'
}
