import { createRequire } from 'node:module'
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IPty } from 'node-pty'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GrokHeadless, type GrokHistoryEvent, type GrokEntryEvent } from './GrokHeadless.js'
import { GrokResponsesProxy } from './proxy/GrokResponsesProxy.js'
import { encodeGrokSessionsDir } from './transcript/SessionDirEncoding.js'

// Only the process boundary is controlled. The real xterm mirror, real
// filesystem tailers, and recorded update envelopes run together; no account,
// model call, developer home, or timing guess is needed to reproduce losses.
const native = createRequire(import.meta.url)('node-pty') as typeof import('node-pty')
const id = '01a07e08-375e-7643-a809-9ab78735e5c7'
const pendingCommandLine = JSON.stringify({ timestamp: 1, method: 'session/update', params: { sessionId: id, update: { sessionUpdate: 'tool_call', toolCallId: 'command-call', title: 'run_terminal_command', rawInput: { command: 'rm -rf ./permission-probe' } } } }) + '\n'
const permissionFixture = JSON.parse(readFileSync(new URL('../testing/fixtures/conditions/command-approval.json', import.meta.url), 'utf8'))
let root: string
let runtime: GrokHeadless | undefined
let processDouble: ReturnType<typeof controlledPty>

function controlledPty() {
  const data = new Set<(value: string) => void>()
  const exits = new Set<(value: { exitCode: number }) => void>()
  const pty: IPty = {
    pid: 123, cols: 120, rows: 40, process: 'controlled-grok', handleFlowControl: false,
    onData: listener => { data.add(listener); return { dispose: () => { data.delete(listener) } } },
    onExit: listener => { exits.add(listener); return { dispose: () => { exits.delete(listener) } } },
    write: vi.fn(), resize: vi.fn(), clear: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    kill: vi.fn(() => { for (const listener of [...exits]) listener({ exitCode: 0 }) }),
  }
  return { pty, data, exits, paint: (text: string) => { for (const listener of data) listener(text) } }
}

function sessionFiles(sessionId = id) {
  const dir = join(root, 'home', 'sessions', encodeGrokSessionsDir(root), sessionId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({ info: { id: sessionId, cwd: root } }))
  return dir
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'grok-lifecycle-'))
  processDouble = controlledPty()
  vi.spyOn(native, 'spawn').mockReturnValue(processDouble.pty)
})
afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe('headless runtime boundary contracts', () => {
  it('exposes ordered history replacement boundaries and marks replacement records as replay', async () => {
    const dir = sessionFiles()
    const path = join(dir, 'chat_history.jsonl')
    const recorded = readFileSync(new URL('../testing/fixtures/recorded/session-014.jsonl', import.meta.url), 'utf8')
    writeFileSync(path, recorded)
    runtime = new GrokHeadless({ cwd: root, grokHome: join(root, 'home'), resumeSessionId: id })
    const events: Array<GrokHistoryEvent | GrokEntryEvent> = []
    runtime.on('grok-history', event => { if (event.channel === 'chat-history') events.push(event) })
    runtime.on('grok-entry', event => events.push(event))
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ type: 'caught-up', generation: 0, complete: true }))
    expect(events[0]).toMatchObject({ type: 'reset', sessionId: id, channel: 'chat-history' })
    expect(events.slice(1, -1).every(event => 'replay' in event && event.replay)).toBe(true)
    writeFileSync(join(dir, 'next'), recorded)
    renameSync(join(dir, 'next'), path)
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ type: 'caught-up', generation: 1, complete: true }))
    expect(events[14]).toMatchObject({ type: 'reset', generation: 1 })
    expect(events.slice(15, -1)).toHaveLength(12)
    expect(events.slice(15, -1).every(event => 'replay' in event && event.replay)).toBe(true)
    appendFileSync(path, recorded.trimEnd().split('\n').at(-1)! + '\n')
    await vi.waitFor(() => expect(events.at(-2)).toMatchObject({ generation: 1, replay: false }))
    writeFileSync(join(dir, 'next'), '')
    renameSync(join(dir, 'next'), path)
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ type: 'caught-up', generation: 2, byteOffset: 0, complete: true }))
    expect(events.at(-2)).toMatchObject({ type: 'reset', generation: 2, snapshotByteLength: 0 })
  })

  it('does not replay replacement updates as live activity or command approvals', async () => {
    const dir = sessionFiles()
    const path = join(dir, 'updates.jsonl')
    writeFileSync(path, '')
    runtime = new GrokHeadless({ cwd: root, grokHome: join(root, 'home'), resumeSessionId: id })
    const boundaries: GrokHistoryEvent[] = []
    const replay: boolean[] = []
    const activity: unknown[] = []
    runtime.on('grok-history', event => { if (event.channel === 'updates') boundaries.push(event) })
    runtime.on('grok-update', event => replay.push(event.replay))
    runtime.on('activity', event => activity.push(event))
    await vi.waitFor(() => expect(boundaries.at(-1)).toMatchObject({ type: 'caught-up', complete: true }))
    const user = JSON.stringify({ timestamp: 1, method: 'session/update', params: { sessionId: id, update: { sessionUpdate: 'user_message_chunk' } } }) + '\n'
    writeFileSync(join(dir, 'next'), user + pendingCommandLine)
    renameSync(join(dir, 'next'), path)
    processDouble.paint('\x1b[2J\x1b[H' + permissionFixture.lines.join('\r\n'))
    await vi.waitFor(() => expect(boundaries.at(-1)).toMatchObject({ type: 'caught-up', generation: 1, complete: true }))
    expect(replay).toEqual([true, true])
    expect(activity).toEqual([])
    expect(runtime.commandPermission).toBeNull()
    appendFileSync(path, pendingCommandLine)
    await vi.waitFor(() => expect(runtime!.commandPermission).not.toBeNull())
    writeFileSync(join(dir, 'next'), '')
    renameSync(join(dir, 'next'), path)
    await vi.waitFor(() => expect(boundaries.at(-1)).toMatchObject({ generation: 2, complete: true }))
    expect(runtime.commandPermission).toBeNull()
  })

  it('keeps fresh-session initial records live and reports invalid native shapes as incomplete', async () => {
    runtime = new GrokHeadless({ cwd: root, grokHome: join(root, 'home') })
    const dir = sessionFiles(runtime.sessionIdentity)
    writeFileSync(join(dir, 'chat_history.jsonl'), '{"type":"assistant","content":42}\n{"type":"assistant","content":"fixture"}\n')
    const boundaries: GrokHistoryEvent[] = []
    const entries: GrokEntryEvent[] = []
    runtime.on('grok-history', event => { if (event.channel === 'chat-history') boundaries.push(event) })
    runtime.on('grok-entry', event => entries.push(event))
    await vi.waitFor(() => expect(boundaries.at(-1)).toMatchObject({ type: 'caught-up', complete: false }))
    expect(entries).toHaveLength(1)
    expect(entries[0].replay).toBe(false)
  })

  it('allows a newly reissued approval after replacement without accepting its stale old action token', async () => {
    const dir = sessionFiles()
    const path = join(dir, 'updates.jsonl')
    writeFileSync(path, '')
    runtime = new GrokHeadless({ cwd: root, grokHome: join(root, 'home'), resumeSessionId: id })
    const boundaries: GrokHistoryEvent[] = []
    runtime.on('grok-history', event => { if (event.channel === 'updates') boundaries.push(event) })
    await vi.waitFor(() => expect(boundaries.at(-1)).toMatchObject({ type: 'caught-up' }))
    appendFileSync(path, pendingCommandLine)
    processDouble.paint('\x1b[2J\x1b[H' + permissionFixture.lines.join('\r\n'))
    await vi.waitFor(() => expect(runtime!.commandPermission).not.toBeNull())
    const oldId = runtime.commandPermission!.id
    expect(runtime.answerCommandPermission(oldId, 'allow-once')).toBe(true)
    writeFileSync(join(dir, 'next'), '')
    renameSync(join(dir, 'next'), path)
    await vi.waitFor(() => expect(boundaries.at(-1)).toMatchObject({ generation: 1, complete: true }))
    appendFileSync(path, pendingCommandLine)
    await vi.waitFor(() => expect(runtime!.commandPermission).not.toBeNull())
    const newId = runtime.commandPermission!.id
    expect(newId).not.toBe(oldId)
    expect(runtime.answerCommandPermission(oldId, 'reject-once')).toBe(false)
    expect(runtime.answerCommandPermission(newId, 'reject-once')).toBe(true)
    expect(processDouble.pty.write).toHaveBeenCalledTimes(2)
  })

  it.each([['allow-once', '3'], ['reject-once', '4']] as const)('answers %s using only its observed one-shot key %s', async (choice, key) => {
    const dir = sessionFiles()
    writeFileSync(join(dir, 'updates.jsonl'), '')
    const fixture = JSON.parse(readFileSync(new URL('../testing/fixtures/conditions/command-approval.json', import.meta.url), 'utf8'))
    runtime = new GrokHeadless({ cwd: root, grokHome: join(root, 'home'), resumeSessionId: id })
    await new Promise(resolve => runtime!.once('session', resolve))
    appendFileSync(join(dir, 'updates.jsonl'), pendingCommandLine)
    processDouble.paint('\x1b[2J\x1b[H' + fixture.lines.join('\r\n'))
    await vi.waitFor(() => expect(runtime!.commandPermission).toMatchObject({ kind: 'grok.command-permission' }))
    const card = runtime.commandPermission!
    expect(runtime.answerCommandPermission(card.id, choice)).toBe(true)
    expect(processDouble.pty.write).toHaveBeenCalledWith(key)
    expect(processDouble.pty.write).not.toHaveBeenCalledWith('1')
    expect(runtime.answerCommandPermission(card.id, choice)).toBe(false)
  })

  it('refuses stale permission actions after the native card leaves the screen', async () => {
    const dir = sessionFiles()
    writeFileSync(join(dir, 'updates.jsonl'), '')
    const fixture = JSON.parse(readFileSync(new URL('../testing/fixtures/conditions/command-approval.json', import.meta.url), 'utf8'))
    runtime = new GrokHeadless({ cwd: root, grokHome: join(root, 'home'), resumeSessionId: id })
    await new Promise(resolve => runtime!.once('session', resolve))
    appendFileSync(join(dir, 'updates.jsonl'), pendingCommandLine)
    processDouble.paint('\x1b[2J\x1b[H' + fixture.lines.join('\r\n'))
    await vi.waitFor(() => expect(runtime!.commandPermission).toMatchObject({ kind: 'grok.command-permission' }))
    const card = runtime.commandPermission!
    processDouble.paint('\x1b[2J\x1b[HNormal composer')
    await vi.waitFor(() => expect(runtime!.commandPermission).toBeNull())
    expect(runtime.answerCommandPermission(card.id, 'allow-once')).toBe(false)
    expect(processDouble.pty.write).not.toHaveBeenCalled()
  })

  it('does not turn replayed, interrupted tool history into an actionable approval', async () => {
    const dir = sessionFiles()
    writeFileSync(join(dir, 'updates.jsonl'), pendingCommandLine)
    runtime = new GrokHeadless({ cwd: root, grokHome: join(root, 'home'), resumeSessionId: id })
    const replayed = new Promise(resolve => runtime!.once('grok-update', resolve))
    processDouble.paint('\x1b[2J\x1b[H' + permissionFixture.lines.join('\r\n'))
    await replayed
    await vi.waitFor(() => expect(runtime!.commandPermissionState).toMatchObject({ status: 'none' }))
  })

  it('reports unacknowledged resize rather than pretending no card exists', async () => {
    sessionFiles()
    runtime = new GrokHeadless({ cwd: root, grokHome: join(root, 'home'), resumeSessionId: id })
    processDouble.paint('Ready')
    await vi.waitFor(() => expect(runtime!.commandPermissionState).toMatchObject({ status: 'none' }))
    runtime.resize(100, 40)
    expect(runtime.commandPermissionState).toMatchObject({ status: 'resizing' })
    expect(runtime.commandPermission).toBeNull()
  })

  it('clears a published permission card on disposal', async () => {
    const dir = sessionFiles()
    writeFileSync(join(dir, 'updates.jsonl'), '')
    runtime = new GrokHeadless({ cwd: root, grokHome: join(root, 'home'), resumeSessionId: id })
    const cards: unknown[] = []
    runtime.on('command-permission', card => cards.push(card))
    await new Promise(resolve => runtime!.once('session', resolve))
    appendFileSync(join(dir, 'updates.jsonl'), pendingCommandLine)
    processDouble.paint('\x1b[2J\x1b[H' + permissionFixture.lines.join('\r\n'))
    await vi.waitFor(() => expect(cards.at(-1)).toMatchObject({ kind: 'grok.command-permission' }))
    await runtime.dispose()
    expect(cards.at(-1)).toBeNull()
    expect(runtime.commandPermissionState).toMatchObject({ status: 'closed' })
  })

  it('keeps native idle detection working when a permission consumer throws', async () => {
    const dir = sessionFiles()
    writeFileSync(join(dir, 'updates.jsonl'), '')
    runtime = new GrokHeadless({ cwd: root, grokHome: join(root, 'home'), resumeSessionId: id })
    const cards: unknown[] = []
    runtime.on('command-permission', card => cards.push(card))
    await new Promise(resolve => runtime!.once('session', resolve))
    appendFileSync(join(dir, 'updates.jsonl'), pendingCommandLine)
    processDouble.paint('\x1b[2J\x1b[H' + permissionFixture.lines.join('\r\n'))
    await vi.waitFor(() => expect(cards.at(-1)).toMatchObject({ kind: 'grok.command-permission' }))
    runtime.on('command-permission', () => { throw new Error('test consumer failed') })
    let idle = false
    runtime.on('idle', () => { idle = true })
    runtime.sendPrompt('controlled lifecycle stimulus')
    appendFileSync(join(dir, 'updates.jsonl'), JSON.stringify({ timestamp: 2, method: 'session/update', params: { sessionId: id, update: { sessionUpdate: 'turn_completed' } } }) + '\n')
    await vi.waitFor(() => expect(idle).toBe(true))
    expect(runtime.lastError?.message).toBe('test consumer failed')
  })

  it('starts an owned relay before spawning and uses one origin for catalog and inference', async () => {
    runtime = await GrokHeadless.create({ cwd: root, grokHome: join(root, 'home'), streaming: { upstreamBaseUrl: 'http://127.0.0.1:1/v1' } })
    const env = vi.mocked(native.spawn).mock.calls[0]![2].env!
    expect(env.GROK_MODELS_BASE_URL).toBe(runtime.streamingInfo!.proxyBaseUrl)
    expect(env.GROK_MODELS_LIST_URL).toBe(runtime.streamingInfo!.modelsListUrl)
    expect(env.GROK_XAI_API_BASE_URL).toBe(runtime.streamingInfo!.proxyBaseUrl)
    const identities: string[] = []
    runtime.on('session', event => identities.push(event.sessionId))
    await vi.waitFor(() => expect(identities).toEqual([runtime!.sessionIdentity]))
    const url = `${runtime.streamingInfo!.proxyBaseUrl}/models`
    await runtime.dispose()
    await expect(fetch(url)).rejects.toThrow()
  })

  it('closes the owned relay if native process creation fails', async () => {
    const create = vi.spyOn(GrokResponsesProxy, 'create')
    vi.mocked(native.spawn).mockImplementation(() => { throw new Error('test spawn failed') })
    await expect(GrokHeadless.create({ cwd: root, grokHome: join(root, 'home'), streaming: { upstreamBaseUrl: 'http://127.0.0.1:1/v1' } })).rejects.toThrow('test spawn failed')
    const relay = await create.mock.results[0]!.value as GrokResponsesProxy
    await expect(fetch(`${relay.info.proxyBaseUrl}/models`)).rejects.toThrow()
  })

  it('keeps the direct-constructor catalog on the supplied relay by default', () => {
    runtime = new GrokHeadless({ cwd: root, grokHome: join(root, 'home'), proxyUrl: 'http://127.0.0.1:9876/v1' })
    expect(vi.mocked(native.spawn).mock.calls[0]![2].env!.GROK_MODELS_LIST_URL).toBe('http://127.0.0.1:9876/v1/models')
  })

  it('cleans the owned relay on the early-exit spawn failure path', async () => {
    runtime = await GrokHeadless.create({ cwd: root, grokHome: join(root, 'home'), streaming: { upstreamBaseUrl: 'http://127.0.0.1:1/v1' } })
    const identities: string[] = []
    const exits: number[] = []
    runtime.on('session', event => identities.push(event.sessionId))
    runtime.on('exit', event => exits.push(event.code!))
    for (const listener of [...processDouble.exits]) listener({ exitCode: 1 })
    await runtime.dispose()
    expect(identities).toEqual([])
    expect(exits).toEqual([1])
    await expect(fetch(runtime.streamingInfo!.proxyBaseUrl)).rejects.toThrow()
  })

  it('reports a completed API prompt with no relay observations instead of implying streaming worked', async () => {
    runtime = await GrokHeadless.create({ cwd: root, grokHome: join(root, 'home'), streaming: { upstreamBaseUrl: 'http://127.0.0.1:1/v1' } })
    const diagnostics: string[] = []
    runtime.on('stream-event', event => { if (event.type === 'diagnostic') diagnostics.push(event.code) })
    await new Promise(resolve => setImmediate(resolve))
    runtime.sendPrompt('test prompt')
    const dir = sessionFiles(runtime.sessionIdentity)
    writeFileSync(join(dir, 'updates.jsonl'), JSON.stringify({ timestamp: 1, method: 'session/update', params: { sessionId: runtime.sessionIdentity, update: { sessionUpdate: 'turn_completed' } } }) + '\n')
    await vi.waitFor(() => expect(diagnostics).toContain('no-stream-observations'))
  })

  it('replays a recorded turn_completed envelope at its actual public nesting level', async () => {
    const dir = sessionFiles()
    const updates = readFileSync(new URL('../testing/fixtures/updates.toolcall.jsonl', import.meta.url), 'utf8')
    writeFileSync(join(dir, 'updates.jsonl'), updates)
    runtime = new GrokHeadless({ cwd: root, grokHome: join(root, 'home'), resumeSessionId: id })
    const observed: string[] = []
    runtime.on('grok-update', event => observed.push(event.params.update.sessionUpdate))
    await vi.waitFor(() => expect(observed.at(-1)).toBe('turn_completed'))
    expect(observed).toEqual(updates.trim().split('\n').map(line => JSON.parse(line).params.update.sessionUpdate))
  })

  it('attaches the terminal mirror so provider output reaches screen subscribers', async () => {
    sessionFiles()
    runtime = new GrokHeadless({ cwd: root, grokHome: join(root, 'home'), resumeSessionId: id })
    const screens: string[] = []
    runtime.on('screen', event => screens.push(event.snapshot.plain))
    processDouble.paint('\x1b[2J\x1b[HRecorded permission card')
    await vi.waitFor(() => expect(screens.some(text => text.includes('Recorded permission card'))).toBe(true))
  })

  it('reports a corrupt committed record once and continues to a valid record', async () => {
    const dir = sessionFiles()
    writeFileSync(join(dir, 'chat_history.jsonl'), '{"type":"assistant","content":42}\n{"type":"assistant","content":"survives"}\n')
    runtime = new GrokHeadless({ cwd: root, grokHome: join(root, 'home'), resumeSessionId: id })
    const errors: Error[] = []
    const content: string[] = []
    runtime.on('error', error => errors.push(error))
    runtime.on('grok-entry', event => { if (event.item.type === 'assistant') content.push(event.item.content) })
    await vi.waitFor(() => expect(content).toEqual(['survives']))
    expect(errors).toHaveLength(1)
  })

  it('pins a fresh UUID before spawn instead of claiming an existing session by directory order', async () => {
    sessionFiles()
    runtime = new GrokHeadless({ cwd: root, grokHome: join(root, 'home') })
    const args = vi.mocked(native.spawn).mock.calls[0]![1] as string[]
    const position = args.indexOf('--session-id')
    expect(position).toBeGreaterThanOrEqual(0)
    expect(args[position + 1]).toMatch(/^[0-9a-f-]{36}$/)
    expect(args[position + 1]).not.toBe(id)
  })

  it('delivers session identity after subscriptions attach, including resume', async () => {
    sessionFiles()
    runtime = new GrokHeadless({ cwd: root, grokHome: join(root, 'home'), resumeSessionId: id })
    const identities: string[] = []
    runtime.on('session', event => identities.push(event.sessionId))
    await vi.waitFor(() => expect(identities).toEqual([id]))
  })

  it('releases all listeners and missing-file waiters when the process exits', async () => {
    sessionFiles()
    runtime = new GrokHeadless({ cwd: root, grokHome: join(root, 'home'), resumeSessionId: id })
    const entries: string[] = []
    runtime.on('grok-entry', event => entries.push(event.raw))
    processDouble.pty.kill()
    await runtime.dispose()
    expect(processDouble.data.size).toBe(0)
    expect(processDouble.exits.size).toBe(0)
    expect(() => runtime!.sendPrompt('must not deliver after exit')).toThrow(/closed/i)
    expect(entries).toEqual([])
  })

  it('waits for an asynchronous PTY exit before resolving dispose', async () => {
    sessionFiles()
    vi.mocked(processDouble.pty.kill).mockImplementation(() => {
      setTimeout(() => { for (const listener of [...processDouble.exits]) listener({ exitCode: 0 }) }, 20)
    })
    runtime = new GrokHeadless({ cwd: root, grokHome: join(root, 'home'), resumeSessionId: id })
    const exits: number[] = []
    runtime.on('exit', event => exits.push(event.code!))
    await runtime.dispose()
    expect(exits).toEqual([0])
    expect(processDouble.exits.size).toBe(0)
  })

  it('drains a final record written at exit before publishing exit to consumers', async () => {
    const dir = sessionFiles()
    const path = join(dir, 'chat_history.jsonl')
    writeFileSync(path, '{"type":"assistant","content":"initial"}\n')
    runtime = new GrokHeadless({ cwd: root, grokHome: join(root, 'home'), resumeSessionId: id })
    const order: string[] = []
    runtime.on('grok-entry', event => { if (event.item.type === 'assistant') order.push(event.item.content) })
    runtime.on('exit', () => order.push('exit'))
    await vi.waitFor(() => expect(order).toEqual(['initial']))
    appendFileSync(path, '{"type":"assistant","content":"final"}\n')
    processDouble.pty.kill()
    await runtime.dispose()
    expect(order).toEqual(['initial', 'final', 'exit'])
  })

  it('rejects malformed and foreign envelopes before emitting a typed update', async () => {
    const dir = sessionFiles()
    writeFileSync(join(dir, 'updates.jsonl'), [
      'null', JSON.stringify({ params: { sessionId: id } }),
      JSON.stringify({ timestamp: 1, method: 'session/update', params: { sessionId: 'foreign', update: { sessionUpdate: 'turn_completed' } } }),
    ].join('\n') + '\n')
    runtime = new GrokHeadless({ cwd: root, grokHome: join(root, 'home'), resumeSessionId: id })
    const errors: Error[] = []
    const updates: unknown[] = []
    runtime.on('error', error => errors.push(error))
    runtime.on('grok-update', event => updates.push(event))
    await vi.waitFor(() => expect(errors).toHaveLength(3))
    expect(updates).toEqual([])
    expect(errors[0]!.message).toMatch(/Malformed update/)
  })

  it('marks resumed update evidence as replay without manufacturing live activity', async () => {
    const dir = sessionFiles()
    const updates = readFileSync(new URL('../testing/fixtures/updates.toolcall.jsonl', import.meta.url), 'utf8')
    writeFileSync(join(dir, 'updates.jsonl'), updates)
    runtime = new GrokHeadless({ cwd: root, grokHome: join(root, 'home'), resumeSessionId: id })
    const replay: boolean[] = []
    const activity: string[] = []
    runtime.on('grok-update', event => replay.push(event.replay))
    runtime.on('activity', () => activity.push('active'))
    runtime.on('idle', () => activity.push('idle'))
    await vi.waitFor(() => expect(replay).toHaveLength(9))
    expect(replay.every(Boolean)).toBe(true)
    expect(activity).toEqual([])
  })

  it('retains pending file observation while dispose waits for a delayed shutdown flush', async () => {
    const dir = sessionFiles()
    vi.mocked(processDouble.pty.kill).mockImplementation(() => {
      setTimeout(() => {
        writeFileSync(join(dir, 'chat_history.jsonl'), '{"type":"assistant","content":"shutdown flush"}\n')
        for (const listener of [...processDouble.exits]) listener({ exitCode: 0 })
      }, 300)
    })
    runtime = new GrokHeadless({ cwd: root, grokHome: join(root, 'home'), resumeSessionId: id })
    const content: string[] = []
    runtime.on('grok-entry', event => { if (event.item.type === 'assistant') content.push(event.item.content) })
    await new Promise(resolve => setTimeout(resolve, 0))
    await runtime.dispose()
    expect(content).toEqual(['shutdown flush'])
  })
})
