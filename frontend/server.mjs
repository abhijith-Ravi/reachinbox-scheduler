import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'

const defaultStaticRoot = fileURLToPath(new URL('./dist/', import.meta.url))
const hopByHopHeaders = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'expect',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.woff2', 'font/woff2'],
])

function parseBackendOrigin(value) {
  const backend = new URL(value)
  if (!['http:', 'https:'].includes(backend.protocol) || backend.pathname !== '/' || backend.search || backend.hash) {
    throw new Error('BACKEND_ORIGIN must be an HTTP(S) origin without a path.')
  }
  return backend.origin
}

async function serveStatic(request, response, staticRoot) {
  let pathname
  try {
    pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
  } catch {
    response.writeHead(400).end('Bad request')
    return
  }

  const root = resolve(staticRoot)
  const requestedPath = resolve(root, `.${pathname}`)
  if (requestedPath !== root && !requestedPath.startsWith(`${root}${sep}`)) {
    response.writeHead(403).end('Forbidden')
    return
  }

  let filePath = requestedPath
  try {
    if ((await stat(filePath)).isDirectory()) filePath = resolve(filePath, 'index.html')
    if (!(await stat(filePath)).isFile()) throw new Error('Not a file')
  } catch {
    if (extname(pathname)) {
      response.writeHead(404).end('Not found')
      return
    }
    filePath = resolve(root, 'index.html')
    try {
      if (!(await stat(filePath)).isFile()) throw new Error('Missing build output')
    } catch {
      response.writeHead(503).end('Frontend build output is unavailable')
      return
    }
  }

  response.writeHead(200, {
    'content-type': contentTypes.get(extname(filePath)) ?? 'application/octet-stream',
    'cache-control': extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  })
  if (request.method === 'HEAD') response.end()
  else createReadStream(filePath).pipe(response)
}

async function proxyApi(request, response, backendOrigin) {
  const target = new URL(request.url ?? '/api', backendOrigin)
  const headers = new Headers(request.headers)
  headers.delete('host')
  for (const header of hopByHopHeaders) headers.delete(header)

  const hasBody = !['GET', 'HEAD'].includes(request.method ?? 'GET')
  const upstream = await fetch(target, {
    method: request.method,
    headers,
    ...(hasBody ? { body: Readable.toWeb(request), duplex: 'half' } : {}),
    redirect: 'manual',
  })

  const responseHeaders = {}
  for (const [name, value] of upstream.headers) {
    if (!hopByHopHeaders.has(name) && name !== 'set-cookie') responseHeaders[name] = value
  }
  const setCookies = upstream.headers.getSetCookie()
  if (setCookies.length) responseHeaders['set-cookie'] = setCookies

  response.writeHead(upstream.status, responseHeaders)
  if (!upstream.body || request.method === 'HEAD') response.end()
  else Readable.fromWeb(upstream.body).pipe(response)
}

export function createFrontendServer({
  backendOrigin = process.env.BACKEND_ORIGIN ?? 'http://127.0.0.1:3000',
  staticRoot = defaultStaticRoot,
} = {}) {
  const targetOrigin = parseBackendOrigin(backendOrigin)
  return createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    const isApi = pathname === '/api' || pathname.startsWith('/api/')
    const operation = isApi
      ? proxyApi(request, response, targetOrigin)
      : serveStatic(request, response, staticRoot)
    void operation.catch((error) => {
      console.error('Frontend request failed', error instanceof Error ? error.message : 'Unknown error')
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ error: { code: 'API_UNAVAILABLE', message: 'The API is temporarily unavailable.' } }))
      } else response.destroy()
    })
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const server = createFrontendServer()
  const port = Number(process.env.PORT ?? 4173)
  server.listen(port, '0.0.0.0', () => console.info(`ReachInbox frontend listening on port ${port}`))
}
