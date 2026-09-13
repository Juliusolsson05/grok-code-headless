import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readVerifiedCaptureBlob, verifyRuntimeCapture, type CaptureEvent } from './Capture.js'
import { FrameSplitter } from './frames.js'

type HistoryState = { bytes: Buffer; caughtUp: boolean }

/**
 * Identity of the rule set a sealed verdict was judged under. Bump it whenever a
 * rule change could alter what verifies: a verdict sealed under another value is
 * stale and must be recomputed, never trusted.
 */
export const EVIDENCE_RULES_VERSION = 2

/**
 * One complete native leader frame reconstructed from recorded transport bytes.
 *
 * WHY frames carry both `sequence` and `index`: `sequence` is the capture event
 * that delivered the frame's final byte, which orders it against other channels
 * (actions, lifecycle, history, file snapshots) in observer arrival order.
 * Several frames can complete inside one chunk, so `index` preserves their order
 * inside the same connection+direction byte stream, where order IS the wire
 * order. Neither is a claim about causality inside the native process.
 *
 * WHY `receipt`: the transport observation contract keeps a write attempt
 * distinct from its completion callback. A frame the guard tried to write is not
 * evidence the peer could read it until its `write-complete` receipt exists, and
 * after any failed write on a connection the peer's stream can no longer be
 * trusted to stay framed, so every later frame on it counts as failed too.
 */
type WireFrame = {
  connectionId: string
  role: string
  direction: 'received' | 'write-attempt'
  sequence: number
  index: number
  receipt?: 'write-complete' | 'write-error'
  envelope: unknown
}

/** This is deliberately stricter than RuntimeCapture's storage verifier. A
 * valid checksum proves that bytes were retained; this pass proves that the
 * retained observations form the continuations the Stage 1 contract needs.
 * It still does not assign product semantics or global native causality. */
export async function verifyScenarioEvidence(directory: string) {
  const { manifest, events } = await verifyRuntimeCapture(directory)
  if (!manifest.captureComplete || manifest.scenarioOutcome !== 'passed') throw new Error('Scenario did not produce complete passing storage evidence')
  requireEvent(events, 'lifecycle', 'capture-start')
  requireEvent(events, 'scenario', 'started')
  requireEvent(events, 'scenario', 'passed')
  requireEvent(events, 'leader', 'spawned')
  requireEvent(events, 'leader', 'exited')
  requireEvent(events, 'lifecycle', 'observation-window-drained')

  const frames = await verifyTransport(directory, events)
  const sessionId = await verifyHistory(directory, events)
  if (manifest.metadata.scenario === 'native-restart-resume') await verifyRestartResume(directory, events, frames, sessionId)
  if (manifest.metadata.scenario === 'cleanup-retry-native') verifyCleanupRetry(events)
  return { manifest, events }
}

/** Startup rejection happens before a session, guard, TUI, or history tailer
 * can honestly exist. Reusing the ordinary verifier would force the recorder
 * to manufacture those channels, so this narrower verifier instead requires
 * one matched owned process lifetime and the recorder's post-exit OS probe. */
export async function verifyLifecycleScenarioEvidence(directory: string) {
  const { manifest, events } = await verifyRuntimeCapture(directory)
  if (!manifest.captureComplete || manifest.scenarioOutcome !== 'passed') throw new Error('Lifecycle scenario did not produce complete passing storage evidence')
  requireEvent(events, 'lifecycle', 'capture-start')
  requireEvent(events, 'scenario', 'started')
  requireEvent(events, 'scenario', 'passed')
  requireEvent(events, 'lifecycle', 'observation-window-drained')
  const spawned = events.filter(event => event.channel === 'leader' && event.kind === 'spawned' && (event.data as any)?.epoch === 'startup-failure')
  const exited = events.filter(event => event.channel === 'leader' && event.kind === 'exited' && (event.data as any)?.epoch === 'startup-failure')
  if (spawned.length !== 1 || exited.length !== 1 || (spawned[0].data as any).pid !== (exited[0].data as any).pid || spawned[0].sequence >= exited[0].sequence) {
    throw new Error('Startup failure does not contain one matched owned process lifetime')
  }
  const outcome = events.find(event => event.channel === 'verification' && event.kind === 'startup-failure-outcome')
  const data = outcome?.data as any
  if (data?.rejected !== true || data?.processAbsent !== true || data?.pid !== (spawned[0].data as any).pid) {
    throw new Error('Startup failure did not verify the owned process is absent')
  }
  if (!Number.isInteger(data.nativeExitCode) || data.nativeExitCode === 0 || data.nativeSignal !== null ||
    data.nativeExitCode !== (exited[0].data as any).exitCode || data.nativeSignal !== (exited[0].data as any).signal) {
    throw new Error('Startup failure lacks a matching nonzero native exit')
  }
  return { manifest, events }
}

export class EvidenceRejectedError extends Error {
  constructor(reason: string) { super(reason); this.name = 'EvidenceRejectedError' }
}

/**
 * Run a strict verifier over a sealed capture and seal its verdict beside it.
 *
 * WHY a separate verdict file: the storage manifest has to be written before
 * strict verification can read the sealed artifacts, so without this a capture
 * whose evidence is refused still reads passed/complete on disk. Stage 1 keeps
 * "the evidence does not show the scenario's claim" (a verdict, possibly a
 * native variant worth cataloguing) apart from "the capture is incomplete"
 * (refused storage).
 *
 * WHY the verdict names its rules and journal: rules tighten as reviews find
 * holes (this round refused five older restart captures), so a bare
 * `verified: true` would silently outlive the rules that produced it. The file
 * name and body carry EVIDENCE_RULES_VERSION and the body carries the journal
 * digest it judged. Readers must treat a missing verdict, another rules version
 * or another journal digest as NOT YET JUDGED and re-run the verifier. A crash
 * between sealing the manifest and writing this file leaves exactly that
 * missing-verdict state. Each rules version is written exclusively once.
 */
export async function sealEvidenceVerdict<T>(directory: string, verify: (directory: string) => Promise<T>): Promise<T> {
  // Storage is not judged. An integrity failure, a lossy capture or a
  // non-passing scenario throws a plain error and seals nothing, so storage
  // corruption can never be catalogued as native behaviour. verify() repeats the
  // storage pass; one more read of a capture capped at 128 MiB is the price.
  const { manifest } = await verifyRuntimeCapture(directory)
  if (!manifest.captureComplete || manifest.scenarioOutcome !== 'passed') throw new Error('Capture is not complete passing storage; its evidence was not judged')
  let verified: T
  try { verified = await verify(directory) } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown verification failure'
    await writeVerdict(directory, manifest.journal.sha256, { verified: false, reason })
    throw new EvidenceRejectedError(reason)
  }
  await writeVerdict(directory, manifest.journal.sha256, { verified: true })
  return verified
}

export function evidenceVerdictPath(directory: string): string {
  return join(directory, `evidence-verdict-r${EVIDENCE_RULES_VERSION}.json`)
}

async function writeVerdict(directory: string, journalSha256: string, verdict: { verified: boolean; reason?: string }) {
  await writeFile(evidenceVerdictPath(directory),
    JSON.stringify({ schemaVersion: 2, rules: EVIDENCE_RULES_VERSION, journalSha256, ...verdict }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
}

function requireEvent(events: CaptureEvent[], channel: string, kind: string) {
  if (!events.some(event => event.channel === channel && event.kind === kind)) throw new Error(`Missing required ${channel}:${kind} evidence`)
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The JSON-RPC message inside a native leader `acp` envelope, or null for
 * leader control envelopes (register, control, ping) and for an `acp` envelope
 * whose payload is not a JSON object. Callers that pair requests with answers
 * must not skip the latter (see `answerTo`): an unreadable frame could be the
 * real answer. */
function acpMessage(frame: WireFrame): Record<string, any> | null {
  if (!isAcpEnvelope(frame) || typeof frame.envelope.payload !== 'string') return null
  try {
    const message: unknown = JSON.parse(frame.envelope.payload)
    return isRecord(message) ? message : null
  } catch { return null }
}

function isAcpEnvelope(frame: WireFrame): frame is WireFrame & { envelope: Record<string, any> } {
  return isRecord(frame.envelope) && frame.envelope.type === 'acp'
}

/** JSON-encoded so a numeric id and its string spelling never pair. */
function rpcId(message: Record<string, any>): string | undefined {
  return message.id === undefined ? undefined : JSON.stringify(message.id)
}

/**
 * The answer to `request`: the FIRST frame travelling the other way on the same
 * connection with the same JSON-RPC id.
 *
 * WHY the pairing aborts instead of guessing: accepting a later success would let
 * a refused request borrow the answer to an unrelated request that reused its
 * id. So pairing is refused when the id is still outstanding from an earlier
 * request, when a later request reuses it before an answer, and when an
 * unreadable `acp` frame sits between the request and the answer found (it could
 * have been the real answer). Ids are per connection, so nothing on another
 * connection can answer. Callers must only pass requests that carry an id.
 */
function answerTo(frames: readonly WireFrame[], request: WireFrame): { answer?: WireFrame; reused?: true; undecodable?: true } {
  const id = rpcId(acpMessage(request)!)
  const position = frames.indexOf(request)
  let outstanding = false
  for (const frame of frames.slice(0, position)) {
    const message = frame.connectionId === request.connectionId ? acpMessage(frame) : null
    if (!message || rpcId(message) !== id) continue
    if (frame.direction === request.direction && message.method !== undefined) outstanding = true
    else if (frame.direction !== request.direction && message.method === undefined) outstanding = false
  }
  if (outstanding) return { reused: true }
  for (const frame of frames.slice(position + 1)) {
    if (frame.connectionId !== request.connectionId) continue
    const message = acpMessage(frame)
    if (!message) { if (isAcpEnvelope(frame)) return { undecodable: true }; continue }
    if (rpcId(message) !== id) continue
    if (frame.direction === request.direction && message.method !== undefined) return { reused: true }
    if (frame.direction !== request.direction && message.method === undefined) return { answer: frame }
  }
  return {}
}

function verifyCleanupRetry(events: CaptureEvent[]) {
  const attempts = events.filter(event => event.channel === 'action' && event.kind === 'close-requested')
  const retained = events.find(event => event.channel === 'verification' && event.kind === 'cleanup-first-attempt')
  const spawned = events.find(event => event.channel === 'leader' && event.kind === 'spawned')
  const exited = events.find(event => event.channel === 'leader' && event.kind === 'exited')
  if (attempts.length < 2 || !retained || (retained.data as any)?.rejected !== true || (retained.data as any)?.leaderAlive !== true ||
    !spawned || (retained.data as any)?.pid !== (spawned.data as any)?.pid || !exited || (exited.data as any)?.pid !== (spawned.data as any)?.pid ||
    retained.sequence >= attempts[1].sequence || exited.sequence <= attempts[1].sequence) {
    throw new Error('Cleanup retry lacks retained-then-exited owned process evidence')
  }
  // WHY the injection must be proven, not inferred from the rejection: native
  // cleanup failure is not something this scenario may claim to have observed.
  // The recorder labels the only failure it causes itself; exactly one labelled
  // injection between the first close request and the retained-leader probe is
  // what makes this synthetic robustness evidence rather than a fabricated
  // "native cleanup failed" row. The rejection's own reason is not recorded, so
  // attribution rests entirely on that label's count and position: no label, a
  // label outside the window, or several labels are unattributable.
  const injections = events.filter(event => event.channel === 'stimulus' && event.kind === 'dependent-cleanup-failure')
  const injection = injections[0]
  if (injections.length !== 1 || (injection.data as any)?.injected !== true ||
    injection.sequence <= attempts[0].sequence || injection.sequence >= retained.sequence) {
    throw new Error('Cleanup retry does not attribute its first failure to exactly one recorded controlled injection')
  }
}

/** Every string inside an inference request body, so prompt text is matched as
 * decoded content rather than through JSON escaping. */
function collectStrings(value: unknown, into: string[] = [], depth = 0): string[] {
  if (depth > 64) return into
  if (typeof value === 'string') into.push(value)
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, into, depth + 1)
  else if (isRecord(value)) for (const item of Object.values(value)) collectStrings(item, into, depth + 1)
  return into
}

/**
 * Restart/resume is certified from what native exchanged and wrote, not from
 * the harness's summary booleans or from rendered text. Screen text cannot help:
 * the resumed TUI paints the replayed turns itself, and any frame may contain
 * the fixture reply.
 *
 * Trusted as recorded: the OS absence probes for the first epoch's processes,
 * which can only be taken between the epochs. Re-derived here from raw frames,
 * inference requests and native files: everything else. The rules mirror the
 * recorded Grok 1.0.30 restart capture:
 *  1. two owned leader/TUI epochs with integer PIDs, each first-epoch process
 *     exiting before its second-epoch replacement started;
 *  2. before the first epoch ended, the first control connection's `session/new`
 *     was answered with the session the history observers followed, and a
 *     `session/prompt` for it was answered with a stopReason;
 *  3. a TUI connection opened in the resumed epoch received `session/load` for
 *     that session, native's first answer was a result whose write to the TUI
 *     completed, and no prompt for the session reached the resumed leader before
 *     that answer (the client registers with user-message echo, so a live
 *     prompt's echo would otherwise pass for replay);
 *  4. before that answer, the same connection was sent a replayed
 *     `session/update user_message_chunk` for the session. A load answer alone
 *     is not enough: the first epoch's empty conversation is also answered, with
 *     nothing replayed;
 *  5. after the load completed, `session/prompt` for the session was written on a
 *     control connection (the first epoch's has closed by then, so it is the
 *     resumed leader's) and answered with a stopReason while the resumed leader
 *     was alive, with no guard hold of the resumed TUI in between;
 *  6. that prompt's inference request to the scripted backend carried the text
 *     of the prompt answered before the restart, so the model was given the
 *     prior conversation;
 *  7. the stable `chat_history.jsonl` checkpoint read after the load and before
 *     the resumed prompt starts with the bytes of the pre-restart checkpoint, and
 *     the checkpoint read after the prompt's answer is longer and starts with it.
 *     The two reads bracket the prompt (the window is wider than the prompt
 *     itself), so this shows native kept the prior conversation and grew around
 *     the prompt; it does not prove which request wrote the new bytes.
 */
async function verifyRestartResume(directory: string, events: CaptureEvent[], frames: readonly WireFrame[], sessionId: string) {
  const fail: (reason: string) => never = reason => { throw new Error(`Restart/resume evidence ${reason}`) }
  const select = (channel: string, kind: string) => events.filter(event => event.channel === channel && event.kind === kind)
  const field = (event: CaptureEvent, name: string) => (event.data as any)?.[name]
  const leaders = select('leader', 'spawned')
  const leaderExits = select('leader', 'exited')
  const tuis = select('tui', 'spawn-returned')
  const tuiExits = select('tui', 'exited')
  const verification = events.find(event => event.channel === 'verification' && event.kind === 'native-restart-resume')
  if (leaders.length !== 2 || leaderExits.length !== 2 || tuis.length !== 2 || tuiExits.length !== 2 || !verification ||
    ![...leaders, ...leaderExits, ...tuis].every(event => Number.isInteger(field(event, 'pid')))) {
    fail('lacks two owned native process epochs')
  }
  if (field(leaderExits[0], 'pid') !== field(leaders[0], 'pid') || field(leaderExits[1], 'pid') !== field(leaders[1], 'pid') ||
    leaderExits[0].sequence >= leaders[1].sequence) fail('does not show the first leader exiting before the second started')
  if (field(tuis[0], 'epoch') === field(tuis[1], 'epoch') || field(tuiExits[0], 'epoch') !== field(tuis[0], 'epoch') ||
    field(tuiExits[1], 'epoch') !== field(tuis[1], 'epoch') || tuiExits[0].sequence >= tuis[1].sequence) {
    fail('does not show the first TUI exiting before the second started')
  }
  const data = verification.data as any
  if (data?.previousLeaderAbsent !== true || data?.previousTuiAbsent !== true || verification.sequence <= leaders[1].sequence ||
    data?.previousLeaderPid !== field(leaders[0], 'pid') || data?.resumedLeaderPid !== field(leaders[1], 'pid') ||
    data?.previousTuiPid !== field(tuis[0], 'pid') || data?.resumedTuiPid !== field(tuis[1], 'pid')) {
    fail('lacks between-epoch absence probes for the recorded processes')
  }
  if (data.sessionId !== sessionId) fail('names a session other than the reconstructed native history')

  const controlRequest = (method: string, from: number, to: number) => frames.find(frame => frame.role === 'control' &&
    frame.direction === 'write-attempt' && frame.sequence > from && frame.sequence < to &&
    (message => message?.method === method && message.id !== undefined &&
      (method === 'session/new' || message.params?.sessionId === sessionId))(acpMessage(frame)))
  const stopReasonOf = (answer: WireFrame | undefined) => {
    const reason = answer && acpMessage(answer)?.result?.stopReason
    return typeof reason === 'string' && reason ? reason : undefined
  }

  const created = controlRequest('session/new', 0, leaderExits[0].sequence)
  if (!created) fail('has no session/new written to the first owned leader')
  const assignment = answerTo(frames, created)
  if (assignment.reused || assignment.undecodable) fail('cannot pair the session/new request with its answer')
  if (!assignment.answer || assignment.answer.sequence >= leaderExits[0].sequence ||
    acpMessage(assignment.answer)?.result?.sessionId !== sessionId) {
    fail('has no native session/new answer assigning the observed session before the first epoch ended')
  }
  const earlierPrompt = controlRequest('session/prompt', created.sequence, leaderExits[0].sequence)
  const earlier = earlierPrompt && answerTo(frames, earlierPrompt)
  if (!earlierPrompt || !earlier?.answer || !stopReasonOf(earlier.answer) || earlier.answer.sequence >= leaderExits[0].sequence) {
    fail('has no prompt answered before the restart')
  }
  const earlierText: string[] = (acpMessage(earlierPrompt)!.params?.prompt ?? [])
    .filter((part: any) => part?.type === 'text' && typeof part.text === 'string' && part.text)
    .map((part: any) => part.text as string)
  if (!earlierText.length) fail('has no prompt text answered before the restart')

  // `session/load` and `session/update` carry `sessionId` directly in params on
  // the recorded 1.0.30 wire; nothing here unwraps other envelope shapes, which
  // could only widen what verifies.
  const resumedTuiConnections = new Set(select('ipc', 'opened')
    .filter(event => field(event, 'role') === 'tui' && event.sequence > leaders[1].sequence)
    .map(event => field(event, 'connectionId') as string))
  const loadRequest = frames.find(frame => frame.direction === 'received' && resumedTuiConnections.has(frame.connectionId) &&
    (message => message?.method === 'session/load' && message.id !== undefined && message.params?.sessionId === sessionId)(acpMessage(frame)))
  if (!loadRequest) fail('has no resumed TUI session/load for the observed session')
  const load = answerTo(frames, loadRequest)
  if (load.reused) fail('reuses the session/load JSON-RPC id before its answer')
  if (load.undecodable) fail('has an undecodable frame before the resumed session/load answer')
  if (!load.answer) fail('has a resumed session/load that native never answered')
  const loadAnswer = load.answer
  const loadMessage = acpMessage(loadAnswer)!
  if ('error' in loadMessage || !('result' in loadMessage)) fail('has a resumed session/load that native refused')
  if (loadAnswer.receipt !== 'write-complete') fail('has a session/load answer whose write to the TUI never completed')
  if (controlRequest('session/prompt', leaders[1].sequence, loadAnswer.sequence)) fail('sends a session/prompt before the resumed load completed')

  // No receipt check on replay frames is needed: each precedes the delivered
  // load answer on the same connection, and any failed write there has already
  // marked that answer failed.
  const replayed = frames.some(frame => frame.connectionId === loadRequest.connectionId && frame.direction === 'write-attempt' &&
    frame.sequence > loadRequest.sequence && frame.index < loadAnswer.index &&
    (message => message?.method === 'session/update' && message.params?.sessionId === sessionId &&
      message.params?.update?.sessionUpdate === 'user_message_chunk')(acpMessage(frame)))
  if (!replayed) fail('has no replayed conversation delivered before the resumed session/load answer')

  const promptRequest = controlRequest('session/prompt', loadAnswer.sequence, Infinity)
  if (!promptRequest) fail('has no session/prompt written to the resumed leader after the load completed')
  const prompt = answerTo(frames, promptRequest)
  if (prompt.reused || prompt.undecodable) fail('cannot pair the resumed session/prompt with its answer')
  if (!prompt.answer || !stopReasonOf(prompt.answer) || prompt.answer.sequence >= leaderExits[1].sequence) {
    fail('has no native completion for the resumed prompt while the resumed leader owned it')
  }
  const promptAnswer = prompt.answer
  // From the resumed leader's spawn: the resumed guard exists before its TUI is
  // spawned, and a hold at any point before the answer means native may have
  // completed the prompt while the TUI was already detached and being stopped.
  if (select('guard', 'holding').some(event => event.sequence > leaders[1].sequence && event.sequence < promptAnswer.sequence)) {
    fail('shows the guard holding the resumed TUI before the resumed prompt completed')
  }

  let carriedHistory = false
  for (const request of select('http', 'request')) {
    if (field(request, 'path') !== '/v1/responses' || !request.blob || request.sequence <= promptRequest.sequence || request.sequence >= promptAnswer.sequence) continue
    let body: unknown
    try { body = JSON.parse((await readVerifiedCaptureBlob(directory, request)).toString('utf8')) } catch { continue }
    const strings = collectStrings(isRecord(body) ? body.input : undefined)
    if (earlierText.every(text => strings.some(value => value.includes(text)))) { carriedHistory = true; break }
  }
  if (!carriedHistory) fail('has no resumed inference request carrying the prompt answered before the restart')

  const checkpoint = (label: string) => events.find(event => event.channel === 'file' && event.kind === 'snapshot' &&
    field(event, 'sessionId') === sessionId && field(event, 'file') === 'chat_history.jsonl' && field(event, 'label') === label)
  const preRestart = checkpoint('before-tui-restart')
  if (!preRestart?.blob || field(preRestart, 'stable') !== true || preRestart.sequence >= leaderExits[0].sequence) {
    fail('has no stable chat history checkpoint before the restart')
  }
  const before = checkpoint('before-resumed-prompt')
  if (!before?.blob || field(before, 'stable') !== true || before.sequence <= loadAnswer.sequence || before.sequence >= promptRequest.sequence) {
    fail('has no stable chat history checkpoint between the resumed load and the prompt')
  }
  const after = checkpoint('after-tui-resume')
  if (!after?.blob || field(after, 'stable') !== true || after.sequence <= promptAnswer.sequence || after.sequence >= leaderExits[1].sequence) {
    fail('has no stable chat history checkpoint after the resumed prompt completed')
  }
  const [preRestartBytes, beforeBytes, afterBytes] = await Promise.all([preRestart, before, after].map(event => readVerifiedCaptureBlob(directory, event)))
  if (!preRestartBytes.length || beforeBytes.length < preRestartBytes.length || !beforeBytes.subarray(0, preRestartBytes.length).equals(preRestartBytes)) {
    fail('does not carry the conversation recorded before the restart into the resumed native file')
  }
  if (afterBytes.length <= beforeBytes.length || !afterBytes.subarray(0, beforeBytes.length).equals(beforeBytes)) {
    fail('shows no chat history growth that keeps the resumed conversation across the prompt')
  }
}

async function verifyTransport(directory: string, events: CaptureEvent[]): Promise<WireFrame[]> {
  const opened = new Map<string, { role: string; closed: boolean }>()
  const roles = new Set<string>()
  const pending = new Map<string, number>()
  const awaitingReceipt = new Map<string, WireFrame[]>()
  const failedWrites = new Map<string, number[]>()
  const queuedBeforeOpen = new Set<string>()
  const streams = new Map<string, { splitter: FrameSplitter; frames: number }>()
  const frames: WireFrame[] = []
  for (const event of events.filter(event => event.channel === 'ipc')) {
    const data = event.data as any
    if (typeof data?.connectionId !== 'string' || typeof data?.role !== 'string') throw new Error('Invalid transport identity')
    const connection = data.connectionId
    if (event.kind === 'opened') { opened.set(connection, { role: data.role, closed: false }); roles.add(data.role) }
    if (event.kind === 'closed' && opened.has(connection)) opened.get(connection)!.closed = true
    if (event.kind === 'received' || event.kind === 'write-attempt') {
      // No data after `closed`, and nothing received before `opened`. Neither is
      // produced by the socket observers, and accepting either would let a frame
      // attributed to a closed connection stand in for live traffic (the restart
      // rules rely on the first epoch's control connection being gone once it
      // has closed). A write attempt before `opened` IS real: the guard writes
      // the TUI's registration to its upstream socket as soon as it creates it,
      // Node queues the write until `connect`, and `opened` is observed on
      // `connect`. Every recorded 1.0.30 capture shows exactly that, and nothing
      // else, outside a lifetime. Such a connection must still open, which is
      // checked once the stream ends. Write receipts are exempt throughout: a
      // write callback may legitimately trail the close.
      const lifecycle = opened.get(connection)
      if (lifecycle?.closed || (!lifecycle && event.kind === 'received')) throw new Error(`Transport data outside its connection lifetime: ${connection}`)
      if (!lifecycle) queuedBeforeOpen.add(connection)
    }
    if (event.kind === 'write-attempt') {
      if (!Number.isInteger(data.writeId) || !event.blob) throw new Error('Invalid transport write attempt')
      const key = `${connection}:${data.writeId}`
      if (pending.has(key)) throw new Error('Duplicate transport write attempt')
      pending.set(key, event.sequence)
    }
    if (event.kind === 'write-complete' || event.kind === 'write-error') {
      const key = `${connection}:${data.writeId}`
      const attempt = pending.get(key)
      if (attempt === undefined || attempt >= event.sequence) throw new Error('Transport write receipt has no preceding attempt')
      pending.delete(key)
      for (const frame of awaitingReceipt.get(key) ?? []) frame.receipt = event.kind
      awaitingReceipt.delete(key)
      if (event.kind === 'write-error') failedWrites.set(connection, [...(failedWrites.get(connection) ?? []), attempt])
    }
    if ((event.kind === 'received' || event.kind === 'write-attempt') && event.blob) {
      const key = `${connection}:${event.kind}`
      const stream = streams.get(key) ?? { splitter: new FrameSplitter(), frames: 0 }
      streams.set(key, stream)
      const bytes = await readVerifiedCaptureBlob(directory, event)
      let envelopes: unknown[]
      try { envelopes = stream.splitter.push(bytes) }
      catch (error) { throw new Error(`Invalid transport frame on ${key}: ${error instanceof Error ? error.message : 'undecodable'}`) }
      for (const envelope of envelopes) {
        const frame: WireFrame = { connectionId: connection, role: data.role, direction: event.kind, sequence: event.sequence, index: stream.frames++, envelope }
        frames.push(frame)
        // A frame belongs to the write that delivered its final byte. Guard
        // writes are whole frames, and a failed earlier write poisons every
        // later frame on the connection below, so this cannot overstate delivery.
        if (event.kind === 'write-attempt') {
          const writeKey = `${connection}:${data.writeId}`
          awaitingReceipt.set(writeKey, [...(awaitingReceipt.get(writeKey) ?? []), frame])
        }
      }
    }
  }
  if (pending.size) throw new Error('Transport write has no completion or error receipt')
  for (const role of ['control', 'tui', 'guard-upstream']) if (!roles.has(role)) throw new Error(`Missing opened ${role} transport`)
  for (const [connection, lifecycle] of opened) {
    // Peer-led EOF has no local close initiation and therefore no `closing`
    // receipt (observed on the native TUI leg). The recorder still retains
    // `closing` as local intent; this verifier requires only `closed`, the
    // authoritative lifetime boundary.
    if (!lifecycle.closed) throw new Error(`Opened transport ${connection} did not close definitively`)
  }
  for (const connection of queuedBeforeOpen) {
    if (!opened.has(connection)) throw new Error(`Transport data outside its connection lifetime: ${connection}`)
  }
  if (!streams.size) throw new Error('No framed transport bytes recorded')
  for (const [key, stream] of streams) {
    if (stream.splitter.pendingBytes) throw new Error(`Incomplete transport frame: ${key}`)
  }
  for (const frame of frames) {
    if (frame.direction === 'write-attempt' && failedWrites.get(frame.connectionId)?.some(sequence => sequence <= frame.sequence)) frame.receipt = 'write-error'
  }
  return frames
}

/** Returns the one primary session whose native files were reconstructed. */
async function verifyHistory(directory: string, events: CaptureEvent[]): Promise<string> {
  const states = new Map<string, HistoryState>()
  const sessions = new Set<string>()
  for (const event of events.filter(event => event.channel === 'history')) {
    const data = event.data as any
    if (typeof data?.sessionId !== 'string' || typeof data?.file !== 'string' || !Number.isInteger(data?.generation)) continue
    sessions.add(data.sessionId)
    const key = `${data.sessionId}:${data.file}:${data.generation}`
    if (event.kind === 'reset') states.set(key, { bytes: Buffer.alloc(0), caughtUp: false })
    if (event.kind === 'row') {
      const state = states.get(key)
      if (!state || data.lineStartOffset !== state.bytes.length) throw new Error(`History row continuation mismatch: ${data.file}`)
      const line = await readVerifiedCaptureBlob(directory, event)
      state.bytes = Buffer.concat([state.bytes, line, Buffer.from('\n')])
    }
    if (event.kind === 'caught-up') {
      const state = states.get(key)
      if (!state || data.complete !== true || data.byteOffset !== state.bytes.length || data.snapshotByteLength !== state.bytes.length) {
        throw new Error(`History caught-up boundary mismatch: ${data.file}`)
      }
      state.caughtUp = true
    }
  }
  if (sessions.size !== 1) throw new Error('History evidence does not identify exactly one primary session')
  const sessionId = [...sessions][0]!
  const finals = events.filter(event => event.channel === 'file' && event.kind === 'snapshot' &&
    (event.data as any)?.label === 'after-owned-exit' && (event.data as any)?.sessionId === sessionId)
  const unavailable = events.some(event => event.channel === 'file' && event.kind === 'snapshot-unavailable' && (event.data as any)?.label === 'after-owned-exit')
  if (unavailable) throw new Error('Final native snapshot is unavailable')
  for (const file of ['summary.json', 'chat_history.jsonl', 'updates.jsonl', 'events.jsonl']) {
    const snapshot = finals.find(event => (event.data as any)?.file === file)
    if (!snapshot?.blob || (snapshot.data as any).stable !== true) throw new Error(`Missing stable final native snapshot: ${file}`)
    if (file === 'summary.json') continue
    const candidates = [...states.entries()].filter(([key, state]) => key.startsWith(`${sessionId}:${file}:`) && state.caughtUp)
    const latest = candidates.sort(([a], [b]) => Number(a.slice(a.lastIndexOf(':') + 1)) - Number(b.slice(b.lastIndexOf(':') + 1))).at(-1)?.[1]
    if (!latest) throw new Error(`Missing reconstructed history: ${file}`)
    const native = await readVerifiedCaptureBlob(directory, snapshot)
    if (!native.equals(latest.bytes)) throw new Error(`Reconstructed history differs from final native file: ${file}`)
  }
  return sessionId
}
