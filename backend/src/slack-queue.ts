import { Queue, type JobsOptions } from 'bullmq'
import { redisConnection } from './queue'

export const SLACK_NOTIFICATION_QUEUE = 'slack-notifications'
export interface SlackNotificationJobData { notificationId: string }

export function createSlackNotificationQueue(): Queue<SlackNotificationJobData> {
  return new Queue<SlackNotificationJobData>(SLACK_NOTIFICATION_QUEUE, {
    connection: redisConnection,
    defaultJobOptions: {
      attempts: 8,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: { age: 86_400, count: 1000 },
      removeOnFail: { age: 604_800, count: 5000 },
    },
  })
}

export function slackNotificationJobOptions(id: string): JobsOptions {
  return { jobId: `slack-notification-${id}` }
}
