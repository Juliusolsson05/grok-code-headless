// Stage-1 instrumentation, not a production control client. Own every process
// created here; never discover/kill a PID from a user's global leader lock.
// Typed ACP text bypasses the TUI paste/desktop-clipboard path entirely.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { HeadlessTerminal } from '../src/terminal/HeadlessTerminal.js'

if (process.env.GROK_ACP_PROBE !== '1') throw new Error('Set GROK_ACP_PROBE=1 for isolated native protocol verification')
const binary = process.env.GROK_BINARY ?? join(homedir(), '.local', 'bin', 'grok')
const root = await mkdtemp(join(tmpdir(), 'g-acp-'))
const home = join(root, 'home')
const socket = join(root, 'l.sock')
await mkdir(home)
await writeFile(join(home, 'config.toml'), '[cli]\nauto_update = false\n[ui]\npermission_mode = "ask"\n')
const wire = await readFile(new URL('../testing/fixtures/streaming/native-papaya.sse', import.meta.url), 'utf8')
const firstText = 'Fixture text only.\n\tKeep literal spacing.'
const secondText = 'Second fixture message.\n\tKeep literal spacing.'
const permissionText = 'Request the controlled permission fixture.'
const responseFrames = wire.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
const createdResponse = responseFrames.find(frame => frame.type === 'response.created').response
const completedResponse = responseFrames.find(frame => frame.type === 'response.completed').response
const toolCall = { id: 'fc_acp_fixture', call_id: 'call_acp_fixture', type: 'function_call', name: 'run_terminal_command',
  arguments: JSON.stringify({ command: 'rm -rf ./permission-probe', description: 'Remove only the controlled fixture directory' }), status: 'completed' }
const toolWire = [
  { type: 'response.created', response: createdResponse },
  { type: 'response.output_item.added', output_index: 0, item: { ...toolCall, arguments: '', status: 'in_progress' } },
  { type: 'response.function_call_arguments.delta', output_index: 0, item_id: toolCall.id, delta: toolCall.arguments },
  { type: 'response.function_call_arguments.done', output_index: 0, item_id: toolCall.id, arguments: toolCall.arguments },
  { type: 'response.output_item.done', output_index: 0, item: toolCall },
  { type: 'response.completed', response: { ...completedResponse, output: [toolCall] } },
].map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join('')
let permissionToolSent = false
const evidence = { version: '', initialized: false, created: false, exactBackendText: false, exactUserEcho: false,
  unexpectedImages: 0, mcpRequests: 0, mcpCalls: 0, mcpToolAdvertised: false, searchToolAdvertised: false, tuiSawReplay: false, tuiSawLive: false,
  methods: [] as string[], serverRequests: [] as string[], notifications: {} as Record<string, number>, echoContainsText: false,
  rpcErrorCategories: [] as string[], mcpStates: [] as unknown[], mcpMethods: [] as string[],
  tuiSawPermission: false, permissionCancelled: false, mcpIsolated: false }
const server = createServer(async (request, response) => {
  if (request.url === '/mcp' && request.method !== 'POST') {
    // Stateless Streamable HTTP explicitly declines the optional GET stream.
    response.writeHead(405, { allow: 'POST' }); response.end(); return
  }
  if (request.url?.startsWith('/v1/models')) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'grok-4.6', model: 'grok-4.6', api_backend: 'responses', context_window: 500000 }] }))
    return
  }
  try {
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of request) { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw new Error('Probe request too large'); chunks.push(chunk) }
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    if (request.url === '/mcp') {
      if (request.headers.authorization !== 'Bearer fixture-only') { response.writeHead(401); response.end(); return }
      evidence.mcpRequests++
      if (typeof body.method === 'string') evidence.mcpMethods.push(body.method)
      if (body.method === 'tools/call') evidence.mcpCalls++
      if (!('id' in body)) { response.writeHead(202); response.end(); return }
      if (!['initialize', 'tools/list', 'tools/call', 'resources/list', 'prompts/list', 'ping'].includes(body.method)) {
        // In particular, do not pretend to implement Grok's server/discover
        // gateway extension by returning a successful but empty object.
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } }))
        return
      }
      const result = body.method === 'initialize'
        ? { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture-mcp', version: '1' } }
        : body.method === 'tools/list' ? { tools: [{ name: 'fixture_echo', description: 'Fixture-only echo', inputSchema: { type: 'object', properties: {} } }] }
        : body.method === 'tools/call' ? { content: [{ type: 'text', text: 'fixture-mcp-ok' }], isError: false }
        : body.method === 'resources/list' ? { resources: [] }
        : body.method === 'prompts/list' ? { prompts: [] } : {}
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })); return
    }
    if (request.url === '/v1/responses') {
      const texts: string[] = []
      const inspect = (value: unknown) => {
        if (typeof value === 'string') texts.push(value)
        else if (Array.isArray(value)) value.forEach(inspect)
        else if (value && typeof value === 'object') {
          const record = value as Record<string, unknown>
          if (['image', 'input_image', 'image_url', 'resource'].includes(String(record.type))) evidence.unexpectedImages++
          Object.values(record).forEach(inspect)
        }
      }
      inspect(body.input)
      if (evidence.unexpectedImages) throw new Error('Unexpected non-text input')
      evidence.exactBackendText ||= texts.some(text => text.includes(firstText))
      const inspectTools = (value: any) => {
        if (Array.isArray(value)) value.forEach(inspectTools)
        else if (value && typeof value === 'object') {
          if (typeof value.name === 'string') {
            evidence.mcpToolAdvertised ||= value.name.includes('fixture_echo')
            evidence.searchToolAdvertised ||= value.name.includes('search_tool')
          }
          Object.values(value).forEach(inspectTools)
        }
      }
      inspectTools(body.tools)
      if (texts.some(text => text.includes(permissionText))) {
        const reply = permissionToolSent ? wire : toolWire
        permissionToolSent = true
        response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(reply); return
      }
      const reply = texts.some(text => text.includes(secondText))
        ? wire.replaceAll('PAPAYA', 'CHERRY').replaceAll('"delta":"PAP"', '"delta":"CHE"').replaceAll('"delta":"AYA"', '"delta":"RRY"') : wire
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(reply); return
    }
    response.writeHead(503); response.end('Probe endpoint unavailable')
  } catch { response.writeHead(400); response.end('Probe request refused') }
})

const children: ChildProcess[] = []
let processFailure = false
let viewer: import('node-pty').IPty | undefined
let viewerExited = false
let permissionRequest: any
let terminal: HeadlessTerminal | undefined
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
const waitUntil = async (predicate: () => boolean, label: string, timeout = 20000) => {
  const deadline = Date.now() + timeout
  while (!predicate() && Date.now() < deadline) {
    if (processFailure) throw new Error('Native probe process failed')
    await delay(50)
  }
  if (!predicate()) throw new Error(`Probe timeout: ${label}`)
}
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing probe address')
  const base = `http://127.0.0.1:${address.port}/v1`
  const env = { PATH: process.env.PATH, HOME: root, USER: 'fixture', LOGNAME: 'fixture', GROK_HOME: home,
    XDG_CONFIG_HOME: join(root, '.config'), XAI_API_KEY: 'fixture-only-not-a-real-key',
    GROK_MODELS_BASE_URL: base, GROK_XAI_API_BASE_URL: base, GROK_CLI_CHAT_PROXY_BASE_URL: base,
    GROK_CONTEXTUAL_HINTS: '0', GROK_PROMPT_SUGGESTIONS: '0', OTEL_TRACES_EXPORTER: 'none', OTEL_METRICS_EXPORTER: 'none' }
  evidence.version = execFileSync(binary, ['--version'], { env, encoding: 'utf8' }).trim()
  const leader = spawn(binary, ['agent', '--model', 'grok-4.6', 'leader', '--leader-socket', socket, '--relay-on-demand', '--no-exit-on-disconnect', '--no-auto-update', '--grok-ws-url', `ws://127.0.0.1:${address.port}/disabled`, '--grok-ws-origin', `http://127.0.0.1:${address.port}`], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] })
  children.push(leader)
  leader.on('error', () => { processFailure = true })
  leader.stderr!.resume()
  let socketReady = false
  await waitUntil(() => {
    if (!socketReady) {
      const probe = createConnection(socket)
      probe.once('connect', () => { socketReady = true; probe.destroy() })
      probe.once('error', () => probe.destroy())
    }
    return socketReady
  }, 'leader socket')
  const client = spawn(binary, ['agent', '--leader', '--model', 'grok-4.6', 'stdio', '--leader-socket', socket], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] })
  children.push(client)
  client.on('error', () => { processFailure = true })
  client.stdin!.on('error', () => { processFailure = true })
  client.stdout!.on('error', () => { processFailure = true })
  client.stderr!.resume()
  let buffer = ''
  client.stdout!.setEncoding('utf8')
  client.stdout!.on('data', (text: string) => {
    buffer += text
    if (buffer.length > 4 * 1024 * 1024) { client.kill(); return }
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
      if (!line.trim()) continue
      let value: any
      try { value = JSON.parse(line) } catch { client.kill(); continue }
      if (!value || typeof value !== 'object' || Array.isArray(value)) { client.kill(); continue }
      if ('id' in value && ('result' in value || 'error' in value)) {
        const waiter = pending.get(value.id)
        if (!waiter) continue
        clearTimeout(waiter.timer); pending.delete(value.id)
        if (value.error) {
          const detail = JSON.stringify(value.error)
          evidence.rpcErrorCategories.push(['not found', 'timed out', 'unauthorized', 'parse', 'invalid', 'connection'].filter(kind => detail.toLowerCase().includes(kind)).join(',') || 'other')
          waiter.reject(new Error(`Native RPC failed (${value.error.code})`))
        } else waiter.resolve(value.result)
      } else if ('id' in value && typeof value.method === 'string') {
        evidence.serverRequests.push(value.method)
        if (value.method === 'session/request_permission') { permissionRequest = value; continue }
        const reply = value.method === 'session/request_permission'
          ? { result: { outcome: { outcome: 'cancelled' } } }
          : { error: { code: -32601, message: 'Unsupported probe request' } }
        client.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: value.id, ...reply }) + '\n')
      } else {
        if (typeof value.method === 'string') evidence.notifications[value.method] = (evidence.notifications[value.method] ?? 0) + 1
        const params = value.params?.method && value.params?.params ? value.params.params : value.params
        const update = params?.update
        if (update?.sessionUpdate === 'user_message_chunk' && update.content?.type === 'text' && update.content.text === firstText) evidence.exactUserEcho = true
        if (update?.sessionUpdate === 'user_message_chunk' && typeof update.content?.text === 'string' && update.content.text.includes(firstText)) evidence.echoContainsText = true
      }
    }
  })
  client.once('close', () => { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Native ACP client closed')) }; pending.clear() })
  let nextId = 0
  const rpc = (method: string, params: unknown): Promise<any> => {
    evidence.methods.push(method)
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native RPC timeout: ${method}`)) }, 30000)
      pending.set(id, { resolve, reject, timer })
      client.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  await rpc('initialize', { protocolVersion: 1, clientCapabilities: { _meta: { 'x.ai/userMessageEcho': true } }, clientInfo: { name: 'fixture-control', version: '1' } })
  evidence.initialized = true
  const mcpServers = [{ type: 'http', name: 'fixture', url: `http://127.0.0.1:${address.port}/mcp`, headers: [{ name: 'Authorization', value: 'Bearer fixture-only' }] }]
  const requestedId = randomUUID()
  const session = await rpc('session/new', { cwd: root, mcpServers, _meta: { sessionId: requestedId } })
  if (session.sessionId !== requestedId) throw new Error('Native create response did not preserve requested session identity')
  evidence.created = true
  const recordMcpState = async (phase: string) => {
    const response = await rpc('_x.ai/mcp/list', { sessionId: session.sessionId })
    const state = response.result ?? response
    const fixture = state.servers?.filter((server: any) => server.name === 'fixture').map((server: any) => ({ enabled: server.session?.enabled, status: server.session?.status, tools: server.session?.tools?.length }))
    evidence.mcpStates.push({ phase, keys: Object.keys(state ?? {}), fixture })
    return fixture?.some((server: any) => server.status === 'ready') ?? false
  }
  for (let attempt = 0; attempt < 20 && !(await recordMcpState('after-create')); attempt++) await delay(100)
  await rpc('_x.ai/mcp/call', { sessionId: session.sessionId, server: 'fixture', serverUrl: `http://127.0.0.1:${address.port}/mcp`, tool: 'fixture_echo', arguments: {} })
  await rpc('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: firstText }] })
  const native = createRequire(import.meta.url)('node-pty') as typeof import('node-pty')
  viewer = native.spawn(binary, ['--no-auto-update', '--fullscreen', '--leader', '--leader-socket', socket, '--resume', session.sessionId], { cwd: root, env: { ...env, TERM: 'xterm-256color' }, cols: 120, rows: 40, name: 'xterm-256color' })
  viewer.onExit(() => { viewerExited = true })
  terminal = new HeadlessTerminal({ pty: viewer, cols: 120, rows: 40 }); terminal.attach()
  await waitUntil(() => terminal!.snapshotPlain().includes('PAPAYA'), 'TUI replay')
  evidence.tuiSawReplay = true
  await rpc('_x.ai/session/update_mcp_servers', { sessionId: session.sessionId, mcpServers })
  for (let attempt = 0; attempt < 20 && !(await recordMcpState('after-update')); attempt++) await delay(100)
  await rpc('_x.ai/mcp/call', { sessionId: session.sessionId, server: 'fixture', serverUrl: `http://127.0.0.1:${address.port}/mcp`, tool: 'fixture_echo', arguments: {} })
  await rpc('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: secondText }] })
  await waitUntil(() => terminal!.snapshotPlain().includes('CHERRY'), 'TUI live update')
  evidence.tuiSawLive = true
  await mkdir(join(root, 'permission-probe'))
  await writeFile(join(root, 'permission-probe', 'owned'), 'fixture')
  let promptFailure: Error | undefined
  const permissionTurn = rpc('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: permissionText }] }).catch(error => { promptFailure = error })
  await waitUntil(() => !!permissionRequest, 'permission routed to control client')
  await waitUntil(() => terminal!.snapshotPlain().includes('No, reject'), 'native TUI permission card')
  evidence.tuiSawPermission = true
  client.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: permissionRequest.id, result: { outcome: { outcome: 'cancelled' } } }) + '\n')
  await permissionTurn
  if (promptFailure) throw promptFailure
  evidence.permissionCancelled = existsSync(join(root, 'permission-probe', 'owned'))
  const other = await rpc('session/new', { cwd: root, mcpServers: [] })
  try {
    await rpc('_x.ai/mcp/call', { sessionId: other.sessionId, server: 'fixture', tool: 'fixture_echo', arguments: {} })
  } catch { evidence.mcpIsolated = evidence.rpcErrorCategories.at(-1) === 'not found' }
  await rpc('_x.ai/mcp/call', { sessionId: session.sessionId, server: 'fixture', tool: 'fixture_echo', arguments: {} })
  if (!evidence.exactBackendText || !evidence.exactUserEcho || !evidence.mcpCalls || !evidence.permissionCancelled || !evidence.mcpIsolated || evidence.unexpectedImages) throw new Error('Native control evidence incomplete')
  console.log(JSON.stringify(evidence, null, 2))
} catch (error) {
  console.log(JSON.stringify(evidence, null, 2))
  throw error
} finally {
  terminal?.dispose()
  if (viewer && !viewerExited) { viewer.kill(); await waitUntil(() => viewerExited, 'viewer exit', 5000).catch(() => viewer!.kill('SIGKILL')) }
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
    child.kill('SIGTERM')
    const force = setTimeout(() => child.kill('SIGKILL'), 2000)
    try { await closed } finally { clearTimeout(force) }
  }
  for (const waiter of pending.values()) clearTimeout(waiter.timer)
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  if (!viewer || viewerExited) await rm(root, { recursive: true, force: true })
}
