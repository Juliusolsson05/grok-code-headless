import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SemanticEvent } from './channels/types.js'
import type { ConditionSnapshot } from './conditions/core/contract.js'
import { PERMISSION_CANCEL_ACTION, PERMISSION_REPLY_ACTION, PLAN_REPLY_ACTION } from './conditions/modules.js'
import type { GrokAcpServerRequest } from './control/GrokAcpClient.js'
import { GrokHeadless, type GrokControlHandle, type GrokGuardHandle } from './GrokHeadless.js'
import { prepareGrokTerminalLaunch } from './launch/prepareLaunch.js'
import type { PtyExitEvent, PtyLike } from './terminal/PtyBinding.js'

// The root class against in-memory PTY, control and guard handles, with the wire
// shapes of the Stage 1 recordings (queue entries, reverse requests, the terminal's
// own session/new and session/load). What is proven here is the composition's
// public contract: acceptance-based submission and every non-accepted outcome,
// condition answers against outstanding requests only and in recorded shapes,
// terminal detection, lifetime edges, and that the class never kills, disposes or
// writes on its own. The recorded ordering of turns is proven by the reconcile
// layer's recorded tests.

class FakePty implements PtyLike {
  readonly pid = 4242
  readonly writes: string[] = []
  private listeners = new Set<(event: PtyExitEvent) => void>()
  write(data: string) { this.writes.push(data) }
  resize() {}
  onExit(listener: (event: PtyExitEvent) => void) {
    this.listeners.add(listener)
    return { dispose: () => { this.listeners.delete(listener) } }
  }
  exit(event: PtyExitEvent) { for (const listener of [...this.listeners]) listener(event) }
}

class FakeControl implements GrokControlHandle {
  isClosed = false
  private observers = new Set<Parameters<GrokControlHandle['observe']>[0]>()
  readonly requests: Array<{ method: string; params: any; settle: { resolve(value: unknown): void; reject(error: unknown): void } }> = []
  readonly rpc = {
    request: vi.fn((method: string, params: unknown) => new Promise<unknown>((resolve, reject) => { this.requests.push({ method, params, settle: { resolve, reject } }) })),
    notify: vi.fn(async () => {}),
    respond: vi.fn(async () => {}),
  }
  observe(observer: Parameters<GrokControlHandle['observe']>[0]) {
    // The helper's contract: an observer attached after the close hears it at once.
    if (this.isClosed) { observer.onClose?.(); return () => {} }
    this.observers.add(observer)
    return () => { this.observers.delete(observer) }
  }
  notification(method: string, params: unknown) { for (const observer of [...this.observers]) observer.onNotification?.({ method, params }) }
  reverse(request: GrokAcpServerRequest) { for (const observer of [...this.observers]) observer.onRequest?.(request) }
  close() { this.isClosed = true; for (const observer of [...this.observers]) observer.onClose?.() }
  observerCount() { return this.observers.size }
}

class FakeGuard implements GrokGuardHandle {
  private listeners = new Set<(message: { direction: 'from-terminal' | 'to-terminal'; payload: string }) => void>()
  observeTerminalMessages(listener: (message: { direction: 'from-terminal' | 'to-terminal'; payload: string }) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  send(direction: 'from-terminal' | 'to-terminal', message: unknown) {
    for (const listener of [...this.listeners]) listener({ direction, payload: JSON.stringify(message) })
  }
}

let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'grok-headless-')) })
afterEach(async () => {
  vi.useRealTimers()
  await rm(home, { recursive: true, force: true })
})

type RigOptions = { acceptanceTimeoutMs?: number; start?: boolean; closedControl?: boolean; launchHome?: string; explicitHome?: boolean }

async function rig(options: RigOptions = {}) {
  const sessionId = randomUUID()
  const pty = new FakePty()
  const control = new FakeControl()
  control.isClosed = options.closedControl === true
  const guard = new FakeGuard()
  const launch = prepareGrokTerminalLaunch({ binary: 'grok', env: options.launchHome ? { GROK_HOME: options.launchHome } : {}, sessionId, guardSocketPath: join(home, 'view.sock') })
  const headless = new GrokHeadless({
    pty, cwd: home, launch, control, guard, heartbeatMs: 0,
    ...(options.explicitHome === false ? {} : { grokHome: home }),
    ...(options.acceptanceTimeoutMs === undefined ? {} : { acceptanceTimeoutMs: options.acceptanceTimeoutMs }),
  })
  const semantic: SemanticEvent[] = []
  const conditions: ConditionSnapshot<'grok'>[] = []
  const states: Array<{ connected: boolean; reason?: string }> = []
  headless.on('semantic', event => semantic.push(event))
  headless.on('conditions', snapshot => conditions.push(snapshot))
  headless.on('live-state', state => states.push(state))
  if (options.start !== false) await headless.start()
  return { sessionId, pty, control, guard, headless, semantic, conditions, states }
}

const latest = (conditions: ConditionSnapshot<'grok'>[]) => conditions[conditions.length - 1]!.conditions
const tokenOf = (action: unknown) => (action as { payload: { token: string } }).payload.token

/** Native lists the app's first written prompt as a waiting queue entry: acceptance. */
function acceptFirst(control: FakeControl, sessionId: string): string {
  const promptId = control.requests[0]!.params._meta.promptId as string
  control.notification('_x.ai/queue/changed', { sessionId, entries: [{ id: promptId, version: 0, kind: 'prompt', position: 0 }] })
  return promptId
}

describe('GrokHeadless composition', () => {
  it('resolves a submitted prompt on native acceptance, not on the write (prompt.acceptance)', async () => {
    const { control, headless, sessionId } = await rig()
    let settled = false
    const submitted = headless.submitPrompt('hello').then(result => { settled = true; return result })
    expect(control.requests).toHaveLength(1)
    expect(control.requests[0]).toMatchObject({ method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'hello' }] } })
    await Promise.resolve()
    expect(settled).toBe(false)
    const promptId = acceptFirst(control, sessionId)
    await expect(submitted).resolves.toEqual({ ok: true, promptId })
    await headless.stop()
  })

  it('reports an unaccepted prompt unconfirmed after the bound and never resends it (uncertain-prompts)', async () => {
    vi.useFakeTimers()
    const { control, headless } = await rig({ acceptanceTimeoutMs: 1_000 })
    const submitted = headless.submitPrompt('hello')
    vi.advanceTimersByTime(1_000)
    await expect(submitted).resolves.toMatchObject({ ok: false, reason: 'unconfirmed' })
    expect(control.rpc.request).toHaveBeenCalledTimes(1)
    await headless.stop()
  })

  it('reports not-sent before start, and when the control client refused before writing (prompt.write)', async () => {
    const { control, headless } = await rig({ start: false })
    await expect(headless.submitPrompt('early')).resolves.toEqual({ ok: false, reason: 'not-sent', detail: 'not-started' })
    expect(control.rpc.request).not.toHaveBeenCalled()
    await headless.start()
    const submitted = headless.submitPrompt('hello')
    control.requests[0]!.settle.reject({ code: 'capacity', uncertain: false })
    await expect(submitted).resolves.toMatchObject({ ok: false, reason: 'not-sent', detail: 'capacity' })
    await headless.stop()
  })

  it('reports refused when native answers a prompt with an error before accepting it (control.rpc-failure)', async () => {
    const { control, headless } = await rig()
    const submitted = headless.submitPrompt('hello')
    control.requests[0]!.settle.reject({ code: 'remote', rpcCode: -32603, uncertain: true })
    await expect(submitted).resolves.toMatchObject({ ok: false, reason: 'refused' })
    await headless.stop()
  })

  it("surfaces native's refusal of an already accepted prompt as api_error instead of dropping it", async () => {
    const { control, headless, sessionId, semantic } = await rig()
    const submitted = headless.submitPrompt('hello')
    const promptId = acceptFirst(control, sessionId)
    await expect(submitted).resolves.toEqual({ ok: true, promptId })
    control.requests[0]!.settle.reject({ code: 'remote', rpcCode: -32603, uncertain: true })
    await expect.poll(() => semantic.filter(event => event.type === 'api_error')).toHaveLength(1)
    await headless.stop()
  })

  it('reports uncertain and disconnected when control closes before acceptance (prompt.uncertain)', async () => {
    const { control, headless, states } = await rig()
    const submitted = headless.submitPrompt('hello')
    control.close()
    await expect(submitted).resolves.toMatchObject({ ok: false, reason: 'uncertain' })
    expect(states).toEqual([{ connected: true }, { connected: false, reason: 'control-closed' }])
    await headless.stop()
  })

  it('settles a written but unaccepted prompt uncertain when the pane stops, so it is never resent (uncertain-prompts)', async () => {
    const { headless } = await rig()
    const submitted = headless.submitPrompt('hello')
    await headless.stop()
    await expect(submitted).resolves.toEqual({ ok: false, reason: 'uncertain', promptId: expect.any(String), detail: 'stopped' })
  })

  it('starts against a control lifetime that already closed: disconnected, and prompts are not sent', async () => {
    const { control, headless, states } = await rig({ closedControl: true })
    expect(states).toEqual([{ connected: false, reason: 'control-closed' }])
    await expect(headless.submitPrompt('hello')).resolves.toMatchObject({ ok: false, reason: 'not-sent' })
    expect(control.rpc.request).not.toHaveBeenCalled()
    await headless.stop()
  })

  it("detects the terminal's /new from native's answer, and its load of this session (session.terminal-connection, tool.mcp)", async () => {
    const { guard, headless, sessionId } = await rig()
    const switched: unknown[] = []
    const loaded: unknown[] = []
    headless.on('session-switched', event => switched.push(event))
    headless.on('terminal-loaded', event => loaded.push(event))
    guard.send('from-terminal', { jsonrpc: '2.0', id: 3, method: 'session/load', params: { sessionId, mcpServers: [] } })
    guard.send('to-terminal', { jsonrpc: '2.0', id: 3, result: {} })
    const other = randomUUID()
    guard.send('from-terminal', { jsonrpc: '2.0', id: 7, method: 'session/new', params: {} })
    expect(switched).toEqual([])
    guard.send('to-terminal', { jsonrpc: '2.0', id: 7, result: { sessionId: other } })
    expect(loaded).toEqual([{ sessionId }])
    expect(switched).toEqual([{ from: sessionId, to: other }])
    await headless.stop()
  })

  it("reports a refused terminal load, and a terminal prompt naming another session (session.load-failure, session.terminal-connection)", async () => {
    const { guard, headless, sessionId } = await rig()
    const refused: unknown[] = []
    const loaded: unknown[] = []
    const switched: unknown[] = []
    headless.on('terminal-load-refused', event => refused.push(event))
    headless.on('terminal-loaded', event => loaded.push(event))
    headless.on('session-switched', event => switched.push(event))
    guard.send('from-terminal', { jsonrpc: '2.0', id: 3, method: 'session/load', params: { sessionId, mcpServers: [] } })
    guard.send('to-terminal', { jsonrpc: '2.0', id: 3, error: { code: -32603, message: 'unavailable' } })
    expect(refused).toEqual([{ sessionId }])
    expect(loaded).toEqual([])
    const other = randomUUID()
    guard.send('from-terminal', { jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId: other, prompt: [] } })
    expect(switched).toEqual([{ from: sessionId, to: other }])
    await headless.stop()
  })

  it('answers only an outstanding permission, and refuses one the terminal already resolved (interaction.permission)', async () => {
    const { control, headless, sessionId, conditions } = await rig()
    const permission = (token: string, toolCallId: string) => control.reverse({ token, id: 0, method: 'session/request_permission', params: {
      sessionId, toolCall: { toolCallId, title: 'Run command' }, options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    } })
    permission('token-1', 'call-1')
    const actions = latest(conditions)['grok.permission']!.actions
    expect(actions).toMatchObject([
      { kind: 'custom', name: PERMISSION_REPLY_ACTION, payload: { token: 'token-1', optionId: 'allow-once' } },
      { kind: 'custom', name: PERMISSION_CANCEL_ACTION, payload: { token: 'token-1' } },
    ])
    await expect(headless.resolveConditionAction(actions[0] as never)).resolves.toEqual({ ok: true })
    expect(control.rpc.respond).toHaveBeenCalledWith('token-1', { outcome: { outcome: 'selected', optionId: 'allow-once' } })
    expect(latest(conditions)['grok.permission']).toBeUndefined()

    permission('token-2', 'call-2')
    const second = latest(conditions)['grok.permission']!.actions[0]!
    control.notification('_x.ai/session_notification', { sessionId, update: { sessionUpdate: 'interaction_resolved', tool_call_id: 'call-2' } })
    await expect(headless.resolveConditionAction(second as never)).resolves.toEqual({ ok: false, reason: 'stale' })
    expect(control.rpc.respond).toHaveBeenCalledTimes(1)
    await headless.stop()
  })

  it('keeps a second outstanding permission queued behind the first instead of replacing it', async () => {
    const { control, headless, sessionId, conditions } = await rig()
    for (const [token, toolCallId] of [['token-1', 'call-1'], ['token-2', 'call-2']] as const) {
      control.reverse({ token, id: 0, method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId }, options: [{ optionId: 'allow-once', name: 'Allow once' }] } })
    }
    expect(tokenOf(latest(conditions)['grok.permission']!.actions[0])).toBe('token-1')
    control.notification('_x.ai/session_notification', { sessionId, update: { sessionUpdate: 'interaction_resolved', tool_call_id: 'call-1' } })
    expect(tokenOf(latest(conditions)['grok.permission']!.actions[0])).toBe('token-2')
    await headless.stop()
  })

  it('writes only recorded answer shapes: permission cancel, question cancel, plan approval, and keeping plan mode only with feedback', async () => {
    const { control, headless, sessionId, conditions } = await rig()
    control.reverse({ token: 'perm-1', id: 0, method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'call-1' }, options: [{ optionId: 'allow-once', name: 'Allow once' }] } })
    await expect(headless.resolveConditionAction(latest(conditions)['grok.permission']!.actions.at(-1) as never)).resolves.toEqual({ ok: true })
    expect(control.rpc.respond).toHaveBeenLastCalledWith('perm-1', { outcome: { outcome: 'cancelled' } })

    control.reverse({ token: 'question-1', id: 1, method: '_x.ai/ask_user_question', params: { sessionId, toolCallId: 'call-2', questions: [{ question: 'Pick one' }] } })
    await expect(headless.resolveConditionAction(latest(conditions)['grok.question']!.actions[0] as never)).resolves.toEqual({ ok: true })
    expect(control.rpc.respond).toHaveBeenLastCalledWith('question-1', { outcome: 'cancelled' })

    control.reverse({ token: 'plan-1', id: 2, method: '_x.ai/exit_plan_mode', params: { sessionId, toolCallId: 'call-3', planContent: 'the plan' } })
    const plan = latest(conditions)['grok.plan-approval']!.actions
    expect(plan.map(action => (action as { payload: { outcome: string } }).payload.outcome)).toEqual(['approved', 'abandoned'])
    const keep = { kind: 'custom', id: 'plan-1:keep', label: 'Keep planning', name: PLAN_REPLY_ACTION, payload: { token: 'plan-1', outcome: 'cancelled' } }
    await expect(headless.resolveConditionAction(keep as never)).resolves.toMatchObject({ ok: false, reason: 'invalid-payload' })
    await expect(headless.resolveConditionAction({ ...keep, payload: { ...keep.payload, feedback: 'Narrow the scope' } } as never)).resolves.toEqual({ ok: true })
    expect(control.rpc.respond).toHaveBeenLastCalledWith('plan-1', { outcome: 'cancelled', feedback: 'Narrow the scope' })

    control.reverse({ token: 'plan-2', id: 3, method: '_x.ai/exit_plan_mode', params: { sessionId, toolCallId: 'call-4', planContent: 'the plan' } })
    await expect(headless.resolveConditionAction(latest(conditions)['grok.plan-approval']!.actions[0] as never)).resolves.toEqual({ ok: true })
    expect(control.rpc.respond).toHaveBeenLastCalledWith('plan-2', { outcome: 'approved' })
    await headless.stop()
  })

  it('cancels over control and never writes a key to the terminal (prompt.cancel)', async () => {
    const { control, headless, pty, sessionId } = await rig()
    await expect(headless.cancelTurn()).resolves.toBe(true)
    expect(control.rpc.notify).toHaveBeenCalledWith('session/cancel', { sessionId })
    expect(pty.writes).toEqual([])
    await headless.stop()
  })

  it('stops by detaching only: no kill, no dispose, no further control observation', async () => {
    const { control, headless, sessionId, semantic } = await rig()
    await headless.stop()
    expect(control.observerCount()).toBe(0)
    control.notification('_x.ai/queue/changed', { sessionId, entries: [], runningPromptId: 'p1' })
    expect(semantic).toEqual([])
    expect(control.rpc.request).not.toHaveBeenCalled()
  })

  it('on terminal exit ends open turns uncertain, settles written submissions uncertain and reports exit', async () => {
    const { control, headless, pty, sessionId, semantic } = await rig()
    control.notification('_x.ai/queue/changed', { sessionId, entries: [], runningPromptId: 'terminal-prompt' })
    const submitted = headless.submitPrompt('late')
    const exited = new Promise(resolve => headless.once('exit', resolve))
    pty.exit({ exitCode: 0 })
    await expect(exited).resolves.toEqual({ exitCode: 0 })
    await expect(submitted).resolves.toMatchObject({ ok: false, reason: 'uncertain', detail: 'terminal-exited' })
    expect(semantic.filter(event => event.type === 'turn_completed')).toMatchObject([{ turnId: 'terminal-prompt', stopReason: 'uncertain' }])
    expect(control.observerCount()).toBe(0)
  })

  it('keeps routing control while the exiting terminal drains, so a completion in that window ends the turn as native says', async () => {
    const { control, headless, pty, sessionId, semantic } = await rig()
    control.notification('_x.ai/queue/changed', { sessionId, entries: [], runningPromptId: 'terminal-prompt' })
    const exited = new Promise(resolve => headless.once('exit', resolve))
    pty.exit({ exitCode: 0 })
    control.notification('_x.ai/session/prompt_complete', { sessionId, promptId: 'terminal-prompt', stopReason: 'cancelled' })
    await exited
    expect(semantic.filter(event => event.type === 'turn_completed')).toMatchObject([{ turnId: 'terminal-prompt', stopReason: 'cancelled' }])
  })

  it("reads history under the launch environment's GROK_HOME, where the observed terminal writes", async () => {
    const launchHome = join(home, 'launch-home')
    const { headless } = await rig({ explicitHome: false, launchHome })
    expect(headless.getTranscriptFile().startsWith(launchHome)).toBe(true)
    await headless.stop()
  })
})
