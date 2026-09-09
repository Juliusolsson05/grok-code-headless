import { createServer, request, type Server, type RequestListener } from 'node:http'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { GrokResponsesProxy } from './GrokResponsesProxy.js'
import type { GrokStreamEvent } from './GrokResponseObserver.js'
import { ResponseCapture, replayResponseCapture } from '../recording/ResponseCapture.js'

const recorded = readFileSync(new URL('../../testing/fixtures/streaming/papaya.sse', import.meta.url))
const servers: Server[] = []
const proxies: GrokResponsesProxy[] = []
async function upstream(handler: RequestListener) {
  const server = createServer(handler)
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP address')
  return `http://127.0.0.1:${address.port}/v1`
}
async function proxy(options: Parameters<typeof GrokResponsesProxy.create>[0]) {
  const instance = await GrokResponsesProxy.create(options)
  proxies.push(instance)
  return instance
}
afterEach(async () => {
  for (const instance of proxies.splice(0)) await instance.stop()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

describe('Grok reverse relay with real local HTTP boundaries', () => {
  it('advertises a unique catalog origin but forwards the ordinary upstream models path', async () => {
    const paths: string[] = []
    const base = await upstream((req, res) => { paths.push(req.url!); res.end('{"data":[]}') })
    const first = await proxy({ upstreamBaseUrl: base })
    const second = await proxy({ upstreamBaseUrl: base })
    expect(first.info.modelsListUrl).not.toBe(second.info.modelsListUrl)
    await (await fetch(first.info.modelsListUrl)).text()
    await (await fetch(second.info.modelsListUrl)).text()
    expect(paths).toEqual(['/v1/models', '/v1/models'])
  })
  it('streams the captured response before EOF, preserving bytes and not exposing request credentials', async () => {
    let release!: () => void
    let auth: string | undefined
    const first = recorded.indexOf('event: response.output_text.delta')
    const split = recorded.indexOf('event: response.output_text.done')
    const base = await upstream(async (req, res) => {
      auth = req.headers.authorization
      for await (const _ of req) { /* exercise streaming upload */ }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(recorded.subarray(0, split))
      await new Promise<void>(resolve => { release = resolve })
      res.end(recorded.subarray(split))
    })
    const events: GrokStreamEvent[] = []
    const capture = new ResponseCapture()
    const relay = await proxy({ upstreamBaseUrl: base, capture, onEvent: event => events.push(event) })
    const result = await fetch(`${relay.info.proxyBaseUrl}/responses`, {
      method: 'POST', body: '{"input":"private prompt"}', headers: { authorization: 'Bearer local-test-secret' },
    })
    const reader = result.body!.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    while (total < split) {
      const part = await reader.read()
      expect(part.done).toBe(false)
      chunks.push(part.value!)
      total += part.value!.byteLength
    }
    expect(total).toBeGreaterThan(first)
    expect(events.filter(event => event.type === 'text-delta').map(event => event.delta)).toEqual(['PAP', 'AYA'])
    expect(events.some(event => event.type === 'completed')).toBe(false)
    release()
    for (;;) { const part = await reader.read(); if (part.done) break; chunks.push(part.value) }
    expect(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))).toEqual(recorded)
    expect(auth).toBe('Bearer local-test-secret')
    expect(JSON.stringify(events)).not.toContain('local-test-secret')
    expect(JSON.stringify(events)).not.toContain('private prompt')
    const replayed: GrokStreamEvent[] = []
    expect(replayResponseCapture(capture.serialize(), event => replayed.push(event)).complete).toBe(true)
    expect(replayed).toEqual(events)
  })

  it.each(['models?client_version=a%2Fb', 'responses/compact', 'future/endpoint?x=1&x=2', 'chat/completions'])('forwards /v1/%s without route guesses or redirects', async path => {
    let seen = ''
    const base = await upstream((req, res) => {
      seen = req.url!
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' })
      res.end('{"error":"test upstream refusal"}')
    })
    const events: GrokStreamEvent[] = []
    const relay = await proxy({ upstreamBaseUrl: base, onEvent: event => events.push(event) })
    const result = await fetch(`${relay.info.proxyBaseUrl}/${path}`)
    expect(seen).toBe(`/v1/${path}`)
    expect(result.status).toBe(429)
    expect(result.headers.get('retry-after')).toBe('7')
    expect(await result.text()).toBe('{"error":"test upstream refusal"}')
    if (path === 'chat/completions') expect(events).toContainEqual(expect.objectContaining({ type: 'diagnostic', code: 'unsupported-backend' }))
  })

  it('keeps compressed bytes intact and reports unsupported observation explicitly', async () => {
    const compressed = gzipSync(recorded)
    const base = await upstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' })
      res.end(compressed)
    })
    const events: GrokStreamEvent[] = []
    const relay = await proxy({ upstreamBaseUrl: base, onEvent: event => events.push(event) })
    const body = await new Promise<Buffer>((resolve, reject) => {
      request(`${relay.info.proxyBaseUrl}/responses`, res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => resolve(Buffer.concat(chunks)))
        res.on('error', reject)
      }).on('error', reject).end()
    })
    expect(body).toEqual(compressed)
    expect(events).toContainEqual(expect.objectContaining({ code: 'unsupported-content-encoding' }))
  })

  it('does not let observer exceptions break model traffic', async () => {
    const base = await upstream((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(recorded) })
    const relay = await proxy({ upstreamBaseUrl: base, onEvent: () => { throw new Error('consumer failed') } })
    expect(await (await fetch(`${relay.info.proxyBaseUrl}/responses`)).text()).toBe(recorded.toString())
  })

  it('rejects browser-origin and hostile request targets before contacting upstream', async () => {
    let hits = 0
    const base = await upstream((_req, res) => { hits++; res.end('unexpected') })
    const relay = await proxy({ upstreamBaseUrl: base })
    expect((await fetch(`${relay.info.proxyBaseUrl}/models`, { headers: { origin: 'https://hostile.example' } })).status).toBe(403)
    const status = await new Promise<number>((resolve, reject) => {
      const target = new URL(relay.info.proxyBaseUrl)
      request({ hostname: target.hostname, port: target.port, path: 'http://hostile.example/v1/models' }, res => {
        res.resume(); resolve(res.statusCode!)
      }).on('error', reject).end()
    })
    expect(status).toBe(400)
    expect(hits).toBe(0)
  })

  it('aborts an upstream held open when stop is called and makes repeated stop idempotent', async () => {
    const base = await upstream((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': keepalive\n\n') })
    const relay = await proxy({ upstreamBaseUrl: base })
    const response = await fetch(`${relay.info.proxyBaseUrl}/responses`)
    const body = response.text().catch(() => 'aborted')
    await relay.stop()
    await relay.stop()
    expect(await body).toBe('aborted')
  })

  it('strips Connection-nominated headers in both directions without stripping authorization', async () => {
    let privateHeader: string | undefined
    let auth: string | undefined
    const base = await upstream((req, res) => {
      privateHeader = req.headers['x-private-hop'] as string | undefined
      auth = req.headers.authorization
      res.writeHead(200, { connection: 'x-response-hop', 'x-response-hop': 'must not forward' })
      res.end('ok')
    })
    const relay = await proxy({ upstreamBaseUrl: base })
    const headers = await new Promise<Record<string, unknown>>((resolve, reject) => {
      request(`${relay.info.proxyBaseUrl}/models`, {
        headers: { connection: 'x-private-hop', 'x-private-hop': 'must not forward', authorization: 'Bearer passthrough-test' },
      }, res => { res.resume(); res.on('end', () => resolve(res.headers)) }).on('error', reject).end()
    })
    expect(privateHeader).toBeUndefined()
    expect(auth).toBe('Bearer passthrough-test')
    expect(headers['x-response-hop']).toBeUndefined()
  })

  it('passes redirects through rather than following them with credentials', async () => {
    let redirectedHits = 0
    const destination = await upstream((_req, res) => { redirectedHits++; res.end('not reached') })
    const base = await upstream((_req, res) => { res.writeHead(307, { location: `${destination}/models` }); res.end() })
    const relay = await proxy({ upstreamBaseUrl: base })
    const response = await fetch(`${relay.info.proxyBaseUrl}/models`, { redirect: 'manual', headers: { authorization: 'Bearer test-secret' } })
    expect(response.status).toBe(307)
    expect(redirectedHits).toBe(0)
  })

  it('turns an upstream header stall into a bounded, recognizable relay error', async () => {
    const base = await upstream(() => { /* deliberately withhold headers */ })
    const events: GrokStreamEvent[] = []
    const relay = await proxy({ upstreamBaseUrl: base, headersTimeoutMs: 30, onEvent: event => events.push(event) })
    const response = await fetch(`${relay.info.proxyBaseUrl}/responses`)
    expect(response.status).toBe(502)
    expect(response.headers.get('x-grok-headless-error')).toBe('upstream-transport-error')
    expect(events.some(event => event.type === 'diagnostic' && event.code === 'upstream-headers-timeout')).toBe(true)
    expect(events.filter(event => event.type === 'diagnostic')).toHaveLength(1)
  })

  it('keeps forwarding when the recording budget is exhausted', async () => {
    const base = await upstream((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(recorded) })
    const capture = new ResponseCapture({ maxBytes: 512 })
    const events: GrokStreamEvent[] = []
    const relay = await proxy({ upstreamBaseUrl: base, capture, onEvent: event => events.push(event) })
    expect(await (await fetch(`${relay.info.proxyBaseUrl}/responses`)).text()).toBe(recorded.toString())
    expect(JSON.parse(capture.serialize())).toMatchObject({ complete: false, truncated: true })
    expect(events).toContainEqual(expect.objectContaining({ code: 'capture-truncated' }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'completed' }))
  })

  it('requests identity encoding only on the observed SSE endpoint', async () => {
    const encodings: Array<string | undefined> = []
    const base = await upstream((req, res) => { encodings.push(req.headers['accept-encoding']); res.end('ok') })
    const relay = await proxy({ upstreamBaseUrl: base })
    await (await fetch(`${relay.info.proxyBaseUrl}/responses`, { headers: { 'accept-encoding': 'gzip' } })).text()
    await (await fetch(`${relay.info.proxyBaseUrl}/models`, { headers: { 'accept-encoding': 'gzip' } })).text()
    expect(encodings).toEqual(['identity', 'gzip'])
  })

  it('cancels upstream when the downstream client aborts without blaming upstream', async () => {
    let signalClose!: () => void
    const closed = new Promise<void>(resolve => { signalClose = resolve })
    const base = await upstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': heartbeat\n\n')
      res.on('close', signalClose)
    })
    const events: GrokStreamEvent[] = []
    const capture = new ResponseCapture()
    const relay = await proxy({ upstreamBaseUrl: base, capture, onEvent: event => events.push(event) })
    const abort = new AbortController()
    const response = await fetch(`${relay.info.proxyBaseUrl}/responses`, { signal: abort.signal })
    const body = response.text().catch(() => 'aborted')
    abort.abort()
    await closed
    expect(await body).toBe('aborted')
    expect(events.some(event => event.type === 'diagnostic' && event.code === 'upstream-transport-error')).toBe(false)
    expect(JSON.parse(capture.serialize())).toMatchObject({ complete: false, records: [expect.anything(), expect.objectContaining({ kind: 'end', interrupted: true })] })
  })
})
