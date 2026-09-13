import { createServer, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { RuntimeCapture } from './Capture.js'

export type FixtureTool = { name: string; description: string; inputSchema: Record<string, unknown>; reply(args: any): unknown | Promise<unknown> }
export type InferenceReply = { kind: 'text'; text: string } | { kind: 'tool'; name: string; arguments: Record<string, unknown>; callId?: string } |
  { kind: 'error'; status: number; message: string } | { kind: 'hold' }
export type InferenceHandler = (body: any, index: number) => InferenceReply

/** Stimulus server, not a Grok emulator. Tool schemas come from the actual
 * native inference request, and every supplied reply is tagged as scripted.
 * The recorder retains what native does with it; no scripted result is promoted
 * into evidence of autonomous model selection or model vision understanding. */
export class FixtureBackend {
  readonly requests: any[] = []
  readonly mcpCalls: Array<{ name: string; arguments: unknown }> = []
  handler: InferenceHandler = () => ({ kind: 'text', text: 'FIXTURE_REPLY' })
  private server!: Server
  private wire!: string
  private titleWire!: string
  private frames: any[] = []
  baseUrl = ''
  private requestId = 0
  private readonly activeResponses = new Set<ServerResponse>()
  private constructor(private readonly capture: RuntimeCapture, readonly tools: FixtureTool[]) {}
  static async create(capture: RuntimeCapture, tools: FixtureTool[]): Promise<FixtureBackend> {
    const backend = new FixtureBackend(capture, tools)
    backend.wire = await readFile(new URL('../../../testing/fixtures/streaming/native-papaya.sse', import.meta.url), 'utf8')
    backend.titleWire = await readFile(new URL('../../../testing/fixtures/sse.responses.txt', import.meta.url), 'utf8')
    backend.frames = backend.wire.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
    backend.server = createServer(async (request, response) => {
      const requestId = ++backend.requestId
      const path = request.url ?? ''
      const headers = Object.fromEntries(['x-grok-session-id', 'x-grok-turn-idx', 'x-grok-req-id', 'x-grok-client-version'].flatMap(name =>
        request.headers[name] === undefined ? [] : [[name, request.headers[name]]]))
      const chunks: Buffer[] = []
      let size = 0
      backend.activeResponses.add(response)
      capture.record('http', 'request-opened', { requestId, path, method: request.method })
      response.on('finish', () => capture.record('http', 'response-finished', { requestId }))
      response.on('close', () => {
        capture.record('http', 'response-closed', { requestId, finished: response.writableFinished })
        backend.activeResponses.delete(response)
      })
      try {
        for await (const chunk of request) {
          capture.record('http', 'request-chunk', { requestId }, chunk)
          size += chunk.length; if (size > 16 * 1024 * 1024) throw new Error('Request budget'); chunks.push(chunk)
        }
        const bytes = Buffer.concat(chunks)
        capture.record('http', 'request', { requestId, path, method: request.method, identityHeaders: headers, headerPolicy: 'credentials excluded' }, bytes)
        const send = (status: number, body: unknown, sse = false) => {
          const wire = sse ? String(body) : JSON.stringify(body)
          capture.record('http', 'scripted-response-attempt', { requestId, status, sse }, Buffer.from(wire))
          response.writeHead(status, { 'content-type': sse ? 'text/event-stream' : 'application/json' })
          response.end(wire)
        }
        if (path.startsWith('/v1/models')) {
          send(200, { data: [{ id: 'grok-4.6', model: 'grok-4.6', api_backend: 'responses', context_window: 500000 }] }); return
        }
        const body = bytes.length ? JSON.parse(bytes.toString()) : {}
        if (path === '/mcp') {
          if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
          if (request.headers.authorization !== 'Bearer fixture-only') { response.writeHead(401); response.end(); return }
          if (!('id' in body)) { response.writeHead(202); response.end(); return }
          let result: unknown
          switch (body.method) {
            case 'initialize': result = { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }; break
            case 'tools/list': result = { tools: tools.map(({ reply: _reply, ...tool }) => tool) }; break
            case 'tools/call': {
              const tool = tools.find(tool => tool.name === body.params.name)
              if (!tool) throw new Error('Unknown fixture tool')
              backend.mcpCalls.push({ name: tool.name, arguments: body.params.arguments })
              result = await tool.reply(body.params.arguments); break
            }
            case 'resources/list': result = { resources: [] }; break
            case 'prompts/list': result = { prompts: [] }; break
            case 'ping': result = {}; break
            default: send(200, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } }); return
          }
          send(200, { jsonrpc: '2.0', id: body.id, result }); return
        }
        if (path === '/v1/responses') {
          // This exact native discriminator is evidenced by the retained title
          // capture. Other requests stay unclassified; text equality is never
          // used to pretend sidecar traffic is the main turn.
          if (body.tool_choice?.name === 'session_title') { send(200, backend.titleWire, true); return }
          backend.requests.push(body)
          const reply = backend.handler(body, backend.requests.length - 1)
          capture.record('stimulus', 'inference-decision', { requestId, kind: reply.kind, name: reply.kind === 'tool' ? reply.name : undefined })
          if (reply.kind === 'error') { send(reply.status, { error: { message: reply.message, type: 'fixture_error' } }); return }
          if (reply.kind === 'hold') { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders(); return }
          if (reply.kind === 'tool' && !backend.advertisedToolNames(body).includes(reply.name)) {
            capture.record('coverage', 'unadvertised-tool', { requestId, name: reply.name })
            send(200, backend.textResponse('FIXTURE_UNADVERTISED_TOOL'), true); return
          }
          send(200, reply.kind === 'tool' ? backend.toolResponse(reply) : backend.textResponse(reply.text), true); return
        }
        send(503, { error: 'Fixture endpoint unavailable' })
      } catch {
        capture.record('http', 'fixture-handler-error', { requestId, path })
        if (!response.headersSent) response.writeHead(400)
        response.end()
      }
    })
    backend.server.listen(0, '127.0.0.1'); await once(backend.server, 'listening')
    const address = backend.server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture listener')
    backend.baseUrl = `http://127.0.0.1:${address.port}`
    return backend
  }
  advertisedToolNames(body: any): string[] { return (body.tools ?? []).map((tool: any) => tool.name ?? tool.function?.name).filter((name: unknown) => typeof name === 'string') }
  textResponse(text: string): string {
    const frames = structuredClone(this.frames)
    let firstDelta = true
    const replace = (value: any): any => {
      if (value === 'PAPAYA') return text
      if (Array.isArray(value)) return value.map(replace)
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child)]))
      return value
    }
    for (const frame of frames) if (frame.type === 'response.output_text.delta') { frame.delta = firstDelta ? text : ''; firstDelta = false }
    return this.serialize(frames.map(replace))
  }
  private toolResponse(reply: Extract<InferenceReply, { kind: 'tool' }>): string {
    const created = this.frames.find(frame => frame.type === 'response.created').response
    const completed = this.frames.find(frame => frame.type === 'response.completed').response
    const call = { type: 'function_call', id: `fc_${randomUUID()}`, call_id: reply.callId ?? `call_${randomUUID()}`,
      name: reply.name, arguments: JSON.stringify(reply.arguments), status: 'completed' }
    const middle = Math.floor(call.arguments.length / 2)
    return this.serialize([
      { type: 'response.created', response: created },
      { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '', status: 'in_progress' } },
      ...[call.arguments.slice(0, middle), call.arguments.slice(middle)].map(delta => ({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: call.id, delta })),
      { type: 'response.function_call_arguments.done', output_index: 0, item_id: call.id, arguments: call.arguments },
      { type: 'response.output_item.done', output_index: 0, item: call },
      { type: 'response.completed', response: { ...completed, output: [call] } },
    ])
  }
  private serialize(frames: any[]): string {
    const oldId = this.frames.find(frame => frame.type === 'response.created').response.id
    const id = randomUUID()
    return frames.map((frame, sequence_number) => `event: ${frame.type}\ndata: ${JSON.stringify({ ...frame, sequence_number }).replaceAll(oldId, id)}\n\n`).join('')
  }
  async close() {
    this.server.closeAllConnections()
    await new Promise<void>(resolve => this.server.close(() => resolve()))
    // Response close callbacks can follow listener closure. Seal the recorder
    // only after these known producers have actually finished reporting.
    const deadline = Date.now() + 5000
    while (this.activeResponses.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    if (this.activeResponses.size) throw new Error('Fixture HTTP observation did not drain')
  }
}
