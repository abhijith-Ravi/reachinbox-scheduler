import { Worker } from 'bullmq'
import { config } from './config'
import { ensureDefaultSender, prisma } from './db'
import { assertSmtpConfigured, createEtherealTransport } from './email-transport'
import { reconcileScheduledEmails } from './outbox'
import { createEmailProcessor } from './processor'
import { createEmailQueue, EMAIL_QUEUE_NAME, redisConnection, type EmailJobData } from './queue'

async function main(): Promise<void> {
  assertSmtpConfigured()
  await prisma.$connect()
  await ensureDefaultSender()
  const emailQueue = createEmailQueue()
  await emailQueue.waitUntilReady()
  const recovered = await reconcileScheduledEmails(prisma, emailQueue)
  if (recovered) console.info(`Reconciled ${recovered} persisted scheduled email(s).`)

  const worker = new Worker<EmailJobData>(EMAIL_QUEUE_NAME, createEmailProcessor(prisma, createEtherealTransport()), {
    connection: redisConnection,
    concurrency: config.WORKER_CONCURRENCY,
  })
  worker.on('completed', (job) => console.info(`Email job ${job.id} completed; SMTP accepted the message.`))
  worker.on('failed', (job, error) => console.error(`Email job ${job?.id ?? 'unknown'} failed: ${error.message}`))
  await worker.waitUntilReady()
  console.info(`Email worker ready with concurrency ${config.WORKER_CONCURRENCY}.`)

  const shutdown = async () => {
    await worker.close()
    await emailQueue.close()
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
