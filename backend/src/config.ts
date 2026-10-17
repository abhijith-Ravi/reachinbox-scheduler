import dotenv from 'dotenv'
import { z } from 'zod'

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH ?? '../.env' })

const positiveInteger = (fallback: number) => z.coerce.number().int().positive().default(fallback)
const optionalNonEmpty = z.preprocess((value) => value === '' ? undefined : value, z.string().min(1).optional())

const envSchema = z.object({
  DATABASE_URL: z.url().refine((value) => new URL(value).protocol === 'mysql:', 'DATABASE_URL must use the mysql: scheme'),
  REDIS_HOST: z.string().default('127.0.0.1'),
  REDIS_PORT: positiveInteger(6379),
  REDIS_PASSWORD: z.string().optional(),
  API_PORT: positiveInteger(3000),
  DEFAULT_SENDER_EMAIL: z.email(),
  DEFAULT_SENDER_NAME: z.string().optional(),
  SMTP_HOST: z.string().default('smtp.ethereal.email'),
  SMTP_PORT: positiveInteger(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_SECURE: z.enum(['true', 'false']).default('false'),
  WORKER_CONCURRENCY: positiveInteger(5),
  EMAIL_MAX_ATTEMPTS: positiveInteger(3),
  EMAIL_RETRY_DELAY_MS: positiveInteger(5000),
  EMAIL_PROCESSING_STALE_MS: positiveInteger(900000),
  EMAIL_MIN_SEND_DELAY_MS: z.coerce.number().int().nonnegative().default(1000),
  SENDER_MAX_EMAILS_PER_HOUR: positiveInteger(100),
  SLACK_CLIENT_ID: optionalNonEmpty,
  SLACK_CLIENT_SECRET: optionalNonEmpty,
  SLACK_REDIRECT_URL: z.preprocess((value) => value === '' ? undefined : value, z.url().refine((value) => new URL(value).protocol === 'https:', 'SLACK_REDIRECT_URL must use HTTPS').optional()),
  SLACK_TOKEN_ENCRYPTION_KEY: z.preprocess((value) => value === '' ? undefined : value, z.string().regex(/^[a-fA-F0-9]{64}$/, 'SLACK_TOKEN_ENCRYPTION_KEY must be 64 hexadecimal characters').optional()),
  SLACK_MANAGEMENT_TOKEN: z.preprocess((value) => value === '' ? undefined : value, z.string().min(32).optional()),
  ELASTICSEARCH_URL: z.preprocess((value) => value === '' ? undefined : value, z.url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), 'ELASTICSEARCH_URL must use HTTP or HTTPS').optional()),
  ELASTICSEARCH_USERNAME: optionalNonEmpty,
  ELASTICSEARCH_PASSWORD: optionalNonEmpty,
  BULL_BOARD_TOKEN: z.preprocess((value) => value === '' ? undefined : value, z.string().min(32).optional()),
}).superRefine((values, context) => {
  if (Boolean(values.ELASTICSEARCH_USERNAME) !== Boolean(values.ELASTICSEARCH_PASSWORD)) {
    context.addIssue({ code: 'custom', path: ['ELASTICSEARCH_USERNAME'], message: 'ELASTICSEARCH_USERNAME and ELASTICSEARCH_PASSWORD must be set together' })
  }
})

const parsed = envSchema.safeParse(process.env)
if (!parsed.success) {
  const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
  throw new Error(`Invalid environment configuration: ${issues.join('; ')}`)
}

export const config = { ...parsed.data, SMTP_SECURE: parsed.data.SMTP_SECURE === 'true' }
