import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { after, before, test } from 'node:test'
import { Worker, type Job } from 'bullmq'
import Redis from 'ioredis'
import { createApp } from '../src/app'
import { prisma } from '../src/db'
import { enqueueEmailById, reconcileScheduledEmails } from '../src/outbox'
import { createEmailProcessor } from '../src/processor'
import { createEmailQueue, EMAIL_QUEUE_NAME, emailJobOptions, redisConnection, type EmailJobData } from '../src/queue'
import { SenderRateLimiter, ZERO_LIMIT_RECHECK_MS } from '../src/rate-limit'

interface ApiEmail { id: string; status: string; attemptCount: number; smtpAcceptedAt: string | null; lastError: string | null }
interface ApiResponse { data?: ApiEmail; error?: { code: string; message: string }; idempotentReplay?: boolean }

let server: Server | undefined
let baseUrl: string
const createdIds = new Set<string>()
const emailQueue = createEmailQueue()
const rateRedis = new Redis(redisConnection)
const testSenderId = `test-${randomUUID()}`
const createdSenderIds = new Set<string>([testSenderId])
const limiter = new SenderRateLimiter(rateRedis, 0, 100)

before(async () => {
  await prisma.$connect()
  await prisma.sender.create({ data: { id: testSenderId, email: 'scheduler-test@example.com', name: 'Test Sender' } })
  await emailQueue.waitUntilReady()
  await rateRedis.ping()
  const app = createApp({ prisma, enqueueEmail: (id) => enqueueEmailById(prisma, emailQueue, id) })
  server = createServer(app)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test API did not bind to a TCP port.')
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  for (const id of createdIds) {
    const job = await emailQueue.getJob(`email-${id}`)
    if (job) await job.remove().catch(() => undefined)
  }
  await prisma.email.deleteMany({ where: { id: { in: [...createdIds] } } })
  await prisma.sender.deleteMany({ where: { id: { in: [...createdSenderIds] } } })
  if (server?.listening) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()))
  await emailQueue.close()
  for (const senderId of createdSenderIds) {
    const safeId = encodeURIComponent(senderId)
    await rateRedis.del(`reachinbox:rate:{${safeId}}:starts`, `reachinbox:rate:{${safeId}}:last-start`)
  }
  await rateRedis.quit()
  await prisma.$disconnect()
})

test('validates email address and future ISO-8601 schedule time', async () => {
  const badEmail = await post('/api/emails/schedule', scheduleBody({ recipient: 'not-an-email' }))
  assert.equal(badEmail.status, 400)
  assert.equal((await badEmail.json() as ApiResponse).error?.code, 'VALIDATION_ERROR')

  const pastDate = new Date(Date.now() - 60_000).toISOString()
  const past = await post('/api/emails/schedule', scheduleBody({ scheduledAt: pastDate }))
  assert.equal(past.status, 400)
  assert.equal((await past.json() as ApiResponse).error?.code, 'INVALID_SCHEDULE_TIME')
})

test('schedules idempotently, rejects conflicting reuse, and lists scheduled/sent emails', async () => {
  const body = scheduleBody()
  const first = await post('/api/emails/schedule', body)
  assert.equal(first.status, 202)
  const firstPayload = await first.json() as ApiResponse
  const email = firstPayload.data!
  createdIds.add(email.id)
  assert.equal(email.status, 'SCHEDULED')

  const duplicate = await post('/api/emails/schedule', body)
  assert.equal(duplicate.status, 200)
  const duplicatePayload = await duplicate.json() as ApiResponse
  assert.equal(duplicatePayload.data?.id, email.id)
  assert.equal(duplicatePayload.idempotentReplay, true)

  const conflict = await post('/api/emails/schedule', { ...body, subject: 'Different subject' })
  assert.equal(conflict.status, 409)
  assert.equal((await conflict.json() as ApiResponse).error?.code, 'IDEMPOTENCY_CONFLICT')

  const scheduled = await fetch(`${baseUrl}/api/emails/scheduled?limit=100`)
  assert.equal(scheduled.status, 200)
  assert.ok((await scheduled.json() as { data: ApiEmail[] }).data.some((item) => item.id === email.id))

  const detail = await fetch(`${baseUrl}/api/emails/${email.id}`)
  assert.equal((await detail.json() as ApiResponse).data?.id, email.id)

  const acceptedAt = new Date()
  await prisma.email.update({ where: { id: email.id }, data: { status: 'SENT', smtpAcceptedAt: acceptedAt } })
  const sent = await fetch(`${baseUrl}/api/emails/sent?limit=100`)
  assert.equal(sent.status, 200)
  assert.ok((await sent.json() as { data: ApiEmail[] }).data.some((item) => item.id === email.id))
})

test('concurrent requests with one idempotency key converge on one database record', async () => {
  const body = scheduleBody()
  const responses = await Promise.all([
    post('/api/emails/schedule', body),
    post('/api/emails/schedule', body),
  ])
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 202])
  const payloads = await Promise.all(responses.map((response) => response.json() as Promise<ApiResponse>))
  const ids = new Set(payloads.map((payload) => payload.data!.id))
  assert.equal(ids.size, 1)
  createdIds.add([...ids][0]!)
  assert.equal(await prisma.email.count({ where: { idempotencyKey: body.idempotencyKey } }), 1)
})

test('persists an outbox row when Redis enqueue fails and recovers the same request on retry', async () => {
  const body = scheduleBody()
  const failingApp = createApp({ prisma, enqueueEmail: async () => { throw new Error('simulated Redis outage') } })
  const failingServer = createServer(failingApp)
  failingServer.listen(0, '127.0.0.1')
  await once(failingServer, 'listening')
  const address = failingServer.address()
  if (!address || typeof address === 'string') throw new Error('Failure test API did not bind.')

  try {
    const failedEnqueue = await fetch(`http://127.0.0.1:${address.port}/api/emails/schedule`, jsonRequest(body))
    assert.equal(failedEnqueue.status, 503)
    const failedPayload = await failedEnqueue.json() as { data: ApiEmail; error: { code: string } }
    assert.equal(failedPayload.error.code, 'QUEUE_UNAVAILABLE')
    createdIds.add(failedPayload.data.id)
    assert.equal((await prisma.emailOutbox.findUnique({ where: { emailId: failedPayload.data.id } }))?.status, 'PENDING')

    const retried = await post('/api/emails/schedule', body)
    assert.equal(retried.status, 200)
    const retriedPayload = await retried.json() as ApiResponse
    assert.equal(retriedPayload.data?.id, failedPayload.data.id)
    assert.equal((await prisma.emailOutbox.findUnique({ where: { emailId: failedPayload.data.id } }))?.status, 'ENQUEUED')
  } finally {
    await new Promise<void>((resolve, reject) => failingServer.close((error) => error ? reject(error) : resolve()))
  }
})

test('SMTP acceptance sets SENT and a repeated job does not send again', async () => {
  const email = await createDueEmail()
  let sends = 0
  const processor = createEmailProcessor(prisma, { send: async () => { sends += 1; return { messageId: 'mock-message-id' } } }, limiter)
  const job = fakeJob(email.id, 0)
  await processor(job)
  await processor(fakeJob(email.id, 1))
  const stored = await prisma.email.findUniqueOrThrow({ where: { id: email.id } })
  assert.equal(stored.status, 'SENT')
  assert.equal(stored.attemptCount, 1)
  assert.ok(stored.smtpAcceptedAt)
  assert.equal(stored.smtpMessageId, 'mock-message-id')
  assert.equal(sends, 1)
})

test('SMTP failures use bounded retry transitions and retain the final error', async () => {
  const email = await createDueEmail()
  const processor = createEmailProcessor(prisma, { send: async () => { throw new Error('mock SMTP unavailable') } }, limiter)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(processor(fakeJob(email.id, attempt)), /mock SMTP unavailable/)
    const stored = await prisma.email.findUniqueOrThrow({ where: { id: email.id } })
    assert.equal(stored.attemptCount, attempt + 1)
    assert.equal(stored.status, attempt === 2 ? 'FAILED' : 'SCHEDULED')
    assert.equal(stored.lastError, 'mock SMTP unavailable')
  }
})

test('startup reconciliation restores a missing persistent delayed job', async () => {
  const body = scheduleBody()
  const response = await post('/api/emails/schedule', body)
  assert.equal(response.status, 202)
  const email = (await response.json() as ApiResponse).data!
  createdIds.add(email.id)
  const jobId = `email-${email.id}`
  const oldJob = await emailQueue.getJob(jobId)
  assert.ok(oldJob)
  await oldJob.remove()

  const recovered = await reconcileScheduledEmails(prisma, emailQueue)
  assert.ok(recovered >= 1)
  const recoveredJob = await emailQueue.getJob(jobId)
  assert.ok(recoveredJob)
  assert.ok(['delayed', 'waiting'].includes(await recoveredJob.getState()))
})

test('Redis enforces the sender minimum delay using server time', async () => {
  const senderId = await createTestSender(20)
  const shortDelayLimiter = new SenderRateLimiter(rateRedis, 250, 20)
  const first = await shortDelayLimiter.reserve(senderId, `email-${randomUUID()}`, 20)
  const second = await shortDelayLimiter.reserve(senderId, `email-${randomUUID()}`, 20)
  assert.equal(first.allowed, true)
  assert.equal(second.allowed, false)
  assert.ok(second.delayMs > 0 && second.delayMs <= 250)
})

test('per-sender zero hourly limit denies reservation when the Redis quota set is empty', async () => {
  const senderId = await createTestSender(0)
  const key = `reachinbox:rate:{${encodeURIComponent(senderId)}}:starts`
  assert.equal(await rateRedis.zcard(key), 0)
  const result = await limiter.reserve(senderId, `email-${randomUUID()}`, 0)
  assert.equal(result.allowed, false)
  assert.equal(result.delayMs, ZERO_LIMIT_RECHECK_MS)
  assert.equal(result.nextEligibleAt, null)
  assert.ok(result.notificationPeriod?.startsWith('disabled:'))
  assert.equal(await rateRedis.zcard(key), 0)
})

test('per-sender zero hourly limit denies reservation with existing quota entries', async () => {
  const senderId = await createTestSender(0)
  const key = `reachinbox:rate:{${encodeURIComponent(senderId)}}:starts`
  const existing = await limiter.reserve(senderId, `email-${randomUUID()}`, 1)
  assert.equal(existing.allowed, true)
  assert.equal(await rateRedis.zcard(key), 1)

  const result = await limiter.reserve(senderId, `email-${randomUUID()}`, 0)
  assert.equal(result.allowed, false)
  assert.equal(result.delayMs, ZERO_LIMIT_RECHECK_MS)
  assert.equal(await rateRedis.zcard(key), 1)
})

test('zero configured default limit is fail-closed even though env validation disallows it', async () => {
  const senderId = await createTestSender(0)
  const zeroDefaultLimiter = new SenderRateLimiter(rateRedis, 0, 0)
  const result = await zeroDefaultLimiter.reserve(senderId, `email-${randomUUID()}`, null)
  assert.equal(result.allowed, false)
  assert.equal(result.delayMs, ZERO_LIMIT_RECHECK_MS)
})

test('zero-limit email is not sent and is parked in BullMQ without a tight retry loop', async () => {
  const senderId = await createTestSender(0)
  const email = await createDueEmail(senderId)
  const oldJob = await emailQueue.getJob(`email-${email.id}`)
  if (oldJob) await oldJob.remove()
  await emailQueue.add('deliver-email', { emailId: email.id }, emailJobOptions(email.id, 0))

  let sends = 0
  let notifications = 0
  const worker = new Worker<EmailJobData>(EMAIL_QUEUE_NAME,
    createEmailProcessor(prisma, { send: async () => { sends += 1; return { messageId: 'unexpected' } } }, limiter, async (event) => {
      notifications += 1
      assert.equal(event.hourlyLimit, 0)
      assert.equal(event.nextEligibleAt, null)
    }),
    { connection: redisConnection, concurrency: 1 })
  try {
    await worker.waitUntilReady()
    await waitForJobState(email.id, 'delayed')
    const job = await emailQueue.getJob(`email-${email.id}`)
    assert.ok(job)
    assert.ok(job.delay >= ZERO_LIMIT_RECHECK_MS - 1000)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(await job.getState(), 'delayed')
    assert.equal(sends, 0)
    assert.equal(notifications, 1)
    const stored = await prisma.email.findUniqueOrThrow({ where: { id: email.id } })
    assert.equal(stored.status, 'SCHEDULED')
    assert.equal(stored.attemptCount, 0)
  } finally {
    await worker.close()
  }
})

test('rolling hourly quota defers without changing the email record or idempotency key', async () => {
  const senderId = await createTestSender(1)
  const firstEmail = await createDueEmail(senderId)
  const secondEmail = await createDueEmail(senderId)
  const original = await prisma.email.findUniqueOrThrow({ where: { id: secondEmail.id }, select: { idempotencyKey: true, scheduledAt: true } })
  const senderLimiter = new SenderRateLimiter(rateRedis, 0, 100)
  const send = async () => ({ messageId: 'accepted' })
  await createEmailProcessor(prisma, { send }, senderLimiter)(fakeJob(firstEmail.id, 0))

  let deferredUntil = 0
  const deferredJob = fakeJob(secondEmail.id, 0, async (timestamp) => { deferredUntil = timestamp })
  await assert.rejects(createEmailProcessor(prisma, { send }, senderLimiter)(deferredJob), /delayed/i)
  const stored = await prisma.email.findUniqueOrThrow({ where: { id: secondEmail.id } })
  assert.equal(stored.status, 'SCHEDULED')
  assert.equal(stored.attemptCount, 0)
  assert.equal(stored.idempotencyKey, original.idempotencyKey)
  assert.equal(stored.scheduledAt.getTime(), original.scheduledAt.getTime())
  assert.ok(deferredUntil > Date.now())
})

test('independent senders have separate hourly quotas', async () => {
  const senderA = await createTestSender(1)
  const senderB = await createTestSender(1)
  const senderLimiter = new SenderRateLimiter(rateRedis, 0, 100)
  const [a, b] = await Promise.all([
    senderLimiter.reserve(senderA, `email-${randomUUID()}`, 1),
    senderLimiter.reserve(senderB, `email-${randomUUID()}`, 1),
  ])
  assert.equal(a.allowed, true)
  assert.equal(b.allowed, true)
})

test('concurrent Redis reservations cannot exceed a sender quota', async () => {
  const senderId = await createTestSender(3)
  const senderLimiter = new SenderRateLimiter(rateRedis, 0, 100)
  const results = await Promise.all(Array.from({ length: 12 }, () =>
    senderLimiter.reserve(senderId, `email-${randomUUID()}`, 3)))
  assert.equal(results.filter((result) => result.allowed).length, 3)
  assert.equal(results.filter((result) => !result.allowed).length, 9)
})

test('concurrent workers for one sender allow one SMTP start and defer the rest', async () => {
  const senderId = await createTestSender(1)
  const emails = await Promise.all(Array.from({ length: 4 }, () => createDueEmail(senderId)))
  const senderLimiter = new SenderRateLimiter(rateRedis, 0, 100)
  let sends = 0
  const processor = createEmailProcessor(prisma, { send: async () => {
    sends += 1
    return { messageId: 'accepted' }
  } }, senderLimiter)
  const results = await Promise.allSettled(emails.map((email) => processor(fakeJob(email.id, 0))))
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter((result) => result.status === 'rejected').length, 3)
  assert.equal(sends, 1)
  const rows = await prisma.email.findMany({ where: { id: { in: emails.map((email) => email.id) } } })
  assert.equal(rows.filter((email) => email.status === 'SENT').length, 1)
  assert.equal(rows.filter((email) => email.status === 'SCHEDULED').length, 3)
  assert.ok(rows.every((email) => email.attemptCount <= 1))
})

test('rate-delayed BullMQ job survives worker restart and keeps its database row scheduled', async () => {
  const senderId = await createTestSender(1)
  const email = await createDueEmail(senderId)
  const existing = await emailQueue.getJob(`email-${email.id}`)
  if (existing) await existing.remove()
  await limiter.reserve(senderId, `occupied-${randomUUID()}`, 1)
  await emailQueue.add('deliver-email', { emailId: email.id }, emailJobOptions(email.id, 0))

  const makeWorker = () => new Worker<EmailJobData>(EMAIL_QUEUE_NAME,
    createEmailProcessor(prisma, { send: async () => ({ messageId: 'must-not-send' }) }, limiter),
    { connection: redisConnection, concurrency: 1 })
  const firstWorker = makeWorker()
  await firstWorker.waitUntilReady()
  await waitForJobState(email.id, 'delayed')
  await firstWorker.close()

  const restartedWorker = makeWorker()
  await restartedWorker.waitUntilReady()
  assert.equal(await (await emailQueue.getJob(`email-${email.id}`))?.getState(), 'delayed')
  assert.equal((await prisma.email.findUniqueOrThrow({ where: { id: email.id } })).status, 'SCHEDULED')
  await restartedWorker.close()
})

test('SMTP retry reuses its hourly reservation instead of consuming another slot', async () => {
  const senderId = await createTestSender(1)
  const email = await createDueEmail(senderId)
  let calls = 0
  const senderLimiter = new SenderRateLimiter(rateRedis, 0, 100)
  const processor = createEmailProcessor(prisma, { send: async () => {
    calls += 1
    if (calls < 3) throw new Error('transient SMTP failure')
    return { messageId: 'accepted-on-third-attempt' }
  } }, senderLimiter)
  await assert.rejects(processor(fakeJob(email.id, 0)), /transient SMTP failure/)
  await assert.rejects(processor(fakeJob(email.id, 1)), /transient SMTP failure/)
  await processor(fakeJob(email.id, 2))
  const stored = await prisma.email.findUniqueOrThrow({ where: { id: email.id } })
  assert.equal(stored.status, 'SENT')
  assert.equal(stored.attemptCount, 3)
  assert.equal(calls, 3)
  const key = `reachinbox:rate:{${encodeURIComponent(senderId)}}:starts`
  assert.equal(await rateRedis.zcard(key), 1)
})

test('Redis coordination failure leaves the email recoverable and consumes no SMTP attempt', async () => {
  const email = await createDueEmail()
  const brokenLimiter = { reserve: async () => { throw new Error('simulated Redis outage') } } as unknown as SenderRateLimiter
  const processor = createEmailProcessor(prisma, { send: async () => ({ messageId: 'unused' }) }, brokenLimiter)
  await assert.rejects(processor(fakeJob(email.id, 0)), /simulated Redis outage/)
  const stored = await prisma.email.findUniqueOrThrow({ where: { id: email.id } })
  assert.equal(stored.status, 'SCHEDULED')
  assert.equal(stored.attemptCount, 0)
  assert.match(stored.lastError ?? '', /Redis send coordination failed/)
})

async function createDueEmail(senderId = testSenderId): Promise<ApiEmail> {
  const body = scheduleBody({ senderId })
  const response = await post('/api/emails/schedule', body)
  assert.equal(response.status, 202)
  const email = (await response.json() as ApiResponse).data!
  createdIds.add(email.id)
  const job = await emailQueue.getJob(`email-${email.id}`)
  if (job) await job.remove()
  await prisma.email.update({ where: { id: email.id }, data: { scheduledAt: new Date(Date.now() - 1000) } })
  return email
}

function fakeJob(emailId: string, attemptsMade: number, move?: (timestamp: number) => Promise<void>): Job<EmailJobData> {
  return { data: { emailId }, attemptsMade, opts: { attempts: 3 }, token: 'test-lock-token', moveToDelayed: move ?? (async () => undefined) } as unknown as Job<EmailJobData>
}

async function createTestSender(hourlyLimit: number): Promise<string> {
  const id = `test-${randomUUID()}`
  createdSenderIds.add(id)
  await prisma.sender.create({ data: { id, email: 'rate-test@example.com', name: 'Rate Test', hourlyLimit } })
  return id
}

async function waitForJobState(emailId: string, expected: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const job = await emailQueue.getJob(`email-${emailId}`)
    if (job && await job.getState() === expected) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`BullMQ job email-${emailId} did not reach state ${expected}.`)
}

function scheduleBody(overrides: Record<string, string> = {}) {
  return {
    senderId: testSenderId,
    recipient: 'recipient@example.com',
    subject: 'Integration test email',
    body: 'Test body; never sent to SMTP in this suite.',
    scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    idempotencyKey: `test-${randomUUID()}`,
    ...overrides,
  }
}

function jsonRequest(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, jsonRequest(body))
}
