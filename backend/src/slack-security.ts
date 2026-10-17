import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import Redis from 'ioredis'

export interface EncryptedSecret {
  ciphertext: string
  nonce: string
  authTag: string
}

export function encryptSecret(plaintext: string, keyHex: string): EncryptedSecret {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), nonce)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    ciphertext: ciphertext.toString('base64'),
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  }
}

export function decryptSecret(encrypted: EncryptedSecret, keyHex: string): string {
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(encrypted.nonce, 'base64'))
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

export class SlackOAuthStateStore {
  constructor(private readonly redis: Redis, private readonly ttlSeconds = 600) {}

  async create(): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = randomBytes(32).toString('base64url')
      const result = await this.redis.set(`slack:oauth:state:${state}`, '1', 'EX', this.ttlSeconds, 'NX')
      if (result === 'OK') return state
    }
    throw new Error('Could not create a unique Slack OAuth state.')
  }

  async consume(state: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{40,50}$/.test(state)) return false
    const result = await this.redis.eval(
      "local value = redis.call('GET', KEYS[1]); if value then redis.call('DEL', KEYS[1]); end; return value",
      1,
      `slack:oauth:state:${state}`,
    )
    return result === '1'
  }
}
