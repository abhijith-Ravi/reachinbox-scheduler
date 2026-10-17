import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { after, before, test } from 'node:test'
import Redis from 'ioredis'
import type { PrismaClient } from '@prisma/client'
import { createApp } from '../src/app'
import { prisma } from '../src/db'
import { redisConnection } from '../src/queue'
import {
  deliverQuotaNotification,
  enqueueQuotaNotification,
  reconcileSlackNotifications,
  startSlackNotificationReconciler,
} from '../src/slack-notifications'
import { createSlackNotificationQueue } from '../src/slack-queue'
import { SlackIntegration } from '../src/slack-integration'
import { decryptSecret, encryptSecret, SlackOAuthStateStore } from '../src/slack-security'

const redis = new Redis(redisConnection)
const touchedStates = new Set<string>()
const testConnectionKeys = new Set<string>()
const createdNotificationIds = new Set<string>()
const key = 'a'.repeat(64)
const managementToken = 'test-management-token-that-is-long-enough-1234'
const notificationQueue = createSlackNotificationQueue()
let apiServer: Server | undefined
let apiUrl = ''

before(async () => {
  await prisma.$connect()
  await notificationQueue.waitUntilReady()
  const app = createApp({ prisma, enqueueEmail: async () => undefined, slackManagementToken: managementToken, slackNotificationQueue: notificationQueue })
  apiServer = createServer(app)
  apiServer.listen(0, '127.0.0.1')
  await once(apiServer, 'listening')
  const address = apiServer.address()
  if (!address || typeof address === 'string') throw new Error('Slack test API did not bind to a TCP port.')
  apiUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  for (const id of createdNotificationIds) {
    for (let replayCount = 0; replayCount < 3; replayCount += 1) {
      const jobId = replayCount === 0 ? `slack-notification-${id}` : `slack-notification-${id}-replay-${replayCount}`
      const job = await notificationQueue.getJob(jobId)
      if (job) await job.remove().catch(() => undefined)
    }
  }
  if (createdNotificationIds.size) await prisma.slackNotificationOutbox.deleteMany({ where: { id: { in: [...createdNotificationIds] } } })
  if (apiServer?.listening) await new Promise<void>((resolve, reject) => apiServer!.close((error) => error ? reject(error) : resolve()))
  await notificationQueue.close()
  if (testConnectionKeys.size) await prisma.slackConnection.deleteMany({ where: { deploymentKey: { in: [...testConnectionKeys] } } })
  if (touchedStates.size) await redis.del(...[...touchedStates].map((state) => `slack:oauth:state:${state}`))
  await redis.quit()
  await prisma.$disconnect()
})

test('OAuth state is unpredictable, expires, and can be consumed only once', async () => {
  const states = new SlackOAuthStateStore(redis)
  const first = await states.create()
  const second = await states.create()
  touchedStates.add(first)
  touchedStates.add(second)
  assert.notEqual(first, second)
  assert.equal(first.length, 43)
  assert.equal(await states.consume(first), true)
  assert.equal(await states.consume(first), false)

  const expiring = new SlackOAuthStateStore(redis, 1)
  const expired = await expiring.create()
  touchedStates.add(expired)
  await new Promise((resolve) => setTimeout(resolve, 1100))
  assert.equal(await expiring.consume(expired), false)
})

test('OAuth start requests only incoming-webhook scope and callback persists encrypted connection without exposing token', async () => {
  await prisma.$connect()
  const deploymentKey = `slack-test-${randomUUID()}`
  const workspaceId = `T${randomUUID().replaceAll('-', '').slice(0, 24)}`
  testConnectionKeys.add(deploymentKey)
  const integration = new SlackIntegration(prisma, redis, {
    SLACK_CLIENT_ID: 'client-id', SLACK_CLIENT_SECRET: 'client-secret',
    SLACK_REDIRECT_URL: 'https://example.test/api/slack/oauth/callback', SLACK_TOKEN_ENCRYPTION_KEY: key,
  }, async (url, init) => {
    assert.equal(url, 'https://slack.com/api/oauth.v2.access')
    const body = new URLSearchParams(init?.body as URLSearchParams)
    assert.equal(body.get('code'), 'one-time-code')
    assert.equal(body.get('redirect_uri'), 'https://example.test/api/slack/oauth/callback')
    return Response.json({ ok: true, access_token: 'never-persist-this', team: { id: workspaceId, name: 'Example' },
      incoming_webhook: { url: 'https://hooks.slack.com/services/T123/B456/secret', channel_id: 'C123', channel: '#alerts' } })
  }, deploymentKey)
  const authorize = new URL(await integration.startOAuth())
  assert.equal(authorize.origin, 'https://slack.com')
  assert.equal(authorize.pathname, '/oauth/v2/authorize')
  assert.equal(authorize.searchParams.get('scope'), 'incoming-webhook')
  const state = authorize.searchParams.get('state')!
  touchedStates.add(state)
  const result = await integration.handleCallback(new URLSearchParams({ code: 'one-time-code', state }))
  assert.deepEqual(result, { workspaceId, workspaceName: 'Example', channelId: 'C123', channelName: '#alerts' })
  const row = await prisma.slackConnection.findUniqueOrThrow({ where: { deploymentKey } })
  assert.notEqual(row.webhookCiphertext, 'https://hooks.slack.com/services/T123/B456/secret')
  assert.equal(decryptSecret({ ciphertext: row.webhookCiphertext, nonce: row.webhookNonce, authTag: row.webhookAuthTag }, key), 'https://hooks.slack.com/services/T123/B456/secret')
  assert.doesNotMatch(JSON.stringify(await integration.getConnection()), /never-persist-this|secret/)
  await integration.disconnect()
  assert.deepEqual(await integration.getConnection(), { connected: false })
})

test('OAuth callback rejects denied, missing, expired, and replayed callbacks without token exchange', async () => {
  let exchanges = 0
  const integration = new SlackIntegration({} as PrismaClient, redis, {
    SLACK_CLIENT_ID: 'client-id', SLACK_CLIENT_SECRET: 'client-secret',
    SLACK_REDIRECT_URL: 'https://example.test/api/slack/oauth/callback', SLACK_TOKEN_ENCRYPTION_KEY: key,
  }, async () => { exchanges += 1; return Response.json({ ok: true }) })
  const authorize = new URL(await integration.startOAuth())
  const state = authorize.searchParams.get('state')!
  touchedStates.add(state)
  await assert.rejects(integration.handleCallback(new URLSearchParams({ state, error: 'access_denied' })), /denied/i)
  await assert.rejects(integration.handleCallback(new URLSearchParams({ state, code: 'code' })), /state/i)
  await assert.rejects(integration.handleCallback(new URLSearchParams({ state: randomUUID(), code: 'code' })), /state/i)
  assert.equal(exchanges, 0)
})

test('OAuth callback turns a Slack token-exchange rejection into a sanitized error', async () => {
  const integration = new SlackIntegration({} as PrismaClient, redis, {
    SLACK_CLIENT_ID: 'client-id', SLACK_CLIENT_SECRET: 'client-secret',
    SLACK_REDIRECT_URL: 'https://example.test/api/slack/oauth/callback', SLACK_TOKEN_ENCRYPTION_KEY: key,
  }, async () => Response.json({ ok: false, error: 'invalid_code' }))
  const authorize = new URL(await integration.startOAuth())
  const state = authorize.searchParams.get('state')!
  touchedStates.add(state)
  await assert.rejects(integration.handleCallback(new URLSearchParams({ state, code: 'bad-code' })), /could not be completed/i)
})

test('AES-GCM encryption detects tampering', () => {
  const encrypted = encryptSecret('https://hooks.slack.com/services/a/b/c', key)
  assert.equal(decryptSecret(encrypted, key), 'https://hooks.slack.com/services/a/b/c')
  const first = encrypted.ciphertext[0] === 'A' ? 'B' : 'A'
  assert.throws(() => decryptSecret({ ...encrypted, ciphertext: `${first}${encrypted.ciphertext.slice(1)}` }, key))
})

test('quota notification outbox deduplicates one sender-period and skips when no Slack connection exists', async () => {
  const records = new Map<string, Record<string, unknown>>()
  let connected = true
  let jobs = 0
  const activeJobs = new Map<string, { getState: () => Promise<string> }>()
  const db = {
    slackConnection: { findUnique: async () => connected ? { status: 'ACTIVE' } : null },
    slackNotificationOutbox: {
      upsert: async ({ where, create }: { where: { eventKey: string }; create: Record<string, unknown> }) => {
        let record = records.get(where.eventKey)
        if (!record) { record = { id: `event-${records.size}`, ...create, status: 'PENDING', createdAt: new Date(), attemptCount: 0 }; records.set(where.eventKey, record) }
        return record
      },
    },
  } as never
  const queue = {
    getJob: async (id: string) => activeJobs.get(id) ?? null,
    add: async (_name: string, _data: unknown, options: { jobId: string }) => {
      jobs += 1
      const job = { getState: async () => 'waiting' }
      activeJobs.set(options.jobId, job)
      return job
    },
  } as never
  const input = { senderId: 'sender-1', senderEmail: 'sender@example.test', senderName: 'Sender', hourlyLimit: 2,
    nextEligibleAt: Date.now() + 60_000, notificationPeriod: 'quota:1234' }
  await enqueueQuotaNotification(db, queue, input)
  await enqueueQuotaNotification(db, queue, input)
  assert.equal(records.size, 1)
  assert.equal(jobs, 1)
  await enqueueQuotaNotification(db, queue, { ...input, notificationPeriod: 'quota:5678' })
  assert.equal(records.size, 2)
  assert.equal(jobs, 2)
  connected = false
  await enqueueQuotaNotification(db, queue, { ...input, senderId: 'sender-2' })
  assert.equal(records.size, 2)
})

test('Slack 429 delays the notification job and does not expose email content', async () => {
  const notification = { id: 'event-1', status: 'PENDING', attemptCount: 0, senderEmail: 'sender@example.test',
    senderName: null, hourlyLimit: 1, nextEligibleAt: new Date(Date.now() + 60_000), senderId: 'sender-1' }
  const encrypted = encryptSecret('https://hooks.slack.com/services/T/B/secret', key)
  let movedTo = 0
  let posted = ''
  const prisma = {
    slackNotificationOutbox: {
      findUnique: async () => notification,
      updateMany: async () => ({ count: 1 }),
      update: async () => notification,
    },
    slackConnection: { findUnique: async () => ({ deploymentKey: 'default', status: 'ACTIVE', webhookCiphertext: encrypted.ciphertext,
      webhookNonce: encrypted.nonce, webhookAuthTag: encrypted.authTag }) },
  } as unknown as PrismaClient
  const job = { data: { notificationId: 'event-1' }, token: 'lock', moveToDelayed: async (time: number) => { movedTo = time } } as never
  await assert.rejects(deliverQuotaNotification(prisma, job, key, async (_url, init) => {
    posted = String(init?.body)
    return new Response('rate_limited', { status: 429, headers: { 'retry-after': '3' } })
  }), /delayed/i)
  assert.ok(movedTo >= Date.now() + 2_000)
  assert.match(posted, /sender@example.test/)
  assert.doesNotMatch(posted, /recipient|body|secret/)
})

test('notification outbox reconciliation restores a pending BullMQ job after restart', async () => {
  const pending = { id: 'pending-1', status: 'PENDING', attemptCount: 0, replayCount: 0 }
  const prisma = { slackNotificationOutbox: { findMany: async () => [pending] } } as unknown as PrismaClient
  let options: { jobId: string; attempts: number; backoff: { type: string; delay: number } } | undefined
  const queue = {
    getJob: async () => null,
    add: async (_name: string, _data: unknown, value: typeof options) => { options = value; return {} },
  } as never
  assert.equal(await reconcileSlackNotifications(prisma as never, queue), 1)
  assert.equal(options?.jobId, 'slack-notification-pending-1')
  assert.equal(options?.attempts, 8)
  assert.deepEqual(options?.backoff, { type: 'exponential', delay: 10_000 })
})

test('unusable Slack webhook revokes the connection and fails only the notification', async () => {
  const notification = { id: 'event-403', status: 'PENDING', attemptCount: 0, senderEmail: 'sender@example.test',
    senderName: null, hourlyLimit: 1, nextEligibleAt: new Date(), senderId: 'sender-1' }
  const encrypted = encryptSecret('https://hooks.slack.com/services/T/B/secret', key)
  const updates: Array<{ model: string; data: Record<string, unknown> }> = []
  const prisma = {
    slackNotificationOutbox: {
      findUnique: async () => notification,
      updateMany: async () => ({ count: 1 }),
      update: async ({ data }: { data: Record<string, unknown> }) => { updates.push({ model: 'event', data }); return notification },
    },
    slackConnection: {
      findUnique: async () => ({ deploymentKey: 'default', status: 'ACTIVE', webhookCiphertext: encrypted.ciphertext,
        webhookNonce: encrypted.nonce, webhookAuthTag: encrypted.authTag }),
      updateMany: async ({ data }: { data: Record<string, unknown> }) => { updates.push({ model: 'connection', data }); return { count: 1 } },
    },
  } as unknown as PrismaClient
  await deliverQuotaNotification(prisma, { data: { notificationId: 'event-403' } } as never, key,
    async () => new Response('invalid_token', { status: 403 }))
  assert.ok(updates.some((update) => update.model === 'connection' && update.data.status === 'REVOKED'))
  assert.ok(updates.some((update) => update.model === 'event' && update.data.status === 'FAILED'))
})

test('periodic recovery queues pending events while running and does not duplicate jobs', async () => {
  const event = await createOutboxEvent('PENDING', 0)
  const reconcilerA = startSlackNotificationReconciler(prisma, notificationQueue, 25)
  const reconcilerB = startSlackNotificationReconciler(prisma, notificationQueue, 25)
  try {
    await waitForJob(`slack-notification-${event.id}`)
    await new Promise((resolve) => setTimeout(resolve, 125))
    const jobs = await notificationQueue.getJobs(['waiting', 'delayed', 'active'])
    assert.equal(jobs.filter((job) => job.data.notificationId === event.id).length, 1)
    assert.equal((await prisma.slackNotificationOutbox.findUniqueOrThrow({ where: { id: event.id } })).status, 'PENDING')
  } finally {
    await Promise.all([reconcilerA.close(), reconcilerB.close()])
  }
})

test('periodic recovery never re-enqueues FAILED events and fails exhausted pending attempts', async () => {
  const failed = await createOutboxEvent('FAILED', 8)
  const exhausted = await createOutboxEvent('PENDING', 8)
  await reconcileSlackNotifications(prisma, notificationQueue)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(await notificationQueue.getJob(`slack-notification-${failed.id}`), undefined)
  assert.equal((await prisma.slackNotificationOutbox.findUniqueOrThrow({ where: { id: failed.id } })).status, 'FAILED')
  assert.equal((await prisma.slackNotificationOutbox.findUniqueOrThrow({ where: { id: exhausted.id } })).status, 'FAILED')
})

test('failed notification inspection and replay require management bearer authentication', async () => {
  const failed = await createOutboxEvent('FAILED', 8, 'Slack returned https://hooks.slack.com/services/hidden and Bearer xoxb-secret')
  for (const authorization of [undefined, 'Bearer wrong-token']) {
    const response = await fetch(`${apiUrl}/api/slack/notifications/failed`, {
      headers: authorization ? { authorization } : {},
    })
    assert.equal(response.status, 401)
  }
  const list = await fetch(`${apiUrl}/api/slack/notifications/failed`, { headers: { authorization: `Bearer ${managementToken}` } })
  assert.equal(list.status, 200)
  const payload = await list.json() as { data: Array<Record<string, unknown>> }
  const record = payload.data.find((item) => item.id === failed.id)
  assert.ok(record)
  assert.equal(record.eventType, 'sender_quota_limit')
  assert.equal(record.senderId, failed.senderId)
  assert.doesNotMatch(JSON.stringify(record), /hooks\.slack\.com|xoxb-secret|ciphertext|authTag|key/i)

  const noAuth = await fetch(`${apiUrl}/api/slack/notifications/${failed.id}/replay`, { method: 'POST' })
  assert.equal(noAuth.status, 401)
  const badAuth = await fetch(`${apiUrl}/api/slack/notifications/${failed.id}/replay`, { method: 'POST', headers: { authorization: 'Bearer wrong-token' } })
  assert.equal(badAuth.status, 401)
})

test('replay rejects missing and nonfailed records, and atomically requeues one failed event during recovery', async () => {
  const missing = await fetch(`${apiUrl}/api/slack/notifications/missing-notification/replay`, {
    method: 'POST', headers: { authorization: `Bearer ${managementToken}` },
  })
  assert.equal(missing.status, 404)
  const pending = await createOutboxEvent('PENDING', 1)
  const conflict = await fetch(`${apiUrl}/api/slack/notifications/${pending.id}/replay`, {
    method: 'POST', headers: { authorization: `Bearer ${managementToken}` },
  })
  assert.equal(conflict.status, 409)

  const failed = await createOutboxEvent('FAILED', 8)
  const replayRequest = fetch(`${apiUrl}/api/slack/notifications/${failed.id}/replay`, {
    method: 'POST', headers: { authorization: `Bearer ${managementToken}` },
  })
  const automaticRecovery = reconcileSlackNotifications(prisma, notificationQueue)
  const [response] = await Promise.all([replayRequest, automaticRecovery])
  assert.equal(response.status, 202)
  const replayed = await response.json() as { data: { id: string; status: string; attemptCount: number; replayCount: number } }
  assert.equal(replayed.data.id, failed.id)
  assert.equal(replayed.data.status, 'PENDING')
  assert.equal(replayed.data.attemptCount, 0)
  assert.equal(replayed.data.replayCount, 1)
  const stored = await prisma.slackNotificationOutbox.findUniqueOrThrow({ where: { id: failed.id } })
  assert.equal(stored.status, 'PENDING')
  assert.equal(stored.attemptCount, 0)
  assert.equal(stored.replayCount, 1)
  const replayJobId = `slack-notification-${failed.id}-replay-1`
  await waitForJob(replayJobId)
  const matchingJobs = await notificationQueue.getJobs(['waiting', 'delayed', 'active'])
  assert.equal(matchingJobs.filter((job) => job.data.notificationId === failed.id).length, 1)
})

async function createOutboxEvent(status: 'PENDING' | 'FAILED', attemptCount: number, lastError: string | null = null) {
  const eventKey = createHash('sha256').update(randomUUID()).digest('hex')
  const event = await prisma.slackNotificationOutbox.create({
    data: {
      eventKey,
      senderId: `recovery-test-${randomUUID()}`,
      senderEmail: 'recovery-test@example.test',
      hourlyLimit: 10,
      nextEligibleAt: new Date(Date.now() + 60_000),
      status,
      attemptCount,
      lastError,
    },
  })
  createdNotificationIds.add(event.id)
  return event
}

async function waitForJob(id: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await notificationQueue.getJob(id)) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Slack test notification job ${id} was not created.`)
}
