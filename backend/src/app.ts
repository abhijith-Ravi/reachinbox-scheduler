import express, { type ErrorRequestHandler, type Request, type Response } from 'express'
import { timingSafeEqual } from 'node:crypto'
import { createBullBoard } from '@bull-board/api'
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter'
import { ExpressAdapter } from '@bull-board/express'
import type { Queue } from 'bullmq'
import type { Client } from '@elastic/elasticsearch'
import { PrismaClient } from '@prisma/client'
import { z } from 'zod'
import { findOrCreateEmail, IdempotencyConflictError, SenderNotFoundError } from './scheduling'
import { SlackIntegration, SlackOAuthError } from './slack-integration'
import { listFailedNotifications, NotificationNotFoundError, NotificationStateError, replayFailedNotification } from './slack-notifications'
import type { SlackNotificationJobData } from './slack-queue'
import { SearchUnavailableError, searchEmails } from './email-search'

const scheduleSchema = z.object({
  senderId: z.string().min(1).max(64).default('default'),
  recipient: z.email(),
  subject: z.string().min(1).max(998),
  body: z.string().min(1),
  scheduledAt: z.string().datetime({ offset: true }),
  idempotencyKey: z.string().min(1).max(191),
}).strict()

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
})

const searchSchema = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  status: z.enum(['SCHEDULED', 'PROCESSING', 'SENT', 'FAILED']).optional(),
  senderId: z.string().min(1).max(64).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict().refine((value) => (value.page - 1) * value.pageSize < 10_000, { message: 'page and pageSize exceed the maximum search window.' })

type EnqueueEmail = (emailId: string) => Promise<void>
interface AppDependencies {
  prisma: PrismaClient
  enqueueEmail: EnqueueEmail
  slack?: SlackIntegration
  slackManagementToken?: string
  slackNotificationQueue?: Queue<SlackNotificationJobData>
  bullBoardQueues?: Queue[]
  bullBoardToken?: string
  elasticsearch?: Client | null
}

export function createApp(dependencies: AppDependencies) {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '1mb' }))

  const dashboardAdapter = dependencies.bullBoardQueues?.length
    ? new ExpressAdapter()
    : undefined
  if (dashboardAdapter && dependencies.bullBoardQueues) {
    dashboardAdapter.setBasePath('/admin/queues')
    createBullBoard({ queues: dependencies.bullBoardQueues.map((queue) => new BullMQAdapter(queue)), serverAdapter: dashboardAdapter })
  }

  app.use('/admin/queues', (request, response, next) => {
    if (!dashboardAdapter) return apiError(response, 503, 'QUEUE_DASHBOARD_UNAVAILABLE', 'The queue dashboard is not configured.')
    if (!authorizedBearer(request.get('authorization'), dependencies.bullBoardToken)) return apiError(response, 401, 'QUEUE_DASHBOARD_UNAUTHORIZED', 'Queue dashboard authorization is required.')
    return next()
  }, dashboardAdapter?.getRouter() ?? ((_request, response) => apiError(response, 503, 'QUEUE_DASHBOARD_UNAVAILABLE', 'The queue dashboard is not configured.')))

  app.get('/health', (_request, response) => response.status(200).json({ status: 'ok' }))

  app.get('/api/slack/oauth/start', async (request, response) => {
    if (!dependencies.slack) return apiError(response, 503, 'SLACK_NOT_CONFIGURED', 'Slack integration is not configured.')
    if (!authorizedSlackManagement(request.get('authorization'), dependencies.slackManagementToken)) return apiError(response, 401, 'SLACK_MANAGEMENT_UNAUTHORIZED', 'Slack management authorization is required.')
    try {
      return response.redirect(302, await dependencies.slack.startOAuth())
    } catch (error) {
      return slackError(response, error)
    }
  })

  app.get('/api/slack/oauth/callback', async (request, response) => {
    if (!dependencies.slack) return apiError(response, 503, 'SLACK_NOT_CONFIGURED', 'Slack integration is not configured.')
    const params = new URLSearchParams()
    for (const name of ['state', 'code', 'error']) {
      const value = request.query[name]
      if (typeof value === 'string') params.set(name, value)
    }
    try {
      const connection = await dependencies.slack.handleCallback(params)
      return response.status(200).json({ data: { connected: true, ...connection } })
    } catch (error) {
      return slackError(response, error)
    }
  })

  app.get('/api/slack/connection', async (_request, response) => {
    if (!dependencies.slack) return apiError(response, 503, 'SLACK_NOT_CONFIGURED', 'Slack integration is not configured.')
    return response.json({ data: await dependencies.slack.getConnection() })
  })

  app.delete('/api/slack/connection', async (_request, response) => {
    if (!dependencies.slack) return apiError(response, 503, 'SLACK_NOT_CONFIGURED', 'Slack integration is not configured.')
    if (!authorizedSlackManagement(_request.get('authorization'), dependencies.slackManagementToken)) return apiError(response, 401, 'SLACK_MANAGEMENT_UNAUTHORIZED', 'Slack management authorization is required.')
    await dependencies.slack.disconnect()
    return response.status(200).json({ data: { disconnected: true } })
  })

  app.get('/api/slack/notifications/failed', async (request, response) => {
    if (!authorizedSlackManagement(request.get('authorization'), dependencies.slackManagementToken)) return apiError(response, 401, 'SLACK_MANAGEMENT_UNAUTHORIZED', 'Slack management authorization is required.')
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).safeParse(request.query)
    if (!parsed.success) return apiError(response, 400, 'VALIDATION_ERROR', 'limit must be an integer from 1 to 100.')
    const data = await listFailedNotifications(dependencies.prisma, parsed.data.limit)
    return response.json({ data })
  })

  app.post('/api/slack/notifications/:id/replay', async (request, response) => {
    if (!authorizedSlackManagement(request.get('authorization'), dependencies.slackManagementToken)) return apiError(response, 401, 'SLACK_MANAGEMENT_UNAUTHORIZED', 'Slack management authorization is required.')
    if (!dependencies.slackNotificationQueue) return apiError(response, 503, 'SLACK_QUEUE_UNAVAILABLE', 'Slack notification queue is unavailable.')
    try {
      const data = await replayFailedNotification(dependencies.prisma, dependencies.slackNotificationQueue, request.params.id)
      return response.status(202).json({ data })
    } catch (error) {
      if (error instanceof NotificationNotFoundError) return apiError(response, 404, 'NOTIFICATION_NOT_FOUND', error.message)
      if (error instanceof NotificationStateError) return apiError(response, 409, 'NOTIFICATION_NOT_FAILED', error.message)
      return apiError(response, 503, 'NOTIFICATION_REPLAY_UNAVAILABLE', 'Notification replay was queued for recovery or could not be completed.')
    }
  })

  app.post('/api/emails/schedule', async (request, response) => {
    const parsed = scheduleSchema.safeParse(request.body)
    if (!parsed.success) return apiError(response, 400, 'VALIDATION_ERROR', parsed.error.issues.map((issue) => issue.message).join('; '))
    const scheduledAt = new Date(parsed.data.scheduledAt)
    if (scheduledAt.getTime() <= Date.now()) return apiError(response, 400, 'INVALID_SCHEDULE_TIME', 'scheduledAt must be a future ISO-8601 timestamp.')

    try {
      const { email, created } = await findOrCreateEmail(dependencies.prisma, { ...parsed.data, scheduledAt })
      try {
        await dependencies.enqueueEmail(email.id)
      } catch {
        return response.status(503).json({
          error: { code: 'QUEUE_UNAVAILABLE', message: 'The email was saved, but the scheduling queue is unavailable. Retry with the same idempotency key.' },
          data: publicEmail(email),
        })
      }
      return response.status(created ? 202 : 200).json({ data: publicEmail(email), idempotentReplay: !created })
    } catch (error) {
      if (error instanceof IdempotencyConflictError) return apiError(response, 409, 'IDEMPOTENCY_CONFLICT', error.message)
      if (error instanceof SenderNotFoundError) return apiError(response, 404, 'SENDER_NOT_FOUND', error.message)
      throw error
    }
  })

  app.get('/api/emails/search', async (request, response) => {
    const parsed = searchSchema.safeParse(request.query)
    if (!parsed.success) return apiError(response, 400, 'VALIDATION_ERROR', 'Search parameters are invalid; use q up to 200 characters, a valid status/senderId, page 1–1000, and pageSize 1–100 within the 10,000-result window.')
    try {
      const data = await searchEmails(dependencies.elasticsearch ?? null, parsed.data)
      return response.json({ data: data.data, pagination: data.pagination })
    } catch (error) {
      if (error instanceof SearchUnavailableError) return apiError(response, 503, 'SEARCH_UNAVAILABLE', 'Email search is not configured.')
      return apiError(response, 503, 'SEARCH_UNAVAILABLE', 'Email search is temporarily unavailable.')
    }
  })

  app.get('/api/emails/scheduled', async (request, response) => {
    const pagination = parsePagination(request, response)
    if (!pagination) return
    const records = await dependencies.prisma.email.findMany({
      where: { status: { in: ['SCHEDULED', 'PROCESSING'] } },
      include: { sender: true },
      orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
      take: pagination.limit + 1,
      ...(pagination.cursor ? { cursor: { id: pagination.cursor }, skip: 1 } : {}),
    })
    return listResponse(response, records, pagination.limit)
  })

  app.get('/api/emails/sent', async (request, response) => {
    const pagination = parsePagination(request, response)
    if (!pagination) return
    const records = await dependencies.prisma.email.findMany({
      where: { status: 'SENT' },
      include: { sender: true },
      orderBy: [{ smtpAcceptedAt: 'desc' }, { id: 'desc' }],
      take: pagination.limit + 1,
      ...(pagination.cursor ? { cursor: { id: pagination.cursor }, skip: 1 } : {}),
    })
    return listResponse(response, records, pagination.limit)
  })

  app.get('/api/emails/:id', async (request, response) => {
    const email = await dependencies.prisma.email.findUnique({ where: { id: request.params.id }, include: { sender: true } })
    if (!email) return apiError(response, 404, 'EMAIL_NOT_FOUND', 'Email not found.')
    return response.json({ data: publicEmail(email) })
  })

  app.use((_request, response) => apiError(response, 404, 'NOT_FOUND', 'Route not found.'))
  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    const status = typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : 500
    const message = status === 413 ? 'Request body is too large.' : status === 400 ? 'Malformed JSON request body.' : 'An unexpected server error occurred.'
    if (status === 500) console.error('Unhandled API error', error instanceof Error ? error.message : 'Unknown error')
    apiError(response, status, status === 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST', message)
  }
  app.use(errorHandler)
  return app
}

function authorizedSlackManagement(header: string | undefined, expected: string | undefined): boolean {
  return authorizedBearer(header, expected)
}

function authorizedBearer(header: string | undefined, expected: string | undefined): boolean {
  if (!header || !expected?.length || !header.startsWith('Bearer ')) return false
  const supplied = Buffer.from(header.slice(7))
  const configured = Buffer.from(expected)
  return supplied.length === configured.length && timingSafeEqual(supplied, configured)
}

function parsePagination(request: Request, response: Response) {
  const parsed = paginationSchema.safeParse(request.query)
  if (!parsed.success) {
    apiError(response, 400, 'VALIDATION_ERROR', 'limit must be an integer from 1 to 100 and cursor must identify a listed email.')
    return null
  }
  return parsed.data
}

function listResponse(response: Response, records: Array<{ id: string } & Record<string, unknown>>, limit: number) {
  const hasMore = records.length > limit
  const page = hasMore ? records.slice(0, limit) : records
  return response.json({
    data: page.map((email) => publicEmail(email as Parameters<typeof publicEmail>[0])),
    pagination: { limit, nextCursor: hasMore ? page.at(-1)?.id ?? null : null },
  })
}

function publicEmail(email: {
  id: string; senderId: string; recipient: string; subject: string; body: string; scheduledAt: Date;
  status: string; bullmqJobId: string | null; attemptCount: number; lastError: string | null;
  smtpAcceptedAt: Date | null; smtpMessageId: string | null; createdAt: Date; updatedAt: Date;
  sender: { id: string; email: string; name: string | null };
}) {
  return {
    id: email.id,
    sender: email.sender,
    recipient: email.recipient,
    subject: email.subject,
    body: email.body,
    scheduledAt: email.scheduledAt.toISOString(),
    status: email.status,
    jobId: email.bullmqJobId,
    attemptCount: email.attemptCount,
    lastError: email.lastError,
    smtpAcceptedAt: email.smtpAcceptedAt?.toISOString() ?? null,
    smtpMessageId: email.smtpMessageId,
    createdAt: email.createdAt.toISOString(),
    updatedAt: email.updatedAt.toISOString(),
  }
}

function apiError(response: Response, status: number, code: string, message: string) {
  return response.status(status).json({ error: { code, message } })
}

function slackError(response: Response, error: unknown) {
  if (error instanceof SlackOAuthError) return apiError(response, error.status, error.code, error.message)
  return apiError(response, 500, 'SLACK_INTEGRATION_ERROR', 'Slack integration request failed.')
}
