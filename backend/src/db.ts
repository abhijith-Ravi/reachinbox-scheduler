import { PrismaClient } from '@prisma/client'
import { config } from './config'

export const prisma = new PrismaClient()

export async function ensureDefaultSender(): Promise<void> {
  await prisma.sender.upsert({
    where: { id: 'default' },
    create: { id: 'default', email: config.DEFAULT_SENDER_EMAIL, name: config.DEFAULT_SENDER_NAME },
    update: { email: config.DEFAULT_SENDER_EMAIL, name: config.DEFAULT_SENDER_NAME },
  })
}
