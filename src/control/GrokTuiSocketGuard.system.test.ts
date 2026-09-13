import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { once } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { GrokTuiSocketGuard, type GrokTuiGuardFault } from './GrokTuiSocketGuard.js'
import type { GrokTransportObserver, GrokTransportObservation } from './transportObservation.js'

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, rm: vi.fn(actual.rm) }
})

// Protocol-v1 envelopes are backed by the installed ACP proof; fragmentation,
// failure timing and hostile lengths below are explicit transport fault injection.
const frame = (value: unknown) => rawFrame(JSON.stringify(value))
function rawFrame(body: string) {
  const bytes = Buffer.from(body)
  const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length)
  return Buffer.concat([header, bytes])
}
const registration = { type: 'registered', client_id: 1, ready: true, leader_protocol_version: 1, leader_capabilities: { control_v1: true } }
const register = { type: 'register', client_type: 'fixture-tui', mode: 'stdio', capabilities: { yolo_mode: false } }
let root: string | undefined
let server: Server | undefined
let guard: GrokTuiSocketGuard | undefined
let client: Socket | undefined
const sockets = new Set<Socket>()
afterEach(async () => {
  await guard?.dispose(async () => { client?.destroy() }); guard = undefined
  client?.destroy(); client = undefined
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
  server = undefined
  if (root) await rm(root, { recursive: true, force: true })
})
function collect(socket: Socket, receive: (value: any, bytes: Buffer) => void) {
  let buffer = Buffer.alloc(0)
  socket.on('error', () => {})
  socket.on('data', bytes => {
    buffer = Buffer.concat([buffer, bytes])
    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE() + 4) {
      const length = buffer.readUInt32BE() + 4
      const next = buffer.subarray(0, length); buffer = buffer.subarray(length)
      let value: unknown
      try { value = JSON.parse(next.subarray(4).toString()) }
      catch { value = { type: 'invalid-fixture-packet' } }
      receive(value, next)
    }
  })
}
async function fixture(options: { pid?: number; silent?: boolean; maxFrameBytes?: number; maxQueuedBytes?: number; maxPendingFrames?: number;
  registration?: Record<string, unknown>; rawRegistration?: string; holdIdentity?: boolean; skipReady?: boolean; observer?: GrokTransportObserver } = {}) {
  root = await mkdtemp(join(tmpdir(), 'g-guard-test-'))
  let upstream: Socket | undefined
  let connects = 0
  const input: Buffer[] = []
  server = createServer(socket => {
    sockets.add(socket); upstream = socket; connects++
    collect(socket, (value, bytes) => {
      input.push(bytes)
      if (options.silent) return
      if (value.type === 'register') socket.write(options.rawRegistration ? rawFrame(options.rawRegistration) : frame(options.registration ?? registration))
      else if (value.type === 'control' && !options.holdIdentity) socket.write(frame({ type: 'control_result', request_id: value.request_id,
        result: { Ok: { type: 'leader_info', pid: options.pid ?? 123, leader_protocol_version: 1 } } }))
    })
  })
  const path = join(root, 'up.sock')
  server.listen(path); await once(server, 'listening')
  const faults: GrokTuiGuardFault[] = []
  guard = await GrokTuiSocketGuard.create({ upstreamPath: path, expectedPid: 123, onFault: reason => faults.push(reason),
    registrationTimeoutMs: options.silent ? 50 : 2000, maxFrameBytes: options.maxFrameBytes, maxQueuedBytes: options.maxQueuedBytes,
    maxPendingFrames: options.maxPendingFrames, onTransportObservation: options.observer })
  client = createConnection(guard.socketPath)
  const output: Buffer[] = []
  let ended = false
  client.on('end', () => { ended = true })
  collect(client, (_value, bytes) => output.push(bytes))
  await once(client, 'connect'); client.write(frame(register))
  if (!options.silent && options.pid !== 999 && !options.skipReady) await expect.poll(() => fReady()).toBe(true)
  function fReady() { return guard!.state === 'forwarding' && output.length === 1 }
  return { input, output, faults, upstream: () => upstream!, connects: () => connects, ended: () => ended }
}

it('verifies the owned upstream PID before forwarding registration, preserving healthy bytes exactly', async () => {
  const f = await fixture()
  expect(f.output).toEqual([frame(registration)])
  const nativeBytes = rawFrame('{ "type": "acp", "payload": "{\\\"n\\\":9007199254740993}" }')
  f.upstream().write(nativeBytes.subarray(0, 1)); f.upstream().write(nativeBytes.subarray(1, 3)); f.upstream().write(nativeBytes.subarray(3))
  await expect.poll(() => f.output.length).toBe(2)
  expect(f.output[1]).toEqual(nativeBytes)
  client!.write(nativeBytes)
  await expect.poll(() => f.input.at(-1)).toEqual(nativeBytes)
})

it('records received TUI bytes even after holding, without granting observers write authority', async () => {
  const events: GrokTransportObservation[] = []
  const f = await fixture({ observer: event => {
    events.push({ ...event, bytes: event.bytes ? Buffer.from(event.bytes) : undefined })
    event.bytes?.fill(0)
    throw new Error('controlled observer failure')
  } })
  expect(f.output).toEqual([frame(registration)])
  guard!.hold()
  const bytes = frame({ type: 'ping' })
  client!.write(bytes)
  await expect.poll(() => events.some(event => event.role === 'tui' && event.kind === 'received' && Buffer.from(event.bytes ?? []).equals(bytes))).toBe(true)
  expect(events.some(event => event.role === 'guard-upstream' && event.kind === 'received')).toBe(true)
  expect(guard!.state).toBe('holding')
})

it('suppresses fragmented shutdown and all trailing traffic while retaining the downstream connection', async () => {
  const f = await fixture()
  const shutdown = frame({ type: 'shutting_down', reason: 'manual', delay_ms: 0 })
  f.upstream().write(shutdown.subarray(0, 5))
  f.upstream().write(Buffer.concat([shutdown.subarray(5), frame({ type: 'shutdown' }), frame({ type: 'acp', payload: '{}' })]))
  await expect.poll(() => guard!.state).toBe('holding')
  expect(f.faults).toEqual(['upstream-closed'])
  expect(f.output).toEqual([frame(registration)])
  expect(f.ended()).toBe(false)
  expect(client!.destroyed).toBe(false)
  const before = f.input.length
  client!.write(frame({ type: 'acp', payload: '{"method":"session/prompt"}' }))
  await new Promise(resolve => setImmediate(resolve))
  expect(f.input).toHaveLength(before)
})

it('holds on upstream EOF without reconnecting and waits for explicit dependent-exit acknowledgement', async () => {
  const f = await fixture()
  f.upstream().end()
  await expect.poll(() => guard!.state).toBe('holding')
  let acknowledge!: () => void
  const exit = new Promise<void>(resolve => { acknowledge = resolve })
  const closing = guard!.dispose(() => exit)
  expect(guard!.dispose(() => exit)).toBe(closing)
  expect(guard!.state).toBe('holding')
  expect(f.ended()).toBe(false)
  expect(f.connects()).toBe(1)
  const directory = dirname(guard!.socketPath)
  acknowledge(); await closing
  expect(guard!.state).toBe('disposed')
  await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('never forwards a registration from a different PID and retains its listener when cleanup fails', async () => {
  const f = await fixture({ pid: 999 })
  await expect.poll(() => guard!.state).toBe('holding')
  expect(f.faults).toEqual(['identity'])
  expect(f.output).toEqual([])
  await expect(guard!.dispose(async () => { throw new Error('fixture still alive') })).rejects.toThrow('fixture still alive')
  expect((await stat(guard!.socketPath)).isSocket()).toBe(true)
  expect(client!.destroyed).toBe(false)
  await guard!.dispose(async () => { client!.destroy() })
})

it('rejects an oversized length before allocating or forwarding its payload', async () => {
  const f = await fixture({ maxFrameBytes: 1024 })
  const oversized = Buffer.alloc(4); oversized.writeUInt32BE(1025)
  f.upstream().write(oversized)
  await expect.poll(() => guard!.state).toBe('holding')
  expect(f.output).toHaveLength(1)
  expect(f.ended()).toBe(false)
})

it('holds a stalled registration and notifies its owner without sending a native fallback-triggering EOF', async () => {
  const f = await fixture({ silent: true })
  await expect.poll(() => guard!.state).toBe('holding')
  expect(f.faults).toEqual(['registration-timeout'])
  expect(f.output).toEqual([])
  expect(f.ended()).toBe(false)
})

it('does not forward an ACP envelope the native client cannot deserialize', async () => {
  const f = await fixture()
  f.upstream().write(frame({ type: 'acp', payload: 7 }))
  await expect.poll(() => guard!.state).toBe('holding')
  expect(f.faults).toEqual(['protocol'])
  expect(f.output).toHaveLength(1)
  expect(f.ended()).toBe(false)
})

it.each([
  '{"type":"acp","payload":"first","payload":"second"}',
  '{"type":"acp","payload":"\\ud800"}',
  '{"type":"control_result","request_id":"fixture","result":null}',
])('holds JSON that JavaScript accepts but the native envelope rejects: %s', async body => {
  const f = await fixture()
  f.upstream().write(rawFrame(body))
  await expect.poll(() => guard!.state).toBe('holding')
  expect(f.faults).toEqual(['protocol'])
  expect(f.output).toHaveLength(1)
  expect(f.ended()).toBe(false)
})

it('refuses registration without the native client identity', async () => {
  const f = await fixture({ registration: { ...registration, client_id: undefined }, skipReady: true })
  await expect.poll(() => guard!.state).toBe('holding')
  expect(f.faults).toEqual(['protocol'])
  expect(f.output).toEqual([])
})

it('resumes filesystem cleanup after a failure following successful socket release', async () => {
  await fixture()
  const directory = dirname(guard!.socketPath)
  vi.mocked(rm).mockRejectedValueOnce(new Error('fixture removal failure'))
  const acknowledge = vi.fn(async () => { client!.destroy() })
  await expect(guard!.dispose(acknowledge)).rejects.toThrow('fixture removal failure')
  await guard!.dispose(acknowledge)
  expect(acknowledge).toHaveBeenCalledOnce()
  await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('charges retained registration bytes while waiting for the identity response', async () => {
  const f = await fixture({ registration: { ...registration, padding: 'x'.repeat(1000) }, holdIdentity: true,
    maxFrameBytes: 2048, maxQueuedBytes: 512, skipReady: true })
  await expect.poll(() => guard!.state).toBe('holding')
  expect(f.faults).toEqual(['capacity'])
  expect(f.output).toEqual([])
})

it('bounds queued frame count independently of wire bytes', async () => {
  const f = await fixture({ maxPendingFrames: 8 })
  f.upstream().write(Buffer.concat(Array.from({ length: 32 }, () => frame({ type: 'pong' }))))
  await expect.poll(() => guard!.state).toBe('holding')
  expect(f.faults).toEqual(['capacity'])
})

it('reports an unexpected reconnect without creating another upstream connection', async () => {
  const f = await fixture()
  expect(guard!.connectionCount).toBe(1)
  const second = createConnection(guard!.socketPath)
  second.on('error', () => {})
  try {
    await once(second, 'connect')
    await expect.poll(() => guard!.state).toBe('holding')
    expect(guard!.connectionCount).toBe(2)
    expect(f.connects()).toBe(1)
    expect(f.faults).toEqual(['extra-client'])
  } finally { second.destroy() }
})

it.each([
  JSON.stringify(registration).replace('"client_id":1', '"client_id":1.0'),
  JSON.stringify(registration).replace('"leader_protocol_version":1', '"leader_protocol_version":1e0'),
  '\ufeff' + JSON.stringify(registration),
])('refuses incompatible registration wire syntax before forwarding: %s', async rawRegistration => {
  const f = await fixture({ rawRegistration, skipReady: true })
  await expect.poll(() => guard!.state).toBe('holding')
  expect(f.faults).toEqual(['protocol'])
  expect(f.output).toEqual([])
})
