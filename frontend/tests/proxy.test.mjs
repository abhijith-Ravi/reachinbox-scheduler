import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createFrontendServer } from '../server.mjs'

let upstreamServer
let frontendServer
let staticRoot
let upstreamOrigin
let frontendOrigin
let forwardedRequest

before(async () => {
  staticRoot = await mkdtemp(join(tmpdir(), 'reachinbox-frontend-'))
  await writeFile(join(staticRoot, 'index.html'), '<main>ReachInbox</main>')
  upstreamServer = createHttpServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    forwardedRequest = {
      url: request.url,
      cookie: request.headers.cookie,
      body: Buffer.concat(chunks).toString('utf8'),
    }
    response.setHeader('Set-Cookie', [
      'reachinbox_session=session-value; HttpOnly; Path=/api; SameSite=None; Secure',
      'secondary=other-value; Path=/api; HttpOnly',
    ])
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ data: { ok: true } }))
  })
  upstreamServer.listen(0, '127.0.0.1')
  await once(upstreamServer, 'listening')
  upstreamOrigin = `http://127.0.0.1:${upstreamServer.address().port}`

  frontendServer = createFrontendServer({ backendOrigin: upstreamOrigin, staticRoot })
  frontendServer.listen(0, '127.0.0.1')
  await once(frontendServer, 'listening')
  frontendOrigin = `http://127.0.0.1:${frontendServer.address().port}`
})

after(async () => {
  if (frontendServer?.listening) await new Promise((resolve, reject) => frontendServer.close((error) => error ? reject(error) : resolve()))
  if (upstreamServer?.listening) await new Promise((resolve, reject) => upstreamServer.close((error) => error ? reject(error) : resolve()))
  if (staticRoot) await rm(staticRoot, { recursive: true, force: true })
})

test('serves the built app at the frontend origin', async () => {
  const response = await fetch(frontendOrigin)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), '<main>ReachInbox</main>')
})

test('proxies API requests and preserves request cookies and Set-Cookie attributes', async () => {
  const response = await fetch(`${frontendOrigin}/api/auth/google?mode=test`, {
    method: 'POST',
    headers: {
      cookie: 'existing_session=preserve-me',
      'content-type': 'application/json',
      origin: frontendOrigin,
    },
    body: JSON.stringify({ credential: 'test-credential' }),
  })

  assert.equal(response.status, 200)
  assert.deepEqual(forwardedRequest, {
    url: '/api/auth/google?mode=test',
    cookie: 'existing_session=preserve-me',
    body: JSON.stringify({ credential: 'test-credential' }),
  })
  assert.deepEqual(response.headers.getSetCookie(), [
    'reachinbox_session=session-value; HttpOnly; Path=/api; SameSite=None; Secure',
    'secondary=other-value; Path=/api; HttpOnly',
  ])
})
