import { config } from './config'
import { createApp } from './app'
import { ensureDefaultSender, prisma } from './db'
import { createEmailQueue } from './queue'
import { enqueueEmailById, reconcileScheduledEmails } from './outbox'

async function main(): Promise<void> {
  await prisma.$connect()
  await ensureDefaultSender()
  const queue = createEmailQueue()
  await queue.waitUntilReady()
  const recovered = await reconcileScheduledEmails(prisma, queue)
  if (recovered) console.info(`Reconciled ${recovered} persisted scheduled email(s).`)

  const app = createApp({
    prisma,
    enqueueEmail: (emailId) => enqueueEmailById(prisma, queue, emailId),
  })
  const server = app.listen(config.API_PORT, () => console.info(`ReachInbox API listening on port ${config.API_PORT}`))

  const shutdown = async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await queue.close()
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
