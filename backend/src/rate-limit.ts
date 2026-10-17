import Redis from 'ioredis'

// A disabled sender is parked for a day at a time. This avoids a hot loop and
// lets a later quota change take effect automatically on the next recheck.
export const ZERO_LIMIT_RECHECK_MS = 24 * 60 * 60 * 1000

// The Redis server clock is the shared time source. A reservation is keyed by
// email ID, so a BullMQ retry for the same logical email doesn't consume a
// second hourly slot while its original reservation remains in the window.
const RESERVE_SEND_SCRIPT = `
local nowParts = redis.call('TIME')
local now = (tonumber(nowParts[1]) * 1000) + math.floor(tonumber(nowParts[2]) / 1000)
local startsKey = KEYS[1]
local lastKey = KEYS[2]
local emailId = ARGV[1]
local minDelay = tonumber(ARGV[2])
local hourlyLimit = tonumber(ARGV[3])
if hourlyLimit <= 0 then
  return {0, 86400000, 3, now + 86400000, math.floor(now / 86400000)}
end
redis.call('ZREMRANGEBYSCORE', startsKey, '-inf', now - 3600000)
local existing = redis.call('ZSCORE', startsKey, emailId)
local waitMs = 0
local quotaLimited = false
local quotaEligibleAt = 0
local lastStart = redis.call('GET', lastKey)
if lastStart then
  waitMs = math.max(waitMs, tonumber(lastStart) + minDelay - now)
end
if not existing and redis.call('ZCARD', startsKey) >= hourlyLimit then
  quotaLimited = true
  local oldest = redis.call('ZRANGE', startsKey, 0, 0, 'WITHSCORES')
  if oldest[2] then
    quotaEligibleAt = tonumber(oldest[2]) + 3600000 + 1
    waitMs = math.max(waitMs, quotaEligibleAt - now)
  end
end
if waitMs > 0 then
  if quotaLimited then return {0, math.ceil(waitMs), 2, quotaEligibleAt, quotaEligibleAt} end
  return {0, math.ceil(waitMs), 1, now + math.ceil(waitMs), 0}
end
if not existing then redis.call('ZADD', startsKey, now, emailId) end
redis.call('PEXPIRE', startsKey, 3600000)
redis.call('SET', lastKey, now, 'PX', math.max(minDelay * 2, 1000))
return {1, 0, 0, 0, 0}
`

export type LimitReason = 'allowed' | 'minimum_delay' | 'hourly_limit' | 'disabled'
export interface SendPermit {
  allowed: boolean
  delayMs: number
  reason: LimitReason
  nextEligibleAt: number | null
  notificationPeriod: string | null
  effectiveLimit: number
}

export class SenderRateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly minDelayMs: number,
    private readonly defaultHourlyLimit: number,
  ) {}

  async reserve(senderId: string, emailId: string, senderHourlyLimit: number | null): Promise<SendPermit> {
    const safeSenderId = encodeURIComponent(senderId)
    const result = await this.redis.eval(
      RESERVE_SEND_SCRIPT,
      2,
      `reachinbox:rate:{${safeSenderId}}:starts`,
      `reachinbox:rate:{${safeSenderId}}:last-start`,
      emailId,
      this.minDelayMs,
      senderHourlyLimit ?? this.defaultHourlyLimit,
    ) as [number | string, number | string, number | string, number | string, number | string]
    const allowed = Number(result[0]) === 1
    const reasonCode = Number(result[2])
    const reason: LimitReason = reasonCode === 1 ? 'minimum_delay' : reasonCode === 2 ? 'hourly_limit' : reasonCode === 3 ? 'disabled' : 'allowed'
    // Disabled senders have a 24-hour recheck time, but no send-eligible time
    // can be calculated until configuration changes.
    const nextEligibleAt = reasonCode === 3 ? null : Number(result[3]) || null
    const notificationPeriod = reasonCode === 3 ? `disabled:${result[4]}` : reasonCode === 2 ? `quota:${result[4]}` : null
    return {
      allowed,
      delayMs: Number(result[1]),
      reason,
      nextEligibleAt,
      notificationPeriod,
      effectiveLimit: senderHourlyLimit ?? this.defaultHourlyLimit,
    }
  }
}

export { RESERVE_SEND_SCRIPT }
