// Explicit instrumentation before composer policy. This types only synthetic
// unsent drafts into an isolated native TUI; the loopback server refuses all
// inference requests. Quiescence selects a capture, never authorizes submission.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { HeadlessTerminal, type StableTerminalFrame } from '../src/terminal/HeadlessTerminal.js'

if (process.env.UPDATE_FIXTURES !== '1' || !process.argv[2]) throw new Error('Use UPDATE_FIXTURES=1 with a new private capture path')
// This is an operator assertion, NOT clipboard isolation. Native paste can
// access the OS pasteboard even with an isolated HOME. Only use a controlled
// desktop/VM whose clipboard contains synthetic fixture data.
if (process.env.GROK_CONTROLLED_DESKTOP_CAPTURE !== '1') throw new Error('Native paste capture requires a controlled desktop clipboard; do not run against a personal desktop')
const binary = process.env.GROK_BINARY ?? join(homedir(), '.local', 'bin', 'grok')
const terminalProgram = process.env.CAPTURE_TERM_PROGRAM
const modelLabel = process.env.CAPTURE_MODEL_LABEL ?? 'grok-4.6'
if (terminalProgram && terminalProgram !== 'iTerm.app') throw new Error('Unreviewed terminal capability profile')
if (!['grok-4.6', 'Fixture Grok'].includes(modelLabel)) throw new Error('Unreviewed model label')
let version = ''
const root = await mkdtemp(join(tmpdir(), 'grok-composer-capture-'))
const cwd = join(root, 'fixture-workspace')
const home = join(root, 'home')
await mkdir(cwd)
await mkdir(home)
await writeFile(join(home, 'config.toml'), '[cli]\nauto_update = false\n[ui]\npermission_mode = "ask"\n')
let inferenceRequests = 0
const server = createServer((request, reply) => {
  if (request.url?.startsWith('/v1/models')) {
    reply.writeHead(200, { 'content-type': 'application/json' })
    reply.end(JSON.stringify({ data: [{ id: 'grok-4.6', model: 'grok-4.6', name: modelLabel, api_backend: 'responses', context_window: 500000 }] }))
  } else {
    if (request.url === '/v1/responses') inferenceRequests++
    request.resume()
    reply.writeHead(503); reply.end('Input-only fixture capture')
  }
})
let pty: import('node-pty').IPty | undefined
let terminal: HeadlessTerminal | undefined
let exited = false
try {
  version = execFileSync(binary, ['--version'], { encoding: 'utf8', env: {
    PATH: process.env.PATH, HOME: root, GROK_HOME: home, XDG_CONFIG_HOME: join(root, '.config'),
  } }).trim()
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback address')
  const base = `http://127.0.0.1:${address.port}/v1`
  const native = createRequire(import.meta.url)('node-pty') as typeof import('node-pty')
  pty = native.spawn(binary, ['--no-auto-update', '--no-leader', '--fullscreen', '--session-id', randomUUID(), '--model', 'grok-4.6'], {
    name: 'xterm-256color', cols: 120, rows: 40, cwd,
    env: { PATH: process.env.PATH, HOME: root, USER: 'fixture', LOGNAME: 'fixture', GROK_HOME: home, XDG_CONFIG_HOME: join(root, '.config'), TERM: 'xterm-256color', ...(terminalProgram ? { TERM_PROGRAM: terminalProgram } : {}), XAI_API_KEY: 'fixture-only-not-a-real-key', GROK_MODELS_BASE_URL: base, GROK_XAI_API_BASE_URL: base, GROK_CLI_CHAT_PROXY_BASE_URL: base, OTEL_TRACES_EXPORTER: 'none', OTEL_METRICS_EXPORTER: 'none' },
  })
  pty.onExit(() => { exited = true })
  terminal = new HeadlessTerminal({ pty, cols: 120, rows: 40 })
  terminal.attach()
  const frames: Array<{ label: string; frame: StableTerminalFrame }> = []
  let lastCaptureGeneration = 0
  const capture = async (label: string) => {
    let previous = -1
    for (let attempt = 0; attempt < 150; attempt++) {
      await delay(100)
      if (exited) throw new Error('Native TUI exited during capture')
      const frame = terminal!.snapshotStableFrame()
      if (frame && frame.rows.some(row => row.text.trim()) && frame.generation > lastCaptureGeneration && frame.generation === previous) {
        frames.push({ label, frame })
        lastCaptureGeneration = frame.generation
        return
      }
      previous = frame?.generation ?? -1
    }
    throw new Error('Native frame never settled')
  }
  await capture('initial')
  pty.write('\x1b[200~fixture draft one\nfixture draft two\x1b[201~')
  await capture('multiline-draft')
  pty.write('\x15') // Native clear-to-start; record what actually remains.
  await capture('after-control-u')
  pty.write('\x7f\x15') // Remove the empty second line, then clear the first.
  await capture('cleared')
  pty.write('\x1b[<0;10;10M\x1b[<0;10;10m')
  await capture('after-transcript-click')
  pty.write('\x1b[<0;7;36M\x1b[<0;7;36m')
  await capture('refocused')
  pty.write('\x10') // Native command palette / overlay, without submitting.
  await capture('after-control-p')
  pty.write('\x1b')
  await capture('overlay-closed')
  pty.write('/')
  await capture('slash-picker')
  pty.write('\x15')
  await capture('slash-cleared')
  pty.write('\x1b[200~fixture stashed draft\x1b[201~')
  await capture('stash-draft')
  pty.write('\x1b')
  await capture('after-escape')
  pty.write('\x1b')
  await capture('stashed')
  if (inferenceRequests) throw new Error('Input-only capture unexpectedly attempted inference')
  await writeFile(process.argv[2], JSON.stringify({ version, profile: { terminalProgram: terminalProgram ?? 'generic', modelLabel, cols: 120, rows: 40 }, inferenceRequests, frames }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ version, frames: frames.map(item => ({ label: item.label, cursor: item.frame.cursor })), inferenceRequests }))
} finally {
  terminal?.dispose()
  if (pty && !exited) {
    pty.kill()
    for (let attempt = 0; !exited && attempt < 50; attempt++) await delay(50)
    if (!exited) { pty.kill('SIGKILL'); for (let attempt = 0; !exited && attempt < 50; attempt++) await delay(50) }
  }
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  if (!pty || exited) await rm(root, { recursive: true, force: true })
  if (pty && !exited) throw new Error('Capture process did not acknowledge exit; retained its isolated directory')
}
