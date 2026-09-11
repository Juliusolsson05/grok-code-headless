// Native integration proof using the production control lifetime. Own every process
// created here; never discover/kill a PID from a user's global leader lock.
// Typed ACP text bypasses the TUI paste/desktop-clipboard path entirely.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { HeadlessTerminal } from '../src/terminal/HeadlessTerminal.js'
import { GrokNativeControl, type GrokMcpServer } from '../src/control/GrokNativeControl.js'
import { GrokAcpError, type GrokAcpServerRequest } from '../src/control/GrokAcpClient.js'
import { detectCommandPermission } from '../src/conditions/commandPermission.js'

if (process.env.GROK_ACP_PROBE !== '1') throw new Error('Set GROK_ACP_PROBE=1 for isolated native protocol verification')
const binary = process.env.GROK_BINARY ?? join(homedir(), '.local', 'bin', 'grok')
const root = await mkdtemp(join(tmpdir(), 'g-acp-'))
const home = join(root, 'home')
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
  tuiSawPermission: false, permissionCancelled: false, mcpIsolated: false, tuiAnsweredPermission: false, stalePermissionRefused: false }
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

let processFailure = false
let viewer: import('node-pty').IPty | undefined
let viewerExited = false
let permissionRequest: GrokAcpServerRequest | undefined
let terminal: HeadlessTerminal | undefined
let control: GrokNativeControl | undefined
const waitUntil = async (predicate: () => boolean, label: string, timeout = 20000) => {
  const deadline = Date.now() + timeout
  while (!predicate() && Date.now() < deadline) {
    if (processFailure) throw new Error('Native probe process failed')
    await delay(50)
  }
  if (!predicate()) throw new Error(`Probe timeout: ${label}`)
}
const closeViewer = async () => {
  if (viewer && !viewerExited) {
    viewer.kill('SIGTERM')
    const force = setTimeout(() => { if (!viewerExited) viewer!.kill('SIGKILL') }, 1000)
    // Cleanup must keep waiting even when a native failure caused entry here.
    // A signal receipt alone is not permission to unlink a live TUI's storage.
    try {
      const deadline = Date.now() + 5000
      while (!viewerExited && Date.now() < deadline) await delay(20)
      if (!viewerExited) throw new Error('Owned native TUI did not exit')
    } finally { clearTimeout(force) }
  }
  terminal?.dispose()
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
  control = await GrokNativeControl.start({ binary, cwd: root, env, inheritEnv: false, model: 'grok-4.6',
    relayUrl: `ws://127.0.0.1:${address.port}/disabled`, relayOrigin: `http://127.0.0.1:${address.port}`,
    beforeClose: closeViewer, onClose: () => { processFailure = true },
    onRequest: request => {
      evidence.serverRequests.push(request.method)
      if (request.method !== 'session/request_permission') throw new Error('Unexpected native request')
      permissionRequest = request
    },
    onNotification: value => {
      evidence.notifications[value.method] = (evidence.notifications[value.method] ?? 0) + 1
      const outer = value.params as any
      const params = outer?.method && outer?.params ? outer.params : outer
      const update = params?.update
      if (update?.sessionUpdate === 'user_message_chunk' && update.content?.type === 'text' && update.content.text === firstText) evidence.exactUserEcho = true
      if (update?.sessionUpdate === 'user_message_chunk' && typeof update.content?.text === 'string' && update.content.text.includes(firstText)) evidence.echoContainsText = true
    },
  })
  const rpc = async (method: string, params: unknown): Promise<any> => {
    evidence.methods.push(method)
    return control!.rpc.request(method, params)
  }
  evidence.methods.push('initialize')
  evidence.initialized = true
  const mcpServers: GrokMcpServer[] = [{ type: 'http', name: 'fixture', url: `http://127.0.0.1:${address.port}/mcp`, headers: [{ name: 'Authorization', value: 'Bearer fixture-only' }] }]
  const requestedId = randomUUID()
  const session = { sessionId: await control.createSession(requestedId, mcpServers) }
  evidence.methods.push('session/new')
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
  await control.prompt(session.sessionId, firstText)
  evidence.methods.push('session/prompt')
  await control.loadSession(session.sessionId, mcpServers)
  evidence.methods.push('session/load')
  const native = createRequire(import.meta.url)('node-pty') as typeof import('node-pty')
  viewer = native.spawn(binary, ['--no-auto-update', '--fullscreen', '--leader', '--leader-socket', control.socketPath, '--resume', session.sessionId], { cwd: root, env: { ...env, TERM: 'xterm-256color' }, cols: 120, rows: 40, name: 'xterm-256color' })
  viewer.onExit(() => { viewerExited = true })
  terminal = new HeadlessTerminal({ pty: viewer, cols: 120, rows: 40 }); terminal.attach()
  await waitUntil(() => terminal!.snapshotPlain().includes('PAPAYA'), 'TUI replay')
  evidence.tuiSawReplay = true
  try { await control.updateMcpServers(session.sessionId, mcpServers) }
  catch (error) {
    const status = await rpc('_x.ai/mcp/list', { sessionId: session.sessionId })
    evidence.mcpStates.push({ phase: 'update-failed', fixture: status.result?.servers?.filter((entry: any) => entry.name === 'fixture').map((entry: any) => ({
      keys: Object.keys(entry), type: entry.type, urlType: typeof entry.url, urlMatches: entry.url === mcpServers[0].url,
      enabled: entry.session?.enabled, status: entry.session?.status,
    })) })
    throw error
  }
  evidence.methods.push('_x.ai/session/update_mcp_servers')
  for (let attempt = 0; attempt < 20 && !(await recordMcpState('after-update')); attempt++) await delay(100)
  await rpc('_x.ai/mcp/call', { sessionId: session.sessionId, server: 'fixture', serverUrl: `http://127.0.0.1:${address.port}/mcp`, tool: 'fixture_echo', arguments: {} })
  await control.prompt(session.sessionId, secondText)
  evidence.methods.push('session/prompt')
  await waitUntil(() => terminal!.snapshotPlain().includes('CHERRY'), 'TUI live update')
  evidence.tuiSawLive = true
  await mkdir(join(root, 'permission-probe'))
  await writeFile(join(root, 'permission-probe', 'owned'), 'fixture')
  let promptFailure: Error | undefined
  const permissionTurn = control.prompt(session.sessionId, permissionText).catch(error => { promptFailure = error })
  await waitUntil(() => !!permissionRequest, 'permission routed to control client')
  await waitUntil(() => terminal!.snapshotPlain().includes('No, reject'), 'native TUI permission card')
  evidence.tuiSawPermission = true
  if (process.env.GROK_ACP_PERMISSION_VIA_TUI === '1') {
    // This variant presses one observed rejection digit on the fixture card.
    // It never sends text/paste or guesses a persistent permission option.
    let key: string | undefined
    await waitUntil(() => {
      const card = detectCommandPermission(terminal!.snapshotPlain(), [{ toolCallId: 'call_acp_fixture', command: 'rm -rf ./permission-probe' }])
      key = card?.actions.find(action => action.id === 'reject-once')?.key
      return key !== undefined
    }, 'verified native reject-once key')
    viewer.write(key!)
    evidence.tuiAnsweredPermission = true
  } else await control.rpc.respond(permissionRequest!.token, { outcome: { outcome: 'cancelled' } })
  await permissionTurn
  if (promptFailure) throw promptFailure
  if (evidence.tuiAnsweredPermission) {
    try { await control.rpc.respond(permissionRequest!.token, { outcome: { outcome: 'cancelled' } }) }
    catch (error) { evidence.stalePermissionRefused = error instanceof GrokAcpError && error.code === 'stale-request' }
    if (!evidence.stalePermissionRefused) throw new Error('Resolved native permission retained stale control authority')
  }
  evidence.permissionCancelled = existsSync(join(root, 'permission-probe', 'owned'))
  const other = { sessionId: await control.createSession(randomUUID(), []) }
  const otherMcp = await rpc('_x.ai/mcp/list', { sessionId: other.sessionId })
  const otherHasFixture = (otherMcp.result ?? otherMcp).servers.some((server: any) => server.name === 'fixture' && server.session?.enabled)
  try {
    await rpc('_x.ai/mcp/call', { sessionId: other.sessionId, server: 'fixture', tool: 'fixture_echo', arguments: {} })
  } catch (error) { evidence.mcpIsolated = !otherHasFixture && error instanceof GrokAcpError && error.rpcCode === -32603 }
  await rpc('_x.ai/mcp/call', { sessionId: session.sessionId, server: 'fixture', tool: 'fixture_echo', arguments: {} })
  if (!evidence.exactBackendText || !evidence.exactUserEcho || !evidence.mcpCalls || !evidence.permissionCancelled || !evidence.mcpIsolated || evidence.unexpectedImages) throw new Error('Native control evidence incomplete')
} catch (error) {
  console.log(JSON.stringify(evidence, null, 2))
  throw error
} finally {
  let cleanupVerified = false
  try {
    if (control) {
      await control.dispose()
      // Absence is a read-only check, not authority to adopt/kill a discovered
      // PID. A surviving native replacement makes this proof fail.
      let found = false
      try { execFileSync('pgrep', ['-f', control.socketPath], { stdio: 'ignore' }); found = true }
      catch (error) { if ((error as { status?: number }).status !== 1) throw new Error('Cannot verify native process cleanup') }
      if (found) throw new Error('Native process survived owned control cleanup')
    } else await closeViewer()
    cleanupVerified = true
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    if (cleanupVerified && (!viewer || viewerExited)) await rm(root, { recursive: true, force: true })
  }
}
console.log(JSON.stringify(evidence, null, 2))
