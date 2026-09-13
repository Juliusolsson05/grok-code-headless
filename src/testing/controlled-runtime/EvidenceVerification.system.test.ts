import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { RuntimeCapture } from './Capture.js'
import {
  EVIDENCE_RULES_VERSION, EvidenceRejectedError, evidenceVerdictPath, sealEvidenceVerdict, verifyLifecycleScenarioEvidence, verifyScenarioEvidence,
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

type TransportVariant = 'none' | 'unmatched-write' | 'queued-before-open' | 'data-after-close' | 'received-before-open' | 'never-opened'

async function validCapture(variant: TransportVariant = 'none') {
  const sessionId = SESSION
  const capture = await RuntimeCapture.create(root, { scenario: 'controlled-verifier' })
  capture.record('lifecycle', 'capture-start', { nativeVersion: 'controlled' })
  capture.record('leader', 'spawned', { pid: 42 })
  capture.record('scenario', 'started', { id: 'controlled-verifier' })
  for (const [index, role] of (['control', 'tui', 'guard-upstream'] as const).entries()) {
    const connectionId = `connection-${index}`
    const attempt = () => capture.record('ipc', 'write-attempt', { role, connectionId, writeId: index + 1 }, packet({ jsonrpc: '2.0', id: index + 1, method: 'fixture' }))
    // Mirrors the real guard: its registration write to the upstream socket is
    // observed before that socket's `connect` produces `opened`.
    const queued = variant === 'queued-before-open' && role === 'guard-upstream'
    if (variant === 'received-before-open' && role === 'tui') capture.record('ipc', 'received', { role, connectionId }, packet({ type: 'register' }))
    if (queued) attempt()
    capture.record('ipc', 'opened', { role, connectionId })
    if (!queued && (variant !== 'unmatched-write' || index !== 0)) attempt()
    capture.record('ipc', 'write-complete', { role, connectionId, writeId: index + 1 })
    capture.record('ipc', 'closing', { role, connectionId })
    capture.record('ipc', 'closed', { role, connectionId })
    if (variant === 'data-after-close' && index === 0) capture.record('ipc', 'received', { role, connectionId }, packet({ jsonrpc: '2.0', id: 1, result: {} }))
  }
  if (variant === 'never-opened') {
    const orphan = { role: 'control', connectionId: 'connection-orphan' }
    capture.record('ipc', 'write-attempt', { ...orphan, writeId: 9 }, packet({ jsonrpc: '2.0', id: 9, method: 'fixture' }))
    capture.record('ipc', 'write-complete', { ...orphan, writeId: 9 })
  }
  for (const file of ['chat_history.jsonl', 'updates.jsonl', 'events.jsonl']) recordHistory(capture, sessionId, file)
  capture.record('file', 'snapshot', { sessionId, file: 'summary.json', label: 'after-owned-exit', stable: true }, Buffer.from('{}'))
  capture.record('scenario', 'passed', { id: 'controlled-verifier' })
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

it('accepts a write queued on a connecting socket before it opens, as the real guard upstream records', async () => {
  await expect(verifyScenarioEvidence(await validCapture('queued-before-open'))).resolves.toMatchObject({
    manifest: { scenarioOutcome: 'passed', captureComplete: true },
  })
})

it('rejects transport data recorded outside its connection lifetime', async () => {
  for (const variant of ['data-after-close', 'received-before-open', 'never-opened'] as const) {
    await expect(verifyScenarioEvidence(await validCapture(variant)), variant).rejects.toThrow(/outside its connection lifetime/)
  }
})

it('rejects a restart-labelled capture without two native epochs', async () => {
  const directory = await validCapture()
  const manifestPath = join(directory, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.metadata.scenario = 'native-restart-resume'
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

  await expect(verifyScenarioEvidence(directory)).rejects.toThrow(/lacks two owned native process epochs/)
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
// answered with a stopReason, its inference request carries the pre-restart
// prompt text, and a second checkpoint shows the file grew while keeping its
// earlier bytes. Each variant changes exactly one of those facts, and each test
// pins the rule that must refuse it so a variant that breaks for an unrelated
// reason cannot pass unnoticed.
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
  firstPromptAnswered?: boolean
  preRestartCheckpoint?: boolean
  loadSessionId?: string
  replaySessionId?: string
  loadOn?: 'resumed-tui' | 'pre-restart-tui' | 'guard-upstream'
  earlierTuiWriteError?: boolean
  loadAnswer?: 'result' | 'none' | 'error' | 'error-then-reused-success' | 'reused-before-answer' | 'earlier-unanswered-id' |
    'string-id' | 'other-connection' | 'undecodable-before-answer' | 'write-error'
  replay?: 'before-answer' | 'after-answer' | 'none'
  replayReceipt?: 'write-complete' | 'write-error'
  promptBeforeLoadAnswer?: boolean
  resumedPromptIdReused?: boolean
  promptAnswer?: 'result' | 'none' | 'error' | 'after-leader-exit'
  guardHoldDuringPrompt?: boolean
  resumedInference?: 'carries-history' | 'missing-history' | 'none'
  beforeCheckpoint?: 'stable' | 'unstable' | 'missing'
  resumedHistory?: 'kept' | 'lost'
  appendAfterPrompt?: boolean
  afterCheckpoint?: 'grown' | 'rewritten' | 'before-answer'
}

async function restartCapture(variant: RestartVariant = {}) {
  const {
    leaderPidsMissing = false, firstLeaderExitsAfterResume = false, firstTuiExitsAfterResume = false, previousLeaderAbsent = true,
    verificationSessionId = SESSION, assignedSessionId = SESSION, sessionNewIdReused = false, firstPromptAnswered = true,
    preRestartCheckpoint = true, loadSessionId = SESSION, replaySessionId = SESSION, loadOn = 'resumed-tui', earlierTuiWriteError = false,
    loadAnswer = 'result', replay = 'before-answer', replayReceipt = 'write-complete', promptBeforeLoadAnswer = false,
    resumedPromptIdReused = false, promptAnswer = 'result', guardHoldDuringPrompt = false, resumedInference = 'carries-history',
    beforeCheckpoint = 'stable', resumedHistory = 'kept', appendAfterPrompt = true, afterCheckpoint = 'grown',
  } = variant
  const file = 'chat_history.jsonl'
  const first = Buffer.from(JSON.stringify({ type: 'user', controlled: 'before-restart' }))
  const second = Buffer.from(JSON.stringify({ type: 'user', controlled: 'after-resume' }))
  const unrelated = Buffer.from(JSON.stringify({ type: 'user', controlled: 'unrelated' }))
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
  write(previous.control, { jsonrpc: '2.0', id: 'prompt-1', method: 'session/prompt', params: { sessionId: SESSION, prompt: [{ type: 'text', text: PRE_RESTART_TEXT }] } })
  capture.record('history', 'row', { sessionId: SESSION, file, generation: 0, lineStartOffset: 0 }, first)
  capture.record('history', 'caught-up', { sessionId: SESSION, file, generation: 0, byteOffset: first.length + 1, snapshotByteLength: first.length + 1, complete: true })
  if (firstPromptAnswered) receive(previous.control, { jsonrpc: '2.0', id: 'prompt-1', result: { stopReason: 'end_turn' } })
  if (preRestartCheckpoint) chatCheckpoint('before-tui-restart', line(first))
  if (!firstTuiExitsAfterResume) capture.record('tui', 'exited', { epoch: 1, exitCode: 0, signal: 0 })
  close(previous.control, previous.tui, previous.upstream)
  const firstLeaderExit = () => capture.record('leader', 'exited', { kind: 'exited', ...pid(41), exitCode: 143, signal: null })
  if (!firstLeaderExitsAfterResume) firstLeaderExit()

  const stale: Connection = { role: 'tui', connectionId: 'tui-stale' }
  if (loadOn === 'pre-restart-tui') capture.record('ipc', 'opened', stale)
  capture.record('leader', 'spawned', { kind: 'spawned', ...pid(42) })
  if (firstLeaderExitsAfterResume) firstLeaderExit()
  const resumed = openEpoch(capture, 2)
  capture.record('tui', 'spawn-returned', { epoch: 2, pid: 52 })
  if (firstTuiExitsAfterResume) capture.record('tui', 'exited', { epoch: 1, exitCode: 0, signal: 0 })
  const loadConnection = loadOn === 'resumed-tui' ? resumed.tui : loadOn === 'guard-upstream' ? resumed.upstream : stale
  if (earlierTuiWriteError) write(loadConnection, { jsonrpc: '2.0', method: '_x.ai/mcp/servers_updated', params: {} }, 'write-error')
  if (loadAnswer === 'earlier-unanswered-id') receive(loadConnection, { jsonrpc: '2.0', id: 3, method: '_x.ai/session/info', params: { sessionId: SESSION } })
  receive(loadConnection, { jsonrpc: '2.0', id: 3, method: 'session/load', params: { sessionId: loadSessionId, cwd: '/fixture', mcpServers: [] } })
  const replayConversation = () => write(loadConnection, {
    jsonrpc: '2.0', method: 'session/update',
    params: { sessionId: replaySessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: PRE_RESTART_TEXT } } },
  }, replayReceipt)
  const loadSuccess = { jsonrpc: '2.0', id: 3, result: { models: {} } }
  const loadRefusal = { jsonrpc: '2.0', id: 3, error: { code: -32603, message: 'controlled refusal' } }
  if (replay === 'before-answer') replayConversation()
  if (promptBeforeLoadAnswer) {
    write(resumed.control, { jsonrpc: '2.0', id: 'prompt-early', method: 'session/prompt', params: { sessionId: SESSION, prompt: [{ type: 'text', text: 'early' }] } })
  }
  if (loadAnswer === 'result' || loadAnswer === 'earlier-unanswered-id') write(loadConnection, loadSuccess)
  if (loadAnswer === 'write-error') write(loadConnection, loadSuccess, 'write-error')
  if (loadAnswer === 'error') write(loadConnection, loadRefusal)
  if (loadAnswer === 'string-id') write(loadConnection, { ...loadSuccess, id: '3' })
  if (loadAnswer === 'other-connection') write(resumed.upstream, loadSuccess)
  if (loadAnswer === 'undecodable-before-answer') {
    writeBytes(loadConnection, packet({ type: 'acp', payload: '{not json' }))
    write(loadConnection, loadSuccess)
  }
  if (loadAnswer === 'error-then-reused-success') {
    write(loadConnection, loadRefusal)
    receive(loadConnection, { jsonrpc: '2.0', id: 3, method: '_x.ai/session/info', params: { sessionId: SESSION } })
    write(loadConnection, loadSuccess)
  }
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
  const resumedPrompt = { jsonrpc: '2.0', id: 'prompt-2', method: 'session/prompt', params: { sessionId: SESSION, prompt: [{ type: 'text', text: RESUMED_TEXT }] } }
  write(resumed.control, resumedPrompt)
  if (resumedPromptIdReused) write(resumed.control, resumedPrompt)
  if (guardHoldDuringPrompt) capture.record('guard', 'holding', { reason: 'protocol' })
  if (resumedInference !== 'none') {
    const history = resumedInference === 'carries-history'
      ? [{ role: 'user', content: [{ type: 'input_text', text: PRE_RESTART_TEXT }] }, { role: 'assistant', content: [{ type: 'output_text', text: 'controlled reply' }] }]
      : []
    capture.record('http', 'request', { requestId: 'resumed-inference', path: '/v1/responses', method: 'POST', headerPolicy: 'credentials excluded' },
      Buffer.from(JSON.stringify({ input: [...history, { role: 'user', content: [{ type: 'input_text', text: RESUMED_TEXT }] }] })))
  }
  const finalHistory = appendAfterPrompt ? Buffer.concat([line(first), line(second)]) : line(first)
  if (appendAfterPrompt) {
    capture.record('history', 'row', { sessionId: SESSION, file, generation: 1, lineStartOffset: first.length + 1 }, second)
    capture.record('history', 'caught-up', { sessionId: SESSION, file, generation: 1, byteOffset: finalHistory.length, snapshotByteLength: finalHistory.length, complete: true })
  }
  const afterBytes = afterCheckpoint === 'rewritten' ? Buffer.concat([line(second), line(first)])
    : resumedHistory === 'lost' ? Buffer.concat([resumedBaseline, line(second)]) : finalHistory
  if (afterCheckpoint === 'before-answer') chatCheckpoint('after-tui-resume', afterBytes)
  const completion = { jsonrpc: '2.0', id: 'prompt-2', result: { stopReason: 'end_turn' } }
  if (promptAnswer === 'result') receive(resumed.control, completion)
  if (promptAnswer === 'error') receive(resumed.control, { jsonrpc: '2.0', id: 'prompt-2', error: { code: -32603, message: 'controlled failure' } })
  if (afterCheckpoint !== 'before-answer') chatCheckpoint('after-tui-resume', afterBytes)
  capture.record('scenario', 'passed', { id: 'native-restart-resume' })
  capture.record('tui', 'exited', { epoch: 2, exitCode: 0, signal: 0 })
  close(resumed.tui, resumed.upstream)
  if (loadOn === 'pre-restart-tui') close(stale)
  capture.record('leader', 'exited', { kind: 'exited', ...pid(42), exitCode: 143, signal: null })
  // The control socket's peer-led close can trail the process exit, which is
  // the only order in which a late answer is observable at all.
  if (promptAnswer === 'after-leader-exit') receive(resumed.control, completion)
  close(resumed.control)

  chatCheckpoint('after-owned-exit', finalHistory)
  for (const other of ['updates.jsonl', 'events.jsonl']) recordHistory(capture, SESSION, other)
  capture.record('file', 'snapshot', { sessionId: SESSION, file: 'summary.json', label: 'after-owned-exit', stable: true }, Buffer.from('{}'))
  capture.record('lifecycle', 'observation-window-drained')
  capture.finish('passed')
  return capture.directory
}

it('certifies restart/resume from the resumed wire, the resumed inference and native file continuity', async () => {
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
  ['no prompt was answered before the restart', { firstPromptAnswered: false }, /no prompt answered before the restart/],
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
  ['an undecodable frame preceded the load answer', { loadAnswer: 'undecodable-before-answer' }, /undecodable frame before the resumed session\/load answer/],
  ['the load answer never reached the TUI', { loadAnswer: 'write-error' }, /write to the TUI never completed/],
  ['the replay write failed before the answer', { replayReceipt: 'write-error' }, /write to the TUI never completed/],
  ['an earlier write to the TUI failed', { earlierTuiWriteError: true }, /write to the TUI never completed/],
  ['a live prompt reached the resumed leader before the load completed', { promptBeforeLoadAnswer: true }, /sends a session\/prompt before the resumed load completed/],
  ['no conversation was replayed', { replay: 'none' }, /no replayed conversation/],
  ['replay arrived only after the load answer', { replay: 'after-answer' }, /no replayed conversation/],
  ['the replay belonged to another session', { replaySessionId: OTHER_SESSION }, /no replayed conversation/],
  ['the resumed prompt id was reused before its answer', { resumedPromptIdReused: true }, /cannot pair the resumed session\/prompt/],
  ['the resumed prompt never completed', { promptAnswer: 'none' }, /no native completion for the resumed prompt/],
  ['the resumed prompt was answered with an error', { promptAnswer: 'error' }, /no native completion for the resumed prompt/],
  ['the resumed prompt completed only after the leader exited', { promptAnswer: 'after-leader-exit' }, /no native completion for the resumed prompt/],
  ['the guard held the resumed TUI during the prompt', { guardHoldDuringPrompt: true }, /guard holding the resumed TUI/],
  ['the resumed inference lacked the earlier conversation', { resumedInference: 'missing-history' }, /no resumed inference request carrying/],
  ['no resumed inference was recorded', { resumedInference: 'none' }, /no resumed inference request carrying/],
  ['no stable checkpoint preceded the restart', { preRestartCheckpoint: false }, /no stable chat history checkpoint before the restart/],
  ['no checkpoint preceded the resumed prompt', { beforeCheckpoint: 'missing' }, /no stable chat history checkpoint between/],
  ['the checkpoint before the resumed prompt was not a stable read', { beforeCheckpoint: 'unstable' }, /no stable chat history checkpoint between/],
  ['the after-prompt checkpoint was read before the prompt was answered', { afterCheckpoint: 'before-answer' }, /no stable chat history checkpoint after the resumed prompt completed/],
  ['the resumed native file lost the pre-restart conversation', { resumedHistory: 'lost' }, /does not carry the conversation recorded before the restart/],
  ['the native file did not grow across the prompt', { appendAfterPrompt: false }, /no chat history growth/],
  ['the native file grew but lost its earlier conversation', { afterCheckpoint: 'rewritten' }, /no chat history growth/],
])('rejects restart/resume evidence when %s', async (_label, variant, reason) => {
  await expect(verifyScenarioEvidence(await restartCapture(variant))).rejects.toThrow(reason)
})

it('seals a rules- and journal-bound verdict so refused evidence never reads as passing', async () => {
  const refused = await restartCapture({ replay: 'none' })
  await expect(sealEvidenceVerdict(refused, verifyScenarioEvidence)).rejects.toBeInstanceOf(EvidenceRejectedError)
  const journal = JSON.parse(await readFile(join(refused, 'manifest.json'), 'utf8')).journal.sha256
  expect(JSON.parse(await readFile(evidenceVerdictPath(refused), 'utf8'))).toEqual({
    schemaVersion: 2, rules: EVIDENCE_RULES_VERSION, journalSha256: journal, verified: false, reason: expect.stringMatching(/no replayed conversation/),
  })

  const accepted = await restartCapture()
  await sealEvidenceVerdict(accepted, verifyScenarioEvidence)
  expect(JSON.parse(await readFile(evidenceVerdictPath(accepted), 'utf8'))).toMatchObject({ rules: EVIDENCE_RULES_VERSION, verified: true })
  // One verdict per rules version; a second judgment must not silently replace it.
  await expect(sealEvidenceVerdict(accepted, verifyScenarioEvidence)).rejects.toThrow(/EEXIST/)
})

it('refuses to judge incomplete storage, so corruption is never catalogued as native behaviour', async () => {
  const capture = await RuntimeCapture.create(root, { scenario: 'native-restart-resume' }, { maxBytes: 1024 })
  capture.record('wire', 'received', {}, Buffer.alloc(2048))
  capture.finish('passed')
  const error = await sealEvidenceVerdict(capture.directory, verifyScenarioEvidence).catch((caught: Error) => caught)
  expect(error).not.toBeInstanceOf(EvidenceRejectedError)
  expect((error as Error).message).toMatch(/not complete passing storage/)
  await expect(readFile(evidenceVerdictPath(capture.directory))).rejects.toMatchObject({ code: 'ENOENT' })
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
    await expect(verifyScenarioEvidence(await cleanupRetryCapture(injection)), injection)
      .rejects.toThrow(/does not attribute its first failure to exactly one recorded controlled injection/)
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
  await expect(verifyLifecycleScenarioEvidence(await startupFailureCapture(false))).rejects.toThrow(/absent/i)
  await expect(verifyLifecycleScenarioEvidence(await startupFailureCapture(true, 0))).rejects.toThrow(/native exit/i)
})
