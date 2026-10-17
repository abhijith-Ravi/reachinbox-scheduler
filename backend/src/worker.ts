import { Worker } from 'bullmq'
import Redis from 'ioredis'
import { config } from './config'
import { ensureDefaultSender, prisma } from './db'
import { assertSmtpConfigured, createEtherealTransport } from './email-transport'
import { reconcileScheduledEmails } from './outbox'
import { createEmailProcessor } from './processor'
import { createEmailQueue, EMAIL_QUEUE_NAME, redisConnection, type EmailJobData } from './queue'
import { SenderRateLimiter } from './rate-limit'
import { createSlackNotificationQueue } from './slack-queue'
import { createSlackNotificationWorker, enqueueQuotaNotification, reconcileSlackNotifications, startSlackNotificationReconciler } from './slack-notifications'

async function main(): Promise<void> {
  assertSmtpConfigured()
  await prisma.$connect()
  await ensureDefaultSender()
  const emailQueue = createEmailQueue()
  await emailQueue.waitUntilReady()
  const rateRedis = new Redis(redisConnection)
  await rateRedis.ping()
  const recovered = await reconcileScheduledEmails(prisma, emailQueue)
  if (recovered) console.info(`Reconciled ${recovered} persisted scheduled email(s).`)

  const limiter = new SenderRateLimiter(rateRedis, config.EMAIL_MIN_SEND_DELAY_MS, config.SENDER_MAX_EMAILS_PER_HOUR)
  const slackQueue = createSlackNotificationQueue()
  await slackQueue.waitUntilReady()
  let slackWorker: ReturnType<typeof createSlackNotificationWorker> | undefined
  let slackReconciler: ReturnType<typeof startSlackNotificationReconciler> | undefined
  const onQuotaLimited = config.SLACK_TOKEN_ENCRYPTION_KEY
    ? (notification: Parameters<typeof enqueueQuotaNotification>[2]) => enqueueQuotaNotification(prisma, slackQueue, notification)
    : undefined
  if (config.SLACK_TOKEN_ENCRYPTION_KEY) {
    try {
      const queued = await reconcileSlackNotifications(prisma, slackQueue)
      if (queued) console.info(`Reconciled ${queued} pending Slack notification(s).`)
    } catch {
      console.error('Slack notification startup reconciliation failed; periodic recovery will retry.')
    }
    slackWorker = createSlackNotificationWorker(prisma, config.SLACK_TOKEN_ENCRYPTION_KEY)
    await slackWorker.waitUntilReady()
    slackReconciler = startSlackNotificationReconciler(prisma, slackQueue)
  }

  const worker = new Worker<EmailJobData>(EMAIL_QUEUE_NAME, createEmailProcessor(prisma, createEtherealTransport(), limiter, onQuotaLimited), {
    connection: redisConnection,
    concurrency: config.WORKER_CONCURRENCY,
  })
  worker.on('completed', (job) => console.info(`Email job ${job.id} completed; SMTP accepted the message.`))
  worker.on('failed', (job, error) => console.error(`Email job ${job?.id ?? 'unknown'} failed: ${error.message}`))
  await worker.waitUntilReady()
  console.info(`Email worker ready with concurrency ${config.WORKER_CONCURRENCY}.`)

  const shutdown = async () => {
    await worker.close()
    await slackReconciler?.close()
    await slackWorker?.close()
    await slackQueue.close()
    await emailQueue.close()
    await rateRedis.quit()
    await prisma.$disconnect()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

main().catch(async (error: unknown) => {
  console.error('Worker startup failed', error instanceof Error ? error.message : 'Unknown error')
  await prisma.$disconnect().catch(() => undefined)
  process.exitCode = 1
})
