import express, { type ErrorRequestHandler, type Request, type Response } from 'express'
import { PrismaClient } from '@prisma/client'
import { z } from 'zod'
import { findOrCreateEmail, IdempotencyConflictError, SenderNotFoundError } from './scheduling'

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

type EnqueueEmail = (emailId: string) => Promise<void>
interface AppDependencies { prisma: PrismaClient; enqueueEmail: EnqueueEmail }

export function createApp(dependencies: AppDependencies) {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '1mb' }))

  app.get('/health', (_request, response) => response.status(200).json({ status: 'ok' }))

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
