import { createHash } from 'node:crypto'
import { DelayedError, type Job, type Queue, Worker } from 'bullmq'
import type { PrismaClient, SlackNotificationOutbox } from '@prisma/client'
import { decryptSecret } from './slack-security'
import { SLACK_DEPLOYMENT_KEY } from './slack-integration'
import { redisConnection } from './queue'
import { SLACK_NOTIFICATION_QUEUE, type SlackNotificationJobData } from './slack-queue'

const ACTIVE_JOB_STATES = ['waiting', 'delayed', 'active', 'paused', 'waiting-children']
const MAX_DELIVERY_ATTEMPTS = 8

export interface QuotaNotificationInput {
  senderId: string
  senderEmail: string
  senderName: string | null
  hourlyLimit: number
  nextEligibleAt: number | null
  notificationPeriod: string
}

export class NotificationNotFoundError extends Error {}
export class NotificationStateError extends Error {}

type NotificationDb = Pick<PrismaClient, 'slackNotificationOutbox' | 'slackConnection'>
type NotificationQueue = Pick<Queue<SlackNotificationJobData>, 'add' | 'getJob'>

export async function enqueueQuotaNotification(
  db: NotificationDb,
  queue: NotificationQueue,
  input: QuotaNotificationInput,
): Promise<void> {
  const connection = await db.slackConnection.findUnique({ where: { deploymentKey: SLACK_DEPLOYMENT_KEY }, select: { status: true } })
  if (!connection || connection.status !== 'ACTIVE') return
  const eventKey = createHash('sha256').update(JSON.stringify([input.senderId, input.notificationPeriod])).digest('hex')
  const record = await db.slackNotificationOutbox.upsert({
    where: { eventKey },
    create: {
      eventKey,
      senderId: input.senderId,
      senderEmail: input.senderEmail,
      senderName: input.senderName,
      hourlyLimit: input.hourlyLimit,
      nextEligibleAt: input.nextEligibleAt === null ? null : new Date(input.nextEligibleAt),
    },
    update: {},
  })
  if (record.status !== 'PENDING') return
  await ensureNotificationJob(db, queue, record)
}

export async function reconcileSlackNotifications(db: NotificationDb, queue: NotificationQueue): Promise<number> {
  const pending = await db.slackNotificationOutbox.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' } })
  for (const record of pending) await ensureNotificationJob(db, queue, record)
  return pending.length
}

export function startSlackNotificationReconciler(
  db: NotificationDb,
  queue: NotificationQueue,
  intervalMs = 30_000,
): { close: () => Promise<void> } {
  let running = false
  let stopped = false
  let inFlight: Promise<void> | undefined
  const timer = setInterval(() => {
    if (stopped || running) return
    running = true
    inFlight = reconcileSlackNotifications(db, queue)
      .then(() => undefined)
      .catch(() => { console.error('Slack notification reconciliation failed.') })
      .finally(() => { running = false })
  }, intervalMs)
  timer.unref()
  return {
    close: async () => {
      stopped = true
      clearInterval(timer)
      await inFlight
    },
  }
}

async function ensureNotificationJob(db: NotificationDb, queue: NotificationQueue, record: SlackNotificationOutbox): Promise<void> {
  if (record.attemptCount >= MAX_DELIVERY_ATTEMPTS) {
    await db.slackNotificationOutbox.updateMany({
      where: { id: record.id, status: 'PENDING', replayCount: record.replayCount },
      data: { status: 'FAILED', lastError: 'Notification delivery retry limit exhausted; operator replay required.' },
    })
    return
  }
  const jobId = notificationJobId(record.id, record.replayCount)
  const existing = await queue.getJob(jobId)
  if (existing) {
    const state = await existing.getState()
    if (ACTIVE_JOB_STATES.includes(state)) return
    await db.slackNotificationOutbox.updateMany({
      where: { id: record.id, status: 'PENDING', replayCount: record.replayCount },
      data: { status: 'FAILED', lastError: 'Notification queue job ended while the outbox remained pending; operator replay required.' },
    })
    return
  }
  await queue.add('deliver-slack-notification', { notificationId: record.id }, { jobId, attempts: MAX_DELIVERY_ATTEMPTS, backoff: { type: 'exponential', delay: 10_000 } })
}

export async function listFailedNotifications(prisma: PrismaClient, limit = 50) {
  const records = await prisma.slackNotificationOutbox.findMany({
    where: { status: 'FAILED' },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    take: limit,
    select: { id: true, senderId: true, status: true, attemptCount: true, replayCount: true, createdAt: true, updatedAt: true, lastError: true },
  })
  return records.map((record) => ({
    ...record,
    eventType: 'sender_quota_limit' as const,
    lastError: sanitizeNotificationError(record.lastError),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }))
}

export async function replayFailedNotification(prisma: PrismaClient, queue: Queue<SlackNotificationJobData>, id: string) {
  const claimed = await prisma.slackNotificationOutbox.updateMany({
    where: { id, status: 'FAILED' },
    data: { status: 'PENDING', attemptCount: 0, replayCount: { increment: 1 }, lastError: null, deliveredAt: null },
  })
  if (claimed.count !== 1) {
    const existing = await prisma.slackNotificationOutbox.findUnique({ where: { id }, select: { status: true } })
    if (!existing) throw new NotificationNotFoundError('Notification event was not found.')
    throw new NotificationStateError('Only failed notification events can be replayed.')
  }
  const record = await prisma.slackNotificationOutbox.findUniqueOrThrow({ where: { id } })
  await ensureNotificationJob(prisma, queue, record)
  return {
    id: record.id,
    eventType: 'sender_quota_limit' as const,
    senderId: record.senderId,
    status: record.status,
    attemptCount: record.attemptCount,
    replayCount: record.replayCount,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

function notificationJobId(id: string, replayCount: number): string {
  return replayCount === 0 ? `slack-notification-${id}` : `slack-notification-${id}-replay-${replayCount}`
}

function sanitizeNotificationError(value: string | null): string | null {
  if (!value) return null
  return value
    .replace(/https?:\/\/\S+/gi, '[redacted URL]')
    .replace(/(?:xox[baprs]-[A-Za-z0-9-]+|Bearer\s+\S+)/gi, '[redacted credential]')
    .replace(/[\r\n\t]/g, ' ')
    .slice(0, 300)
}

export function createSlackNotificationWorker(prisma: PrismaClient, encryptionKey: string, fetcher: typeof fetch = fetch) {
  return new Worker<SlackNotificationJobData>(SLACK_NOTIFICATION_QUEUE, async (job) => {
    await deliverQuotaNotification(prisma, job, encryptionKey, fetcher)
  }, { connection: redisConnection, concurrency: 2 })
}

export async function deliverQuotaNotification(
  prisma: PrismaClient,
  job: Job<SlackNotificationJobData>,
  encryptionKey: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const notification = await prisma.slackNotificationOutbox.findUnique({ where: { id: job.data.notificationId } })
  if (!notification || notification.status !== 'PENDING') return
  const connection = await prisma.slackConnection.findUnique({ where: { deploymentKey: SLACK_DEPLOYMENT_KEY } })
  if (!connection || connection.status !== 'ACTIVE') {
    await prisma.slackNotificationOutbox.update({ where: { id: notification.id }, data: { status: 'SKIPPED', lastError: 'No active Slack connection was available.' } })
    return
  }

  const updated = await prisma.slackNotificationOutbox.updateMany({
    where: { id: notification.id, status: 'PENDING' },
    data: { attemptCount: { increment: 1 } },
  })
  if (updated.count !== 1) return
  const attemptNumber = notification.attemptCount + 1

  try {
    const webhookUrl = decryptSecret({
      ciphertext: connection.webhookCiphertext,
      nonce: connection.webhookNonce,
      authTag: connection.webhookAuthTag,
    }, encryptionKey)
    const response = await fetcher(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: notificationText(notification), mrkdwn: false }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    if (response.status === 429) {
      if (attemptNumber >= MAX_DELIVERY_ATTEMPTS) {
        await markFailed(prisma, notification.id, 'Slack rate limit retry limit exhausted.')
        return
      }
      const retryAfterSeconds = Number(response.headers.get('retry-after'))
      const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? Math.min(retryAfterSeconds * 1000, 3_600_000)
        : 60_000
      if (!job.token) throw new Error('Slack notification cannot be delayed because the BullMQ lock is missing.')
      await job.moveToDelayed(Date.now() + retryAfterMs, job.token)
      throw new DelayedError()
    }
    if (response.status === 401 || response.status === 403 || response.status === 404 || response.status === 410) {
      await prisma.slackConnection.updateMany({ where: { deploymentKey: SLACK_DEPLOYMENT_KEY, status: 'ACTIVE' }, data: { status: 'REVOKED' } })
      await markFailed(prisma, notification.id, `Slack webhook is unusable (HTTP ${response.status}).`)
      return
    }
    if (!response.ok) {
      if (response.status >= 500 && attemptNumber < MAX_DELIVERY_ATTEMPTS) throw new Error(`Slack webhook returned HTTP ${response.status}.`)
      await markFailed(prisma, notification.id, `Slack webhook returned HTTP ${response.status}.`)
      return
    }
    const responseBody = await response.text()
    if (responseBody.trim() !== 'ok') {
      await markFailed(prisma, notification.id, 'Slack webhook returned an unexpected response.')
      return
    }
    await prisma.slackNotificationOutbox.update({
      where: { id: notification.id },
      data: { status: 'DELIVERED', deliveredAt: new Date(), lastError: null },
    })
  } catch (error) {
    if (error instanceof DelayedError) throw error
    if (attemptNumber >= MAX_DELIVERY_ATTEMPTS) {
      await markFailed(prisma, notification.id, 'Slack notification retry limit exhausted.')
      return
    }
    throw error
  }
}

function notificationText(notification: SlackNotificationOutbox): string {
  const sender = notification.senderName
    ? `${plainText(notification.senderName)} <${plainText(notification.senderEmail)}>`
    : plainText(notification.senderEmail)
  const eligible = notification.nextEligibleAt
    ? notification.nextEligibleAt.toISOString()
    : 'after the sender limit is changed'
  const limit = notification.hourlyLimit === 0 ? 'disabled (0/hour)' : `${notification.hourlyLimit}/hour`
  return `ReachInbox: sender ${sender} reached its sending limit (${limit}). Email sending is postponed; next eligible time: ${eligible}.`
}

function plainText(value: string): string {
  return value.replace(/[\r\n\t]/g, ' ').slice(0, 320)
}

async function markFailed(prisma: PrismaClient, notificationId: string, reason: string): Promise<void> {
  await prisma.slackNotificationOutbox.update({ where: { id: notificationId }, data: { status: 'FAILED', lastError: reason } })
}

