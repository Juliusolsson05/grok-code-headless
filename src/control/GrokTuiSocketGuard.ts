import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { validateDeadlineMs } from './deadline.js'
import { parseLeaderEnvelope as envelope, validLeaderRegistration, validLeaderControlResult } from './GrokLeaderEnvelope.js'

export type GrokTuiGuardFault = 'owner-stopped' | 'upstream-closed' | 'protocol' | 'capacity' | 'identity' | 'registration-timeout' | 'extra-client'
export interface GrokTuiSocketGuardOptions {
  upstreamPath: string
  expectedPid: number
  onFault(reason: GrokTuiGuardFault): void
  registrationTimeoutMs?: number
  maxFrameBytes?: number
  maxQueuedBytes?: number
  maxPendingFrames?: number
}
export class GrokTuiSocketGuard {
  readonly socketPath: string
  private phase: 'waiting' | 'forwarding' | 'holding' | 'disposed' = 'waiting'
  private readonly server: Server
  private readonly clients = new Set<Socket>()
  private acceptedConnections = 0
  private upstream: Socket | undefined
  private downstream: Socket | undefined
  private readers: LeaderFrames[] = []
  private readonly identityRequest = randomUUID()
  private registered: Buffer | undefined
  private readyMarker: Buffer | undefined
  private ready = false
  private verified = false
  private registerSent = false
  private registrationSeen = false
  private early: Buffer[] = []
  private earlyBytes = 0
  private queuedBytes = 0
  private queuedFrames = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposal: Promise<void> | undefined
  private released = false
  private release: Promise<void> | undefined
  private readonly maxFrame: number
  private readonly maxQueued: number

  private constructor(private readonly options: GrokTuiSocketGuardOptions, private readonly directory: string) {
    this.socketPath = join(directory, 'view.sock')
    this.maxFrame = options.maxFrameBytes ?? 64 * 1024 * 1024
    this.maxQueued = options.maxQueuedBytes ?? this.maxFrame + 4
    this.server = createServer({ allowHalfOpen: true }, socket => this.accept(socket))
    // One expected viewer; a small hard socket cap also bounds unexpected local
    // clients while fault handling asks the host to terminate its owned TUI.
    this.server.maxConnections = 8
    this.server.on('error', () => this.hold('protocol'))
  }
  get state() { return this.phase }
  /** Lifetime count, not current socket count: a closed retry must remain observable. */
  get connectionCount() { return this.acceptedConnections }
  static async create(options: GrokTuiSocketGuardOptions): Promise<GrokTuiSocketGuard> {
    if (!options.upstreamPath || !Number.isSafeInteger(options.expectedPid) || options.expectedPid <= 0) throw new Error('Owned leader path and PID required')
    validateDeadlineMs(options.registrationTimeoutMs ?? 2000)
    for (const value of [options.maxFrameBytes ?? 64 * 1024 * 1024, options.maxQueuedBytes ?? 64 * 1024 * 1024 + 4, options.maxPendingFrames ?? 1024]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid guard capacity')
    }
    if ((options.maxFrameBytes ?? 0) > 64 * 1024 * 1024) throw new Error('Native frame limit exceeded')
    const directory = await mkdtemp(join(tmpdir(), 'g-view-'))
    const guard = new GrokTuiSocketGuard(options, directory)
    try {
      if (Buffer.byteLength(guard.socketPath) >= 104) throw new Error('Private TUI socket path is too long')
      await new Promise<void>((resolve, reject) => {
        const fail = (error: Error) => reject(error)
        guard.server.once('error', fail)
        guard.server.listen(guard.socketPath, () => { guard.server.off('error', fail); resolve() })
      })
      return guard
    } catch (error) {
      guard.server.close()
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  }
  hold(reason: GrokTuiGuardFault = 'owner-stopped'): void {
    if (this.phase === 'holding' || this.phase === 'disposed') return
    // This latch MUST precede every callback or upstream destroy: either can
    // re-enter disposal. Do not send shutdown/EOF downstream. Native interprets
    // those as an instruction to reconnect_or_spawn, even on graceful shutdown.
    this.phase = 'holding'
    clearTimeout(this.timer)
    for (const reader of this.readers) reader.stop()
    this.readers = []; this.early = []; this.earlyBytes = 0
    this.registered = undefined; this.readyMarker = undefined
    this.upstream?.destroy()
    try { this.options.onFault(reason) } catch { /* a throwing observer cannot reopen forwarding */ }
  }
  dispose(acknowledgeTuiExit: () => Promise<void>): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposal = Promise.resolve().then(async () => {
      // A signal receipt is not exit acknowledgement. Keep the listener and
      // downstream halves alive if dependent cleanup rejects; the host may
      // explicitly retry after it can establish that its TUI really exited.
      if (!this.released) { await acknowledgeTuiExit(); this.released = true }
      this.release ??= new Promise<void>((resolve, reject) => {
        this.server.close(error => error ? reject(error) : resolve())
        for (const socket of this.clients) socket.destroy()
      })
      await this.release
      await rm(this.directory, { recursive: true, force: true })
      this.phase = 'disposed'
    }).catch(error => { this.disposal = undefined; throw error })
    this.hold()
    return this.disposal
  }
  private accept(socket: Socket): void {
    this.acceptedConnections++
    if (this.released) { socket.destroy(); return }
    this.clients.add(socket)
    socket.on('error', () => this.hold('owner-stopped'))
    socket.on('end', () => this.hold('owner-stopped'))
    socket.on('close', () => { this.clients.delete(socket); this.hold('owner-stopped') })
    if (this.downstream || this.phase !== 'waiting') {
      socket.on('data', () => { /* drain without buffering/replaying */ })
      this.hold('extra-client')
      return
    }
    this.downstream = socket
    const upstream = createConnection(this.options.upstreamPath)
    this.upstream = upstream
    upstream.on('error', () => this.hold('upstream-closed'))
    upstream.on('end', () => this.hold('upstream-closed'))
    upstream.on('close', () => this.hold('upstream-closed'))
    const input = new LeaderFrames(this.maxFrame, bytes => this.fromTui(bytes))
    const output = new LeaderFrames(this.maxFrame, bytes => this.fromLeader(bytes))
    this.readers.push(input, output)
    socket.on('data', bytes => { try { input.write(bytes) } catch { this.hold('protocol') } })
    upstream.on('data', bytes => { try { output.write(bytes) } catch { this.hold('protocol') } })
    this.timer = setTimeout(() => this.hold('registration-timeout'), this.options.registrationTimeoutMs ?? 2000)
  }
  private fromTui(bytes: Buffer): void {
    const value = envelope(bytes)
    if (value.type === 'acp' && typeof value.payload !== 'string') throw new Error('Invalid ACP envelope')
    if (!this.registerSent) {
      if (value.type !== 'register' || !['stdio', 'headless'].includes(value.mode) || typeof value.client_type !== 'string') throw new Error('Expected registration')
      this.registerSent = true
    } else if (this.phase !== 'forwarding' || !['acp', 'ping', 'control', 'disconnect'].includes(value.type)) {
      throw new Error('Unexpected native client message')
    }
    this.send(this.upstream!, bytes)
  }
  private fromLeader(bytes: Buffer): void {
    const value = envelope(bytes)
    // Native deserialization failure also triggers reconnect. A syntactically
    // valid JSON object with a non-string ACP payload is not a valid envelope.
    if (value.type === 'acp' && typeof value.payload !== 'string') throw new Error('Invalid ACP envelope')
    if (['shutdown', 'shutting_down', 'error'].includes(value.type)) { this.hold('upstream-closed'); return }
    if (value.type === 'registered') {
      if (!this.registerSent || this.registrationSeen || !validLeaderRegistration(value)) throw new Error('Unsupported registration')
      if (!this.hasCapacity(bytes)) return
      this.registrationSeen = true
      this.registered = bytes; this.ready = value.ready
      this.send(this.upstream!, encode({ type: 'control', request_id: this.identityRequest, command: { type: 'get_leader_info' } }))
    } else if (value.type === 'control_result' && value.request_id === this.identityRequest) {
      const identity = value.result?.Ok
      if (!this.registrationSeen || this.verified || identity?.type !== 'leader_info' || identity.pid !== this.options.expectedPid || identity.leader_protocol_version !== 1) {
        this.hold('identity'); return
      }
      this.verified = true
    } else if (value.type === 'leader_ready' && this.phase === 'waiting') {
      if (!this.registered || this.readyMarker) throw new Error('Unexpected readiness')
      if (!this.hasCapacity(bytes)) return
      this.ready = true; this.readyMarker = bytes
    } else {
      if (!['acp', 'pong', 'control_result', 'leader_ready'].includes(value.type)) throw new Error('Unknown native message')
      if (value.type === 'control_result' && !validLeaderControlResult(value)) throw new Error('Invalid native control result')
      if (this.phase === 'forwarding') this.send(this.downstream!, bytes)
      else {
        if (this.early.length >= 64 || !this.hasCapacity(bytes)) { this.hold('capacity'); return }
        this.early.push(bytes); this.earlyBytes += bytes.length
      }
    }
    if (this.phase === 'waiting' && this.registered && this.ready && this.verified) {
      this.phase = 'forwarding'
      clearTimeout(this.timer)
      // Transfer retained packets into the write budget instead of counting
      // them twice or omitting them from accounting during admission.
      const registration = this.registered; this.registered = undefined
      this.send(this.downstream!, registration)
      const ready = this.readyMarker; this.readyMarker = undefined
      if (ready) this.send(this.downstream!, ready)
      while (this.early.length) {
        const message = this.early.shift()!
        this.earlyBytes -= message.length
        this.send(this.downstream!, message)
      }
    }
  }
  private send(socket: Socket, bytes: Buffer): void {
    if (this.phase === 'holding' || this.phase === 'disposed') return
    if (!this.hasCapacity(bytes)) return
    this.queuedBytes += bytes.length; this.queuedFrames++
    // Count pending write receipts in both directions. Never allow a stalled
    // native peer to turn forwarding into an unbounded replay queue.
    socket.write(bytes, error => {
      this.queuedBytes -= bytes.length; this.queuedFrames--
      if (error) this.hold('upstream-closed')
    })
  }
  private hasCapacity(bytes: Buffer): boolean {
    const held = this.earlyBytes + (this.registered?.length ?? 0) + (this.readyMarker?.length ?? 0)
    const frames = this.queuedFrames + this.early.length + Number(!!this.registered) + Number(!!this.readyMarker)
    if (this.queuedBytes + held + bytes.length > this.maxQueued || frames >= (this.options.maxPendingFrames ?? 1024)) {
      this.hold('capacity'); return false
    }
    return true
  }
}

function encode(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4); header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

/** Buffer ONE complete native envelope before inspection. A blind pipe leaks a
 * shutdown frame before the owner can react; reserialization loses raw numeric
 * precision. Keep the original bytes and inspect only the routing envelope. */
class LeaderFrames {
  private readonly header = Buffer.alloc(4)
  private headerBytes = 0
  private packet: Buffer | undefined
  private packetBytes = 0
  private stopped = false
  constructor(private readonly limit: number, private readonly receive: (bytes: Buffer) => void) {}
  stop() { this.stopped = true; this.packet = undefined; this.headerBytes = 0 }
  write(bytes: Buffer) {
    let offset = 0
    while (!this.stopped && offset < bytes.length) {
      if (!this.packet) {
        const count = Math.min(4 - this.headerBytes, bytes.length - offset)
        bytes.copy(this.header, this.headerBytes, offset, offset + count)
        offset += count; this.headerBytes += count
        if (this.headerBytes !== 4) continue
        const length = this.header.readUInt32BE()
        if (length === 0 || length > this.limit) throw new Error('Invalid native frame length')
        this.packet = Buffer.allocUnsafe(length + 4)
        this.header.copy(this.packet); this.packetBytes = 4
      }
      const count = Math.min(this.packet.length - this.packetBytes, bytes.length - offset)
      bytes.copy(this.packet, this.packetBytes, offset, offset + count)
      offset += count; this.packetBytes += count
      if (this.packetBytes !== this.packet.length) continue
      const packet = this.packet
      this.packet = undefined; this.headerBytes = 0
      this.receive(packet)
    }
  }
}
