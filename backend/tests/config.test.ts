import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveApiPort } from '../src/api-port'

test('Railway PORT takes precedence over API_PORT', () => {
  assert.equal(resolveApiPort(8080, 3000), 8080)
})

test('API_PORT remains supported, defaulting to 3000', () => {
  assert.equal(resolveApiPort(undefined, 4100), 4100)
  assert.equal(resolveApiPort(undefined, 3000), 3000)
})
