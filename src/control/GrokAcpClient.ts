import type { Readable, Writable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { validateDeadlineMs } from './deadline.js'

export interface GrokAcpServerRequest { token: string; id: string | number; method: string; params?: unknown }
export interface GrokAcpRequestOptions { signal?: AbortSignal; timeoutMs?: number | null }
export interface GrokAcpClientOptions {
  maxFrameBytes?: number
  maxPendingRequests?: number
  maxQueuedBytes?: number
  maxIncomingRequests?: number
  onNotification?: (value: { method: string; params?: unknown }) => void
  onRequest?: (value: GrokAcpServerRequest) => void
  onClose?: (error: GrokAcpError) => void
}

export class GrokAcpError extends Error {
  constructor(readonly code: 'closed' | 'capacity' | 'protocol' | 'remote' | 'aborted' | 'timeout' | 'write' | 'stale-request' | 'busy', readonly uncertain: boolean, readonly rpcCode?: number) {
    // Never include native error.data/message or JSON parse excerpts: either
    // may contain the prompt, a tool result or a per-session MCP credential.
    super(`Grok ACP ${code}${rpcCode === undefined ? '' : ` (${rpcCode})`}`)
    this.name = 'GrokAcpError'
  }
}
type Pending = { resolve(value: unknown): void; reject(error: GrokAcpError): void; cleanup(): void }
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const validId = (value: unknown): value is string | number => typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))

/** One connection epoch. Disconnection is terminal; this layer never replays RPCs. */
export class GrokAcpClient {
  private closed = false
  private fragment = ''
  private fragmentBytes = 0
  private queuedBytes = 0
  private incomingBytes = 0
  private readonly pending = new Map<string | number, Pending>()
  private readonly requests = new Map<string, { request: GrokAcpServerRequest; bytes: number }>()
  private readonly requestIds = new Map<string | number, string>()
  private readonly writes = new Set<{ reject(error: GrokAcpError): void; bytes: number }>()
  private readonly maxFrame: number
  private readonly maxPending: number
  private readonly maxQueued: number
  private readonly maxIncoming: number

  constructor(private readonly incoming: Readable, private readonly outgoing: Writable, private readonly options: GrokAcpClientOptions = {}) {
    this.maxFrame = options.maxFrameBytes ?? 64 * 1024 * 1024
    this.maxPending = options.maxPendingRequests ?? 64
    this.maxQueued = options.maxQueuedBytes ?? 64 * 1024 * 1024
    this.maxIncoming = options.maxIncomingRequests ?? 64
    for (const limit of [this.maxFrame, this.maxPending, this.maxQueued, this.maxIncoming]) {
      if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('ACP limits must be positive safe integers')
    }
    incoming.setEncoding('utf8')
    incoming.on('data', this.onData)
    incoming.on('end', this.onEnd)
    incoming.on('close', this.onEnd)
    incoming.on('error', this.onTransportError)
    outgoing.on('error', this.onTransportError)
    outgoing.on('close', this.onEnd)
  }
  get isClosed(): boolean { return this.closed }

  async request(method: string, params: unknown, options: GrokAcpRequestOptions = {}): Promise<unknown> {
    if (this.closed) throw new GrokAcpError('closed', false)
    if (options.signal?.aborted) throw new GrokAcpError('aborted', false)
    if (this.pending.size >= this.maxPending) throw new GrokAcpError('capacity', false)
    // session/prompt completes at turn end, not admission. The typed layer can
    // explicitly opt out of a clock deadline while closure still settles every
    // pending request. Other RPCs retain bounded response waits by default.
    const timeout = options.timeoutMs === undefined ? 30000 : options.timeoutMs
    if (timeout !== null) validateDeadlineMs(timeout)
    const id = randomUUID()
    const frame = this.encode({ jsonrpc: '2.0', id, method, params })
    return new Promise((resolve, reject) => {
      const finish = (code: 'aborted' | 'timeout') => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id); pending.cleanup()
        reject(new GrokAcpError(code, true))
      }
      const abort = () => finish('aborted')
      const timer = timeout === null ? undefined : setTimeout(() => finish('timeout'), timeout)
      this.pending.set(id, { resolve, reject, cleanup: () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort) } })
      options.signal?.addEventListener('abort', abort, { once: true })
      // Register correlation BEFORE write: a fast local peer may respond while
      // Writable.write is still unwinding. The native reply remains opaque;
      // x.ai extension result wrappers belong to the typed method layer.
      void this.write(frame).catch(error => {
        const pending = this.pending.get(id)
        if (pending) { this.pending.delete(id); pending.cleanup(); pending.reject(error) }
      })
    })
  }
  async notify(method: string, params: unknown): Promise<void> {
    await this.write(this.encode({ jsonrpc: '2.0', method, params }))
  }
  async respond(token: string, result: unknown): Promise<void> {
    const request = this.requests.get(token)
    if (!request) throw new GrokAcpError('stale-request', false)
    const frame = this.encode({ jsonrpc: '2.0', id: request.request.id, result })
    // Consume before transport. A delayed UI action cannot answer a later
    // request even if the native peer reuses the same numeric RPC id.
    this.retireRequest(token)
    await this.write(frame)
  }
  retireRequest(token: string): void {
    const value = this.requests.get(token)
    if (!value) return
    this.incomingBytes -= value.bytes
    this.requestIds.delete(value.request.id)
    this.requests.delete(token)
  }
  retireRequests(predicate: (request: GrokAcpServerRequest) => boolean): void {
    // Let the typed native layer retire shared interactions without exposing
    // or duplicating the bounded request store in a second, drifting cache.
    for (const [token, value] of this.requests) if (predicate(value.request)) this.retireRequest(token)
  }

  close(error = new GrokAcpError('closed', true)): void {
    if (this.closed) return
    this.closed = true
    this.incoming.off('data', this.onData)
    this.incoming.off('end', this.onEnd)
    this.incoming.off('close', this.onEnd)
    this.outgoing.off('close', this.onEnd)
    // Keep error sinks through stream destruction: late native pipe errors
    // must not turn an already-owned shutdown into an unhandled EventEmitter error.
    this.fragment = ''; this.fragmentBytes = 0
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error) }
    this.pending.clear()
    for (const write of this.writes) write.reject(error)
    this.writes.clear(); this.queuedBytes = 0
    this.requests.clear(); this.requestIds.clear(); this.incomingBytes = 0
    this.incoming.destroy(); this.outgoing.destroy()
    try { this.options.onClose?.(error) } catch { /* observers do not own shutdown */ }
  }
  private readonly onEnd = () => this.close(new GrokAcpError(this.fragmentBytes ? 'protocol' : 'closed', true))
  private readonly onTransportError = () => this.close(new GrokAcpError('closed', true))
  private readonly onData = (chunk: string) => {
    let start = 0
    while (!this.closed && start < chunk.length) {
      const newline = chunk.indexOf('\n', start)
      const end = newline < 0 ? chunk.length : newline
      const part = chunk.slice(start, end)
      this.fragmentBytes += Buffer.byteLength(part)
      if (this.fragmentBytes > this.maxFrame) { this.close(new GrokAcpError('capacity', true)); return }
      this.fragment += part
      if (newline < 0) return
      const line = this.fragment
      const bytes = this.fragmentBytes
      this.fragment = ''; this.fragmentBytes = 0
      if (line.trim()) this.receive(line, bytes)
      start = newline + 1
    }
  }
  private receive(line: string, bytes: number): void {
    try {
      const value: unknown = JSON.parse(line)
      if (!record(value) || value.jsonrpc !== '2.0') throw new Error('Invalid envelope')
      if (typeof value.method === 'string') {
        if ('result' in value || 'error' in value || !value.method) throw new Error('Invalid request')
        if (!('id' in value)) { this.options.onNotification?.({ method: value.method, params: value.params }); return }
        if (!validId(value.id) || this.requestIds.has(value.id)) throw new Error('Invalid reverse request identity')
        if (this.requests.size >= this.maxIncoming || this.incomingBytes + bytes > this.maxFrame) {
          this.close(new GrokAcpError('capacity', true)); return
        }
        const request = { token: randomUUID(), id: value.id, method: value.method, params: value.params }
        this.requests.set(request.token, { request, bytes }); this.requestIds.set(request.id, request.token); this.incomingBytes += bytes
        // Never auto-reject a shared permission request. The real TUI can
        // answer it too; native interaction-resolved notifications retire it.
        this.options.onRequest?.(request)
        return
      }
      if (!validId(value.id) || ('result' in value) === ('error' in value)) throw new Error('Invalid response')
      if ('error' in value && (!record(value.error) || !Number.isSafeInteger(value.error.code) || typeof value.error.message !== 'string')) throw new Error('Invalid error')
      const pending = this.pending.get(value.id)
      if (!pending) return // Late replies after timeout/abort do not restart work.
      this.pending.delete(value.id); pending.cleanup()
      if ('error' in value) pending.reject(new GrokAcpError('remote', true, (value.error as { code: number }).code))
      else pending.resolve(value.result)
    } catch { this.close(new GrokAcpError('protocol', true)) }
  }
  private encode(value: unknown): string {
    if (this.closed) throw new GrokAcpError('closed', false)
    let frame: string
    try { frame = JSON.stringify(value) + '\n' } catch { throw new GrokAcpError('protocol', false) }
    if (Buffer.byteLength(frame) > this.maxFrame) throw new GrokAcpError('capacity', false)
    return frame
  }
  private write(frame: string): Promise<void> {
    if (this.closed) return Promise.reject(new GrokAcpError('closed', false))
    const bytes = Buffer.byteLength(frame)
    if (this.queuedBytes + bytes > this.maxQueued) return Promise.reject(new GrokAcpError('capacity', false))
    return new Promise((resolve, reject) => {
      const receipt = { reject, bytes }
      this.writes.add(receipt); this.queuedBytes += bytes
      try {
        this.outgoing.write(frame, 'utf8', error => {
          if (!this.writes.delete(receipt)) return
          this.queuedBytes -= bytes
          if (error) { reject(new GrokAcpError('write', true)); this.close(new GrokAcpError('write', true)) }
          else resolve()
        })
      } catch { this.close(new GrokAcpError('write', true)) }
    })
  }
}
