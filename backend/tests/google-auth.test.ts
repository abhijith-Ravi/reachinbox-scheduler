import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { after, before, test } from 'node:test'
import type { PrismaClient } from '@prisma/client'
import { createApp } from '../src/app'
import { GoogleAuthService, type GoogleTokenClaims } from '../src/google-auth'

const clientId = 'test-google-client.apps.googleusercontent.com'
const secret = 'test-session-signing-secret-with-more-than-32-characters'
const frontendOrigin = 'https://frontend.example.com'
let server: Server | undefined
let baseUrl = ''
let claims: GoogleTokenClaims = { sub: 'google-user-123', email: 'person@example.com', email_verified: true, name: 'Test Person', picture: 'https://example.com/avatar.png' }

const googleAuth = new GoogleAuthService(clientId, secret, async (credential, audience) => {
  assert.equal(audience, clientId)
  if (credential !== 'mock-valid-google-id-token') throw new Error('invalid mock token')
  return claims
})

before(async () => {
  const fakePrisma = { email: { findMany: async () => [] } } as unknown as PrismaClient
  server = createServer(createApp({ prisma: fakePrisma, enqueueEmail: async () => undefined, googleAuth, googleAuthRequired: true, secureCookies: true, frontendOrigin }))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Google auth test API did not bind.')
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()))
})

test('Google login verifies token claims, sets an HttpOnly session cookie, and returns only the profile', async () => {
  const response = await fetch(`${baseUrl}/api/auth/google`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: 'mock-valid-google-id-token' }),
  })
  assert.equal(response.status, 200)
  const body = await response.json() as { data: { user: { id: string; email: string; name: string; picture: string } } }
  assert.deepEqual(body.data.user, { id: 'google-user-123', email: 'person@example.com', name: 'Test Person', picture: 'https://example.com/avatar.png' })
  assert.doesNotMatch(JSON.stringify(body), /mock-valid-google-id-token|session-signing-secret/)
  const cookie = response.headers.get('set-cookie')
  assert.ok(cookie?.includes('HttpOnly'))
  assert.ok(cookie?.includes('SameSite=None'))
  assert.ok(cookie?.includes('Secure'))
  assert.ok(cookie?.includes('Path=/api'))
  assert.ok(cookie?.includes('Max-Age=28800'))
  assert.ok(cookie)

  const session = await fetch(`${baseUrl}/api/auth/session`, { headers: { cookie: cookie.split(';')[0]! } })
  assert.deepEqual((await session.json() as { data: { enabled: boolean; user: unknown } }).data, { enabled: true, configurationError: false, user: body.data.user })
})

test('credentialed CORS is limited to the configured frontend origin', async () => {
  const preflight = await fetch(`${baseUrl}/api/auth/google`, {
    method: 'OPTIONS',
    headers: {
      origin: frontendOrigin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), frontendOrigin)
  assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true')

  const rejected = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { origin: 'https://attacker.example.com' },
  })
  assert.equal(rejected.status, 403)
})

test('invalid or unverified Google claims are rejected and email APIs require a valid session', async () => {
  const invalid = await fetch(`${baseUrl}/api/auth/google`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: 'not-a-valid-google-token' }),
  })
  assert.equal(invalid.status, 401)

  claims = { sub: 'google-user-123', email: 'person@example.com', email_verified: false }
  const unverified = await fetch(`${baseUrl}/api/auth/google`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: 'mock-valid-google-id-token' }),
  })
  assert.equal(unverified.status, 401)
  claims = { sub: 'google-user-123', email: 'person@example.com', email_verified: true, name: 'Test Person' }

  const protectedResponse = await fetch(`${baseUrl}/api/emails/scheduled`)
  assert.equal(protectedResponse.status, 401)
  const protectedBody = await protectedResponse.json() as { error: { code: string } }
  assert.equal(protectedBody.error.code, 'AUTHENTICATION_REQUIRED')

  const login = await fetch(`${baseUrl}/api/auth/google`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: 'mock-valid-google-id-token' }),
  })
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  const allowedResponse = await fetch(`${baseUrl}/api/emails/scheduled`, { headers: { cookie } })
  assert.equal(allowedResponse.status, 200)
})

test('logout clears the cookie and invalid session signatures are rejected', async () => {
  const login = await fetch(`${baseUrl}/api/auth/google`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: 'mock-valid-google-id-token' }),
  })
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  const value = cookie.slice(cookie.indexOf('=') + 1)
  const tampered = await fetch(`${baseUrl}/api/auth/session`, { headers: { cookie: `reachinbox_session=${value}x` } })
  assert.equal((await tampered.json() as { data: { user: unknown } }).data.user, null)

  const logout = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST' })
  assert.ok(logout.headers.get('set-cookie')?.includes('Max-Age=0'))
  assert.ok(logout.headers.get('set-cookie')?.includes('SameSite=None'))
  assert.ok(logout.headers.get('set-cookie')?.includes('Secure'))
  const loggedOutSession = await fetch(`${baseUrl}/api/auth/session`)
  assert.equal((await loggedOutSession.json() as { data: { user: unknown } }).data.user, null)
})
