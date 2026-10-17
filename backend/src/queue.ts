import { Queue, type JobsOptions } from 'bullmq'
import { config } from './config'

export const EMAIL_QUEUE_NAME = 'scheduled-emails'
export interface EmailJobData { emailId: string }

export const redisConnection = {
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
  ...(config.REDIS_PASSWORD ? { password: config.REDIS_PASSWORD } : {}),
  maxRetriesPerRequest: null,
}

export function createEmailQueue(): Queue<EmailJobData> {
  return new Queue<EmailJobData>(EMAIL_QUEUE_NAME, {
    connection: redisConnection,
    defaultJobOptions: {
      attempts: config.EMAIL_MAX_ATTEMPTS,
      backoff: { type: 'exponential', delay: config.EMAIL_RETRY_DELAY_MS },
      removeOnComplete: { age: 86400, count: 1000 },
      removeOnFail: { age: 604800, count: 5000 },
    },
  })
}

export function emailJobOptions(id: string, delay: number): JobsOptions {
  return { jobId: `email-${id}`, delay: Math.max(0, delay) }
}
