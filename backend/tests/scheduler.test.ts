import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { after, before, test } from 'node:test'
import type { Job } from 'bullmq'
import { createApp } from '../src/app'
import { prisma } from '../src/db'
import { enqueueEmailById, reconcileScheduledEmails } from '../src/outbox'
import { createEmailProcessor } from '../src/processor'
import { createEmailQueue, type EmailJobData } from '../src/queue'

interface ApiEmail { id: string; status: string; attemptCount: number; smtpAcceptedAt: string | null; lastError: string | null }
interface ApiResponse { data?: ApiEmail; error?: { code: string; message: string }; idempotentReplay?: boolean }

let server: Server | undefined
let baseUrl: string
const createdIds = new Set<string>()
const emailQueue = createEmailQueue()
const testSenderId = `test-${randomUUID()}`

before(async () => {
  await prisma.$connect()
  await prisma.sender.create({ data: { id: testSenderId, email: 'scheduler-test@example.com', name: 'Test Sender' } })
  await emailQueue.waitUntilReady()
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
  await prisma.sender.deleteMany({ where: { id: testSenderId } })
  if (server?.listening) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()))
  await emailQueue.close()
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
  const processor = createEmailProcessor(prisma, { send: async () => { sends += 1; return { messageId: 'mock-message-id' } } })
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
  const processor = createEmailProcessor(prisma, { send: async () => { throw new Error('mock SMTP unavailable') } })
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

async function createDueEmail(): Promise<ApiEmail> {
  const body = scheduleBody()
  const response = await post('/api/emails/schedule', body)
  assert.equal(response.status, 202)
  const email = (await response.json() as ApiResponse).data!
  createdIds.add(email.id)
  const job = await emailQueue.getJob(`email-${email.id}`)
  if (job) await job.remove()
  await prisma.email.update({ where: { id: email.id }, data: { scheduledAt: new Date(Date.now() - 1000) } })
  return email
}

function fakeJob(emailId: string, attemptsMade: number): Job<EmailJobData> {
  return { data: { emailId }, attemptsMade, opts: { attempts: 3 } } as Job<EmailJobData>
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
