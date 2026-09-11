import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GrokNativeControl } from './GrokNativeControl.js'
import type { GrokAcpServerRequest } from './GrokAcpClient.js'

let root: string
let control: GrokNativeControl | undefined
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'g-own-'))) })
afterEach(async () => { await control?.dispose(); control = undefined; delete process.env.GROK_CONTROL_PARENT_FIXTURE; await rm(root, { recursive: true, force: true }) })
function options(mode = '') {
  return { binary: process.execPath, cwd: root, env: { NODE_OPTIONS: `--import=${new URL('./testing/nativeLeader.mjs', import.meta.url).href}`, GROK_CONTROL_FIXTURE_MODE: mode, GROK_CONTROL_FIXTURE_STATE: join(root, 'state.json') } }
}
async function state() { return JSON.parse(await readFile(join(root, 'state.json'), 'utf8')) as { pid: number; socketPath: string; inherited: boolean } }
async function expectCleaned() {
  const owned = await state()
  expect(() => process.kill(owned.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  await expect(stat(dirname(owned.socketPath))).rejects.toMatchObject({ code: 'ENOENT' })
}
describe('owned Grok native control lifetime', () => {
  it('starts a private verified leader, carries literal prompt text and cleans its own socket directory', async () => {
    control = await GrokNativeControl.start(options())
    const directory = dirname(control.socketPath)
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    const id = '00000000-0000-4000-8000-000000000001'
    await expect(control.createSession(id, [])).resolves.toBe(id)
    await expect(control.prompt(id, 'literal\n\ttext')).resolves.toMatchObject({ text: 'literal\n\ttext' })
    await control.dispose()
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(control.isClosed).toBe(true)
  })
  it('fails a startup that never registers and acknowledges process cleanup', async () => {
    await expect(GrokNativeControl.start({ ...options('no-register'), startupTimeoutMs: 500 })).rejects.toThrow()
    await expectCleaned()
  })
  it('rejects in-flight work on leader death without adopting or restarting another leader', async () => {
    control = await GrokNativeControl.start(options('exit-on-prompt'))
    await expect(control.prompt('00000000-0000-4000-8000-000000000001', 'fixture')).rejects.toMatchObject({ uncertain: true })
    await control.dispose()
    expect(control.isClosed).toBe(true)
  })
  it('escalates only its own unresponsive process and makes disposal single-flight', async () => {
    control = await GrokNativeControl.start(options('ignore-term'))
    const first = control.dispose()
    expect(control.dispose()).toBe(first)
    await first
    expect(control.isClosed).toBe(true)
  })
  it('runs dependent TUI cleanup before stopping the leader', async () => {
    let liveDuringCleanup = false
    let cleanups = 0
    control = await GrokNativeControl.start({ ...options(), beforeClose: async () => { cleanups++; liveDuringCleanup = control!.pid !== undefined } })
    await control.dispose()
    expect(liveDuringCleanup).toBe(true)
    expect(cleanups).toBe(1)
  })
  it('can start with only the supplied environment for isolated native verification', async () => {
    process.env.GROK_CONTROL_PARENT_FIXTURE = 'fixture'
    control = await GrokNativeControl.start({ ...options(), inheritEnv: false })
    expect((await state()).inherited).toBe(false)
  })
  it('rejects unsupported ACP initialization before exposing a usable control', async () => {
    await expect(GrokNativeControl.start(options('wrong-protocol'))).rejects.toThrow()
    await expectCleaned()
  })
  it('cancels startup while registration is pending and waits for owned cleanup', async () => {
    const abort = new AbortController()
    const opening = GrokNativeControl.start({ ...options('no-register'), signal: abort.signal }).catch(error => error)
    await expect.poll(async () => state().then(() => true, () => false)).toBe(true)
    abort.abort()
    expect(await opening).toBeInstanceOf(Error)
    await expectCleaned()
  })
  it('waits for native session-only MCP readiness even though the catalog omits the HTTP URL', async () => {
    control = await GrokNativeControl.start(options())
    await expect(control.updateMcpServers('00000000-0000-4000-8000-000000000001', [
      { type: 'http', name: 'fixture', url: 'http://127.0.0.1:1234/mcp', headers: [] },
    ], 500)).resolves.toBeUndefined()
  })
  it('requests native cancellation and keeps the session busy until the native turn acknowledges completion', async () => {
    const notifications: Array<{ method: string; params?: unknown }> = []
    control = await GrokNativeControl.start({ ...options('hold-prompt'), onNotification: value => notifications.push(value) })
    const id = '00000000-0000-4000-8000-000000000001'
    const abort = new AbortController()
    const turn = control.prompt(id, 'fixture', { signal: abort.signal }).catch(error => error)
    await expect.poll(() => notifications.some(value => value.method === 'fixture/prompt_received')).toBe(true)
    abort.abort()
    expect(await turn).toMatchObject({ code: 'aborted', uncertain: true })
    await expect.poll(() => notifications.filter(value => value.method === 'fixture/cancel_received')).toEqual([
      { method: 'fixture/cancel_received', params: { sessionId: id } },
    ])
    await expect(control.prompt(id, 'must not overlap')).rejects.toMatchObject({ code: 'busy', uncertain: false })
    await control.rpc.request('fixture/release', {})
    await expect(control.prompt(id, 'next admitted turn')).resolves.toMatchObject({ text: 'next admitted turn' })
  })
  it('retains the leader when dependent cleanup fails, then permits an explicit cleanup retry', async () => {
    let canClose = false
    control = await GrokNativeControl.start({ ...options(), beforeClose: async () => {
      if (!canClose) throw new Error('Fixture dependent still alive')
    } })
    try {
      await expect(control.dispose()).rejects.toThrow()
      expect(control.pid).toBeDefined()
      expect((await stat(dirname(control.socketPath))).isDirectory()).toBe(true)
    } finally { canClose = true; await control.dispose() }
    await expectCleaned()
  })
  it('releases the turn gate after a correlated native error without claiming its effects were undone', async () => {
    control = await GrokNativeControl.start(options('prompt-error'))
    const id = '00000000-0000-4000-8000-000000000001'
    await expect(control.prompt(id, 'first')).rejects.toMatchObject({ code: 'remote', uncertain: true })
    await expect(control.prompt(id, 'next')).resolves.toMatchObject({ text: 'next' })
  })
  it('retires shared interactions only for the matching session and rejects a stale answer after another client wins', async () => {
    const requests: GrokAcpServerRequest[] = []
    control = await GrokNativeControl.start({ ...options(), onRequest: request => requests.push(request) })
    const sessionId = '00000000-0000-4000-8000-000000000001'
    await control.rpc.request('fixture/interaction', { sessionId })
    await control.rpc.request('fixture/resolve_interaction', { sessionId: '00000000-0000-4000-8000-000000000002' })
    await expect(control.rpc.respond(requests[0].token, { outcome: { outcome: 'cancelled' } })).resolves.toBeUndefined()
    await control.rpc.request('fixture/interaction', { sessionId })
    await control.rpc.request('fixture/resolve_interaction', { sessionId })
    await expect(control.rpc.respond(requests[1].token, {})).rejects.toMatchObject({ code: 'stale-request', uncertain: false })
    await control.rpc.request('fixture/interaction', { sessionId })
    expect(requests).toHaveLength(3)
    expect(requests[2].token).not.toBe(requests[1].token)
  })
})
