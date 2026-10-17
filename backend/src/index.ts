import Redis from 'ioredis'
import { config } from './config'
import { createApp } from './app'
import { ensureDefaultSender, prisma } from './db'
import { createEmailQueue, redisConnection } from './queue'
import { enqueueEmailById, reconcileScheduledEmails } from './outbox'
import { SlackIntegration } from './slack-integration'
import { createSlackNotificationQueue } from './slack-queue'
import { createElasticsearchClient } from './email-search'

async function main(): Promise<void> {
  await prisma.$connect()
  await ensureDefaultSender()
  const queue = createEmailQueue()
  await queue.waitUntilReady()
  const slackNotificationQueue = createSlackNotificationQueue()
  await slackNotificationQueue.waitUntilReady()
  const slackRedis = new Redis(redisConnection)
  await slackRedis.ping()
  const elasticsearch = createElasticsearchClient()
  const recovered = await reconcileScheduledEmails(prisma, queue)
  if (recovered) console.info(`Reconciled ${recovered} persisted scheduled email(s).`)

  const app = createApp({
    prisma,
    enqueueEmail: (emailId) => enqueueEmailById(prisma, queue, emailId),
    slack: new SlackIntegration(prisma, slackRedis, config),
    slackManagementToken: config.SLACK_MANAGEMENT_TOKEN,
    slackNotificationQueue,
    bullBoardQueues: [queue, slackNotificationQueue],
    bullBoardToken: config.BULL_BOARD_TOKEN,
    elasticsearch,
  })
  const server = app.listen(config.API_PORT, () => console.info(`ReachInbox API listening on port ${config.API_PORT}`))

  const shutdown = async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await queue.close()
    await slackNotificationQueue.close()
    await slackRedis.quit()
    await elasticsearch?.close()
    await prisma.$disconnect()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

main().catch(async (error: unknown) => {
  console.error('API startup failed', error instanceof Error ? error.message : 'Unknown error')
  await prisma.$disconnect().catch(() => undefined)
  process.exitCode = 1
})
