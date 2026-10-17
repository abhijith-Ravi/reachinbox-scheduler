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
if hourlyLimit <= 0 then return {0, 86400000} end
redis.call('ZREMRANGEBYSCORE', startsKey, '-inf', now - 3600000)
local existing = redis.call('ZSCORE', startsKey, emailId)
local waitMs = 0
local lastStart = redis.call('GET', lastKey)
if lastStart then
  waitMs = math.max(waitMs, tonumber(lastStart) + minDelay - now)
end
if not existing and redis.call('ZCARD', startsKey) >= hourlyLimit then
  local oldest = redis.call('ZRANGE', startsKey, 0, 0, 'WITHSCORES')
  if oldest[2] then
    waitMs = math.max(waitMs, tonumber(oldest[2]) + 3600000 - now + 1)
  end
end
if waitMs > 0 then return {0, math.ceil(waitMs)} end
if not existing then redis.call('ZADD', startsKey, now, emailId) end
redis.call('PEXPIRE', startsKey, 3600000)
redis.call('SET', lastKey, now, 'PX', math.max(minDelay * 2, 1000))
return {1, 0}
`

export interface SendPermit { allowed: boolean; delayMs: number }

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
    ) as [number | string, number | string]
    return { allowed: Number(result[0]) === 1, delayMs: Number(result[1]) }
  }
}

export { RESERVE_SEND_SCRIPT }
