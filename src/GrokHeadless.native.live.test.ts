import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { SemanticEvent } from './channels/types.js'
import { GrokNativeControl, type GrokMcpServer } from './control/GrokNativeControl.js'
import { GrokTuiSocketGuard } from './control/GrokTuiSocketGuard.js'
import { GrokHeadless } from './GrokHeadless.js'
import { prepareGrokTerminalLaunch } from './launch/prepareLaunch.js'
import { RuntimeCapture } from './testing/controlled-runtime/Capture.js'
import { FixtureBackend } from './testing/controlled-runtime/FixtureBackend.js'
import { isolatedEnv } from './testing/controlled-runtime/NativeHarness.js'
import { fixtureTools } from './testing/controlled-runtime/scenarios.js'

// Stage 3's exit proof: installed Grok driven through GrokHeadless in exactly the
// order the app session uses:
//   1. start the leader, then create the session over control;
//   2. start the guard, prepare the launch and spawn the terminal PTY;
//   3. attach GrokHeadless;
//   4. re-seed MCP on terminal-loaded.
// It runs against the recorder's scripted local backend in a disposable home, with
// the terminal contained by the same deny-fork profile the recordings used. No
// paid inference, personal session, auth file or cache is touched.
//
// The recorded contract is proven by the replay tests; this proves the composition
// holds against the real binary: acceptance before completion, the answer before
// completion, cancel over control, and detaching without owning a process.

const enabled = process.env.GROK_HEADLESS_NATIVE_LIVE === '1'
const CONTAINMENT = '(version 1) (allow default) (deny process-fork)'

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Live deadline: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

describe.skipIf(!enabled)('GrokHeadless against installed Grok, in the app order', () => {
  it('accepts, completes after the answer, cancels over control, and detaches without owning a process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grok-headless-live-'))
    const cwd = join(root, 'workspace')
    const home = join(root, 'native-home')
    await mkdir(cwd, { mode: 0o700 })
    await mkdir(home, { mode: 0o700 })
    await writeFile(join(home, 'config.toml'), '[cli]\nauto_update = false\n[ui]\npermission_mode = "ask"\n', { mode: 0o600 })
    const capture = await RuntimeCapture.create(root, { purpose: 'scripted backend log for the GrokHeadless native live test' })
    const backend = await FixtureBackend.create(capture, fixtureTools)
    const binary = await realpath(process.env.GROK_BINARY ?? join(homedir(), '.local', 'bin', 'grok'))
    const env = Object.fromEntries(Object.entries(isolatedEnv(capture.directory, home, backend.baseUrl)).filter((entry): entry is [string, string] => entry[1] !== undefined))
    const mcpServers: GrokMcpServer[] = [{ type: 'http', name: 'fixture', url: `${backend.baseUrl}/mcp`, headers: [{ name: 'Authorization', value: 'Bearer fixture-only' }] }]

    let pty: import('node-pty').IPty | undefined
    let terminalExit: Promise<void> | undefined
    let guard: GrokTuiSocketGuard | undefined
    let headless: GrokHeadless | undefined

    const sessionId = randomUUID()
    // Step 1: the owned leader, then the session over control.
    const control = await GrokNativeControl.start({ binary, cwd, env })
    try {
      await control.createSession(sessionId, mcpServers)
      // Step 2: the guard, the prepared launch, the contained terminal PTY.
      guard = await GrokTuiSocketGuard.create({ upstreamPath: control.socketPath, expectedPid: control.pid!, onFault: () => {} })
      const launch = prepareGrokTerminalLaunch({ binary, env, sessionId, guardSocketPath: guard.socketPath })
      const requirePty = createRequire(import.meta.url)
      // WHY sandbox-exec wrapping the terminal: the recordings contained the
      // terminal with exactly this deny-fork profile, so the composition is proven
      // in the environment the catalog's facts were observed in.
      pty = requirePty('node-pty') as import('node-pty').IPty
      const terminal = requirePty('node-pty').spawn('sandbox-exec', ['-p', CONTAINMENT, binary, ...launch.args], { cwd, env: launch.env, name: 'xterm-256color', cols: 120, rows: 40 })
      terminalExit = new Promise(resolve => terminal.onExit(() => resolve()))

      const order: string[] = []
      const semantic: SemanticEvent[] = []
      // Step 3: attach GrokHeadless to the PTY and both handles.
      headless = new GrokHeadless({ pty: terminal, cwd, launch, // WHY a getter and not a snapshot: `isClosed` captured at construction stays false
      // forever after the lifetime closes, and submitPrompt's closed check would
      // then pass a closed control through to a throw.
      control: { get isClosed() { return control.isClosed }, rpc: control, observe: observer => control.observe(observer) }, guard, grokHome: home, heartbeatMs: 0 })
      headless.on('semantic', event => {
        semantic.push(event)
        if (event.type === 'turn_started' || event.type === 'turn_completed') order.push(event.type)
      })
      headless.on('entry', entry => { if (!entry.inRewriteSnapshot && entry.item.type === 'assistant') order.push('answer') })
      // Step 4: re-seed the session MCP set when native answers the terminal's load.
      // Step 4: re-seed the session MCP set when native answers the terminal's load.
      const instance = headless
      const loaded = new Promise<void>(resolve => {
        instance.once('terminal-loaded', () => { void control.request('_x.ai/session/update_mcp_servers', { sessionId, servers: mcpServers }).then(() => resolve(), () => resolve()) })
      })
      await instance.start()
      const accepted = await instance.submitPrompt('first composition check')
      expect(accepted).toEqual({ ok: true, promptId: expect.any(String) })
      // Acceptance resolved before any completion was observed.
      expect(order).not.toContain('turn_completed')
      await loaded

      await waitFor(() => semantic.some(event => event.type === 'turn_completed' && accepted.ok && event.turnId === accepted.promptId), 'first turn completion')
      const first = order.join(',')
      // The committed answer precedes the completion that consumed it.
      expect(first.indexOf('answer')).toBeGreaterThanOrEqual(0)
      expect(first.indexOf('answer')).toBeLessThan(first.indexOf('turn_completed'))

      // Cancel over control while a second turn runs.
      const second = await headless.submitPrompt('second composition check')
      if (!second.ok) throw new Error(`second prompt not accepted: ${second.reason}`)
      await waitFor(() => semantic.some(event => event.type === 'stream_phase' && event.phase !== 'idle'), 'second turn starts')
      expect(await headless.cancelTurn()).toBe(true)
      await waitFor(() => semantic.some(event => event.type === 'turn_completed' && event.turnId === second.promptId), 'cancelled completion')
      expect(semantic.filter(event => event.type === 'turn_completed').at(-1)).toMatchObject({ stopReason: 'cancelled' })

      // Detach without owning a process: stop must not kill the terminal.
      await headless.stop()
      expect(terminal.exitCode).toBeUndefined()
      terminal.kill()
      await terminalExit
    } finally {
      await headless?.stop()
      const exit = terminalExit ?? Promise.resolve()
      await guard?.dispose(() => exit)
      await control.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
