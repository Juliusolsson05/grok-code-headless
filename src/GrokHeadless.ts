// GrokHeadless — the native Grok Build terminal, read the way Agent Code reads
// every provider.
//
// The app session starts the owned leader (GrokNativeControl), creates or resumes
// the session over it, starts the terminal socket guard (GrokTuiSocketGuard),
// prepares the launch, spawns the terminal PTY with the prepared arguments, and
// passes the PTY and both handles in. This class never spawns, kills or disposes a
// process, exactly like claude-code-headless, codex-headless and
// opencode-terminal-headless. It composes:
//
//   live/        control transitions: turns, acceptance, activity, requests
//   transcript/  durable channel: chat_history.jsonl entries and generations
//   reconcile/   the one place both meet (answer-before-completion ordering)
//   conditions/  shared conditions core → Agent Code's condition snapshot
//   channels/    semantic / screen / committed, the siblings' shape
//
// Every rule it applies is a Stage 2 catalog fact (testing/fixtures/
// controlled-runtime/catalog.json; contract.md explains the shape). Two are worth
// restating here because they decide the public surface:
// - A submitted prompt resolves on native ACCEPTANCE, the first queue
//   notification naming its client-chosen id, never on the write
//   (prompt.acceptance, prompt.write). A prompt that may have reached native is
//   never resent (decision uncertain-prompts).
// - The terminal moving to another conversation is detected from the terminal's
//   own requests and reported as `session-switched`. Fencing input is the app
//   session's job (decision terminal-conversation-change).
//
// Degradation is explicit, never silent:
// - An unreadable history file or entry → `transcript-error`; control keeps working.
// - A closed control connection → `live-state { connected: false }`, open turns
//   end uncertain and written submissions settle uncertain.
// - Native refusing the terminal's load → `terminal-load-refused`.
// - Native refusing a prompt it already accepted → a semantic `api_error`.

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'

import { CommittedChannel, ScreenChannel, SemanticChannel } from './channels/channels.js'
import type { GrokActivity, SemanticEvent } from './channels/types.js'
import type { ConditionCustomAction, ConditionSnapshot } from './conditions/core/contract.js'
import { makeEvaluator } from './conditions/core/evaluator.js'
import { GROK_MODULES, PERMISSION_CANCEL_ACTION, PERMISSION_REPLY_ACTION, PLAN_REPLY_ACTION, QUESTION_CANCEL_ACTION, type GrokConditionInputs } from './conditions/modules.js'
import type { GrokAcpServerRequest } from './control/GrokAcpClient.js'
import type { GrokTerminalLaunch } from './launch/prepareLaunch.js'
import { ControlStateProjector } from './live/ControlStateProjector.js'
import type { ControlInput, LiveOutput } from './live/types.js'
import { SessionSequencer } from './reconcile/SessionSequencer.js'
import { PtyBinding, type PtyLike } from './terminal/PtyBinding.js'
import type { GrokDurableEntry, GrokHistoryBoundary } from './transcript/durable.js'
import { HistoryReader } from './transcript/HistoryReader.js'
import { validateGrokSessionId } from './transcript/SessionDirEncoding.js'
import { resolveGrokTranscriptPath } from './transcript/SessionList.js'

/** The app-owned control helper, structurally: GrokNativeControl satisfies it. */
export type GrokControlHandle = {
  readonly isClosed: boolean
  /** Throws once the control lifetime is closed. */
  readonly rpc: {
    request(method: string, params: unknown, options?: { timeoutMs?: number | null }): Promise<unknown>
    notify(method: string, params: unknown): Promise<void>
    respond(token: string, result: unknown): Promise<void>
  }
  /** Tells an observer attached after the connection closed about the close at once. */
  observe(observer: {
    onNotification?: (value: { method: string; params?: unknown }) => void
    onRequest?: (value: GrokAcpServerRequest) => void
    onClose?: () => void
  }): () => void
}

/** The app-owned terminal socket guard, structurally: GrokTuiSocketGuard satisfies it. */
export type GrokGuardHandle = {
  observeTerminalMessages(listener: (message: { direction: 'from-terminal' | 'to-terminal'; payload: string }) => void): () => void
}

export type GrokHeadlessOptions = {
  /** The terminal PTY the app spawned from `launch`. Never killed here. */
  pty: PtyLike
  cwd: string
  launch: GrokTerminalLaunch
  control: GrokControlHandle
  guard: GrokGuardHandle
  /**
   * The conversation existed before this pane (the app resumed it). Its first
   * history generation is then a rewrite snapshot of an existing conversation
   * (history.replacement, process.restart-resume).
   */
  resume?: boolean
  /**
   * Sessions home. Defaults to the launch environment's GROK_HOME, where the
   * terminal this pane observes writes, then the host's GROK_HOME or ~/.grok.
   * Reading another home than the terminal's would wait forever for a file.
   */
  grokHome?: string
  now?: () => number
  heartbeatMs?: number
  settleDeadlineMs?: number
  /**
   * How long a submission waits for native acceptance before reporting
   * `unconfirmed` (prompt.acceptance). It changes only what is reported: the
   * prompt is never resent (decision uncertain-prompts).
   */
  acceptanceTimeoutMs?: number
}

/**
 * What is known about a submitted prompt.
 * - `not-sent`: never written, so native never saw it; sending again is safe.
 * - `refused`: native answered with an error before accepting it; nothing ran.
 * - `uncertain`: written, then the connection or this pane ended before native
 *   accepted it. It may have run; never resend it (decision uncertain-prompts).
 * - `unconfirmed`: written and not accepted within the bound. Its turn still flows
 *   if native runs it; never resend it.
 * The reason names differ from OpencodeTerminalHeadless's because the transports
 * differ; the app adapter maps both onto the same delivery dispositions.
 */
export type SubmitPromptResult =
  | { ok: true; promptId: string }
  | { ok: false; reason: 'not-sent' | 'refused' | 'uncertain' | 'unconfirmed'; promptId?: string; detail?: string }

export type ConditionActionResult =
  | { ok: true }
  | { ok: false; reason: string; failedAtStep?: string }

/** A durable-channel diagnostic. Control and conditions keep working. */
export type GrokTerminalError = { channel: 'durable'; code: string; message: string }

export type GrokHeadlessEvents = {
  activity: [GrokActivity]
  entry: [GrokDurableEntry]
  /** Generation reset or caught-up boundary (history.replacement); never completion or idle. */
  history: [GrokHistoryBoundary]
  semantic: [SemanticEvent]
  conditions: [ConditionSnapshot<'grok'>]
  /** Native agent mode (interaction.plan). */
  mode: [{ modeId: string }]
  'transcript-error': [GrokTerminalError]
  'live-state': [{ connected: boolean; reason?: string }]
  /** The terminal moved to another conversation. Detection only; the app session fences input. */
  'session-switched': [{ from: string; to: string }]
  /** Native answered the terminal's load of this session: re-seed the session MCP set now (tool.mcp). */
  'terminal-loaded': [{ sessionId: string }]
  /** Native refused the terminal's load of this session (session.load-failure): report the resume as failed. */
  'terminal-load-refused': [{ sessionId: string }]
  exit: [{ exitCode: number; signal?: number }]
}

export interface GrokHeadless {
  on<K extends keyof GrokHeadlessEvents>(event: K, listener: (...args: GrokHeadlessEvents[K]) => void): this
  off<K extends keyof GrokHeadlessEvents>(event: K, listener: (...args: GrokHeadlessEvents[K]) => void): this
  once<K extends keyof GrokHeadlessEvents>(event: K, listener: (...args: GrokHeadlessEvents[K]) => void): this
  emit<K extends keyof GrokHeadlessEvents>(event: K, ...args: GrokHeadlessEvents[K]): boolean
}

// WHY 30 s: acceptance is the first queue notification after the request is
// written, which every recording shows within the same observed second. A leader
// busy starting MCP servers or under host load is still healthy at 10–20 s. The
// bound only changes what is REPORTED: an unconfirmed prompt keeps being tracked,
// its turn still flows if native runs it, and it is never resent.
const DEFAULT_ACCEPTANCE_TIMEOUT_MS = 30_000

const PLAN_OUTCOMES = new Set(['approved', 'cancelled', 'abandoned'])

function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export class GrokHeadless extends EventEmitter {
  readonly semantic = new SemanticChannel()
  readonly screen = new ScreenChannel()
  readonly committed = new CommittedChannel()

  private readonly binding: PtyBinding
  private readonly sessionId: string
  private readonly file: string
  private readonly now: () => number
  private readonly projector: ControlStateProjector
  private readonly sequencer: SessionSequencer
  private readonly evaluator = makeEvaluator<'grok', GrokConditionInputs>('grok', GROK_MODULES, () => this.now())
  private readonly acceptance = new Map<string, (result: SubmitPromptResult) => void>()

  private conditionInputs: GrokConditionInputs = { permission: null, question: null, planApproval: null }
  private conditionSnapshot: ConditionSnapshot<'grok'>
  private history: HistoryReader | null = null
  private detachControl: (() => void) | null = null
  private detachGuard: (() => void) | null = null
  private liveState: { connected: boolean; reason?: string } | null = null
  private started = false
  private stopped = false
  private exited = false
  private tornDown = false

  constructor(private readonly options: GrokHeadlessOptions) {
    super()
    validateGrokSessionId(options.launch.sessionId)
    this.sessionId = options.launch.sessionId
    this.now = options.now ?? Date.now
    // Subscribes to the PTY's exit immediately; an exit before `start()` is
    // latched there and delivered by `start()` (see PtyBinding).
    this.binding = new PtyBinding(options.pty)
    this.file = resolveGrokTranscriptPath(options.cwd, this.sessionId, options.grokHome ?? options.launch.env.GROK_HOME)
    this.projector = new ControlStateProjector(this.sessionId)
    this.sequencer = new SessionSequencer({
      now: this.now,
      heartbeatMs: options.heartbeatMs,
      settleDeadlineMs: options.settleDeadlineMs,
      // The sequencer isolates consumer exceptions so one broken listener cannot
      // strand a turn; they surface as a durable diagnostic, never a throw inside
      // the state machine.
      onSinkError: error => this.reportError('sink_failed', `a session event sink threw: ${error instanceof Error ? error.message : String(error)}`),
      sink: {
        entry: entry => {
          this.committed.publish({ type: 'entry', entry, file: this.file, ts: this.now() })
          this.emit('entry', entry)
        },
        history: boundary => {
          this.committed.publish({ type: 'history', boundary, file: this.file, ts: this.now() })
          this.emit('history', boundary)
        },
        semantic: event => {
          this.semantic.publish(event)
          this.emit('semantic', event)
        },
        activity: state => {
          this.screen.publish({ type: 'activity', ...state, ts: this.now() })
          this.emit('activity', state)
        },
        requests: state => {
          this.screen.publish({ type: 'requests', state, ts: this.now() })
          this.conditionInputs = state
          this.publishConditions(false)
        },
        mode: modeId => {
          this.screen.publish({ type: 'mode', modeId, ts: this.now() })
          this.emit('mode', { modeId })
        },
      },
    })
    this.conditionSnapshot = this.evaluator.evaluate(this.conditionInputs)
  }

  /**
   * Attach to the PTY, the control lifetime, the guard's terminal traffic and the
   * durable history. Resolves without waiting for anything native.
   *
   * WHY a fence after every stage: each stage can call host code synchronously
   * (an exit a PTY latched, an onClose for a control lifetime already gone), and
   * that host code may stop the instance. `stop()` is idempotent, so a resource
   * opened after such a stop would never be released.
   */
  async start(): Promise<void> {
    if (this.started || this.isClosed()) return
    this.started = true
    this.binding.onExit(event => this.handleExit(event))
    if (this.isClosed()) return
    this.detachControl = this.options.control.observe({
      onNotification: value => this.route({ kind: 'notification', method: value.method, params: value.params }),
      onRequest: value => this.route({ kind: 'request', token: value.token, method: value.method, params: value.params }),
      onClose: () => {
        this.route({ kind: 'control-closed' })
        this.setLiveState({ connected: false, reason: 'control-closed' })
      },
    })
    if (this.isClosed()) return
    this.detachGuard = this.options.guard.observeTerminalMessages(message => this.terminalMessage(message))
    if (this.isClosed()) return
    this.openHistory()
    if (this.isClosed()) return
    if (!this.options.control.isClosed) this.setLiveState({ connected: true })
    // An explicit empty snapshot clears any condition a host cached under a
    // reused pane id before this backend existed.
    this.publishConditions(true)
  }

  /** Idempotent. Detaches from the PTY, the helpers and the history without killing or disposing anything. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.binding.detach()
    // Every submission still waiting was handed to the control client, so native
    // may have it. Reporting `not-sent` would invite a duplicate turn.
    this.settleAllSubmissions('stopped')
    await this.teardown()
  }

  /** Raw terminal input for the host's attached terminal. Programmatic prompts use submitPrompt. */
  write(data: string): void {
    this.binding.write(data)
  }

  resize(cols: number, rows: number): void {
    this.binding.resize(cols, rows)
  }

  /**
   * Deliver a prompt over the owned control connection with a fresh client
   * prompt id, and resolve once native ACCEPTS it: the first queue notification
   * naming that id, waiting or running (prompt.acceptance). The model's turn
   * continues through `semantic` and `activity`.
   */
  submitPrompt(text: string, opts: { timeoutMs?: number } = {}): Promise<SubmitPromptResult> {
    // Before start nothing observes acceptance, and after close nothing will. Both
    // refuse before writing, as OpenCode Terminal refuses before its live channel
    // exists.
    if (!this.started) return Promise.resolve({ ok: false, reason: 'not-sent', detail: 'not-started' })
    if (this.isClosed()) return Promise.resolve({ ok: false, reason: 'not-sent', detail: 'closed' })
    if (this.options.control.isClosed) return Promise.resolve({ ok: false, reason: 'not-sent', detail: 'control-closed' })
    let rpc: GrokControlHandle['rpc']
    try { rpc = this.options.control.rpc } catch { return Promise.resolve({ ok: false, reason: 'not-sent', detail: 'control-closed' }) }
    const promptId = randomUUID()
    // Registered before the write: acceptance may be observed before the write
    // callback returns (prompt.write), and must still be attributed.
    this.projector.registerPrompt(promptId)
    const requested = opts.timeoutMs ?? this.options.acceptanceTimeoutMs ?? DEFAULT_ACCEPTANCE_TIMEOUT_MS
    // Invalid timer values must not turn a bounded API into an infinite wait.
    const timeoutMs = Number.isFinite(requested) ? Math.max(0, requested) : DEFAULT_ACCEPTANCE_TIMEOUT_MS
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (result: SubmitPromptResult) => {
        if (!this.acceptance.has(promptId)) return
        this.acceptance.delete(promptId)
        clearTimeout(timer)
        resolve(result)
      }
      this.acceptance.set(promptId, finish)
      timer = setTimeout(() => finish({ ok: false, reason: 'unconfirmed', promptId }), timeoutMs)
      timer.unref?.()
      // session/prompt answers at turn end, not admission, so the request itself
      // carries no clock deadline; acceptance has its own bound above.
      void rpc.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }], _meta: { promptId } }, { timeoutMs: null }).then(
        result => this.route({ kind: 'prompt-result', promptId, result }),
        (error: { code?: unknown; rpcCode?: unknown; uncertain?: unknown } | undefined) => this.route({
          kind: 'prompt-error',
          promptId,
          native: error?.code === 'remote' && typeof error.rpcCode === 'number',
          // The control client marks a failure it raised before writing
          // `uncertain: false` (capacity, a connection already closed or aborted).
          // Anything else may have reached native.
          written: error?.uncertain !== false,
          ...(typeof error?.code === 'string' ? { detail: error.code } : {}),
        }),
      )
    })
  }

  /**
   * Stop the running turn over control (prompt.cancel). Queued prompts keep their
   * place and run (decision stop-scope); a running terminal-typed turn is
   * cancelled too (decision stop-foreign-turn). True means the cancel was
   * written, not that the turn has ended: its completion reports that.
   */
  async cancelTurn(): Promise<boolean> {
    if (this.isClosed()) return false
    try {
      await this.options.control.rpc.notify('session/cancel', { sessionId: this.sessionId })
      return true
    } catch {
      return false
    }
  }

  getProviderSessionId(): string {
    return this.sessionId
  }

  getTranscriptFile(): string {
    return this.file
  }

  getActivity(): GrokActivity {
    return this.sequencer.currentActivity()
  }

  getConditionSnapshot(): ConditionSnapshot<'grok'> {
    return this.conditionSnapshot
  }

  /** True once the terminal exited, including an exit latched before `start()` delivered it. */
  isExited(): boolean {
    return this.exited || this.binding.isExited()
  }

  /**
   * Answer the outstanding permission, question or plan approval over control,
   * with only the answer shapes native was recorded accepting (conditions/modules.ts).
   * Only a request still outstanding may be answered: one the terminal resolved
   * first is gone, and answering it is refused here before anything is written
   * (interaction.permission).
   */
  async resolveConditionAction(action: ConditionCustomAction): Promise<ConditionActionResult> {
    if (this.isClosed()) return { ok: false, reason: 'closed' }
    const payload = obj(action.payload)
    const token = str(payload.token)
    if (!token) return { ok: false, reason: 'invalid-payload' }
    let result: unknown
    if (action.name === PERMISSION_REPLY_ACTION) {
      const optionId = str(payload.optionId)
      if (!optionId) return { ok: false, reason: 'invalid-payload' }
      result = { outcome: { outcome: 'selected', optionId } }
    } else if (action.name === PERMISSION_CANCEL_ACTION) {
      result = { outcome: { outcome: 'cancelled' } }
    } else if (action.name === QUESTION_CANCEL_ACTION) {
      result = { outcome: 'cancelled' }
    } else if (action.name === PLAN_REPLY_ACTION) {
      const outcome = str(payload.outcome)
      if (!outcome || !PLAN_OUTCOMES.has(outcome)) return { ok: false, reason: 'invalid-payload' }
      if (outcome === 'cancelled') {
        // Keeping plan mode was recorded only with feedback text
        // (plan-exit-cancelled). A bare cancel is unrecorded, so it is refused
        // rather than guessed.
        const feedback = str(payload.feedback)
        if (!feedback) return { ok: false, reason: 'invalid-payload', failedAtStep: 'keeping plan mode requires feedback' }
        result = { outcome, feedback }
      } else {
        result = { outcome }
      }
    } else {
      return { ok: false, reason: 'no-resolver' }
    }
    const pending = this.projector.currentRequests()
    if (![pending.permission, pending.question, pending.planApproval].some(request => request?.token === token)) return { ok: false, reason: 'stale' }
    try {
      await this.options.control.rpc.respond(token, result)
    } catch (error) {
      const code = (error as { code?: unknown } | undefined)?.code
      return { ok: false, reason: code === 'stale-request' ? 'stale' : 'aborted', failedAtStep: `respond: ${String(code ?? 'unknown')}` }
    }
    // Cleared as soon as the answer is written, so the condition disappears the
    // moment the user acts; a late notification cannot bring it back.
    this.deliverOutputs(this.projector.forgetRequest(token))
    return { ok: true }
  }

  private route(input: ControlInput): void {
    if (!this.isLive()) return
    this.deliverOutputs(this.projector.apply(input))
  }

  /**
   * Hand projector outputs on. WHY submission results and terminal detection
   * bypass the sequencer: none of them changes a turn, a request or durable state,
   * so there is nothing to order them against.
   */
  private deliverOutputs(outputs: readonly LiveOutput[]): void {
    for (const output of outputs) {
      switch (output.kind) {
        case 'prompt-accepted': this.acceptance.get(output.promptId)?.({ ok: true, promptId: output.promptId }); break
        case 'prompt-refused': this.acceptance.get(output.promptId)?.({ ok: false, reason: 'refused', promptId: output.promptId }); break
        case 'prompt-not-sent': this.acceptance.get(output.promptId)?.({ ok: false, reason: 'not-sent', promptId: output.promptId, ...(output.detail ? { detail: output.detail } : {}) }); break
        case 'prompt-uncertain': this.acceptance.get(output.promptId)?.({ ok: false, reason: 'uncertain', promptId: output.promptId }); break
        case 'session-switched': if (this.isLive()) this.emit('session-switched', { from: output.from, to: output.to }); break
        case 'terminal-loaded': if (this.isLive()) this.emit('terminal-loaded', { sessionId: output.sessionId }); break
        case 'terminal-load-refused': if (this.isLive()) this.emit('terminal-load-refused', { sessionId: output.sessionId }); break
      }
    }
    this.sequencer.onLiveOutputs(outputs)
  }

  private terminalMessage(message: { direction: 'from-terminal' | 'to-terminal'; payload: string }): void {
    if (!this.isLive()) return
    // Native streams the whole session toward the terminal, in frames up to 64 MB
    // when they carry images, and this layer reads only native's answers to the
    // terminal's own load and session/new. Nothing is parsed while none is owed.
    if (message.direction === 'to-terminal' && !this.projector.awaitingTerminalAnswers()) return
    let rpc: unknown
    // A payload the guard already validated as an envelope but that is not JSON
    // names nothing this layer can act on.
    try { rpc = JSON.parse(message.payload) } catch { return }
    const value = obj(rpc)
    if (message.direction === 'from-terminal' && typeof value.method === 'string') {
      this.route({ kind: 'terminal-request', id: value.id as string | number | undefined, method: value.method, params: value.params })
    } else if (message.direction === 'to-terminal' && value.method === undefined && value.id !== undefined) {
      this.route({ kind: 'terminal-answer', id: value.id as string | number, result: value.result, error: value.error })
    }
  }

  private openHistory(): void {
    const reader = new HistoryReader({
      sessionId: this.sessionId,
      file: this.file,
      resume: this.options.resume === true,
      onEntries: entries => this.sequencer.onDurableEntries(entries),
      onBoundary: boundary => this.sequencer.onHistoryBoundary(boundary),
      onError: error => this.reportError('history_unreadable', error.message),
    })
    // Assigned before start: a synchronous error report may stop the instance,
    // and teardown must find the reader.
    this.history = reader
    reader.start()
  }

  private handleExit(event: { exitCode: number; signal?: number }): void {
    if (this.exited || this.stopped) return
    this.exited = true
    // WHY drain before closing turns, with control still routed meanwhile: the
    // drain is the last chance to hand over what native committed before the
    // terminal died, and a normally ended turn waiting for its answer should
    // complete with it rather than degraded. A terminal exit is not control loss,
    // so a completion that arrives during the drain ends its turn as native says.
    void (async () => {
      try {
        await this.history?.drain()
      } catch (error) {
        this.reportError('final_drain_incomplete', error instanceof Error ? error.message : String(error))
      }
      if (this.stopped) return
      this.sequencer.onExit()
      this.settleAllSubmissions('terminal-exited')
      await this.teardown()
      this.emit('exit', event)
    })()
  }

  private settleAllSubmissions(detail: string): void {
    for (const [promptId, finish] of [...this.acceptance]) finish({ ok: false, reason: 'uncertain', promptId, detail })
  }

  // Releases everything the instance holds, on every path that ends it. Idempotent.
  private async teardown(): Promise<void> {
    this.tornDown = true
    this.binding.detach()
    this.detachControl?.()
    this.detachControl = null
    this.detachGuard?.()
    this.detachGuard = null
    const history = this.history
    this.history = null
    this.sequencer.dispose()
    await history?.stop()
  }

  /** Closed to callers: stopped, or the terminal exited. */
  private isClosed(): boolean {
    return this.stopped || this.exited
  }

  /** Still consuming control and terminal traffic: not stopped and not torn down (an exiting terminal drains first). */
  private isLive(): boolean {
    return !this.stopped && !this.tornDown
  }

  private setLiveState(next: { connected: boolean; reason?: string }): void {
    if (this.liveState && this.liveState.connected === next.connected && this.liveState.reason === next.reason) return
    this.liveState = next
    this.emit('live-state', next)
  }

  private publishConditions(force: boolean): void {
    const snapshot = this.evaluator.evaluate(this.conditionInputs)
    this.conditionSnapshot = snapshot
    if (this.evaluator.changed(this.evaluator.keyOf(snapshot)) || force) this.emit('conditions', snapshot)
  }

  private reportError(code: string, message: string): void {
    this.committed.publish({ type: 'tail_error', code, message, ts: this.now() })
    this.emit('transcript-error', { channel: 'durable', code, message })
  }
}
