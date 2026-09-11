import { createConnection, type Socket } from 'node:net'
import { PassThrough, Writable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { GrokAcpClient, GrokAcpError, type GrokAcpClientOptions } from './GrokAcpClient.js'
import { validateDeadlineMs } from './deadline.js'

export interface GrokLeaderConnectionOptions extends GrokAcpClientOptions { connectTimeoutMs?: number; signal?: AbortSignal }

// Native leader protocol v1: 4-byte big-endian length + JSON envelope. ACP is
// a string payload inside that envelope. Keep this adapter separate from RPC
// correlation so neither layer has to guess the other's framing/ownership.
export class GrokLeaderConnection {
  readonly rpc: GrokAcpClient
  private socket: Socket
  private readonly incoming = new PassThrough()
  private closed = false
  private registered = false
  private leaderReady = false
  private verified = false
  private initialized = false
  private readonly controlId = randomUUID()
  private readonly maxFrame: number
  private readonly header = Buffer.alloc(4)
  private headerBytes = 0
  private payload: Buffer | undefined
  private payloadBytes = 0
  private buffered: string[] = []
  private bufferedBytes = 0
  private resolveReady!: () => void
  private rejectReady!: (error: Error) => void
  private readonly ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject })
  private readonly timer: ReturnType<typeof setTimeout>
  private readonly abort = () => this.fail(new Error('Grok leader connection cancelled'))

  static async connect(path: string, expectedPid: number, options: GrokLeaderConnectionOptions = {}): Promise<GrokLeaderConnection> {
    if (!path || !Number.isSafeInteger(expectedPid) || expectedPid <= 0) throw new Error('A private leader path and owned PID are required')
    if (options.signal?.aborted) throw new Error('Grok leader connection cancelled')
    if (options.connectTimeoutMs !== undefined) validateDeadlineMs(options.connectTimeoutMs)
    const connection = new GrokLeaderConnection(path, expectedPid, options)
    try {
      await connection.ready
      if (connection.closed) throw new Error('Grok leader closed during registration')
      return connection
    } catch (error) { connection.close(); throw error }
  }
  private constructor(path: string, private readonly expectedPid: number, private readonly options: GrokLeaderConnectionOptions) {
    this.maxFrame = Math.min(options.maxFrameBytes ?? 64 * 1024 * 1024, 64 * 1024 * 1024)
    const outgoing = new Writable({ write: (chunk, _encoding, callback) => {
      this.send({ type: 'acp', payload: chunk.toString('utf8').trimEnd() }, callback)
    } })
    this.rpc = new GrokAcpClient(this.incoming, outgoing, { ...options, onClose: error => {
      this.close()
      options.onClose?.(error)
    } })
    this.socket = createConnection(path)
    this.timer = setTimeout(() => this.fail(new Error('Grok leader registration timed out')), options.connectTimeoutMs ?? 10000)
    options.signal?.addEventListener('abort', this.abort, { once: true })
    this.socket.on('error', () => this.fail(new Error('Grok leader connection failed')))
    this.socket.on('close', () => this.fail(new Error('Grok leader connection closed')))
    this.socket.on('end', () => this.fail(new Error('Grok leader connection ended')))
    this.socket.on('data', data => this.consume(data))
    this.socket.once('connect', () => this.send({
      type: 'register', client_type: 'grok-code-headless', mode: 'stdio',
      capabilities: { yolo_mode: false, auto_mode: false, terminal: false, fs_read: false, fs_write: false, user_message_echo: true },
    }))
    this.incoming.on('drain', () => this.socket.resume())
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.timer)
    this.options.signal?.removeEventListener('abort', this.abort)
    this.rejectReady(new Error('Grok leader connection closed'))
    this.buffered = []; this.bufferedBytes = 0; this.payload = undefined
    this.socket?.destroy()
    this.rpc.close()
  }
  private fail(error: Error): void {
    if (this.closed) return
    this.rejectReady(error)
    this.close()
  }
  private send(value: unknown, callback?: (error?: Error | null) => void): void {
    if (this.closed) { callback?.(new GrokAcpError('closed', false)); return }
    const payload = Buffer.from(JSON.stringify(value))
    if (payload.length > this.maxFrame) { callback?.(new GrokAcpError('capacity', false)); this.fail(new Error('Leader frame exceeds limit')); return }
    const header = Buffer.alloc(4); header.writeUInt32BE(payload.length)
    this.socket.write(Buffer.concat([header, payload]), error => {
      callback?.(error)
      if (error) this.fail(new Error('Grok leader write failed'))
    })
  }
  private consume(chunk: Buffer): void {
    let offset = 0
    while (!this.closed && offset < chunk.length) {
      if (!this.payload) {
        const count = Math.min(4 - this.headerBytes, chunk.length - offset)
        chunk.copy(this.header, this.headerBytes, offset, offset + count)
        this.headerBytes += count; offset += count
        if (this.headerBytes !== 4) continue
        const size = this.header.readUInt32BE()
        if (size === 0 || size > this.maxFrame) { this.fail(new Error('Invalid leader frame length')); return }
        this.payload = Buffer.alloc(size); this.payloadBytes = 0
      }
      const count = Math.min(this.payload.length - this.payloadBytes, chunk.length - offset)
      chunk.copy(this.payload, this.payloadBytes, offset, offset + count)
      this.payloadBytes += count; offset += count
      if (this.payloadBytes !== this.payload.length) continue
      const payload = this.payload
      this.payload = undefined; this.headerBytes = 0
      try { this.receive(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload))) }
      catch { this.fail(new Error('Invalid native leader message')) }
    }
  }
  private receive(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid leader envelope')
    const message = value as Record<string, any>
    switch (message.type) {
      case 'registered':
        if (this.registered || message.leader_protocol_version !== 1 || message.leader_capabilities?.control_v1 !== true || typeof message.ready !== 'boolean') throw new Error('Unsupported leader registration')
        this.registered = true; this.leaderReady = message.ready
        this.send({ type: 'control', request_id: this.controlId, command: { type: 'get_leader_info' } })
        break
      case 'leader_ready':
        if (!this.registered) throw new Error('Unexpected ready marker')
        this.leaderReady = true
        break
      case 'control_result': {
        if (message.request_id !== this.controlId || this.verified) throw new Error('Unexpected leader control response')
        const info = message.result?.Ok
        // The PID is a comparison only, never something to adopt or signal.
        if (info?.type !== 'leader_info' || info.pid !== this.expectedPid || info.leader_protocol_version !== 1) {
          this.fail(new Error('Grok leader identity mismatch')); return
        }
        this.verified = true
        break
      }
      case 'acp':
        if (typeof message.payload !== 'string') throw new Error('Invalid ACP payload')
        if (!this.initialized) {
          this.bufferedBytes += Buffer.byteLength(message.payload)
          // Empty/tiny envelopes still consume array/string bookkeeping. A
          // byte budget alone admits an unbounded count while readiness stalls.
          if (this.buffered.length >= 64 || this.bufferedBytes > this.maxFrame) throw new Error('Excess early ACP traffic')
          this.buffered.push(message.payload)
        } else this.deliver(message.payload)
        break
      case 'pong': break
      case 'shutting_down':
      case 'shutdown':
      case 'error': this.fail(new Error('Native leader stopped')); return
      default: throw new Error('Unknown leader envelope')
    }
    if (!this.initialized && this.registered && this.verified && this.leaderReady) {
      this.initialized = true
      clearTimeout(this.timer)
      this.resolveReady()
      const buffered = this.buffered; this.buffered = []; this.bufferedBytes = 0
      for (const payload of buffered) this.deliver(payload)
    }
  }
  private deliver(payload: string): void {
    if (!this.incoming.write(payload + '\n')) this.socket.pause()
  }
}
