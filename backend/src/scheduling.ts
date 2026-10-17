import { Prisma, type PrismaClient } from '@prisma/client'
import { queueInitialEmailSearchInTransaction } from './email-search'

export interface ScheduleInput {
  senderId: string
  recipient: string
  subject: string
  body: string
  scheduledAt: Date
  idempotencyKey: string
}

export class IdempotencyConflictError extends Error {}
export class SenderNotFoundError extends Error {}

export function samePayload(record: {
  senderId: string; recipient: string; subject: string; body: string; scheduledAt: Date
}, input: ScheduleInput): boolean {
  return record.senderId === input.senderId
    && record.recipient === input.recipient
    && record.subject === input.subject
    && record.body === input.body
    && record.scheduledAt.getTime() === input.scheduledAt.getTime()
}

export async function findOrCreateEmail(db: PrismaClient, input: ScheduleInput) {
  const existing = await db.email.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { sender: true } })
  if (existing) {
    if (!samePayload(existing, input)) throw new IdempotencyConflictError('This idempotency key was already used with a different payload.')
    return { email: existing, created: false }
  }

  if (!await db.sender.findUnique({ where: { id: input.senderId }, select: { id: true } })) throw new SenderNotFoundError('The selected sender does not exist.')

  try {
    const email = await db.$transaction(async (tx) => {
      const created = await tx.email.create({
        data: {
          idempotencyKey: input.idempotencyKey,
          senderId: input.senderId,
          recipient: input.recipient,
          subject: input.subject,
          body: input.body,
          scheduledAt: input.scheduledAt,
          status: 'SCHEDULED',
        },
        include: { sender: true },
      })
      await tx.emailOutbox.create({ data: { emailId: created.id } })
      await queueInitialEmailSearchInTransaction(tx, created.id, created.searchVersion)
      return created
    })
    return { email, created: true }
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const raced = await db.email.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { sender: true } })
      if (raced) {
        if (!samePayload(raced, input)) throw new IdempotencyConflictError('This idempotency key was already used with a different payload.')
        return { email: raced, created: false }
      }
    }
    throw error
  }
}
