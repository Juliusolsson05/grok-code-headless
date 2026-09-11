import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GrokAcpClient, type GrokAcpServerRequest } from './GrokAcpClient.js'

const clients: GrokAcpClient[] = []
afterEach(() => { for (const client of clients.splice(0)) client.close(); vi.useRealTimers() })
function harness(options: ConstructorParameters<typeof GrokAcpClient>[2] = {}) {
  const incoming = new PassThrough()
  const outgoing = new PassThrough()
  const sent: Record<string, any>[] = []
  outgoing.on('data', chunk => sent.push(JSON.parse(chunk.toString())))
  const client = new GrokAcpClient(incoming, outgoing, options)
  clients.push(client)
  return { incoming, outgoing, sent, client, reply: (value: unknown) => incoming.write(JSON.stringify(value) + '\n') }
}

describe('production ACP RPC boundary', () => {
  it('preserves literal text and correlates concurrent replies without unwrapping native extension results', async () => {
    const h = harness()
    const first = h.client.request('session/prompt', { prompt: [{ type: 'text', text: 'line one\n\tline two' }] })
    const second = h.client.request('_x.ai/mcp/list', { sessionId: 'fixture' })
    expect(h.sent[0].params.prompt[0].text).toBe('line one\n\tline two')
    h.reply({ jsonrpc: '2.0', id: h.sent[1].id, result: { result: { servers: [] } } })
    h.reply({ jsonrpc: '2.0', id: h.sent[0].id, result: { stopReason: 'end_turn' } })
    await expect(first).resolves.toEqual({ stopReason: 'end_turn' })
    await expect(second).resolves.toEqual({ result: { servers: [] } })
  })

  it('decodes split UTF-8 and multiple frames without treating a chunk boundary as a message boundary', async () => {
    const notifications: unknown[] = []
    const h = harness({ onNotification: value => notifications.push(value) })
    const bytes = Buffer.from('{"jsonrpc":"2.0","method":"session/update","params":{"text":"héllo"}}\n')
    const split = bytes.indexOf(Buffer.from('é')) + 1
    h.incoming.write(bytes.subarray(0, split))
    expect(notifications).toEqual([])
    h.incoming.write(Buffer.concat([bytes.subarray(split), bytes]))
    expect(notifications).toHaveLength(2)
    expect(notifications[0]).toMatchObject({ params: { text: 'héllo' } })
  })

  it('surfaces reverse requests without auto-answering and fences responses with a one-use token', async () => {
    const requests: GrokAcpServerRequest[] = []
    const h = harness({ onRequest: request => requests.push(request) })
    h.reply({ jsonrpc: '2.0', id: 7, method: 'session/request_permission', params: { sessionId: 'fixture' } })
    expect(h.sent).toEqual([])
    await h.client.respond(requests[0].token, { outcome: { outcome: 'cancelled' } })
    expect(h.sent[0]).toMatchObject({ id: 7, result: { outcome: { outcome: 'cancelled' } } })
    await expect(h.client.respond(requests[0].token, {})).rejects.toMatchObject({ code: 'stale-request', uncertain: false })
    h.reply({ jsonrpc: '2.0', id: 7, method: 'session/request_permission', params: {} })
    expect(requests[1].token).not.toBe(requests[0].token)
  })

  it('rejects outstanding work on close and never replays it', async () => {
    const h = harness()
    const result = h.client.request('session/prompt', {}).catch(error => error)
    h.incoming.end()
    expect(await result).toMatchObject({ code: 'closed', uncertain: true })
    await expect(h.client.request('session/prompt', {})).rejects.toMatchObject({ code: 'closed', uncertain: false })
    expect(h.sent).toHaveLength(1)
  })

  it('bounds individual frames and pending requests before writing', async () => {
    const h = harness({ maxFrameBytes: 256, maxPendingRequests: 1 })
    await expect(h.client.request('session/prompt', { text: 'x'.repeat(300) })).rejects.toMatchObject({ code: 'capacity', uncertain: false })
    expect(h.sent).toEqual([])
    const first = h.client.request('one', {}).catch(error => error)
    await expect(h.client.request('two', {})).rejects.toMatchObject({ code: 'capacity', uncertain: false })
    h.client.close()
    await first
  })

  it('fails malformed input without copying private payloads into errors', async () => {
    const h = harness()
    const pending = h.client.request('one', {}).catch(error => error)
    h.incoming.write('PRIVATE_FIXTURE_BAD_JSON\n')
    const error = await pending
    expect(error).toMatchObject({ code: 'protocol', uncertain: true })
    expect((error as Error).message).not.toContain('PRIVATE')
  })

  it('reports remote failure codes without retaining native error data', async () => {
    const h = harness()
    const pending = h.client.request('one', {}).catch(error => error)
    h.reply({ jsonrpc: '2.0', id: h.sent[0].id, error: { code: -32603, message: 'PRIVATE', data: { secret: 'PRIVATE' } } })
    const error = await pending
    expect(error).toMatchObject({ code: 'remote', rpcCode: -32603 })
    expect((error as Error).message).not.toContain('PRIVATE')
  })

  it('distinguishes pre-write abort from uncertain cancellation after submission', async () => {
    const h = harness()
    const before = new AbortController(); before.abort()
    await expect(h.client.request('one', {}, { signal: before.signal })).rejects.toMatchObject({ code: 'aborted', uncertain: false })
    expect(h.sent).toEqual([])
    const after = new AbortController()
    const pending = h.client.request('one', {}, { signal: after.signal }).catch(error => error)
    after.abort()
    expect(await pending).toMatchObject({ code: 'aborted', uncertain: true })
    expect(h.sent).toHaveLength(1)
  })

  it('settles timed-out requests without retrying or closing unrelated work', async () => {
    const h = harness()
    await expect(h.client.request('one', {}, { timeoutMs: 10 })).rejects.toMatchObject({ code: 'timeout', uncertain: true })
    expect(h.client.isClosed).toBe(false)
    expect(h.sent).toHaveLength(1)
  })

  it('bounds outgoing backpressure and settles write receipts on closure', async () => {
    const incoming = new PassThrough()
    const outgoing = new Writable({ write(_chunk, _encoding, _callback) { /* deliberately stalled transport */ } })
    const client = new GrokAcpClient(incoming, outgoing, { maxQueuedBytes: 180 })
    clients.push(client)
    const first = client.notify('fixture', { text: 'x'.repeat(80) }).catch(error => error)
    await expect(client.notify('fixture', { text: 'x'.repeat(80) })).rejects.toMatchObject({ code: 'capacity', uncertain: false })
    client.close()
    expect(await first).toMatchObject({ code: 'closed', uncertain: true })
  })
  it('can await a long native turn without inventing a completion deadline', async () => {
    vi.useFakeTimers()
    const h = harness()
    let settled = false
    const pending = h.client.request('session/prompt', {}, { timeoutMs: null }).catch(error => error).finally(() => { settled = true })
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(settled).toBe(false)
    h.reply({ jsonrpc: '2.0', id: h.sent[0].id, result: { stopReason: 'end_turn' } })
    await expect(pending).resolves.toEqual({ stopReason: 'end_turn' })
  })
  it('rejects overflowing Node deadlines before submitting any work', async () => {
    const h = harness()
    await expect(h.client.request('fixture', {}, { timeoutMs: 2 ** 31 })).rejects.toThrow('deadline')
    expect(h.sent).toEqual([])
  })
})
