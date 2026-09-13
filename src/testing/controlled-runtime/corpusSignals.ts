// Signals a normalized controlled-runtime timeline line carries.
//
// WHY one module: the Claude render-shape verdicts and the Stage 2 catalog both
// cite corpus lines by signal, and both gates re-derive those signals from the
// committed timelines. Two private copies of the derivation would let a verdict
// and a catalog fact disagree about what the same line carries. Single consumer
// kind: controlled-runtime gate tests. Production runtime code must not import
// this; it describes the published corpus shape, not the native wire.

type Frame = { type?: unknown; payload?: unknown }
type CorpusLine = {
  sequence: number
  channel: string
  kind: string
  data?: any
  frames?: Frame[]
  row?: any
}

/** The harness session in every recorded scenario. Corpus identities are
 * ordinals in first-seen order, and each scenario creates its own session first. */
const ASSIGNED_SESSION = 'session-1'

/** Discriminator keys read at any depth of data, frames (including their JSON
 * payloads) and native updates/events rows; chat_history rows contribute row,
 * synthetic-reason and content-part types, because their other identities are
 * independently normalized. */
export function signalsOf(line: CorpusLine): Set<string> {
  const signals = new Set<string>()
  const walk = (value: unknown, parent = ''): void => {
    if (Array.isArray(value)) { for (const item of value) walk(item, parent); return }
    if (!value || typeof value !== 'object') return
    for (const [key, item] of Object.entries(value)) {
      if (['sessionUpdate', 'variant', 'tool_name', 'method', 'updateType'].includes(key) && typeof item === 'string') signals.add(`${key}:${item}`)
      if (key === 'kind' && (parent === 'update' || parent === 'toolCall') && typeof item === 'string') signals.add(`tool-kind:${item}`)
      if (key === 'payload' && typeof item === 'string' && item.startsWith('{')) walk(JSON.parse(item), key)
      else walk(item, key)
    }
  }
  walk(line.data)
  for (const frame of line.frames ?? []) walk(frame)
  const row = line.row
  if (row && typeof row === 'object') {
    if (line.data?.file === 'chat_history.jsonl') {
      if (typeof row.type === 'string') signals.add(`chat-row:${row.type}`)
      if (typeof row.synthetic_reason === 'string') signals.add(`chat-synthetic:${row.synthetic_reason}`)
      if (Array.isArray(row.tool_calls) && row.tool_calls.length) signals.add('chat-row:tool_calls')
      for (const part of Array.isArray(row.content) ? row.content : []) if (typeof part?.type === 'string') signals.add(`chat-part:${part.type}`)
    } else {
      if (typeof row.type === 'string') signals.add(`${line.data?.file}:${row.type}`)
      walk(row)
    }
  }
  return signals
}

function* frameMessages(line: CorpusLine): Generator<Record<string, unknown>> {
  for (const frame of line.frames ?? []) {
    if (typeof frame?.payload !== 'string') continue
    // A frame the deriver could not decode is already an omission marker; it
    // names no method, so it contributes nothing rather than failing.
    try {
      const message: unknown = JSON.parse(frame.payload)
      if (message && typeof message === 'object' && !Array.isArray(message)) yield message as Record<string, unknown>
    } catch { /* undecodable frame */ }
  }
}

/** signalsOf plus the ownership facts the Stage 2 catalog needs.
 *
 * WHY these and not every key: each one is a distinction some catalog fact
 * owns, and each is qualified by SOURCE where one string would otherwise
 * merge two owners:
 * - queue state is `other-session:` when it belongs to a child or second
 *   session, because those never drive the assigned session;
 * - values read from native's updates.jsonl and events.jsonl rows are
 *   `durable-`: a turn's `outcome: cancelled` in events.jsonl is a history
 *   observation, while the same string in a permission answer is a control one,
 *   and a value native writes only durably must surface under its own owner
 *   instead of hiding behind an identical control string;
 * - the terminal connection's traffic is `tui-sends:` / `tui-replies` (what the
 *   terminal itself sends) apart from `tui-receives:` (what native streams to
 *   it), because native offers shared requests to both clients and the
 *   terminal can answer first;
 * - `guard-forwards-answer` is a terminal answer the guard wrote upstream;
 * - `control-sends:` covers frames the control client wrote that have no harness
 *   action record (session/cancel, initialize).
 * Adding a key here widens the completeness universe, so a new one must come
 * with an owner in catalog.json. */
export function catalogSignals(line: CorpusLine): Set<string> {
  const signals = signalsOf(line)
  signals.add(`${line.channel}:${line.kind}`)
  const walk = (value: unknown, source: '' | 'durable-'): void => {
    if (Array.isArray(value)) { for (const item of value) walk(item, source); return }
    if (!value || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    const add = (signal: string) => signals.add(source + signal)
    if (record.method === '_x.ai/queue/changed' && record.params && typeof record.params === 'object') {
      const params = record.params as { sessionId?: unknown; runningPromptId?: unknown; entries?: unknown }
      const prefix = params.sessionId === ASSIGNED_SESSION ? '' : 'other-session:'
      const waiting = Array.isArray(params.entries) && params.entries.length > 0
      add(prefix + (params.runningPromptId ? 'queue:running' : waiting ? 'queue:waiting' : 'queue:idle'))
      if (waiting && params.runningPromptId) add(`${prefix}queue:waiting-behind-running`)
    }
    if (record.sessionUpdate === 'tool_call_update' && typeof record.status === 'string') add(`status:${record.status}`)
    if (record.sessionUpdate === 'current_mode_update' && typeof record.currentModeId === 'string') add(`mode:${record.currentModeId}`)
    if (record.method === '_x.ai/mcp/server_status' && record.params && typeof record.params === 'object') {
      const params = record.params as { status?: unknown; reason?: unknown }
      if (typeof params.status === 'string') add(`mcp-status:${params.status}`)
      if (typeof params.reason === 'string') add(`mcp-reason:${params.reason}`)
    }
    for (const [key, item] of Object.entries(record)) {
      if ((key === 'stopReason' || key === 'stop_reason') && typeof item === 'string') add(`stop:${item}`)
      if (key === 'isReplay' && item === true) add('replay')
      if (key === 'activity' && typeof item === 'string') add(`activity:${item}`)
      if (key === 'outcome' && typeof item === 'string') add(`outcome:${item}`)
      // Control payloads spell the category camelCase and events.jsonl rows spell
      // it snake_case. Reading one spelling left every durable category underived.
      if ((key === 'cancellationCategory' || key === 'cancellation_category') && typeof item === 'string') add(`cancel-category:${item}`)
      if (key === 'reason' && line.channel === 'guard' && typeof item === 'string') add(`guard-reason:${item}`)
      walk(item, source)
    }
  }
  walk(line.data, '')
  // updates.jsonl and events.jsonl rows carry the same keys durably (a failed tool
  // status, a turn outcome), so a value native writes only there must still reach
  // the universe, under `durable-` (see above). chat_history rows are excluded:
  // their identities are normalized independently and signalsOf already reads
  // their row types.
  if (line.row && typeof line.row === 'object' && line.data?.file !== 'chat_history.jsonl') walk(line.row, 'durable-')
  // Notifications for a child or second session share the connection but never
  // drive the assigned session; their method is qualified so ownership can say so.
  const notifiedSession = line.channel === 'control' && line.kind === 'notification' ? line.data?.params?.sessionId : undefined
  if (typeof notifiedSession === 'string' && notifiedSession !== ASSIGNED_SESSION && typeof line.data?.method === 'string') signals.add(`other-session:method:${line.data.method}`)
  if (line.channel === 'action' && line.kind === 'rpc-error') signals.add(`rpc-error:${line.data?.code}`)
  if (line.channel === 'action' && line.kind === 'rpc-requested' && line.data?.method === 'session/prompt') {
    signals.add(typeof line.data?.params?._meta?.promptId === 'string' ? 'prompt-id:client' : 'prompt-id:native')
  }
  if (line.channel === 'ipc') {
    const role = line.data?.role
    signals.add(`ipc-role:${role}`)
    if (line.kind === 'opened' || line.kind === 'closing' || line.kind === 'closed') signals.add(`connection:${role}:${line.kind}`)
    for (const message of frameMessages(line)) {
      const method = typeof message.method === 'string' ? message.method : undefined
      const answer = message.method === undefined && 'id' in message
      if (role === 'tui' && line.kind === 'received') {
        if (method) signals.add(`tui-sends:${method}`)
        if (answer) {
          signals.add('tui-replies')
          if ('error' in message) signals.add('tui-replies-error')
          // Permission answers nest the outcome (`{ outcome: { outcome } }`); plan and
          // question answers carry it directly (`{ outcome }`).
          const result = message.result && typeof message.result === 'object' ? message.result as { outcome?: unknown } : {}
          const nested = result.outcome && typeof result.outcome === 'object' ? (result.outcome as { outcome?: unknown }).outcome : result.outcome
          if (typeof nested === 'string') signals.add(`tui-replies-outcome:${nested}`)
        }
      }
      if (role === 'tui' && line.kind === 'write-attempt') {
        if (method) signals.add(`tui-receives:${method}`)
        if (answer) signals.add('tui-receives-answer')
        // What native streams to the terminal is not always also on control: after
        // a resume the replay goes only to the terminal, and a terminal-created
        // session's traffic never reaches control.
        const update = (message.params as { update?: { sessionUpdate?: unknown } } | undefined)?.update?.sessionUpdate
        if (typeof update === 'string') signals.add(`tui-receives-update:${update}`)
      }
      if (role === 'control' && line.kind === 'write-attempt' && method) signals.add(`control-sends:${method}`)
      // The guard's upstream side otherwise repeats the terminal direction and is
      // not derived. A terminal answer written upstream is the exception: it is the
      // only record that a late terminal answer reached native at all. Without it,
      // "the late answer changed nothing" could not be told apart from "the guard
      // never forwarded it".
      if (role === 'guard-upstream' && line.kind === 'write-attempt' && answer) signals.add('guard-forwards-answer')
    }
  }
  return signals
}

/** Channels whose lines are recorder bookkeeping, controlled stimulus or
 * byte-level payloads rather than native observations the runtime consumes. */
const NON_NATIVE_CHANNELS = new Set(['http', 'terminal', 'file', 'observation', 'stimulus', 'scenario'])
const TRANSPORT_UNIVERSE_PREFIXES = ['tui-sends:', 'tui-replies', 'tui-receives', 'control-sends:', 'connection:', 'guard-forwards-answer']

/** Whether a signal on this line belongs to the catalog's completeness universe.
 *
 * WHY transport lines count only through the derived traffic signals: their raw
 * discriminators mix both directions and every connection into one string, so
 * ownership by raw discriminator would merge control, terminal and guard copies.
 * The derived signals keep them apart: connection epochs, what the terminal
 * sends and replies, every update kind native writes toward the terminal
 * (including replay and new-session traffic control never sees), terminal
 * answers the guard forwards upstream, and control frames with no harness action.
 *
 * Two limits are deliberate:
 * - Other guard-upstream copies are not derived; they repeat the terminal
 *   direction on the leader side.
 * - Values inside frames written toward the terminal (a stop reason, tool status
 *   or mode in the resume replay native sends only to the terminal) are not
 *   derived. The runtime takes no state from terminal-bound frames: it reads the
 *   terminal connection only for the terminal's own requests and native's
 *   answers to them (session.terminal-connection), so a new value there cannot
 *   be consumed unowned. The same value on control or in a durable row still
 *   fails the gate. */
export function inCatalogUniverse(line: CorpusLine, signal: string): boolean {
  if (line.channel === 'ipc') return TRANSPORT_UNIVERSE_PREFIXES.some(prefix => signal.startsWith(prefix))
  if (NON_NATIVE_CHANNELS.has(line.channel)) return false
  return !(line.channel === 'tui' && line.kind === 'output')
}
