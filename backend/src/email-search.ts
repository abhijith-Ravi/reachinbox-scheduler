import { Client } from '@elastic/elasticsearch'
import type { Prisma, PrismaClient } from '@prisma/client'
import { config } from './config'

export const EMAIL_SEARCH_INDEX = 'reachinbox-emails-v1'
const SEARCH_BATCH_SIZE = 50
const SEARCH_LEASE_MS = 60_000
const BASE_RETRY_DELAY_MS = 5_000
const MAX_RETRY_DELAY_MS = 3_600_000
const MAX_RETRY_COUNT = 12

export const EMAIL_SEARCH_MAPPINGS = {
  dynamic: 'strict',
  properties: {
    id: { type: 'keyword' },
    senderId: { type: 'keyword' },
    recipient: { type: 'keyword' },
    subject: { type: 'text', fields: { exact: { type: 'keyword', ignore_above: 998 } } },
    body: { type: 'text' },
    status: { type: 'keyword' },
    scheduledAt: { type: 'date' },
    smtpAcceptedAt: { type: 'date' },
    createdAt: { type: 'date' },
    updatedAt: { type: 'date' },
  },
} as const
const indexSetupByClient = new WeakMap<Client, Promise<void>>()

export interface EmailSearchDocument {
  id: string
  senderId: string
  recipient: string
  subject: string
  body: string
  status: string
  scheduledAt: string
  smtpAcceptedAt: string | null
  createdAt: string
  updatedAt: string
}

export function createElasticsearchClient(): Client | null {
  if (!config.ELASTICSEARCH_URL) return null
  const auth = config.ELASTICSEARCH_USERNAME && config.ELASTICSEARCH_PASSWORD
    ? { username: config.ELASTICSEARCH_USERNAME, password: config.ELASTICSEARCH_PASSWORD }
    : undefined
  return new Client({ node: config.ELASTICSEARCH_URL, ...(auth ? { auth } : {}), requestTimeout: 5_000, maxRetries: 0 })
}

export async function ensureEmailSearchIndex(client: Client): Promise<void> {
  const existing = indexSetupByClient.get(client)
  if (existing) return existing
  const setup = (async () => {
    try {
      await client.indices.create({ index: EMAIL_SEARCH_INDEX, mappings: EMAIL_SEARCH_MAPPINGS, settings: { number_of_replicas: 0 } })
    } catch (error) {
      if (getStatusCode(error) === 400 && await client.indices.exists({ index: EMAIL_SEARCH_INDEX })) return
      throw error
    }
  })()
  indexSetupByClient.set(client, setup)
  try {
    await setup
  } catch (error) {
    indexSetupByClient.delete(client)
    throw error
  }
}

export async function updateEmailWithSearchOutbox(
  db: PrismaClient,
  emailId: string,
  where: Prisma.EmailWhereInput,
  data: Prisma.EmailUpdateManyMutationInput,
): Promise<number> {
  return db.$transaction((tx) => updateEmailWithSearchOutboxInTransaction(tx, emailId, where, data))
}

export async function updateEmailWithSearchOutboxInTransaction(
  tx: Prisma.TransactionClient,
  emailId: string,
  where: Prisma.EmailWhereInput,
  data: Prisma.EmailUpdateManyMutationInput,
): Promise<number> {
  const result = await tx.email.updateMany({
    where: { AND: [{ id: emailId }, where] },
    data: { ...data, searchVersion: { increment: 1 } },
  })
  if (result.count !== 1) return result.count
  const email = await tx.email.findUniqueOrThrow({ where: { id: emailId }, select: { searchVersion: true } })
  await tx.emailSearchOutbox.create({ data: { emailId, version: email.searchVersion } })
  return result.count
}

export async function queueInitialEmailSearchInTransaction(tx: Prisma.TransactionClient, emailId: string, version: bigint): Promise<void> {
  await tx.emailSearchOutbox.create({ data: { emailId, version } })
}

export async function reconcileEmailSearchOutbox(db: PrismaClient, client: Client, batchSize = SEARCH_BATCH_SIZE, onlyEmailId?: string): Promise<number> {
  await ensureEmailSearchIndex(client)
  const now = new Date()
  const candidates = await db.emailSearchOutbox.findMany({
    where: {
      ...(onlyEmailId ? { emailId: onlyEmailId } : {}),
      OR: [
        { status: 'PENDING', nextAttemptAt: { lte: now } },
        { status: 'PROCESSING', leaseExpiresAt: { lte: now } },
      ],
    },
    orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
    take: batchSize,
    select: { id: true, emailId: true, status: true, nextAttemptAt: true, leaseExpiresAt: true, attemptCount: true },
  })

  let claimedCount = 0
  for (const candidate of candidates) {
    const eligibility = candidate.status === 'PENDING'
      ? { status: 'PENDING' as const, nextAttemptAt: { lte: now } }
      : { status: 'PROCESSING' as const, leaseExpiresAt: { lte: now } }
    const claimed = await db.emailSearchOutbox.updateMany({
      where: { id: candidate.id, ...eligibility },
      data: {
        status: 'PROCESSING',
        leaseExpiresAt: new Date(Date.now() + SEARCH_LEASE_MS),
        attemptCount: Math.min(candidate.attemptCount + 1, MAX_RETRY_COUNT),
      },
    })
    if (claimed.count !== 1) continue
    claimedCount += 1

    try {
      const email = await db.email.findUnique({
        where: { id: candidate.emailId },
        select: {
          id: true,
          senderId: true,
          recipient: true,
          subject: true,
          body: true,
          status: true,
          scheduledAt: true,
          smtpAcceptedAt: true,
          createdAt: true,
          updatedAt: true,
          searchVersion: true,
        },
      })
      if (!email) {
        await db.emailSearchOutbox.updateMany({ where: { id: candidate.id, status: 'PROCESSING' }, data: { status: 'INDEXED', indexedAt: new Date(), leaseExpiresAt: null } })
        continue
      }

      const document: EmailSearchDocument = {
        id: email.id,
        senderId: email.senderId,
        recipient: email.recipient,
        subject: email.subject,
        body: email.body,
        status: email.status,
        scheduledAt: email.scheduledAt.toISOString(),
        smtpAcceptedAt: email.smtpAcceptedAt?.toISOString() ?? null,
        createdAt: email.createdAt.toISOString(),
        updatedAt: email.updatedAt.toISOString(),
      }
      await client.index({
        index: EMAIL_SEARCH_INDEX,
        id: email.id,
        document,
        version: Number(email.searchVersion),
        version_type: 'external_gte',
      })
      await db.emailSearchOutbox.updateMany({
        where: { emailId: email.id, version: { lte: email.searchVersion }, status: { in: ['PENDING', 'PROCESSING'] } },
        data: { status: 'INDEXED', indexedAt: new Date(), leaseExpiresAt: null, lastError: null },
      })
    } catch (error) {
      const attempt = Math.min(candidate.attemptCount + 1, MAX_RETRY_COUNT)
      const delay = Math.min(BASE_RETRY_DELAY_MS * 2 ** Math.min(attempt - 1, 10), MAX_RETRY_DELAY_MS)
      await db.emailSearchOutbox.updateMany({
        where: { id: candidate.id, status: 'PROCESSING' },
        data: {
          status: 'PENDING',
          leaseExpiresAt: null,
          nextAttemptAt: new Date(Date.now() + delay),
          attemptCount: attempt,
          lastError: getStatusCode(error) ? `Elasticsearch indexing failed (HTTP ${getStatusCode(error)}).` : 'Elasticsearch indexing request failed.',
        },
      })
    }
  }
  return claimedCount
}

export function startEmailSearchReconciler(
  db: PrismaClient,
  client: Client,
  intervalMs = 5_000,
  onlyEmailId?: string,
): { close: () => Promise<void> } {
  let running = false
  let stopped = false
  let inFlight: Promise<void> | undefined
  let retryDelayMs = intervalMs
  let timer: NodeJS.Timeout | undefined
  const schedule = (delay: number) => {
    if (stopped) return
    timer = setTimeout(() => { void run() }, delay)
    timer.unref()
  }
  const run = async () => {
    if (stopped || running) return
    running = true
    inFlight = (async () => {
      try {
        await reconcileEmailSearchOutbox(db, client, SEARCH_BATCH_SIZE, onlyEmailId)
        retryDelayMs = intervalMs
      } catch {
        console.error('Email search indexing reconciliation failed.')
        retryDelayMs = Math.min(Math.max(intervalMs, retryDelayMs * 2), 60_000)
      } finally {
        running = false
        schedule(retryDelayMs)
      }
    })()
    await inFlight
  }
  void run()
  return {
    close: async () => {
      stopped = true
      if (timer) clearTimeout(timer)
      await inFlight
    },
  }
}

export interface EmailSearchInput {
  q?: string
  status?: 'SCHEDULED' | 'PROCESSING' | 'SENT' | 'FAILED'
  senderId?: string
  page: number
  pageSize: number
}

export async function searchEmails(client: Client | null, input: EmailSearchInput) {
  if (!client) throw new SearchUnavailableError()
  await ensureEmailSearchIndex(client)
  const filters = [
    ...(input.status ? [{ term: { status: input.status } }] : []),
    ...(input.senderId ? [{ term: { senderId: input.senderId } }] : []),
  ]
  const response = await client.search<EmailSearchDocument>({
    index: EMAIL_SEARCH_INDEX,
    from: (input.page - 1) * input.pageSize,
    size: input.pageSize,
    track_total_hits: true,
    _source: ['id', 'senderId', 'recipient', 'subject', 'status', 'scheduledAt', 'smtpAcceptedAt', 'createdAt', 'updatedAt'],
    query: {
      bool: {
        must: input.q
          ? [{ multi_match: { query: input.q, fields: ['subject^3', 'body'], type: 'best_fields', operator: 'and' } }]
          : [{ match_all: {} }],
        filter: filters,
      },
    },
    sort: [{ scheduledAt: { order: 'desc' } }, { id: { order: 'asc' } }],
  })
  const total = response.hits.total
  const totalValue = typeof total === 'number' ? total : total?.value ?? 0
  return {
    data: response.hits.hits.flatMap((hit) => hit._source ? [hit._source] : []),
    pagination: {
      page: input.page,
      pageSize: input.pageSize,
      total: totalValue,
      totalPages: Math.ceil(totalValue / input.pageSize),
    },
  }
}

export class SearchUnavailableError extends Error {}

function getStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('meta' in error)) return undefined
  const meta = error.meta
  if (typeof meta !== 'object' || meta === null || !('statusCode' in meta)) return undefined
  return typeof meta.statusCode === 'number' ? meta.statusCode : undefined
}
