import { randomUUID } from 'node:crypto'
import { createServer, request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Socket } from 'node:net'
import { GrokResponseObserver, type GrokStreamEvent } from './GrokResponseObserver.js'
import type { ResponseCapture } from '../recording/ResponseCapture.js'

const DEFAULT_HEADERS_TIMEOUT_MS = 300000

export type GrokResponsesProxyOptions = {
  /** Explicit: OAuth and API-key endpoints must never be guessed from a token. */
  upstreamBaseUrl: string
  onEvent?: (event: GrokStreamEvent) => void
  maxFrameBytes?: number
  maxConcurrentRequests?: number
  headersTimeoutMs?: number
  /** Opt-in private SSE capture. Request bodies/headers never enter it. */
  capture?: ResponseCapture
}

function endToEndHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const blocked = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection', 'host',
  ])
  // RFC hop-by-hop headers include names declared by Connection, not just
  // the usual fixed list. Preserve Content-Encoding/Length: unlike fetch,
  // node:http does not transparently decompress the bytes we forward.
  for (const token of (headers.connection ?? '').split(',')) blocked.add(token.trim().toLowerCase())
  const result: IncomingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) if (!blocked.has(name.toLowerCase())) result[name] = value
  return result
}

// This is a fixed-origin reverse relay, not an open proxy. It owns no auth
// and never reads provider configuration or caches. The caller must settle
// Grok's shared models-cache contract before injecting the relay into a TUI.
export class GrokResponsesProxy {
  readonly info: Readonly<{ proxyBaseUrl: string; modelsListUrl: string; upstreamBaseUrl: string }>
  private readonly catalogPath = `/v1/.grok-headless/${randomUUID()}/models`
  private readonly sockets = new Set<Socket>()
  private readonly requests = new Set<ClientRequest>()
  private stopping: Promise<void> | undefined
  private lastFailure: GrokStreamEvent | undefined

  private constructor(
    private readonly server: Server,
    private readonly upstream: URL,
    private readonly options: GrokResponsesProxyOptions,
    port: number,
  ) {
    this.info = Object.freeze({
      proxyBaseUrl: `http://127.0.0.1:${port}/v1`,
      // Ports can be reused after shutdown. A per-listener catalog path keeps
      // the native cache-origin fence unique even when the OS reuses a port.
      modelsListUrl: `http://127.0.0.1:${port}${this.catalogPath}`,
      upstreamBaseUrl: upstream.href,
    })
    server.maxConnections = (options.maxConcurrentRequests ?? 32) * 2
    server.on('connection', socket => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
    server.on('request', (req, res) => this.handle(req, res))
    server.on('error', () => this.report({ type: 'diagnostic', flowId: 'listener', code: 'listener-error' }))
    // Do not assume Grok has Codex's WS fallback policy. This implementation
    // exposes HTTP/SSE only and refuses upgrade/CONNECT without tunneling.
    server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nUpgrade: HTTP/1.1\r\nContent-Length: 0\r\n\r\n'))
    server.on('connect', (_req, socket) => socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'))
  }

  get lastDiagnostic(): GrokStreamEvent | undefined { return this.lastFailure }

  static async create(options: GrokResponsesProxyOptions): Promise<GrokResponsesProxy> {
    const upstream = new URL(options.upstreamBaseUrl)
    if (upstream.username || upstream.password || upstream.search || upstream.hash) throw new Error('Upstream must not contain credentials, query or fragment')
    const local = ['127.0.0.1', '[::1]', 'localhost'].includes(upstream.hostname)
    if (upstream.protocol !== 'https:' && !(upstream.protocol === 'http:' && local)) throw new Error('Upstream must use HTTPS (HTTP is allowed only for loopback testing)')
    for (const value of [options.maxFrameBytes ?? 1024 * 1024, options.maxConcurrentRequests ?? 32, options.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid relay budget')
    }
    // These deadlines govern incoming header/body receipt, not the lifetime
    // of an SSE response. Upstream time-to-first-byte has its own budget.
    const server = createServer({ requestTimeout: 30000, headersTimeout: 15000 })
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => { server.close(); reject(error) }
      server.once('error', fail)
      server.listen(0, '127.0.0.1', () => { server.off('error', fail); resolve() })
    })
    const address = server.address()
    if (!address || typeof address === 'string') { server.close(); throw new Error('No relay bind address') }
    return new GrokResponsesProxy(server, upstream, options, address.port)
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopping = new Promise<void>((resolve, reject) => {
      this.server.close(error => error ? reject(error) : resolve())
      for (const upstream of this.requests) upstream.destroy()
      for (const socket of this.sockets) socket.destroy()
      this.server.closeAllConnections()
    })
    return this.stopping
  }

  private report(event: GrokStreamEvent): void {
    if (event.type === 'diagnostic') this.lastFailure = event
    try { this.options.onEvent?.(event) }
    catch { this.lastFailure = { type: 'diagnostic', flowId: event.flowId, code: 'consumer-error' } }
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const reject = (status: number) => { res.writeHead(status, { connection: 'close' }); res.end() }
    if (req.headers.origin) { reject(403); return }
    if (req.headers.host !== new URL(this.info.proxyBaseUrl).host) { reject(421); return }
    let target = req.url ?? ''
    if (!target.startsWith('/v1/') || target.includes('\\')) { reject(400); return }
    if (target.split('?', 1)[0] === this.catalogPath) target = `/v1/models${target.slice(this.catalogPath.length)}`
    if (this.stopping || this.requests.size >= (this.options.maxConcurrentRequests ?? 32)) { reject(503); return }
    const endpoint = target.split('?', 1)[0]
    const flowId = randomUUID()
    if (endpoint === '/v1/chat/completions') this.report({ type: 'diagnostic', flowId, code: 'unsupported-backend' })
    const send = this.upstream.protocol === 'https:' ? httpsRequest : httpRequest
    // Build the path as an origin-form string, not new URL(userInput, base).
    // The latter can replace the authority or normalize encoded traversal.
    const upstreamPath = this.upstream.pathname.replace(/\/$/, '') + target.slice('/v1'.length)
    const forwarded = endToEndHeaders(req.headers)
    // Ask for uncompressed SSE rather than assuming the provider never
    // compresses it. If ignored, preserve bytes and report observation loss.
    if (endpoint === '/v1/responses') forwarded['accept-encoding'] = 'identity'
    const outgoing = send({
      protocol: this.upstream.protocol, hostname: this.upstream.hostname.replace(/^\[|\]$/g, ''),
      port: this.upstream.port || undefined, method: req.method, path: upstreamPath,
      headers: forwarded, agent: false,
    })
    this.requests.add(outgoing)
    let response: IncomingMessage | undefined
    let observer: GrokResponseObserver | undefined
    let capturing = false
    let captureEnded = false
    let captureFailed = false
    let reportedTransportError = false
    let cancelled = false
    const capture = (chunk?: Buffer, interrupted = false) => {
      if (!capturing || captureFailed || (chunk === undefined && captureEnded)) return
      if (chunk === undefined) captureEnded = true
      try {
        const accepted = chunk === undefined ? this.options.capture!.end(flowId, interrupted) : this.options.capture!.write(flowId, chunk)
        if (accepted) return
      } catch { /* recording failure cannot break byte forwarding */ }
      captureFailed = true
      this.report({ type: 'diagnostic', flowId, code: 'capture-truncated' })
    }
    const timer = setTimeout(() => {
      reportedTransportError = true
      this.report({ type: 'diagnostic', flowId, code: 'upstream-headers-timeout' })
      outgoing.destroy(new Error('Upstream header deadline exceeded'))
    }, this.options.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS)
    const close = () => {
      cancelled = true
      clearTimeout(timer)
      req.unpipe(outgoing)
      outgoing.destroy()
      response?.destroy()
      observer?.end()
      // Only incoming 'end' proves all buffered chunks reached capture().
      // IncomingMessage.complete can be true while readable data is still
      // buffered, so a close before that callback is always interrupted.
      capture(undefined, true)
      this.requests.delete(outgoing)
    }
    res.once('close', close)
    res.on('error', close)
    req.once('aborted', () => { cancelled = true; outgoing.destroy(); res.destroy() })
    req.on('error', () => { cancelled = true; outgoing.destroy(); res.destroy() })
    outgoing.on('error', () => {
      clearTimeout(timer)
      if (!cancelled && !reportedTransportError) {
        reportedTransportError = true
        this.report({ type: 'diagnostic', flowId, code: 'upstream-transport-error' })
      }
      if (res.destroyed) return
      if (res.headersSent) res.destroy()
      else { res.writeHead(502, { 'x-grok-headless-error': 'upstream-transport-error', connection: 'close' }); res.end() }
    })
    outgoing.once('response', incoming => {
      response = incoming
      clearTimeout(timer)
      res.writeHead(incoming.statusCode ?? 502, endToEndHeaders(incoming.headers))
      const contentType = incoming.headers['content-type'] ?? ''
      const encoding = incoming.headers['content-encoding']
      if (endpoint === '/v1/responses' && contentType.split(';', 1)[0]!.trim().toLowerCase() === 'text/event-stream') {
        if (encoding && encoding !== 'identity') {
          this.report({ type: 'diagnostic', flowId, code: 'unsupported-content-encoding' })
        } else {
          capturing = this.options.capture !== undefined
          observer = new GrokResponseObserver({ flowId, maxFrameBytes: this.options.maxFrameBytes, onEvent: event => this.report(event) })
          incoming.on('data', (chunk: Buffer) => { capture(chunk); observer!.write(chunk) })
          incoming.once('end', () => { observer!.end(); capture() })
        }
      }
      incoming.on('error', () => {
        if (!cancelled && !reportedTransportError) {
          reportedTransportError = true
          this.report({ type: 'diagnostic', flowId, code: 'upstream-response-error' })
        }
        res.destroy()
      })
      // Stream piping owns backpressure in both directions. Observation never
      // buffers a whole request or response and never changes forwarded bytes.
      incoming.pipe(res)
    })
    req.pipe(outgoing)
  }
}
