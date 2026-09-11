import { writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { GrokResponseObserver, type GrokStreamEvent } from '../proxy/GrokResponseObserver.js'

type CaptureRecord =
  | { kind: 'chunk'; flowId: string; timeMs: number; data: string }
  | { kind: 'end'; flowId: string; timeMs: number; interrupted: boolean }
type CaptureDocument = {
  version: 1
  provider: 'grok'
  privacy: 'private-provider-output'
  complete: boolean
  truncated: boolean
  reason: string | null
  records: CaptureRecord[]
}
const DEFAULT_BYTES = 8 * 1024 * 1024
const MAX_RECORDS = 32768
const flowPattern = /^(?!__proto__$|constructor$|prototype$)[A-Za-z0-9_-]{1,128}$/

// Package-owned evidence, not an Agent Code IPC recording. Opt-in raw SSE
// may contain private assistant/tool output: saving is explicit, mode 0600,
// and never certifies that a capture is safe to publish. Request bodies and
// HTTP headers cannot enter through this API.
export class ResponseCapture {
  private readonly records: CaptureRecord[] = []
  private readonly states = new Map<string, 'open' | 'ended'>()
  private readonly started = performance.now()
  private readonly maxBytes: number
  private readonly maxRecords: number
  private bytes = 512 // conservative budget for version/privacy/completion metadata
  private reason: string | null = null
  private interrupted = false

  constructor(options: { maxBytes?: number; maxRecords?: number } = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_BYTES
    this.maxRecords = options.maxRecords ?? MAX_RECORDS
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 512 ||
      !Number.isSafeInteger(this.maxRecords) || this.maxRecords < 1) throw new Error('Invalid capture budget')
  }

  write(flowId: string, chunk: Uint8Array): boolean {
    if (this.reason) return false
    // Check before base64 conversion so an oversized chunk cannot allocate a
    // second large copy merely to discover it is beyond the capture budget.
    if (Math.ceil(chunk.byteLength / 3) * 4 > this.maxBytes - this.bytes) { this.reason = 'byte-limit'; return false }
    return this.append({ kind: 'chunk', flowId, timeMs: performance.now() - this.started, data: Buffer.from(chunk).toString('base64') })
  }
  end(flowId: string, interrupted = false): boolean {
    return this.append({ kind: 'end', flowId, timeMs: performance.now() - this.started, interrupted })
  }
  private append(record: CaptureRecord): boolean {
    if (this.reason) return false
    if (!flowPattern.test(record.flowId) || this.states.get(record.flowId) === 'ended') { this.reason = 'invalid-flow-order'; return false }
    if (this.records.length >= this.maxRecords) { this.reason = 'record-limit'; return false }
    const bytes = Buffer.byteLength(JSON.stringify(record)) + 1
    if (this.bytes + bytes > this.maxBytes) { this.reason = 'byte-limit'; return false }
    this.bytes += bytes
    this.records.push(record)
    this.states.set(record.flowId, record.kind === 'end' ? 'ended' : 'open')
    if (record.kind === 'end' && record.interrupted) this.interrupted = true
    return true
  }

  serialize(): string {
    const document: CaptureDocument = {
      version: 1, provider: 'grok', privacy: 'private-provider-output',
      complete: this.states.size > 0 && !this.reason && !this.interrupted && [...this.states.values()].every(state => state === 'ended'),
      truncated: this.reason !== null, reason: this.reason, records: this.records,
    }
    return JSON.stringify(document)
  }
  save(path: string): Promise<void> {
    return writeFile(path, this.serialize(), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  }
}

export function replayResponseCapture(
  serialized: string,
  onEvent: (event: GrokStreamEvent) => void,
  options: { maxBytes?: number; maxRecords?: number; maxFrameBytes?: number } = {},
): { complete: boolean; truncated: boolean } {
  const maxBytes = options.maxBytes ?? DEFAULT_BYTES
  const maxRecords = options.maxRecords ?? MAX_RECORDS
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 512 || !Number.isSafeInteger(maxRecords) || maxRecords < 1 ||
    Buffer.byteLength(serialized) > maxBytes) throw new Error('Capture exceeds replay budget')
  let document: CaptureDocument
  try { document = JSON.parse(serialized) as CaptureDocument } catch { throw new Error('Invalid capture JSON') }
  if (!document || document.version !== 1 || document.provider !== 'grok' || document.privacy !== 'private-provider-output' ||
    typeof document.complete !== 'boolean' || typeof document.truncated !== 'boolean' ||
    !Array.isArray(document.records) || document.records.length > maxRecords) throw new Error('Invalid capture schema')
  if ((document.reason !== null && typeof document.reason !== 'string') ||
    document.truncated !== (document.reason !== null)) throw new Error('Invalid capture truncation claim')
  // Validate the whole imported recording before invoking any consumer. A
  // corrupt final record must not leave half a replay applied to caller state.
  const states = new Map<string, 'open' | 'ended'>()
  let interrupted = false
  for (const record of document.records) {
    if (!record || typeof record.flowId !== 'string' || !flowPattern.test(record.flowId) ||
      !Number.isFinite(record.timeMs) || record.timeMs < 0 || states.get(record.flowId) === 'ended') throw new Error('Invalid capture record')
    if (record.kind === 'chunk') {
      if (typeof record.data !== 'string' || record.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(record.data) ||
        Buffer.from(record.data, 'base64').toString('base64') !== record.data) throw new Error('Invalid capture bytes')
      states.set(record.flowId, 'open')
    } else if (record.kind === 'end' && typeof record.interrupted === 'boolean') {
      states.set(record.flowId, 'ended')
      interrupted ||= record.interrupted
    } else throw new Error('Invalid capture record kind')
  }
  const complete = states.size > 0 && !document.truncated && !interrupted && [...states.values()].every(state => state === 'ended')
  if (complete !== document.complete) throw new Error('Invalid capture completion claim')
  const observers = new Map<string, GrokResponseObserver>()
  for (const record of document.records) {
    let observer = observers.get(record.flowId)
    if (!observer) {
      observer = new GrokResponseObserver({ flowId: record.flowId, onEvent, maxFrameBytes: options.maxFrameBytes })
      observers.set(record.flowId, observer)
    }
    if (record.kind === 'chunk') observer.write(Buffer.from(record.data, 'base64'))
    else {
      observer.end()
      if (record.interrupted) {
        try { onEvent({ type: 'diagnostic', flowId: record.flowId, code: 'capture-interrupted' }) }
        catch { /* same consumer isolation as the live observer */ }
      }
      observers.delete(record.flowId)
    }
  }
  for (const observer of observers.values()) observer.end()
  return { complete, truncated: document.truncated }
}
