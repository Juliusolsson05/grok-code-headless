import { createHash } from 'node:crypto'
import { mkdir, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { normalizeTranscript } from '../normalizeTranscript.js'
import { readVerifiedCaptureBlob, verifyRuntimeCapture, type CaptureEvent } from './Capture.js'
import { EVIDENCE_RULES_VERSION, verifyLifecycleScenarioEvidence, verifyScenarioEvidence } from './EvidenceVerification.js'
import { FrameSplitter } from './frames.js'
import { RECORDED_ENUM_VALUES, RECORDED_PROTOCOL_KEYS } from './recordedVocabulary.js'
import { advancedScenarios } from './advancedScenarios.js'
import { contentScenarios } from './contentScenarios.js'
import { failureScenarios } from './failureScenarios.js'
import { scenarios } from './scenarios.js'

/**
 * Shareable, shape-only timelines derived from private exact controlled-runtime
 * captures: the Stage 1 fixture set that later catalog and runtime tests consume
 * without access to the private recordings.
 *
 * WHY derive from the newest verified capture per scenario: a fixture must show
 * what the evidence rules certified, on the native version the integration
 * targets. Every other capture still counts in the manifest (verified, refused
 * and failed per native version), so sample frequencies stay visible without
 * committing duplicates.
 *
 * WHY events keep their capture sequence: the Stage 2 catalog references exact
 * Stage 1 event ranges, and observer arrival order is the only ordering the
 * recorder claims. Wall-clock `atMs` is dropped because the recorder's
 * synchronous fsync perturbs timing; it was never valid evidence.
 *
 * Every lossy transformation is listed in the manifest `limits`, because the plan
 * requires each transformed field and resulting coverage limit to be labelled
 * where a consumer of the fixtures will see it.
 */
export type ControlledRuntimeCorpusManifest = {
  schemaVersion: 1
  normalization: 'controlled-runtime-shape-v1'
  evidenceRules: number
  unverifiableCaptures: number
  scenarios: Array<{
    id: string
    targets: string[]
    file: string
    nativeVersion: string
    events: number
    bytes: number
    sha256: string
    unknownKeys: number
    channels: Record<string, number>
    captures: Record<string, { verified: number; refused: number; failed: number }>
  }>
  coverageGaps: Array<{ scenario?: string; agenda?: string; reason: string }>
  limits: string[]
}

const registeredScenarios = () => [...scenarios, ...contentScenarios, ...advancedScenarios, ...failureScenarios]

/** Own-property lookup: native keys such as `constructor` or `__proto__` must
 * never resolve to inherited object members. */
const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined => Object.hasOwn(record, key) ? record[key] : undefined

/** Lookup key for the `id` of a prompt-kind queue entry. WHY a prompt identity and
 * not the generic `id` family: native lists a waiting prompt under the same id it
 * later reports as runningPromptId, prompt_complete's promptId and the result's
 * _meta.promptId. The recorder showed this for client-chosen ids
 * (client-supplied-prompt-identity adoptedAsQueueEntry, cancel-queued-prompt
 * queuedEntryUsesClientId). Numbering entry ids apart from prompt ids hid that
 * equality from the shareable corpus, so acceptance of a waiting prompt, the
 * earliest acceptance point, could not be read from any timeline (Stage 2
 * review). The mapping stays value-based: an entry id that differs from every
 * prompt id still gets its own ordinal, so no equality is invented. */
const PROMPT_QUEUE_ENTRY_ID_KEY = 'promptQueueEntryId'

/** String identities become `<namespace>-N` per capture. Shared namespaces keep
 * cross-channel identity: the same session in a harness record, a wire frame and
 * an HTTP header maps to the same ordinal. */
const STRING_IDENTITIES: Record<string, string> = {
  sessionId: 'session', session_id: 'session', primarySessionId: 'session', secondSessionId: 'session', child_session_id: 'session',
  parent_session_id: 'session', filter_session_id: 'session', sid: 'session', 'x-grok-session-id': 'session', resume_from_hint: 'session',
  promptId: 'prompt', prompt_id: 'prompt', runningPromptId: 'prompt', wire_prompt_id: 'prompt', parent_prompt_id: 'prompt',
  connectionId: 'connection', requestId: 'request', request_id: 'request', 'x-grok-req-id': 'request', token: 'token',
  toolCallId: 'tool-call', tool_call_id: 'tool-call', callId: 'tool-call', call_id: 'tool-call', eventId: 'event',
  checkpoint_id: 'checkpoint', subagent_id: 'subagent', attempt_id: 'attempt', agentAddress: 'agent', agentId: 'agent',
  agentInstanceId: 'agent-instance', traceparent: 'trace', id: 'id', task_id: 'task',
  // Not a native key: the lookup key EvidenceNormalizer.value uses for the `id` of
  // a prompt-kind `_x.ai/queue/changed` entry (see PROMPT_QUEUE_ENTRY_ID there).
  [PROMPT_QUEUE_ENTRY_ID_KEY]: 'prompt',
}
/** Numeric identities become per-capture ordinals: process ids, and the scripted
 * backend's HTTP request counter, which pairs a request with its chunks, its
 * response receipts and its inference decision. */
const NUMBER_IDENTITIES: Record<string, string> = {
  pid: 'pid', previousLeaderPid: 'pid', resumedLeaderPid: 'pid', previousTuiPid: 'pid', resumedTuiPid: 'pid', requestId: 'request',
}
/** Protocol counters, indices and small structural quantities keep their value
 * wherever they appear: they carry ordering, pagination or geometry. */
const COUNTER_KEYS = new Set([
  'actionId', 'auth_required', 'autoCompactThresholdPercent', 'chunkId', 'client_id', 'code', 'cols', 'commandsCount', 'compactionCount',
  'compressed_height', 'compressed_width', 'connected', 'conversation_message_count', 'count', 'cursorPaintGeneration', 'epoch', 'exitCode',
  'exit_code', 'expected', 'failed', 'generation', 'height', 'id', 'images', 'index', 'inferenceRequests', 'layoutEpoch',
  'layoutStartGeneration', 'leader_protocol_version', 'limit', 'line_number', 'loop_index', 'match_count', 'mcpToolCount', 'messageCount',
  'modelCalls', 'nativeExitCode', 'new_line', 'numTurns', 'observed', 'old_line', 'original_height', 'original_width', 'planSteps', 'position',
  'prompt_index', 'prompt_index_at_compaction', 'promptIndex', 'protocolVersion', 'providerLayoutEpoch', 'result_count', 'rows', 'rpcCode',
  'schema_version', 'status', 'succeeded', 'target_prompt_index', 'timeout_sec', 'tool_count', 'tool_index', 'toolCallCount',
  'toolDefinitionsCount', 'total', 'total_lines', 'total_servers', 'total_tools', 'turn_number', 'turnCount', 'turnIndex', 'turns', 'usagePct',
  'version', 'width', 'writeId', 'x.ai/leaderClientId',
  // Harness verification counts of the prompt-identity and terminal new-session
  // scenarios. Their magnitude is the evidence (33 original-session updates
  // reaching the terminal is not the same finding as 1), and they are small
  // integers computed by the harness, never native content.
  'queueNotifications', 'completionNotifications', 'originalUpdatesToTerminalBeforePrompt',
  'originalUpdatesToTerminalDuringPrompt', 'otherSessionUpdatesToTerminal',
])
/** History byte offsets. They depend on content length, which normalization
 * changes, so deriveTimeline replaces them with ranks within one (session, file,
 * generation) BEFORE normalization; the normalizer then keeps the small rank. */
const OFFSET_KEYS = ['byteOffset', 'lineStartOffset', 'snapshotByteLength'] as const
/** Values of these keys are JSON documents in a string; their structure is kept. */
const JSON_STRING_KEYS = new Set(['payload', 'arguments'])
/** Exact-shape values allowed for specific keys. `label` and `type` are
 * deliberately absent: they occur at every depth, including native free text
 * (question option labels, tool labels), so an identifier pattern would pass
 * model-written or host text. `type` is an enum; harness labels are restored
 * only on harness events (see HARNESS_LABEL_CHANNELS). */
const VALUE_PATTERNS: Record<string, RegExp> = {
  path: /^\/(?:v1\/(?:responses|models|api-key)|mcp)?$/,
  nativeVersion: /^grok \d+\.\d+\.\d+ \([0-9a-f]{12}\)$/,
  nodeVersion: /^v\d+\.\d+\.\d+$/,
  agentVersion: /^\d+\.\d+\.\d+$/, client_version: /^\d+\.\d+\.\d+$/, clientVersion: /^\d+\.\d+\.\d+$/,
  leader_binary_version: /^\d+\.\d+\.\d+$/, ver: /^\d+\.\d+\.\d+$/, 'x-grok-client-version': /^\d+\.\d+\.\d+$/,
  'x-grok-turn-idx': /^\d{1,3}$/, schema_version: /^\d+\.\d+$/, version: /^\d+\.\d+\.\d+$/,
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Checkpoint labels are authored by the harness (scenario checkpoints, file
 * snapshots, terminal checkpoint frames), never by native or the model. */
const HARNESS_LABEL_CHANNELS = new Set(['scenario', 'file', 'terminal'])
const HARNESS_LABEL = /^[a-z]+(?:-[a-z0-9]+)*$/
/** Terminal events keep numeric geometry and paint generations only, including
 * inside a checkpoint's nested `frame`: screen text is user-visible content, and
 * terminal fidelity stays with the private capture. WHY the numeric test: a
 * stable frame's `rows` is the array of screen lines, not a row count. */
const TERMINAL_NUMBER_KEYS = new Set(['cols', 'rows', 'epoch', 'generation', 'layoutEpoch', 'layoutStartGeneration', 'providerLayoutEpoch', 'cursorPaintGeneration'])
/** Objects whose keys are data rather than protocol field names (model ids in
 * usage maps, todo ids, question texts, raw tool flags). Their keys still become
 * `field_N`; they are simply not counted as unrecognised protocol fields, so a
 * nonzero `unknownKeys` means the native protocol grew, not that a map had keys. */
const DATA_KEYED_PARENTS = new Set(['modelUsage', 'todos', 'answers', 'annotations', 'rawInput'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

class EvidenceNormalizer {
  unknownKeys = 0
  /** True only while normalizing a history event whose byte offsets were already
   * replaced by ranks. Anywhere else an offset-named field would be a raw byte
   * count, so it is reduced like any other number instead of being published. */
  rankedOffsets = false
  private readonly ordinals = new Map<string, Map<unknown, number>>()

  private ordinal(namespace: string, value: unknown): number {
    let map = this.ordinals.get(namespace)
    if (!map) { map = new Map(); this.ordinals.set(namespace, map) }
    if (!map.has(value)) map.set(value, map.size + 1)
    return map.get(value)!
  }

  value(value: unknown, key = '', depth = 0): unknown {
    if (depth > 64) throw new Error('Controlled-runtime fixture exceeds the normalization depth limit')
    if (value === null || typeof value === 'boolean') return value
    if (typeof value === 'number') return this.number(value, key)
    if (Array.isArray(value)) return value.map(item => this.value(item, key, depth + 1))
    if (isRecord(value)) {
      // Object.fromEntries keeps own __proto__-like keys as data; untrusted keys
      // are never assigned onto a normal prototype.
      // Array items are normalized under their parent key, so a queue entry
      // object arrives here with key `entries`.
      const promptQueueEntry = key === 'entries' && value.kind === 'prompt'
      return Object.fromEntries(Object.entries(value).map(([field, item]) => {
        const known = RECORDED_PROTOCOL_KEYS.has(field)
        if (!known && !DATA_KEYED_PARENTS.has(key)) this.unknownKeys++
        const lookup = promptQueueEntry && field === 'id' ? PROMPT_QUEUE_ENTRY_ID_KEY : field
        return [known ? field : `field_${this.ordinal('field', field)}`, this.value(item, lookup, depth + 1)]
      }))
    }
    if (typeof value !== 'string') throw new Error('Controlled-runtime fixture must contain only JSON values')
    return this.string(value, key, depth)
  }

  private number(value: number, key: string): number {
    const identity = own(NUMBER_IDENTITIES, key)
    if (identity) return this.ordinal(identity, value)
    const counter = COUNTER_KEYS.has(key) || (this.rankedOffsets && (OFFSET_KEYS as readonly string[]).includes(key))
    if (counter && Number.isSafeInteger(value) && Math.abs(value) <= 1_000_000) return value
    return value === 0 ? 0 : Math.sign(value) * (Number.isInteger(value) ? 1 : 1.5)
  }

  private string(value: string, key: string, depth: number): string {
    if (value === '') return ''
    const pattern = own(VALUE_PATTERNS, key)
    if (own(RECORDED_ENUM_VALUES, key)?.has(value) || (pattern?.test(value) && !UUID.test(value))) return value
    if (key === 'jsonrpc' && value === '2.0') return value
    const identity = own(STRING_IDENTITIES, key)
    if (identity) return `${identity}-${this.ordinal(identity, value)}`
    if (JSON_STRING_KEYS.has(key)) {
      let parsed: unknown
      // A malformed recorded document stays visibly malformed rather than being
      // laundered into a valid one or leaking its text through an error message.
      try { parsed = JSON.parse(value) } catch { return '[invalid JSON omitted]' }
      return JSON.stringify(this.value(parsed, '', depth + 1))
    }
    if (/^data:[^;,]+;base64,/.test(value) || (value.length > 256 && /^[A-Za-z0-9+/=\r\n]+$/.test(value))) return '[binary omitted]'
    return `[text ${this.ordinal('text', value)}]`
  }
}

type DerivedLine = { sequence: number; channel: string; kind: string; data: unknown; frames?: unknown[]; row?: unknown; omitted?: string }

function omissionFor(event: CaptureEvent): string {
  if (event.channel === 'tui') return 'pty-bytes'
  if (event.channel === 'file') return 'native-file-bytes'
  if (event.channel === 'http') return 'http-body'
  if (event.channel === 'stimulus') return 'generated-bytes'
  return 'bytes'
}

/** Numeric terminal geometry only; a recorded null frame stays null rather than
 * being synthesized into an empty object. */
function terminalGeometry(value: unknown): unknown {
  if (value === null) return null
  if (!isRecord(value)) return {}
  const picked: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (TERMINAL_NUMBER_KEYS.has(key) && typeof item === 'number') picked[key] = item
    else if (key === 'frame') picked.frame = terminalGeometry(item)
  }
  return picked
}

/** Ranks of history byte offsets within one (session, file, generation). 0 is
 * always present so an empty file keeps offset 0 and non-empty offsets rank >= 1. */
function historyOffsetRanks(events: readonly CaptureEvent[]) {
  const group = (data: Record<string, unknown>) => JSON.stringify([data.sessionId, data.file, data.generation])
  const values = new Map<string, Set<number>>()
  for (const event of events) {
    if (event.channel !== 'history' || !isRecord(event.data)) continue
    const set = values.get(group(event.data)) ?? new Set([0])
    for (const key of OFFSET_KEYS) if (typeof event.data[key] === 'number') set.add(event.data[key] as number)
    values.set(group(event.data), set)
  }
  const ranks = new Map([...values].map(([name, set]) => [name, new Map([...set].sort((a, b) => a - b).map((value, rank) => [value, rank]))]))
  return (data: Record<string, unknown>) => {
    const table = ranks.get(group(data))
    const ranked: Record<string, unknown> = { ...data }
    for (const key of OFFSET_KEYS) if (typeof data[key] === 'number') ranked[key] = table?.get(data[key] as number)
    return ranked
  }
}

async function deriveTimeline(directory: string, events: CaptureEvent[]) {
  const normalizer = new EvidenceNormalizer()
  const splitters = new Map<string, FrameSplitter>()
  const rankOffsets = historyOffsetRanks(events)
  // chat_history rows use the separately reviewed transcript normalizer, grouped
  // per session so repeated rows across history generations keep their equality.
  const chatRows = new Map<string, Array<{ record: Record<string, unknown>; line: DerivedLine }>>()
  const lines: DerivedLine[] = []
  const channels: Record<string, number> = {}
  for (const event of events) {
    channels[`${event.channel}:${event.kind}`] = (channels[`${event.channel}:${event.kind}`] ?? 0) + 1
    const data = isRecord(event.data) ? event.data : {}
    const line: DerivedLine = { sequence: event.sequence, channel: event.channel, kind: event.kind, data: undefined }
    if (event.channel === 'terminal') {
      line.data = normalizer.value(terminalGeometry(event.data))
      line.omitted = 'terminal-content'
    } else if (event.channel === 'lifecycle' && event.kind === 'capture-start') {
      line.data = normalizer.value({ nativeVersion: data.nativeVersion, nodeVersion: data.nodeVersion })
      line.omitted = 'host-paths'
    } else if (event.channel === 'history') {
      normalizer.rankedOffsets = true
      try { line.data = normalizer.value(rankOffsets(data)) } finally { normalizer.rankedOffsets = false }
    } else {
      line.data = normalizer.value(event.data)
    }
    if (HARNESS_LABEL_CHANNELS.has(event.channel) && typeof data.label === 'string' && HARNESS_LABEL.test(data.label) && isRecord(line.data)) {
      line.data.label = data.label
    }
    if (event.blob) {
      if (event.channel === 'ipc' && (event.kind === 'received' || event.kind === 'write-attempt')) {
        const key = `${String(data.connectionId)}:${event.kind}`
        const splitter = splitters.get(key) ?? new FrameSplitter()
        splitters.set(key, splitter)
        line.frames = splitter.push(await readVerifiedCaptureBlob(directory, event)).map(envelope => normalizer.value(envelope))
      } else if (event.channel === 'history' && event.kind === 'row') {
        let record: unknown
        try { record = JSON.parse((await readVerifiedCaptureBlob(directory, event)).toString('utf8')) } catch {
          throw new Error(`Capture history row at sequence ${event.sequence} is not JSON`)
        }
        if (data.file === 'chat_history.jsonl' && isRecord(record)) {
          const group = String(data.sessionId)
          chatRows.set(group, [...(chatRows.get(group) ?? []), { record, line }])
        } else {
          line.row = normalizer.value(record)
        }
      } else {
        line.omitted ??= omissionFor(event)
      }
    }
    lines.push(line)
  }
  // The verifier refuses streams that end inside a frame; asserting it here keeps
  // the deriver from silently dropping a partial frame if it is ever reused alone.
  for (const [key, splitter] of splitters) if (splitter.pendingBytes) throw new Error(`Capture transport stream ends inside a frame: ${key}`)
  for (const rows of chatRows.values()) {
    const normalized = normalizeTranscript(rows.map(row => row.record))
    rows.forEach((row, index) => { row.line.row = normalized[index] })
  }
  return { jsonl: lines.map(line => JSON.stringify(line) + '\n').join(''), events: lines.length, channels, unknownKeys: normalizer.unknownKeys }
}

function compareVersions(a: string, b: string): number {
  const parse = (value: string) => value.split('.').map(part => Number(part) || 0)
  const [left, right] = [parse(a), parse(b)]
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) - (right[index] ?? 0)
  }
  return 0
}

export const CORPUS_LIMITS = [
  'Shape evidence only: prompts, replies, tool arguments and results, commands, paths, errors and other free text become per-timeline `[text N]` placeholders that keep equality within one timeline.',
  'Identities (sessions, prompts, connections, HTTP and JSON-RPC requests, tokens, tool calls, events, process ids) become per-timeline ordinals that keep cross-channel equality. String JSON-RPC ids share one `id-N` numbering with other string ids (auth methods, config options, todos), so a kept enum value such as a default auth method id is not matched to them. The id of a prompt-kind queue entry is numbered with prompt ids instead, so a waiting prompt and the same prompt running or completed share one `prompt-N`.',
  'chat_history rows use the separately reviewed transcript normalizer: their text placeholders, tool-call ids, tool names and prompt_index values are numbered independently, restarting per session, and do not match timeline identities. Its image carriers are placeholders too: inline data URLs keep their MIME type but decode to "fixture image N" instead of image bytes, other image URLs become fixture.invalid placeholder URLs, and its text equality ignores surrounding whitespace.',
  'History byte offsets are ranks within one (session, file, generation): order and equality hold there and 0 stays 0, but byte counts do not.',
  'Protocol counters (indices, geometry, codes, pagination, numeric ids) keep their values wherever they appear; every other number keeps only its sign and whether it is an integer, so comparisons such as token counts before and after compaction are not possible.',
  'Keys inside data-keyed objects (usage per model, todos, question answers and annotations, raw tool input) and any unrecognised key become `field_N`; values outside the recorded discriminator vocabulary become text placeholders.',
  'Binary payloads become `[binary omitted]` and malformed JSON becomes `[invalid JSON omitted]`, so equal binaries or malformed documents cannot be matched; identifiers embedded inside strings lose their equality.',
  'Omitted with explicit markers: terminal screen text and row arrays (numeric geometry and paint generations are kept where the recorded frame has them), PTY bytes, native file snapshot bytes, HTTP bodies, generated media bytes and host paths. Wall-clock timing is dropped because recording perturbs it.',
  'Decoded leader frames are attached to the event whose chunk completed them, so an event may carry an empty frame list.',
  'Ordering is observer arrival order within one capture, not native causality.',
  'Captures whose storage cannot be verified are not samples of native behaviour; they are counted only in unverifiableCaptures.',
  'Per-version capture counts are keyed by scenario id alone, so they include captures made by earlier revisions of that scenario\'s recorder code; a failed or refused count can describe a harness step that was later corrected rather than native behaviour.',
]

/**
 * Inventory (no output) or derive (explicit new output directory) the corpus.
 * Same safety contract as `generateTranscriptFixtures`: writing requires
 * UPDATE_FIXTURES=1, source and output must not overlap, files are written
 * exclusively and the manifest last, so a failed export is never a corpus.
 */
export async function deriveControlledRuntimeFixtures(source: string, output?: string): Promise<ControlledRuntimeCorpusManifest> {
  if (output && process.env.UPDATE_FIXTURES !== '1') throw new Error('Set UPDATE_FIXTURES=1 to generate fixtures')
  const sourceRoot = await realpath(source).catch(() => { throw new Error('Cannot resolve private capture storage') })
  let outputRoot: string | undefined
  if (output) {
    const destination = resolve(output)
    const parent = await realpath(dirname(destination)).catch(() => { throw new Error('Cannot resolve output parent') })
    outputRoot = join(parent, basename(destination))
    const contains = (root: string, path: string) => {
      const child = relative(root, path)
      return child === '' || (child !== '..' && !child.startsWith(`..${sep}`))
    }
    if (contains(sourceRoot, outputRoot) || contains(outputRoot, sourceRoot)) throw new Error('Source and output must not overlap')
  }

  type Candidate = { directory: string; version: string; modified: number }
  const registered = registeredScenarios()
  const counts = new Map<string, Record<string, { verified: number; refused: number; failed: number }>>()
  const verified = new Map<string, Candidate[]>()
  let unverifiableCaptures = 0
  for (const name of (await readdir(sourceRoot)).filter(entry => entry.startsWith('grok-recording-')).sort()) {
    const directory = join(sourceRoot, name)
    let storage: Awaited<ReturnType<typeof verifyRuntimeCapture>>
    try { storage = await verifyRuntimeCapture(directory) } catch { unverifiableCaptures++; continue }
    const id = String(storage.manifest.metadata.scenario)
    const start = storage.events.find(event => event.channel === 'lifecycle' && event.kind === 'capture-start')
    const version = /grok (\d+\.\d+\.\d+)/.exec(String(isRecord(start?.data) ? start.data.nativeVersion : ''))?.[1] ?? 'unknown'
    const tally = counts.get(id) ?? {}
    const row = tally[version] ?? { verified: 0, refused: 0, failed: 0 }
    tally[version] = row
    counts.set(id, tally)
    if (storage.manifest.scenarioOutcome !== 'passed' || !storage.manifest.captureComplete) { row.failed++; continue }
    const lifecycle = registered.find(scenario => scenario.id === id && 'kind' in scenario)
    try { await (lifecycle ? verifyLifecycleScenarioEvidence : verifyScenarioEvidence)(directory) } catch { row.refused++; continue }
    row.verified++
    verified.set(id, [...(verified.get(id) ?? []), { directory, version, modified: (await stat(join(directory, 'events.jsonl'))).mtimeMs }])
  }

  const manifest: ControlledRuntimeCorpusManifest = {
    schemaVersion: 1, normalization: 'controlled-runtime-shape-v1', evidenceRules: EVIDENCE_RULES_VERSION, unverifiableCaptures,
    scenarios: [], coverageGaps: [], limits: [...CORPUS_LIMITS],
  }
  const files: string[] = []
  for (const scenario of registered) {
    const candidates = verified.get(scenario.id) ?? []
    if (!candidates.length) {
      manifest.coverageGaps.push({ scenario: scenario.id, reason: `no capture verifies under evidence rules r${EVIDENCE_RULES_VERSION}` })
      continue
    }
    const chosen = candidates.sort((a, b) => compareVersions(b.version, a.version) || b.modified - a.modified)[0]!
    const { events } = await verifyRuntimeCapture(chosen.directory)
    const timeline = await deriveTimeline(chosen.directory, events)
    files.push(timeline.jsonl)
    manifest.scenarios.push({
      id: scenario.id, targets: [...scenario.targets], file: `${scenario.id}.jsonl`, nativeVersion: chosen.version,
      events: timeline.events, bytes: Buffer.byteLength(timeline.jsonl),
      // Hash the published, normalized timeline only; source hashes and capture
      // directory names are unnecessary correlations to private storage.
      sha256: createHash('sha256').update(timeline.jsonl).digest('hex'),
      unknownKeys: timeline.unknownKeys, channels: timeline.channels, captures: counts.get(scenario.id) ?? {},
    })
  }
  manifest.coverageGaps.push({
    agenda: 'cancellation racing the first prompt write',
    reason: 'no registered scenario issues a cancel before native has accepted the prompt at all; cancel-inference covers an outstanding inference and cancel-queued-prompt a prompt already accepted into the native queue',
  })

  if (outputRoot) {
    try {
      await mkdir(outputRoot, { mode: 0o755 })
      for (const [index, entry] of manifest.scenarios.entries()) await writeFile(join(outputRoot, entry.file), files[index]!, { flag: 'wx', mode: 0o644 })
      await writeFile(join(outputRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o644 })
    } catch { throw new Error('Cannot create fixture output; use a new writable directory. A partial export without a manifest must not be used.') }
  }
  return manifest
}
