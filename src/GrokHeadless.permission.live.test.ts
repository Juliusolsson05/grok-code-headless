import { createServer } from 'node:http'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { expect, it } from 'vitest'
import { GrokHeadless } from './GrokHeadless.js'

const binary = process.env.GROK_BINARY ?? join(homedir(), '.local', 'bin', 'grok')
it.skipIf(process.env.GROK_HEADLESS_PERMISSION_LIVE !== '1' || !existsSync(binary)).each(['allow-once', 'reject-once'] as const)('resolves the native command card with %s without changing approval mode (explicit native opt-in)', async choice => {
  const root = mkdtempSync(join(tmpdir(), 'grok-permission-'))
  const home = join(root, '.grok')
  const victim = join(root, 'permission-probe')
  mkdirSync(home); mkdirSync(victim)
  writeFileSync(join(victim, 'owned-test-file'), 'fixture only')
  writeFileSync(join(home, 'config.toml'), '[cli]\nauto_update = false\n[ui]\npermission_mode = "ask"\n')
  const native = readFileSync(new URL('../testing/fixtures/streaming/native-papaya.sse', import.meta.url), 'utf8')
  const title = readFileSync(new URL('../testing/fixtures/sse.responses.txt', import.meta.url), 'utf8')
  const frames = native.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
  const created = frames.find(frame => frame.type === 'response.created').response
  const completed = frames.find(frame => frame.type === 'response.completed').response
  const call = { id: 'fc_permission_fixture', call_id: 'call_permission_fixture', type: 'function_call', name: 'run_terminal_command', arguments: JSON.stringify({ command: 'rm -rf ./permission-probe', description: 'Remove only the disposable fixture directory' }), status: 'completed' }
  // Controlled stimulus in the recorded Responses envelope. The permission
  // UI and approval behavior below are produced by the real native runtime.
  const toolEvents = [
    { type: 'response.created', response: created },
    { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '', status: 'in_progress' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: call.id, delta: call.arguments },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: call.id, arguments: call.arguments },
    { type: 'response.output_item.done', output_index: 0, item: call },
    { type: 'response.completed', response: { ...completed, output: [call] } },
  ].map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join('')
  let toolSent = false
  const server = createServer(async (req, res) => {
    if (req.url?.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'grok-4.6', model: 'grok-4.6', api_backend: 'responses', context_window: 500000 }] }))
    } else if (req.url === '/v1/responses') {
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) { res.writeHead(413); res.end(); return }; chunks.push(chunk) }
      const request = JSON.parse(Buffer.concat(chunks).toString())
      const sidecar = request.tool_choice?.name === 'session_title'
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (sidecar) res.end(title)
      else if (!toolSent) { toolSent = true; res.end(toolEvents) }
      else res.end(native)
    } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') }
  })
  let runtime: GrokHeadless | undefined
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No local address')
    const upstream = `http://127.0.0.1:${address.port}/v1`
    runtime = await GrokHeadless.create({
      cwd: root, grokHome: home, grokBinary: binary,
      streaming: { upstreamBaseUrl: upstream }, extraArgs: ['--model', 'grok-4.6'],
      env: { HOME: root, XDG_CONFIG_HOME: join(root, '.config'), XAI_API_KEY: 'fixture-only-not-a-real-key', GROK_CLI_CHAT_PROXY_BASE_URL: upstream, OTEL_TRACES_EXPORTER: 'none' },
    })
    let screen = ''
    let settled = false
    runtime.on('screen', event => { screen = event.snapshot.plain })
    runtime.on('grok-update', event => { if (event.params.update.sessionUpdate === 'turn_completed') settled = true })
    const ready = performance.now() + 15000
    while (!screen && performance.now() < ready) await new Promise(resolve => setTimeout(resolve, 50))
    runtime.sendPrompt('Remove the disposable permission-probe directory after asking for approval.')
    const deadline = performance.now() + 20000
    while (!runtime.commandPermission && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
    const card = runtime.commandPermission
    expect(card, `native approval-card evidence: ${screen}`).not.toBeNull()
    expect(card!.actions.map(action => action.key)).toEqual(['3', '4'])
    expect(existsSync(victim), 'command must not execute before an approval').toBe(true)
    if (process.env.UPDATE_FIXTURES === '1' && choice === 'allow-once') {
      const minimized = screen.replaceAll(realpathSync(root), '<fixture-cwd>').replaceAll(root, '<fixture-cwd>')
      writeFileSync(new URL('../testing/fixtures/conditions/command-approval.json', import.meta.url), JSON.stringify({ provider: 'grok', version: '1.0.13', source: 'native TUI with controlled tool stimulus', redaction: 'isolated HOME; cwd replaced', cols: 120, rows: 40, lines: minimized.split('\n').map(line => line.trimEnd()) }, null, 2) + '\n', { flag: 'wx' })
    }
    expect(runtime.answerCommandPermission(card!.id, choice)).toBe(true)
    expect(runtime.answerCommandPermission(card!.id, choice)).toBe(false)
    const execute = performance.now() + 15000
    while (!settled && performance.now() < execute) await new Promise(resolve => setTimeout(resolve, 100))
    expect(settled, 'native turn settles after the selected permission response').toBe(true)
    expect(existsSync(victim), 'only allow-once may execute the fixture command').toBe(choice === 'reject-once')
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toContain('permission_mode = "ask"')
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).not.toContain('rm -rf')
  } finally {
    await runtime?.dispose()
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
}, 60000)
