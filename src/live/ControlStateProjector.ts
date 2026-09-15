// ControlStateProjector — the only code that knows Grok's control vocabulary.
// It turns the owned control connection's notifications, reverse requests and
// prompt answers, plus the requests the native terminal sends on its own
// connection, into turn, activity, phase and pending-request transitions for
// ONE assigned session. Pure and synchronous: no sockets, no timers.
//
// Every rule is a Stage 2 catalog fact (testing/fixtures/controlled-runtime/
// catalog.json); the fact id is named where the rule is applied. The rules that
// look surprising, and the recording that forces each:
// - Acceptance is the first queue notification naming the app's client-chosen
//   prompt id, never an echo of the text and never a completion (prompt.acceptance).
//   Identical terminal and app prompts have exactly the same shape; only the id
//   tells them apart.
// - Activity comes from the queue plus per-prompt completion. sessions/changed
//   was recorded announcing idle while a queued prompt was already running
//   (concurrent-prompts:511), and a cancelled prompt completed with no
//   queue-empty notification before it (cancel-inference:340), so neither the
//   announcement nor the queue alone can end activity (session.activity).
// - Completion arrives up to three ways for one prompt (the prompt result,
//   _x.ai/session/prompt_complete, the extension turn_completed update) in
//   varying order, and the next prompt can already be running when it does.
//   The first one wins and the rest are no-ops, keyed by prompt id
//   (prompt.completion).
// - The terminal's conversation change is visible only in the terminal's own
//   requests: nothing reaches control, and native keeps streaming the original
//   session to the terminal (session.terminal-connection).
//
// The projector never decides transcript content. Live text is provisional; the
// durable history reader owns rows (history.durable).

import type { ControlInput, LiveOutput, PendingPermission, PendingPlanApproval, PendingQuestion, PendingRequests, StreamPhase } from './types.js'

type Props = Record<string, unknown>

function obj(value: unknown): Props {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Props) : {}
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Native extension responses and requests are sometimes wrapped as `{ method, params }`. */
function innerParams(value: unknown): Props {
  const outer = obj(value)
  return typeof outer.method === 'string' && outer.params !== null && typeof outer.params === 'object' ? obj(outer.params) : outer
}

function toolCallIdOf(params: Props): string | null {
  const tool = obj(params.toolCall ?? params.tool_call)
  return str(params.toolCallId) ?? str(params.tool_call_id) ?? str(tool.toolCallId) ?? str(tool.tool_call_id) ?? str(tool.id) ?? null
}

export function permissionFromRequest(token: string, params: Props): PendingPermission | null {
  const sessionId = str(params.sessionId)
  if (!sessionId) return null
  const tool = obj(params.toolCall)
  const options = (Array.isArray(params.options) ? params.options : [])
    .map(option => obj(option))
    .map(option => ({ optionId: str(option.optionId) ?? '', name: str(option.name) ?? str(option.optionId) ?? '', kind: str(option.kind) ?? null }))
    .filter(option => option.optionId.length > 0)
  return { token, sessionId, toolCallId: toolCallIdOf(params), title: str(tool.title) ?? 'Permission', options, metadata: params }
}

export function questionFromRequest(token: string, params: Props): PendingQuestion | null {
  const sessionId = str(params.sessionId)
  if (!sessionId) return null
  const text = (Array.isArray(params.questions) ? params.questions : [])
    .map(item => str(obj(item).question))
    .filter((line): line is string => line !== undefined)
    .join('\n')
  return { token, sessionId, toolCallId: toolCallIdOf(params), text, metadata: params }
}

export function planApprovalFromRequest(token: string, params: Props): PendingPlanApproval | null {
  const sessionId = str(params.sessionId)
  if (!sessionId) return null
  return { token, sessionId, toolCallId: toolCallIdOf(params), planContent: typeof params.planContent === 'string' ? params.planContent : '', metadata: params }
}

type AnyPending = PendingPermission | PendingQuestion | PendingPlanApproval

export class ControlStateProjector {
  // App prompt ids registered before their request is written, so an
  // acceptance that races the write receipt is still attributed (prompt.write).
  private readonly appPrompts = new Set<string>()
  private readonly accepted = new Set<string>()
  private readonly started = new Set<string>()
  private readonly completed = new Set<string>()
  // Turns that started and have not completed. More than one can be open for a
  // moment: native starts the next queued prompt before it announces the
  // previous one's completion (concurrent-prompts 509 then 510).
  private readonly open = new Set<string>()
  private running: string | null = null
  private waiting: string[] = []
  private phase: StreamPhase = 'idle'
  private active = false
  // Outstanding reverse requests per kind, oldest first; the condition surface
  // shows the head of each. WHY a queue and not one slot per kind: a second
  // outstanding request of the same kind must not silently replace the first
  // while native still waits for its answer. Two at once is unrecorded, and
  // keeping both never loses an answer path.
  private readonly outstanding: { permission: PendingPermission[]; question: PendingQuestion[]; planApproval: PendingPlanApproval[] } = { permission: [], question: [], planApproval: [] }
  private requests: PendingRequests = { permission: null, question: null, planApproval: null }
  private readonly answered = new Set<string>()
  // JSON-encoded ids of terminal requests awaiting native's answer, so 3 and "3"
  // never pair (the same rule the evidence verifier applies to load answers).
  private readonly terminalNewSessionIds = new Set<string>()
  private readonly terminalLoadIds = new Set<string>()
  // The conversation the terminal was last reported moving to. Each move is
  // reported once, and a later move back to the same target after the terminal
  // returned to the assigned session is a new move.
  private reportedTarget: string | null = null
  private closed = false

  constructor(private readonly sessionId: string) {}

  /** Register an app prompt id before its request is written. */
  registerPrompt(promptId: string): void {
    this.appPrompts.add(promptId)
  }

  apply(input: ControlInput): LiveOutput[] {
    if (this.closed) return []
    const out: LiveOutput[] = []
    switch (input.kind) {
      case 'notification': this.notification(input.method, obj(input.params), out); break
      case 'request': this.request(input.token, input.method, innerParams(input.params), out); break
      case 'prompt-result': this.complete(input.promptId, str(obj(input.result).stopReason) ?? 'end_turn', out); break
      case 'prompt-error': this.promptError(input, out); break
      case 'terminal-request': this.terminalRequest(input, out); break
      case 'terminal-answer': this.terminalAnswer(input, out); break
      case 'control-closed': this.controlClosed(out); break
    }
    return out
  }

  /** Forget a request the app answered, so a late notification cannot resurrect it (interaction.permission). */
  forgetRequest(token: string): LiveOutput[] {
    this.answered.add(token)
    const out: LiveOutput[] = []
    this.retire(request => request.token === token, out)
    return out
  }

  /** Whether native still owes the terminal an answer this layer reads (its load of this session, or a session/new). */
  awaitingTerminalAnswers(): boolean {
    return this.terminalLoadIds.size > 0 || this.terminalNewSessionIds.size > 0
  }

  isActive(): boolean { return this.active }
  runningTurn(): string | null { return this.running }
  currentRequests(): PendingRequests { return this.requests }

  private notification(method: string, params: Props, out: LiveOutput[]): void {
    // sessions/changed lists every resident session and is advisory only
    // (session.activity); it is deliberately not consumed.
    if (method === '_x.ai/sessions/changed') return
    // Every other notification names a session. Child and unrelated sessions
    // share this connection (content.subagent, session.identity) and never
    // drive this session's turns or activity.
    if (params.sessionId !== this.sessionId) return
    if (method === '_x.ai/queue/changed') { this.queue(params, out); return }
    if (method === '_x.ai/session/prompt_complete') {
      const promptId = str(params.promptId)
      if (promptId) this.complete(promptId, str(params.stopReason) ?? 'end_turn', out)
      return
    }
    const update = obj(params.update)
    const kind = str(update.sessionUpdate)
    // Replay is bounded by the load answer and never opens, advances or ends a
    // turn (session.load-replay).
    if (obj(params._meta).isReplay === true) return
    switch (kind) {
      case 'turn_completed': {
        const promptId = str(update.prompt_id)
        if (promptId) this.complete(promptId, str(update.stop_reason) ?? 'end_turn', out)
        return
      }
      case 'agent_thought_chunk': this.setPhase('thinking', out); return
      case 'agent_message_chunk': {
        this.setPhase('responding', out)
        const text = str(obj(update.content).text)
        if (text) out.push({ kind: 'text', turnId: this.running, text })
        return
      }
      case 'tool_call': this.setPhase('tool-use', out, str(update.title)); return
      case 'current_mode_update': {
        const modeId = str(update.currentModeId) ?? str(update.modeId)
        if (modeId) out.push({ kind: 'mode', modeId })
        return
      }
      case 'interaction_resolved': {
        // Resolution by either client retires the request (interaction.permission).
        const callId = str(update.tool_call_id) ?? str(update.toolCallId)
        if (callId) this.retire(request => request.toolCallId === callId, out)
        return
      }
    }
  }

  private queue(params: Props, out: LiveOutput[]): void {
    const running = str(params.runningPromptId) ?? null
    const waiting = (Array.isArray(params.entries) ? params.entries : []).map(entry => str(obj(entry).id)).filter((id): id is string => id !== undefined)
    // Acceptance on the first notification that names an app prompt id at all,
    // waiting or running (prompt.acceptance).
    for (const id of running ? [...waiting, running] : waiting) {
      if (this.appPrompts.has(id) && !this.accepted.has(id) && !this.completed.has(id)) {
        this.accepted.add(id)
        out.push({ kind: 'prompt-accepted', promptId: id })
      }
    }
    this.waiting = waiting.filter(id => !this.completed.has(id))
    // A completed prompt that a stale queue notification still names does not
    // come back to life; the completion already ended it (prompt.completion).
    // WHY an empty running slot does not end the open turn: native empties the
    // queue one notification BEFORE it announces completion (text-load-repeat
    // 483 then 484), so treating the empty slot as the end would report idle
    // ahead of the turn's own completion. Only a completion, or the connection
    // closing, ends a turn.
    if (running && !this.completed.has(running)) {
      this.running = running
      if (!this.started.has(running)) {
        this.started.add(running)
        this.open.add(running)
        out.push({ kind: 'turn-start', turnId: running, foreign: !this.appPrompts.has(running) })
        this.setPhase('requesting', out)
      }
    }
    this.recomputeActivity(out)
  }

  private complete(promptId: string, stopReason: string, out: LiveOutput[]): void {
    if (this.completed.has(promptId)) return
    this.completed.add(promptId)
    // No acceptance here: a completion that arrives before any queue notification
    // names the prompt is unrecorded, and the submission reports `unconfirmed`
    // rather than a guessed acceptance (prompt.acceptance).
    // Only a started turn can end; a prompt that completed without ever running
    // has no turn to close.
    if (this.started.has(promptId)) out.push({ kind: 'turn-end', turnId: promptId, stopReason, foreign: !this.appPrompts.has(promptId) })
    this.open.delete(promptId)
    if (this.running === promptId) this.running = null
    // The idle phase names the turn that just ended, so a consumer can pair it
    // with that turn's completion even when the next turn is already queued.
    if (this.open.size === 0) this.setPhase('idle', out, undefined, promptId)
    this.waiting = this.waiting.filter(id => id !== promptId)
    this.recomputeActivity(out)
  }

  private promptError(input: Extract<ControlInput, { kind: 'prompt-error' }>, out: LiveOutput[]): void {
    const { promptId } = input
    if (this.completed.has(promptId)) return
    if (input.native) {
      // A JSON-RPC error answer is native's definite answer (control.rpc-failure).
      // No recording has one for session/prompt, so what follows reports what
      // native said and guesses nothing about what it did.
      if (this.started.has(promptId)) {
        // It was running: the error is surfaced on its turn, which ends with the
        // package's `error` stop reason.
        out.push({ kind: 'api-error', turnId: promptId, message: input.detail ?? 'native answered the running prompt with an error' })
        this.complete(promptId, 'error', out)
        return
      }
      this.completed.add(promptId)
      this.waiting = this.waiting.filter(id => id !== promptId)
      // Not yet accepted: its submission is still waiting and fails as refused.
      // Already accepted: its submission already reported success, so the refusal
      // must reach consumers another way instead of vanishing.
      if (this.accepted.has(promptId)) out.push({ kind: 'api-error', turnId: null, message: input.detail ?? 'native refused an accepted prompt before it ran' })
      else out.push({ kind: 'prompt-refused', promptId })
      this.recomputeActivity(out)
      return
    }
    if (!input.written) {
      // The client refused before writing, so native never saw the prompt
      // (prompt.write). Sending it again is safe.
      this.completed.add(promptId)
      out.push({ kind: 'prompt-not-sent', promptId, ...(input.detail ? { detail: input.detail } : {}) })
      return
    }
    // Written, then settled without an answer (closed, timed out, aborted): native
    // may have run it. Uncertain, never replayed (prompt.uncertain).
    out.push({ kind: 'prompt-uncertain', promptId })
  }

  private request(token: string, method: string, params: Props, out: LiveOutput[]): void {
    if (this.answered.has(token) || params.sessionId !== this.sessionId) return
    if (method === 'session/request_permission') {
      const permission = permissionFromRequest(token, params)
      if (permission && !this.outstanding.permission.some(request => request.token === token)) this.outstanding.permission.push(permission)
    } else if (method === '_x.ai/ask_user_question') {
      const question = questionFromRequest(token, params)
      if (question && !this.outstanding.question.some(request => request.token === token)) this.outstanding.question.push(question)
    } else if (method === '_x.ai/exit_plan_mode') {
      const approval = planApprovalFromRequest(token, params)
      if (approval && !this.outstanding.planApproval.some(request => request.token === token)) this.outstanding.planApproval.push(approval)
    }
    this.publishRequests(out)
  }

  private terminalRequest(input: Extract<ControlInput, { kind: 'terminal-request' }>, out: LiveOutput[]): void {
    const params = obj(input.params)
    if (input.method === 'session/new') {
      // The new id exists only once native answers (tui-new-session:525); a
      // refused session/new moved nothing.
      if (input.id !== undefined) this.terminalNewSessionIds.add(JSON.stringify(input.id))
      return
    }
    const target = str(params.sessionId)
    if (input.method === 'session/load' && target === this.sessionId) {
      // The terminal's load of the assigned session is expected on attach and on
      // resume; its answer is when the MCP set must be re-seeded (tool.mcp).
      if (input.id !== undefined) this.terminalLoadIds.add(JSON.stringify(input.id))
      // Back on the assigned conversation, so a later move away is a new move.
      // Whether the terminal ever returns by itself is unrecorded, so the return
      // is not reported, and the app session's fence stays until the user acts.
      this.reportedTarget = null
    }
    if ((input.method === 'session/load' || input.method === 'session/prompt') && target && target !== this.sessionId) this.reportSwitch(target, out)
  }

  private terminalAnswer(input: Extract<ControlInput, { kind: 'terminal-answer' }>, out: LiveOutput[]): void {
    const key = JSON.stringify(input.id)
    if (this.terminalLoadIds.delete(key)) {
      const refused = input.error !== undefined && input.error !== null
      out.push(refused ? { kind: 'terminal-load-refused', sessionId: this.sessionId } : { kind: 'terminal-loaded', sessionId: this.sessionId })
      return
    }
    if (!this.terminalNewSessionIds.delete(key)) return
    const to = str(obj(input.result).sessionId)
    if (to && to !== this.sessionId) this.reportSwitch(to, out)
  }

  private reportSwitch(to: string, out: LiveOutput[]): void {
    if (this.reportedTarget === to) return
    this.reportedTarget = to
    out.push({ kind: 'session-switched', from: this.sessionId, to })
  }

  private controlClosed(out: LiveOutput[]): void {
    // Nothing more will be answered: every app prompt without a completion is
    // uncertain, the running turn ends uncertain, and pending requests lose
    // their only answer path (prompt.uncertain).
    for (const promptId of this.appPrompts) {
      if (!this.completed.has(promptId)) out.push({ kind: 'prompt-uncertain', promptId })
    }
    for (const turnId of this.open) {
      this.completed.add(turnId)
      out.push({ kind: 'turn-end', turnId, stopReason: 'uncertain', foreign: !this.appPrompts.has(turnId) })
    }
    this.open.clear()
    this.running = null
    this.setPhase('idle', out)
    this.waiting = []
    this.retire(() => true, out)
    this.recomputeActivity(out)
    this.closed = true
  }

  private setPhase(phase: StreamPhase, out: LiveOutput[], toolName?: string, turnId: string | null = this.running): void {
    if (phase === this.phase && phase !== 'tool-use') return
    this.phase = phase
    out.push({ kind: 'phase', phase, turnId, ...(toolName ? { toolName } : {}) })
  }

  private recomputeActivity(out: LiveOutput[]): void {
    const active = this.open.size > 0 || this.waiting.length > 0
    if (active === this.active) return
    this.active = active
    out.push({ kind: 'activity', active, status: active ? 'working' : null })
  }

  private retire(match: (request: AnyPending) => boolean, out: LiveOutput[]): void {
    this.outstanding.permission = this.outstanding.permission.filter(request => !match(request))
    this.outstanding.question = this.outstanding.question.filter(request => !match(request))
    this.outstanding.planApproval = this.outstanding.planApproval.filter(request => !match(request))
    this.publishRequests(out)
  }

  private publishRequests(out: LiveOutput[]): void {
    const next: PendingRequests = {
      permission: this.outstanding.permission[0] ?? null,
      question: this.outstanding.question[0] ?? null,
      planApproval: this.outstanding.planApproval[0] ?? null,
    }
    if (next.permission === this.requests.permission && next.question === this.requests.question && next.planApproval === this.requests.planApproval) return
    this.requests = next
    out.push({ kind: 'requests', ...next })
  }
}
