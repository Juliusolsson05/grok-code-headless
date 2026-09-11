import { createServer, type Server, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { GrokLeaderConnection } from './GrokLeaderConnection.js'

let root: string | undefined
let server: Server | undefined
let connection: GrokLeaderConnection | undefined
const sockets = new Set<Socket>()
afterEach(async () => {
  connection?.close(); connection = undefined
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
  server = undefined
  if (root) await rm(root, { recursive: true, force: true })
})
const frame = (value: unknown) => {
  const payload = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4); header.writeUInt32BE(payload.length)
  return Buffer.concat([header, payload])
}
async function peer(onMessage: (value: any, socket: Socket) => void) {
  root = await mkdtemp(join(tmpdir(), 'g-ipc-'))
  const path = join(root, 's')
  server = createServer(socket => {
    sockets.add(socket)
    let buffer = Buffer.alloc(0)
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data])
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE()) {
        const size = buffer.readUInt32BE()
        const value = JSON.parse(buffer.subarray(4, 4 + size).toString())
        buffer = buffer.subarray(4 + size)
        onMessage(value, socket)
      }
    })
  })
  server.listen(path); await once(server, 'listening')
  return path
}
function register(socket: Socket, ready = true) {
  const bytes = frame({ type: 'registered', client_id: 1, ready, leader_protocol_version: 1, leader_binary_version: 'fixture', leader_capabilities: { control_v1: true } })
  socket.write(bytes.subarray(0, 2)); socket.write(bytes.subarray(2))
}
function identity(value: any, socket: Socket, pid = 123) {
  socket.write(frame({ type: 'control_result', request_id: value.request_id, result: { Ok: { type: 'leader_info', pid, leader_protocol_version: 1, leader_binary_version: 'fixture' } } }))
}

describe('native leader transport', () => {
  it('verifies registration/owned PID and routes RPC through the native length-framed envelope', async () => {
    const path = await peer((value, socket) => {
      if (value.type === 'register') { expect(value.mode).toBe('stdio'); register(socket) }
      else if (value.type === 'control') identity(value, socket)
      else if (value.type === 'acp') {
        const request = JSON.parse(value.payload)
        socket.write(frame({ type: 'acp', payload: JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { literal: request.params.text } }) }))
      }
    })
    connection = await GrokLeaderConnection.connect(path, 123)
    await expect(connection.rpc.request('fixture', { text: 'line one\n\tline two' })).resolves.toEqual({ literal: 'line one\n\tline two' })
  })

  it('does not authorize a different leader PID', async () => {
    const path = await peer((value, socket) => {
      if (value.type === 'register') register(socket)
      else if (value.type === 'control') identity(value, socket, 999)
    })
    await expect(GrokLeaderConnection.connect(path, 123)).rejects.toThrow('identity')
  })

  it('waits for leader-ready after a not-ready registration', async () => {
    let native: Socket | undefined
    let finishIdentity: (() => void) | undefined
    const receivedControl = new Promise<void>(resolve => { finishIdentity = resolve })
    const path = await peer((value, socket) => {
      if (value.type === 'register') { native = socket; register(socket, false) }
      else if (value.type === 'control') { identity(value, socket); finishIdentity!() }
    })
    let resolved = false
    const opening = GrokLeaderConnection.connect(path, 123).then(value => { resolved = true; return value })
    await receivedControl
    await new Promise(resolve => setImmediate(resolve))
    expect(resolved).toBe(false)
    native!.write(frame({ type: 'leader_ready' }))
    connection = await opening
  })

  it('treats shutdown as terminal and never reconnects or replays a prompt', async () => {
    let prompts = 0
    const path = await peer((value, socket) => {
      if (value.type === 'register') register(socket)
      else if (value.type === 'control') identity(value, socket)
      else if (value.type === 'acp') { prompts++; socket.write(frame({ type: 'shutting_down', reason: 'auto_update', delay_ms: 0 })) }
    })
    connection = await GrokLeaderConnection.connect(path, 123)
    await expect(connection.rpc.request('session/prompt', {})).rejects.toMatchObject({ uncertain: true })
    expect(connection.rpc.isClosed).toBe(true)
    expect(prompts).toBe(1)
  })
  it('bounds the number of pre-readiness ACP frames independently of their byte length', async () => {
    const path = await peer((value, socket) => {
      if (value.type === 'register') {
        register(socket, false)
        socket.write(Buffer.concat(Array.from({ length: 65 }, () => frame({ type: 'acp', payload: '' }))))
      }
    })
    await expect(GrokLeaderConnection.connect(path, 123, { connectTimeoutMs: 500 })).rejects.toThrow('Invalid native leader message')
  })
})
