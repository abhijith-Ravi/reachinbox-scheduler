import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { after, before, test } from 'node:test'
import type { Client } from '@elastic/elasticsearch'
import { createApp } from '../src/app'
import { prisma } from '../src/db'
import { EMAIL_QUEUE_NAME, createEmailQueue } from '../src/queue'
import { createSlackNotificationQueue, SLACK_NOTIFICATION_QUEUE } from '../src/slack-queue'
import { findOrCreateEmail } from '../src/scheduling'
import {
  EMAIL_SEARCH_INDEX,
  EMAIL_SEARCH_MAPPINGS,
  createElasticsearchClient,
  reconcileEmailSearchOutbox,
  searchEmails,
  startEmailSearchReconciler,
  updateEmailWithSearchOutbox,
  type EmailSearchDocument,
} from '../src/email-search'

const testSenderId = `search-${randomUUID()}`
const createdEmailIds = new Set<string>()
const dashboardToken = 'test-bull-board-token-that-is-long-enough-123456'
const emailQueue = createEmailQueue()
const slackQueue = createSlackNotificationQueue()
let server: Server | undefined
let baseUrl = ''

interface IndexedValue { version: number; document: EmailSearchDocument }
interface SearchRequest { index: string; from: number; size: number; query: unknown; _source: string[] }

class FakeElasticsearch {
  readonly documents = new Map<string, IndexedValue>()
  readonly mappingCalls: Array<unknown> = []
  readonly indexCalls: Array<{ id: string; version: number }> = []
  searchRequest: SearchRequest | undefined
  failIndexes = 0
  delayVersionOne: (() => Promise<void>) | undefined
  onVersionOne: (() => void) | undefined

  readonly client = {
    indices: {
      create: async (params: unknown) => { this.mappingCalls.push(params); return {} },
      exists: async () => true,
    },
    index: async (params: { id: string; version: number; document: EmailSearchDocument }) => {
      this.indexCalls.push({ id: params.id, version: params.version })
      if (this.failIndexes > 0) { this.failIndexes -= 1; throw new Error('mock cluster unavailable') }
      if (params.version === 1 && this.delayVersionOne) {
        this.onVersionOne?.()
        await this.delayVersionOne()
      }
      const previous = this.documents.get(params.id)
      if (previous && params.version < previous.version) {
        const error = new Error('version conflict') as Error & { meta: { statusCode: number } }
        error.meta = { statusCode: 409 }
        throw error
      }
      this.documents.set(params.id, { version: params.version, document: params.document })
      return {}
    },
    search: async (params: SearchRequest) => {
      this.searchRequest = params
      const values = [...this.documents.values()].map((item) => item.document)
      return {
        hits: {
          total: { value: values.length, relation: 'eq' },
          hits: values.slice(params.from, params.from + params.size).map((document) => ({ _source: {
            id: document.id,
            senderId: document.senderId,
            recipient: document.recipient,
            subject: document.subject,
            status: document.status,
            scheduledAt: document.scheduledAt,
            smtpAcceptedAt: document.smtpAcceptedAt,
            createdAt: document.createdAt,
            updatedAt: document.updatedAt,
          } })),
        },
      }
    },
  } as unknown as Client
}

const es = new FakeElasticsearch()
const liveElasticsearch = createElasticsearchClient()

before(async () => {
  await prisma.$connect()
  await prisma.sender.create({ data: { id: testSenderId, email: 'search-test@example.com', name: 'Search Test' } })
  await emailQueue.waitUntilReady()
  await slackQueue.waitUntilReady()
  const app = createApp({
    prisma,
    enqueueEmail: async () => undefined,
    elasticsearch: es.client,
    bullBoardQueues: [emailQueue, slackQueue],
    bullBoardToken: dashboardToken,
  })
  server = createServer(app)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Search test API did not bind to a TCP port.')
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  if (createdEmailIds.size) await prisma.email.deleteMany({ where: { id: { in: [...createdEmailIds] } } })
  await prisma.sender.deleteMany({ where: { id: testSenderId } })
  if (server?.listening) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()))
  await emailQueue.close()
  await slackQueue.close()
  await liveElasticsearch?.close()
  await prisma.$disconnect()
})

test('mapping is explicit and indexing uses stable IDs with idempotent status updates', async () => {
  assert.equal(EMAIL_SEARCH_MAPPINGS.dynamic, 'strict')
  assert.equal(EMAIL_SEARCH_MAPPINGS.properties.senderId.type, 'keyword')
  assert.equal(EMAIL_SEARCH_MAPPINGS.properties.subject.type, 'text')
  assert.equal(EMAIL_SEARCH_MAPPINGS.properties.body.type, 'text')
  assert.equal(EMAIL_SEARCH_MAPPINGS.properties.status.type, 'keyword')

  const email = await createEmail()
  assert.equal(await reconcileEmailSearchOutbox(prisma, es.client, 50, email.id), 1)
  const indexed = es.documents.get(email.id)
  assert.ok(indexed)
  assert.equal(indexed.version, 1)
  assert.equal(indexed.document.body, 'Searchable body text')
  assert.equal((await prisma.emailSearchOutbox.findMany({ where: { emailId: email.id } }))[0]?.status, 'INDEXED')

  const acceptedAt = new Date()
  assert.equal(await updateEmailWithSearchOutbox(prisma, email.id, {}, { status: 'SENT', smtpAcceptedAt: acceptedAt }), 1)
  assert.equal(await reconcileEmailSearchOutbox(prisma, es.client, 50, email.id), 1)
  assert.equal(es.documents.size, 1)
  assert.equal(es.documents.get(email.id)?.version, 2)
  assert.equal(es.documents.get(email.id)?.document.status, 'SENT')
  assert.equal(es.documents.get(email.id)?.document.smtpAcceptedAt, acceptedAt.toISOString())
  assert.equal(es.indexCalls.filter((call) => call.id === email.id).length, 2)
})

test('failed indexing stays durable and retries with delayed bounded backoff', async () => {
  const email = await createEmail()
  es.failIndexes = 1
  assert.equal(await reconcileEmailSearchOutbox(prisma, es.client, 50, email.id), 1)
  const pending = await prisma.emailSearchOutbox.findFirstOrThrow({ where: { emailId: email.id } })
  assert.equal(pending.status, 'PENDING')
  assert.equal(pending.attemptCount, 1)
  assert.ok(pending.nextAttemptAt.getTime() > Date.now())
  assert.equal(pending.lastError, 'Elasticsearch indexing request failed.')

  await prisma.emailSearchOutbox.update({ where: { id: pending.id }, data: { nextAttemptAt: new Date(Date.now() - 1) } })
  assert.equal(await reconcileEmailSearchOutbox(prisma, es.client, 50, email.id), 1)
  assert.equal((await prisma.emailSearchOutbox.findUniqueOrThrow({ where: { id: pending.id } })).status, 'INDEXED')
})

test('an older in-flight write cannot overwrite newer MySQL email state', async () => {
  const email = await createEmail()
  let releaseOldWrite!: () => void
  let reachedOldWrite!: () => void
  const oldWriteReached = new Promise<void>((resolve) => { reachedOldWrite = resolve })
  const oldWriteGate = new Promise<void>((resolve) => { releaseOldWrite = resolve })
  es.delayVersionOne = () => oldWriteGate
  es.onVersionOne = reachedOldWrite
  const oldReconcile = reconcileEmailSearchOutbox(prisma, es.client, 50, email.id)
  await oldWriteReached

  await updateEmailWithSearchOutbox(prisma, email.id, {}, { status: 'SENT', smtpAcceptedAt: new Date() })
  await reconcileEmailSearchOutbox(prisma, es.client, 50, email.id)
  releaseOldWrite()
  await oldReconcile
  es.delayVersionOne = undefined
  es.onVersionOne = undefined

  assert.equal(es.documents.get(email.id)?.document.status, 'SENT')
  assert.equal(es.documents.get(email.id)?.version, 2)
  const rows = await prisma.emailSearchOutbox.findMany({ where: { emailId: email.id } })
  assert.ok(rows.every((row) => row.status === 'INDEXED'))
})

test('search API validates filters and pagination and returns a stable response without body text', async () => {
  const email = await createEmail()
  await reconcileEmailSearchOutbox(prisma, es.client, 50, email.id)
  const invalid = await fetch(`${baseUrl}/api/emails/search?page=0&pageSize=1000`)
  assert.equal(invalid.status, 400)

  const response = await fetch(`${baseUrl}/api/emails/search?q=meeting&status=SCHEDULED&senderId=${testSenderId}&page=1&pageSize=7`)
  assert.equal(response.status, 200)
  const payload = await response.json() as { data: Array<Record<string, unknown>>; pagination: { page: number; pageSize: number; total: number; totalPages: number } }
  assert.equal(payload.pagination.page, 1)
  assert.equal(payload.pagination.pageSize, 7)
  assert.equal(payload.pagination.total, es.documents.size)
  assert.ok(payload.data.some((item) => item.id === email.id))
  assert.equal('body' in payload.data[0]!, false)
  const request = es.searchRequest!
  assert.equal(request.index, EMAIL_SEARCH_INDEX)
  assert.equal(request.from, 0)
  assert.equal(request.size, 7)
  assert.deepEqual(request._source, ['id', 'senderId', 'recipient', 'subject', 'status', 'scheduledAt', 'smtpAcceptedAt', 'createdAt', 'updatedAt'])
  assert.match(JSON.stringify(request.query), /meeting|SCHEDULED/)
})

test('search returns a clear 503 when Elasticsearch is unavailable or unconfigured', async () => {
  const unavailableApp = createApp({ prisma, enqueueEmail: async () => undefined })
  const unavailableServer = createServer(unavailableApp)
  unavailableServer.listen(0, '127.0.0.1')
  await once(unavailableServer, 'listening')
  const address = unavailableServer.address()
  if (!address || typeof address === 'string') throw new Error('Unavailable-search test API did not bind.')
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/emails/search?q=test`)
    assert.equal(response.status, 503)
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'SEARCH_UNAVAILABLE')
  } finally {
    await new Promise<void>((resolve, reject) => unavailableServer.close((error) => error ? reject(error) : resolve()))
  }

  const errorClient = { ...es.client, indices: { create: async () => { throw new Error('cluster timeout') }, exists: async () => false } } as unknown as Client
  await assert.rejects(searchEmails(errorClient, { q: 'test', page: 1, pageSize: 20 }))
})

test('Bull Board protects all routes and registers the email and Slack queues', async () => {
  const unauthorized = await fetch(`${baseUrl}/admin/queues`)
  assert.equal(unauthorized.status, 401)
  const wrong = await fetch(`${baseUrl}/admin/queues`, { headers: { authorization: 'Bearer wrong-token' } })
  assert.equal(wrong.status, 401)

  const dashboard = await fetch(`${baseUrl}/admin/queues/api/queues`, { headers: { authorization: `Bearer ${dashboardToken}` } })
  assert.equal(dashboard.status, 200)
  const payload = await dashboard.json() as { queues: Array<{ name: string }> }
  assert.deepEqual(new Set(payload.queues.map((queue) => queue.name)), new Set([EMAIL_QUEUE_NAME, SLACK_NOTIFICATION_QUEUE]))
})

test('search outbox reconciler recovers pending rows after process restart', async () => {
  const email = await createEmail()
  const reconciler = startEmailSearchReconciler(prisma, es.client, 30_000, email.id)
  try {
    for (let attempt = 0; attempt < 30 && !es.documents.has(email.id); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(es.documents.get(email.id)?.document.id, email.id)
  } finally {
    await reconciler.close()
  }
})

test('live Elasticsearch outbox indexing and search round trip when configured', { skip: !liveElasticsearch ? 'ELASTICSEARCH_URL is not configured.' : false }, async (context) => {
  const health = await liveElasticsearch!.cluster.health({ wait_for_status: 'yellow', timeout: '2s' }).catch(() => null)
  if (!health || health.status === 'red') {
    context.skip('Elasticsearch is unavailable or its primary shards are unassigned.')
    return
  }
  const email = await createEmail()
  try {
    const target = await prisma.email.findUniqueOrThrow({ where: { id: email.id }, select: { searchVersion: true } })
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const row = await prisma.emailSearchOutbox.findUniqueOrThrow({ where: { emailId_version: { emailId: email.id, version: target.searchVersion } } })
      if (row.status === 'INDEXED') break
      await reconcileEmailSearchOutbox(prisma, liveElasticsearch!, 1000, email.id)
    }
    await liveElasticsearch!.indices.refresh({ index: EMAIL_SEARCH_INDEX })
    const result = await searchEmails(liveElasticsearch!, { q: 'Searchable body text', status: 'SCHEDULED', senderId: testSenderId, page: 1, pageSize: 10 })
    assert.ok(result.data.some((item) => item.id === email.id))
    assert.equal(result.data.find((item) => item.id === email.id)?.subject, 'Meeting follow up')
  } finally {
    await liveElasticsearch!.delete({ index: EMAIL_SEARCH_INDEX, id: email.id }).catch(() => undefined)
  }
})

async function createEmail() {
  const result = await findOrCreateEmail(prisma, {
    senderId: testSenderId,
    recipient: `recipient-${randomUUID()}@example.com`,
    subject: 'Meeting follow up',
    body: 'Searchable body text',
    scheduledAt: new Date(Date.now() + 60_000),
    idempotencyKey: `search-test-${randomUUID()}`,
  })
  createdEmailIds.add(result.email.id)
  return result.email
}
