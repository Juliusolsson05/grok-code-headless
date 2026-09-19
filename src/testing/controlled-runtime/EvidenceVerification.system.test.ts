import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { RuntimeCapture } from './Capture.js'
import {
  EVIDENCE_RULES_VERSION, EvidenceRejectedError, evidenceVerdictPath, readEvidenceVerdict, sealEvidenceVerdict,
  verifyLifecycleScenarioEvidence, verifyScenarioEvidence,
} from './EvidenceVerification.js'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'g-evidence-test-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const SESSION = '00000000-0000-4000-8000-000000000001'
const OTHER_SESSION = '00000000-0000-4000-8000-0000000000ff'

const packet = (value: unknown) => {
  const body = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4); header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}
const acp = (message: unknown) => packet({ type: 'acp', payload: JSON.stringify(message) })
const undecodableAcp = () => packet({ type: 'acp', payload: '{not json' })

type Connection = { role: 'control' | 'tui' | 'guard-upstream'; connectionId: string }
type Epoch = { control: Connection; tui: Connection; upstream: Connection }

function openEpoch(capture: RuntimeCapture, epoch: number): Epoch {
  const connections: Epoch = {
    control: { role: 'control', connectionId: `control-${epoch}` },
    tui: { role: 'tui', connectionId: `tui-${epoch}` },
    upstream: { role: 'guard-upstream', connectionId: `upstream-${epoch}` },
  }
  for (const connection of Object.values(connections)) capture.record('ipc', 'opened', connection)
  return connections
}

function recordHistory(capture: RuntimeCapture, sessionId: string, file: string) {
  const line = Buffer.from(JSON.stringify({ type: 'controlled', file }))
  capture.record('history', 'reset', { sessionId, file, generation: 0, snapshotByteLength: line.length + 1 })
  capture.record('history', 'row', { sessionId, file, generation: 0, lineStartOffset: 0 }, line)
  capture.record('history', 'caught-up', { sessionId, file, generation: 0, byteOffset: line.length + 1, snapshotByteLength: line.length + 1, complete: true })
  capture.record('file', 'snapshot', { sessionId, file, label: 'after-owned-exit', stable: true }, Buffer.concat([line, Buffer.from('\n')]))
}

type TransportVariant = 'none' | 'unmatched-write' | 'queued-before-open' | 'data-after-close' | 'received-before-open' | 'never-opened' |
  'duplicate-open' | 'role-mismatch' | 'pre-open-non-guard' | 'pre-open-non-register' | 'pre-open-twice'

async function validCapture(variant: TransportVariant = 'none', scenario = 'controlled-verifier') {
  const sessionId = SESSION
  const capture = await RuntimeCapture.create(root, { scenario })
  capture.record('lifecycle', 'capture-start', { nativeVersion: 'controlled' })
  capture.record('leader', 'spawned', { pid: 42 })
  capture.record('scenario', 'started', { id: scenario })
  for (const [index, role] of (['control', 'tui', 'guard-upstream'] as const).entries()) {
    const connectionId = `connection-${index}`
    const writeId = index + 1
    const register = packet({ type: 'register' })
    const fixture = packet({ jsonrpc: '2.0', id: writeId, method: 'fixture' })
    const label = variant === 'role-mismatch' && role === 'tui' ? 'control' : role
    const attempt = (id: number, bytes: Buffer) => capture.record('ipc', 'write-attempt', { role: label, connectionId, writeId: id }, bytes)
    const complete = (id: number) => capture.record('ipc', 'write-complete', { role: label, connectionId, writeId: id })
    // The real guard's registration write to its upstream socket is observed
    // before that socket's `connect` produces `opened`.
    let queued = false
    if (variant === 'received-before-open' && role === 'tui') capture.record('ipc', 'received', { role, connectionId }, register)
    if ((variant === 'queued-before-open' || variant === 'pre-open-twice') && role === 'guard-upstream') { attempt(writeId, register); queued = true }
    if (variant === 'pre-open-twice' && role === 'guard-upstream') attempt(30, register)
    if (variant === 'pre-open-non-guard' && role === 'control') { attempt(writeId, register); queued = true }
    if (variant === 'pre-open-non-register' && role === 'guard-upstream') { attempt(writeId, fixture); queued = true }
    capture.record('ipc', 'opened', { role, connectionId })
    if (variant === 'duplicate-open' && index === 0) capture.record('ipc', 'opened', { role, connectionId })
    if (!queued && (variant !== 'unmatched-write' || index !== 0)) attempt(writeId, fixture)
    complete(writeId)
    if (variant === 'pre-open-twice' && role === 'guard-upstream') complete(30)
    capture.record('ipc', 'closing', { role, connectionId })
    capture.record('ipc', 'closed', { role, connectionId })
    if (variant === 'data-after-close' && index === 0) capture.record('ipc', 'received', { role, connectionId }, packet({ jsonrpc: '2.0', id: 1, result: {} }))
  }
  if (variant === 'never-opened') {
    const orphan = { role: 'guard-upstream', connectionId: 'connection-orphan' }
    capture.record('ipc', 'write-attempt', { ...orphan, writeId: 9 }, packet({ type: 'register' }))
    capture.record('ipc', 'write-complete', { ...orphan, writeId: 9 })
  }
  for (const file of ['chat_history.jsonl', 'updates.jsonl', 'events.jsonl']) recordHistory(capture, sessionId, file)
  capture.record('file', 'snapshot', { sessionId, file: 'summary.json', label: 'after-owned-exit', stable: true }, Buffer.from('{}'))
  capture.record('scenario', 'passed', { id: scenario })
  capture.record('leader', 'exited', { pid: 42, exitCode: 0 })
  capture.record('lifecycle', 'observation-window-drained')
  capture.finish('passed')
  return capture.directory
}

it('independently validates a complete scenario and reconstructed native files', async () => {
  await expect(verifyScenarioEvidence(await validCapture())).resolves.toMatchObject({
    manifest: { scenarioOutcome: 'passed', captureComplete: true },
  })
})

it('rejects a successful-looking capture with an unmatched transport write', async () => {
  await expect(verifyScenarioEvidence(await validCapture('unmatched-write'))).rejects.toThrow(/receipt has no preceding attempt/)
})

it('accepts the single guard-upstream registration queued before its socket opens, as real captures record', async () => {
  await expect(verifyScenarioEvidence(await validCapture('queued-before-open'))).resolves.toMatchObject({
    manifest: { scenarioOutcome: 'passed', captureComplete: true },
  })
})

it.each<[TransportVariant, RegExp]>([
  ['data-after-close', /outside its connection lifetime/],
  ['received-before-open', /outside its connection lifetime/],
  ['never-opened', /outside its connection lifetime/],
  ['pre-open-non-guard', /outside its connection lifetime/],
  ['pre-open-non-register', /outside its connection lifetime/],
  ['pre-open-twice', /outside its connection lifetime/],
  ['duplicate-open', /opened twice/],
  ['role-mismatch', /role does not match its connection/],
])('rejects transport evidence with %s', async (variant, reason) => {
  await expect(verifyScenarioEvidence(await validCapture(variant))).rejects.toThrow(reason)
})

it('rejects a capture whose manifest label differs from its journaled scenario, since the label selects the rules', async () => {
  const directory = await validCapture()
  const manifestPath = join(directory, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.metadata.scenario = 'native-restart-resume'
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  await expect(verifyScenarioEvidence(directory)).rejects.toThrow(/does not match its journaled scenario/)
})

it('rejects a restart capture without two native epochs', async () => {
  await expect(verifyScenarioEvidence(await validCapture('none', 'native-restart-resume'))).rejects.toThrow(/lacks two owned native process epochs/)
})

// Hand-built packets below are instrumentation tests of the verifier's rules,
// NOT Grok behavior fixtures (the exact recordings are private and cannot be
// committed). Their ORDER is copied from the recorded native restart capture on
// Grok 1.0.30: the first control connection's session/new is answered with S and
// a prompt is answered before a stable checkpoint and the first epoch's exit;
// after a new leader spawns, the resumed TUI connection receives `session/load`
// for S, the guard writes replayed `session/update user_message_chunk` frames
// BEFORE the load answer, native rewrites chat_history to the same bytes, a
// stable checkpoint is read, the resumed control connection's session/prompt is
// answered with a stopReason, the turn's inference request ends with the resumed
// prompt after an item carrying the pre-restart prompt, and a second checkpoint
// shows the file grew while keeping its earlier bytes. Each variant changes
// exactly one of those facts, and each test pins the rule that must refuse it so
// a variant that breaks for an unrelated reason cannot pass unnoticed.
const PRE_RESTART_TEXT = 'Controlled prompt before restart.'
const RESUMED_TEXT = 'Controlled prompt after resume.'

type RestartVariant = {
  leaderPidsMissing?: boolean
  firstLeaderExitsAfterResume?: boolean
  firstTuiExitsAfterResume?: boolean
  previousLeaderAbsent?: boolean
  verificationSessionId?: string
  assignedSessionId?: string
  sessionNewIdReused?: boolean
  firstPromptAnswer?: 'result' | 'none' | 'error'
  firstPromptTextless?: boolean
  preRestartCheckpoint?: 'stable' | 'missing' | 'unstable' | 'empty' | 'before-answer' | 'after-exit'
  loadSessionId?: string
  replaySessionId?: string
  loadOn?: 'resumed-tui' | 'pre-restart-tui' | 'guard-upstream'
  earlierTuiWriteError?: boolean
  loadAnswer?: 'result' | 'none' | 'error' | 'error-then-reused-success' | 'reused-before-answer' | 'earlier-unanswered-id' |
    'twice-outstanding' | 'string-id' | 'other-connection' | 'undecodable-before-answer' | 'write-error'
  replay?: 'before-answer' | 'after-answer' | 'none'
  replayReceipt?: 'write-complete' | 'write-error'
  livePromptBeforeLoadAnswer?: 'none' | 'control' | 'tui'
  guardHold?: 'none' | 'before-load-answer' | 'during-prompt'
  resumedPromptOnFirstControl?: boolean
  resumedPromptIdReused?: boolean
  promptAnswer?: 'result' | 'none' | 'error' | 'after-leader-exit' | 'undecodable-first'
  resumedInference?: 'carries-history' | 'missing-history' | 'none' | 'outside-window' | 'title-carries-history' |
    'summary-sidecar-carries-history' | 'history-in-same-item'
  beforeCheckpoint?: 'stable' | 'unstable' | 'missing'
  resumedHistory?: 'kept' | 'lost'
  appendAfterPrompt?: boolean
  afterCheckpoint?: 'grown' | 'rewritten' | 'before-answer'
}

async function restartCapture(variant: RestartVariant = {}) {
  const {
    leaderPidsMissing = false, firstLeaderExitsAfterResume = false, firstTuiExitsAfterResume = false, previousLeaderAbsent = true,
    verificationSessionId = SESSION, assignedSessionId = SESSION, sessionNewIdReused = false, firstPromptAnswer = 'result',
    firstPromptTextless = false, preRestartCheckpoint = 'stable', loadSessionId = SESSION, replaySessionId = SESSION, loadOn = 'resumed-tui',
    earlierTuiWriteError = false, loadAnswer = 'result', replay = 'before-answer', replayReceipt = 'write-complete',
    livePromptBeforeLoadAnswer = 'none', guardHold = 'none', resumedPromptOnFirstControl = false, resumedPromptIdReused = false,
    promptAnswer = 'result', resumedInference = 'carries-history', beforeCheckpoint = 'stable', resumedHistory = 'kept',
    appendAfterPrompt = true, afterCheckpoint = 'grown',
  } = variant
  const file = 'chat_history.jsonl'
  const first = Buffer.from(JSON.stringify({ type: 'user', controlled: 'before-restart' }))
  const second = Buffer.from(JSON.stringify({ type: 'user', controlled: 'after-resume' }))
  // Longer than `first`, so a lost-history variant reaches the byte comparison
  // rather than failing the length check before it.
  const unrelated = Buffer.from(JSON.stringify({ type: 'user', controlled: 'unrelated-conversation-row' }))
  const line = (row: Buffer) => Buffer.concat([row, Buffer.from('\n')])
  const capture = await RuntimeCapture.create(root, { scenario: 'native-restart-resume' })
  let writeId = 0
  const writeBytes = (connection: Connection, bytes: Buffer, receipt: 'write-complete' | 'write-error' = 'write-complete') => {
    const id = ++writeId
    capture.record('ipc', 'write-attempt', { ...connection, writeId: id }, bytes)
    capture.record('ipc', receipt, { ...connection, writeId: id })
  }
  const write = (connection: Connection, message: unknown, receipt: 'write-complete' | 'write-error' = 'write-complete') => writeBytes(connection, acp(message), receipt)
  const receive = (connection: Connection, message: unknown) => capture.record('ipc', 'received', connection, acp(message))
  const close = (...connections: Connection[]) => { for (const connection of connections) capture.record('ipc', 'closed', connection) }
  const chatCheckpoint = (label: string, bytes: Buffer, stable = true) => capture.record('file', 'snapshot', { sessionId: SESSION, file, label, stable }, bytes)
  const pid = (value: number) => leaderPidsMissing ? {} : { pid: value }
  const inference = (requestId: string, body: unknown) => capture.record('http', 'request',
    { requestId, path: '/v1/responses', method: 'POST', headerPolicy: 'credentials excluded' }, Buffer.from(JSON.stringify(body)))
  const userItem = (text: string) => ({ role: 'user', content: [{ type: 'input_text', text }] })
  const assistantItem = { role: 'assistant', content: [{ type: 'output_text', text: 'controlled reply' }] }
  capture.record('lifecycle', 'capture-start', { nativeVersion: 'controlled' })

  capture.record('leader', 'spawned', { kind: 'spawned', ...pid(41) })
  const previous = openEpoch(capture, 1)
  const newSession = { jsonrpc: '2.0', id: 'new-1', method: 'session/new', params: { cwd: '/fixture', mcpServers: [], _meta: { sessionId: SESSION } } }
  write(previous.control, newSession)
  if (sessionNewIdReused) write(previous.control, newSession)
  receive(previous.control, { jsonrpc: '2.0', id: 'new-1', result: { sessionId: assignedSessionId } })
  capture.record('history', 'reset', { sessionId: SESSION, file, generation: 0, snapshotByteLength: 0 })
  capture.record('history', 'caught-up', { sessionId: SESSION, file, generation: 0, byteOffset: 0, snapshotByteLength: 0, complete: true })
  capture.record('tui', 'spawn-returned', { epoch: 1, pid: 51 })
  capture.record('scenario', 'started', { id: 'native-restart-resume' })
  write(previous.control, { jsonrpc: '2.0', id: 'prompt-1', method: 'session/prompt',
    params: { sessionId: SESSION, prompt: firstPromptTextless ? [{ type: 'image', data: 'AA==', mimeType: 'image/png' }] : [{ type: 'text', text: PRE_RESTART_TEXT }] } })
  capture.record('history', 'row', { sessionId: SESSION, file, generation: 0, lineStartOffset: 0 }, first)
  capture.record('history', 'caught-up', { sessionId: SESSION, file, generation: 0, byteOffset: first.length + 1, snapshotByteLength: first.length + 1, complete: true })
  const preRestartBytes = preRestartCheckpoint === 'empty' ? Buffer.alloc(0) : line(first)
  if (preRestartCheckpoint === 'before-answer') chatCheckpoint('before-tui-restart', preRestartBytes)
  if (firstPromptAnswer === 'result') receive(previous.control, { jsonrpc: '2.0', id: 'prompt-1', result: { stopReason: 'end_turn' } })
  if (firstPromptAnswer === 'error') receive(previous.control, { jsonrpc: '2.0', id: 'prompt-1', error: { code: -32603, message: 'controlled failure' } })
  if (['stable', 'unstable', 'empty'].includes(preRestartCheckpoint)) chatCheckpoint('before-tui-restart', preRestartBytes, preRestartCheckpoint !== 'unstable')
  if (!firstTuiExitsAfterResume) capture.record('tui', 'exited', { epoch: 1, exitCode: 0, signal: 0 })
  close(previous.tui, previous.upstream)
  if (!resumedPromptOnFirstControl) close(previous.control)
  const firstLeaderExit = () => capture.record('leader', 'exited', { kind: 'exited', ...pid(41), exitCode: 143, signal: null })
  if (!firstLeaderExitsAfterResume) firstLeaderExit()
  if (preRestartCheckpoint === 'after-exit') chatCheckpoint('before-tui-restart', preRestartBytes)

  const stale: Connection = { role: 'tui', connectionId: 'tui-stale' }
  if (loadOn === 'pre-restart-tui') capture.record('ipc', 'opened', stale)
  capture.record('leader', 'spawned', { kind: 'spawned', ...pid(42) })
  if (firstLeaderExitsAfterResume) firstLeaderExit()
  const resumed = openEpoch(capture, 2)
  capture.record('tui', 'spawn-returned', { epoch: 2, pid: 52 })
  if (firstTuiExitsAfterResume) capture.record('tui', 'exited', { epoch: 1, exitCode: 0, signal: 0 })
  if (guardHold === 'before-load-answer') capture.record('guard', 'holding', { reason: 'protocol' })
  const loadConnection = loadOn === 'resumed-tui' ? resumed.tui : loadOn === 'guard-upstream' ? resumed.upstream : stale
  if (earlierTuiWriteError) write(loadConnection, { jsonrpc: '2.0', method: '_x.ai/mcp/servers_updated', params: {} }, 'write-error')
  const sessionInfo = { jsonrpc: '2.0', id: 3, method: '_x.ai/session/info', params: { sessionId: SESSION } }
  if (loadAnswer === 'earlier-unanswered-id') receive(loadConnection, sessionInfo)
  if (loadAnswer === 'twice-outstanding') {
    receive(loadConnection, sessionInfo); receive(loadConnection, sessionInfo)
    write(loadConnection, { jsonrpc: '2.0', id: 3, result: {} })
  }
  receive(loadConnection, { jsonrpc: '2.0', id: 3, method: 'session/load', params: { sessionId: loadSessionId, cwd: '/fixture', mcpServers: [] } })
  const replayConversation = () => write(loadConnection, {
    jsonrpc: '2.0', method: 'session/update',
    params: { sessionId: replaySessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: PRE_RESTART_TEXT } } },
  }, replayReceipt)
  const loadSuccess = { jsonrpc: '2.0', id: 3, result: { models: {} } }
  const loadRefusal = { jsonrpc: '2.0', id: 3, error: { code: -32603, message: 'controlled refusal' } }
  const livePrompt = (id: string) => ({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId: SESSION, prompt: [{ type: 'text', text: 'live' }] } })
  if (replay === 'before-answer') replayConversation()
  if (livePromptBeforeLoadAnswer === 'control') write(resumed.control, livePrompt('prompt-live'))
  if (livePromptBeforeLoadAnswer === 'tui') receive(loadConnection, livePrompt('4'))
  if (['result', 'earlier-unanswered-id', 'twice-outstanding'].includes(loadAnswer)) write(loadConnection, loadSuccess)
  if (loadAnswer === 'write-error') write(loadConnection, loadSuccess, 'write-error')
  if (loadAnswer === 'error') write(loadConnection, loadRefusal)
  if (loadAnswer === 'string-id') write(loadConnection, { ...loadSuccess, id: '3' })
  if (loadAnswer === 'other-connection') write(resumed.upstream, loadSuccess)
  if (loadAnswer === 'undecodable-before-answer') { writeBytes(loadConnection, undecodableAcp()); write(loadConnection, loadSuccess) }
  if (loadAnswer === 'error-then-reused-success') { write(loadConnection, loadRefusal); receive(loadConnection, sessionInfo); write(loadConnection, loadSuccess) }
  if (loadAnswer === 'reused-before-answer') {
    receive(loadConnection, { jsonrpc: '2.0', id: 3, method: 'session/load', params: { sessionId: SESSION, cwd: '/fixture', mcpServers: [] } })
    write(loadConnection, loadSuccess)
  }
  if (replay === 'after-answer') replayConversation()
  capture.record('history', 'reset', { sessionId: SESSION, file, generation: 1, snapshotByteLength: first.length + 1 })
  capture.record('history', 'row', { sessionId: SESSION, file, generation: 1, lineStartOffset: 0 }, first)
  capture.record('history', 'caught-up', { sessionId: SESSION, file, generation: 1, byteOffset: first.length + 1, snapshotByteLength: first.length + 1, complete: true })
  capture.record('verification', 'native-restart-resume', {
    sessionId: verificationSessionId, ...(leaderPidsMissing ? {} : { previousLeaderPid: 41, resumedLeaderPid: 42 }), previousTuiPid: 51, resumedTuiPid: 52,
    previousLeaderAbsent, previousTuiAbsent: true, loadObserved: true, replayObserved: true,
  })
  const resumedBaseline = resumedHistory === 'lost' ? line(unrelated) : line(first)
  if (beforeCheckpoint !== 'missing') chatCheckpoint('before-resumed-prompt', resumedBaseline, beforeCheckpoint === 'stable')
  const withHistory = { input: [userItem(PRE_RESTART_TEXT), assistantItem, userItem(RESUMED_TEXT)] }
  if (resumedInference === 'outside-window') inference('early-inference', withHistory)
  const promptConnection = resumedPromptOnFirstControl ? previous.control : resumed.control
  const resumedPrompt = { jsonrpc: '2.0', id: 'prompt-2', method: 'session/prompt', params: { sessionId: SESSION, prompt: [{ type: 'text', text: RESUMED_TEXT }] } }
  write(promptConnection, resumedPrompt)
  if (resumedPromptIdReused) write(promptConnection, resumedPrompt)
  if (guardHold === 'during-prompt') capture.record('guard', 'holding', { reason: 'protocol' })
  if (resumedInference === 'carries-history') inference('turn', withHistory)
  if (['missing-history', 'title-carries-history', 'summary-sidecar-carries-history'].includes(resumedInference)) inference('turn', { input: [userItem(RESUMED_TEXT)] })
  if (resumedInference === 'title-carries-history') {
    inference('title', { tool_choice: { type: 'function', name: 'session_title' }, input: [userItem(PRE_RESTART_TEXT), userItem(RESUMED_TEXT)] })
  }
  if (resumedInference === 'summary-sidecar-carries-history') {
    inference('summary', { input: [...withHistory.input, assistantItem, userItem('Summarize the last turn.')] })
  }
  if (resumedInference === 'history-in-same-item') inference('turn', { input: [userItem(`${PRE_RESTART_TEXT} ${RESUMED_TEXT}`)] })
  const finalHistory = appendAfterPrompt ? Buffer.concat([line(first), line(second)]) : line(first)
  if (appendAfterPrompt) {
    capture.record('history', 'row', { sessionId: SESSION, file, generation: 1, lineStartOffset: first.length + 1 }, second)
    capture.record('history', 'caught-up', { sessionId: SESSION, file, generation: 1, byteOffset: finalHistory.length, snapshotByteLength: finalHistory.length, complete: true })
  }
  const afterBytes = afterCheckpoint === 'rewritten' ? Buffer.concat([line(second), line(first)])
    : resumedHistory === 'lost' ? Buffer.concat([resumedBaseline, line(second)]) : finalHistory
  if (afterCheckpoint === 'before-answer') chatCheckpoint('after-tui-resume', afterBytes)
  const completion = { jsonrpc: '2.0', id: 'prompt-2', result: { stopReason: 'end_turn' } }
  if (promptAnswer === 'undecodable-first') { capture.record('ipc', 'received', promptConnection, undecodableAcp()); receive(promptConnection, completion) }
  if (promptAnswer === 'result') receive(promptConnection, completion)
  if (promptAnswer === 'error') receive(promptConnection, { jsonrpc: '2.0', id: 'prompt-2', error: { code: -32603, message: 'controlled failure' } })
  if (afterCheckpoint !== 'before-answer') chatCheckpoint('after-tui-resume', afterBytes)
  capture.record('scenario', 'passed', { id: 'native-restart-resume' })
  capture.record('tui', 'exited', { epoch: 2, exitCode: 0, signal: 0 })
  close(resumed.tui, resumed.upstream)
  if (loadOn === 'pre-restart-tui') close(stale)
  capture.record('leader', 'exited', { kind: 'exited', ...pid(42), exitCode: 143, signal: null })
  // The control socket's peer-led close can trail the process exit, which is
  // the only order in which a late answer is observable at all.
  if (promptAnswer === 'after-leader-exit') receive(promptConnection, completion)
  close(resumed.control)
  if (resumedPromptOnFirstControl) close(previous.control)

  chatCheckpoint('after-owned-exit', finalHistory)
  for (const other of ['updates.jsonl', 'events.jsonl']) recordHistory(capture, SESSION, other)
  capture.record('file', 'snapshot', { sessionId: SESSION, file: 'summary.json', label: 'after-owned-exit', stable: true }, Buffer.from('{}'))
  capture.record('lifecycle', 'observation-window-drained')
  capture.finish('passed')
  return capture.directory
}

it('certifies restart/resume from the resumed wire, the resumed turn inference and native file continuity', async () => {
  await expect(verifyScenarioEvidence(await restartCapture())).resolves.toMatchObject({
    manifest: { scenarioOutcome: 'passed', captureComplete: true },
  })
})

it.each<[string, RestartVariant, RegExp]>([
  ['process events carry no PIDs', { leaderPidsMissing: true }, /lacks two owned native process epochs/],
  ['the first leader exited only after the resumed leader started', { firstLeaderExitsAfterResume: true }, /first leader exiting before the second started/],
  ['the first TUI exited only after the resumed TUI started', { firstTuiExitsAfterResume: true }, /first TUI exiting before the second started/],
  ['the previous leader was still present between the epochs', { previousLeaderAbsent: false }, /absence probes/],
  ['the harness summary names another session', { verificationSessionId: OTHER_SESSION }, /names a session other than/],
  ['native assigned a different session identity', { assignedSessionId: OTHER_SESSION }, /no native session\/new answer assigning/],
  ['the session/new id was reused before its answer', { sessionNewIdReused: true }, /cannot pair the session\/new request/],
  ['no prompt was answered before the restart', { firstPromptAnswer: 'none' }, /no prompt answered before the restart/],
  ['the pre-restart prompt was answered with an error', { firstPromptAnswer: 'error' }, /no prompt answered before the restart/],
  ['the pre-restart prompt carried no text', { firstPromptTextless: true }, /no prompt text answered before the restart/],
  ['the resumed TUI loaded another session', { loadSessionId: OTHER_SESSION }, /no resumed TUI session\/load/],
  ['the load arrived on a TUI connection from before the restart', { loadOn: 'pre-restart-tui' }, /no resumed TUI session\/load/],
  ['the load arrived on the guard upstream instead of the TUI', { loadOn: 'guard-upstream' }, /no resumed TUI session\/load/],
  ['the native load was never answered', { loadAnswer: 'none' }, /never answered/],
  ['the only answer used another id type', { loadAnswer: 'string-id' }, /never answered/],
  ['the only answer arrived on another connection', { loadAnswer: 'other-connection' }, /never answered/],
  ['native refused the load', { loadAnswer: 'error' }, /native refused/],
  ['native refused the load and a later request reused its id', { loadAnswer: 'error-then-reused-success' }, /native refused/],
  ['the load id was reused before any answer', { loadAnswer: 'reused-before-answer' }, /reuses the session\/load JSON-RPC id/],
  ['the load id was still outstanding from an earlier request', { loadAnswer: 'earlier-unanswered-id' }, /reuses the session\/load JSON-RPC id/],
  ['two earlier requests used the load id and only one was answered', { loadAnswer: 'twice-outstanding' }, /reuses the session\/load JSON-RPC id/],
  ['an undecodable frame preceded the load answer', { loadAnswer: 'undecodable-before-answer' }, /undecodable frame before the resumed session\/load answer/],
  ['the load answer never reached the TUI', { loadAnswer: 'write-error' }, /write to the TUI never completed/],
  ['the replay write failed before the answer', { replayReceipt: 'write-error' }, /write to the TUI never completed/],
  ['an earlier write to the TUI failed', { earlierTuiWriteError: true }, /write to the TUI never completed/],
  ['a control prompt was live before the load completed', { livePromptBeforeLoadAnswer: 'control' }, /sends a session\/prompt before the resumed load completed/],
  ['the resumed TUI sent a prompt before the load completed', { livePromptBeforeLoadAnswer: 'tui' }, /sends a session\/prompt before the resumed load completed/],
  ['no conversation was replayed', { replay: 'none' }, /no replayed conversation/],
  ['replay arrived only after the load answer', { replay: 'after-answer' }, /no replayed conversation/],
  ['the replay belonged to another session', { replaySessionId: OTHER_SESSION }, /no replayed conversation/],
  ['the resumed prompt used the first epoch control connection', { resumedPromptOnFirstControl: true }, /no session\/prompt written to the resumed leader after the load completed/],
  ['the resumed prompt id was reused before its answer', { resumedPromptIdReused: true }, /cannot pair the resumed session\/prompt/],
  ['an undecodable frame preceded the resumed prompt answer', { promptAnswer: 'undecodable-first' }, /cannot pair the resumed session\/prompt/],
  ['the resumed prompt never completed', { promptAnswer: 'none' }, /no native completion for the resumed prompt/],
  ['the resumed prompt was answered with an error', { promptAnswer: 'error' }, /no native completion for the resumed prompt/],
  ['the resumed prompt completed only after the leader exited', { promptAnswer: 'after-leader-exit' }, /no native completion for the resumed prompt/],
  ['the guard held the resumed TUI before the load answer', { guardHold: 'before-load-answer' }, /guard holding the resumed TUI/],
  ['the guard held the resumed TUI during the prompt', { guardHold: 'during-prompt' }, /guard holding the resumed TUI/],
  ['the resumed turn request lacked the earlier conversation', { resumedInference: 'missing-history' }, /no resumed turn inference request carrying/],
  ['no resumed inference was recorded', { resumedInference: 'none' }, /no resumed turn inference request carrying/],
  ['the history-carrying request fell outside the prompt window', { resumedInference: 'outside-window' }, /no resumed turn inference request carrying/],
  ['only a title sidecar carried the earlier conversation', { resumedInference: 'title-carries-history' }, /no resumed turn inference request carrying/],
  ['only a summary sidecar carried the earlier conversation', { resumedInference: 'summary-sidecar-carries-history' }, /no resumed turn inference request carrying/],
  ['both prompt texts appeared only inside one item', { resumedInference: 'history-in-same-item' }, /no resumed turn inference request carrying/],
  ['no stable checkpoint preceded the restart', { preRestartCheckpoint: 'missing' }, /no stable chat history checkpoint between the pre-restart answer and the restart/],
  ['the pre-restart checkpoint was not a stable read', { preRestartCheckpoint: 'unstable' }, /no stable chat history checkpoint between the pre-restart answer and the restart/],
  ['the pre-restart checkpoint was read before its prompt was answered', { preRestartCheckpoint: 'before-answer' }, /no stable chat history checkpoint between the pre-restart answer and the restart/],
  ['the pre-restart checkpoint was read after the first leader exited', { preRestartCheckpoint: 'after-exit' }, /no stable chat history checkpoint between the pre-restart answer and the restart/],
  ['the pre-restart checkpoint was empty', { preRestartCheckpoint: 'empty' }, /does not carry the conversation recorded before the restart/],
  ['no checkpoint preceded the resumed prompt', { beforeCheckpoint: 'missing' }, /no stable chat history checkpoint between the resumed load/],
  ['the checkpoint before the resumed prompt was not a stable read', { beforeCheckpoint: 'unstable' }, /no stable chat history checkpoint between the resumed load/],
  ['the after-prompt checkpoint was read before the prompt was answered', { afterCheckpoint: 'before-answer' }, /no stable chat history checkpoint after the resumed prompt completed/],
  ['the resumed native file lost the pre-restart conversation', { resumedHistory: 'lost' }, /does not carry the conversation recorded before the restart/],
  ['the native file did not grow across the prompt', { appendAfterPrompt: false }, /no chat history growth/],
  ['the native file grew but lost its earlier conversation', { afterCheckpoint: 'rewritten' }, /no chat history growth/],
])('rejects restart/resume evidence when %s', async (_label, variant, reason) => {
  const error = await verifyScenarioEvidence(await restartCapture(variant)).catch((caught: Error) => caught)
  expect(error).toBeInstanceOf(EvidenceRejectedError)
  expect((error as Error).message).toMatch(reason)
})

it('seals a claim verdict bound to its rules, journal and manifest, and reads it back through the contract', async () => {
  const refused = await restartCapture({ replay: 'none' })
  await expect(sealEvidenceVerdict(refused, verifyScenarioEvidence)).rejects.toBeInstanceOf(EvidenceRejectedError)
  const journal = JSON.parse(await readFile(join(refused, 'manifest.json'), 'utf8')).journal.sha256
  expect(JSON.parse(await readFile(evidenceVerdictPath(refused), 'utf8'))).toEqual({
    schemaVersion: 2, rules: EVIDENCE_RULES_VERSION, journalSha256: journal, manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    verified: false, reason: expect.stringMatching(/no replayed conversation/),
  })
  await expect(readEvidenceVerdict(refused)).resolves.toEqual({ status: 'refused', reason: expect.stringMatching(/no replayed conversation/) })

  const accepted = await restartCapture()
  await sealEvidenceVerdict(accepted, verifyScenarioEvidence)
  await expect(readEvidenceVerdict(accepted)).resolves.toEqual({ status: 'verified' })
  // One verdict per rules version; a second judgment must not silently replace it.
  await expect(sealEvidenceVerdict(accepted, verifyScenarioEvidence)).rejects.toThrow(/EEXIST/)
  // Editing the label that selects the rules invalidates the sealed judgement.
  const manifestPath = join(accepted, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.metadata.scenario = 'controlled-verifier'
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  await expect(readEvidenceVerdict(accepted)).resolves.toMatchObject({ status: 'unjudged' })
  await expect(readEvidenceVerdict(await validCapture())).resolves.toMatchObject({ status: 'unjudged' })
})

it('seals nothing for incomplete storage or a recorder-integrity failure, so neither is catalogued as native behaviour', async () => {
  const lossy = await RuntimeCapture.create(root, { scenario: 'native-restart-resume' }, { maxBytes: 1024 })
  lossy.record('wire', 'received', {}, Buffer.alloc(2048))
  lossy.finish('passed')
  for (const [directory, reason] of [[lossy.directory, /not complete passing storage/], [await validCapture('unmatched-write'), /receipt has no preceding attempt/]] as const) {
    const error = await sealEvidenceVerdict(directory, verifyScenarioEvidence).catch((caught: Error) => caught)
    expect(error).not.toBeInstanceOf(EvidenceRejectedError)
    expect((error as Error).message).toMatch(reason)
    await expect(readFile(evidenceVerdictPath(directory))).rejects.toMatchObject({ code: 'ENOENT' })
  }
})

// Same labelling rule as above: the order follows the recorded cleanup-retry
// capture (close requested → guard holds → injected dependent failure →
// retained-leader verification → second close → matched leader exit).
type Injection = 'before-rejection' | 'missing' | 'not-injected' | 'after-rejection' | 'twice' | 'before-first-close'

async function cleanupRetryCapture(injection: Injection = 'before-rejection') {
  const capture = await RuntimeCapture.create(root, { scenario: 'cleanup-retry-native' })
  capture.record('lifecycle', 'capture-start', { nativeVersion: 'controlled' })
  capture.record('leader', 'spawned', { kind: 'spawned', pid: 42 })
  const epoch = openEpoch(capture, 1)
  capture.record('ipc', 'write-attempt', { ...epoch.control, writeId: 1 }, acp({ jsonrpc: '2.0', id: 1, method: 'initialize' }))
  capture.record('ipc', 'write-complete', { ...epoch.control, writeId: 1 })
  capture.record('tui', 'spawn-returned', { epoch: 1, pid: 51 })
  capture.record('scenario', 'started', { id: 'cleanup-retry-native' })
  if (injection === 'before-first-close') capture.record('stimulus', 'dependent-cleanup-failure', { injected: true })
  capture.record('action', 'close-requested')
  capture.record('guard', 'holding', { reason: 'owner-stopped' })
  if (injection === 'before-rejection' || injection === 'twice') capture.record('stimulus', 'dependent-cleanup-failure', { injected: true })
  if (injection === 'twice') capture.record('stimulus', 'dependent-cleanup-failure', { injected: true })
  if (injection === 'not-injected') capture.record('stimulus', 'dependent-cleanup-failure', { injected: false })
  capture.record('verification', 'cleanup-first-attempt', { pid: 42, rejected: true, leaderAlive: true, guardState: 'holding' })
  if (injection === 'after-rejection') capture.record('stimulus', 'dependent-cleanup-failure', { injected: true })
  capture.record('scenario', 'passed', { id: 'cleanup-retry-native' })
  capture.record('action', 'close-requested')
  capture.record('tui', 'exited', { epoch: 1, exitCode: 0, signal: 0 })
  for (const connection of Object.values(epoch)) capture.record('ipc', 'closed', connection)
  capture.record('leader', 'exited', { kind: 'exited', pid: 42, exitCode: 143, signal: null })
  for (const file of ['chat_history.jsonl', 'updates.jsonl', 'events.jsonl']) recordHistory(capture, SESSION, file)
  capture.record('file', 'snapshot', { sessionId: SESSION, file: 'summary.json', label: 'after-owned-exit', stable: true }, Buffer.from('{}'))
  capture.record('lifecycle', 'observation-window-drained')
  capture.finish('passed')
  return capture.directory
}

it('certifies cleanup retry only when its first failure is exactly one recorded controlled injection', async () => {
  await expect(verifyScenarioEvidence(await cleanupRetryCapture())).resolves.toMatchObject({
    manifest: { scenarioOutcome: 'passed', captureComplete: true },
  })
  for (const injection of ['missing', 'not-injected', 'after-rejection', 'twice', 'before-first-close'] as const) {
    const error = await verifyScenarioEvidence(await cleanupRetryCapture(injection)).catch((caught: Error) => caught)
    expect(error, injection).toBeInstanceOf(EvidenceRejectedError)
    expect((error as Error).message).toMatch(/does not attribute its first failure to exactly one recorded controlled injection/)
  }
})

async function startupFailureCapture(processAbsent = true, nativeExitCode = 1) {
  const capture = await RuntimeCapture.create(root, { scenario: 'native-startup-failure' })
  capture.record('lifecycle', 'capture-start', { nativeVersion: 'controlled' })
  capture.record('scenario', 'started', { id: 'native-startup-failure' })
  capture.record('leader', 'spawned', { pid: 42, epoch: 'startup-failure' })
  capture.record('leader', 'exited', { pid: 42, epoch: 'startup-failure', exitCode: nativeExitCode, signal: null })
  capture.record('verification', 'startup-failure-outcome', { rejected: true, pid: 42, processAbsent, nativeExitCode, nativeSignal: null })
  capture.record('scenario', 'passed', { id: 'native-startup-failure' })
  capture.record('lifecycle', 'observation-window-drained')
  capture.finish('passed')
  return capture.directory
}

it('certifies a startup failure only when the matching owned process exited and is absent', async () => {
  await expect(verifyLifecycleScenarioEvidence(await startupFailureCapture())).resolves.toMatchObject({
    manifest: { scenarioOutcome: 'passed', captureComplete: true },
  })
  await expect(verifyLifecycleScenarioEvidence(await startupFailureCapture(false))).rejects.toThrow(EvidenceRejectedError)
  await expect(verifyLifecycleScenarioEvidence(await startupFailureCapture(false))).rejects.toThrow(/absent/i)
  await expect(verifyLifecycleScenarioEvidence(await startupFailureCapture(true, 0))).rejects.toThrow(/native exit/i)
})
