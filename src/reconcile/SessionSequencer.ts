// SessionSequencer — THE isolated layer where Grok's two sources meet.
//
// It is the only module that sees both durable history entries (from
// transcript/) and control transitions (from live/). Its single consumer is
// GrokHeadless. Nothing else in the package, and nothing in Agent Code, may
// import it; this is the same boundary as opencode-terminal-headless's
// reconcile/SessionSequencer.ts, and the Stage 3 contract
// (testing/fixtures/controlled-runtime/contract.md) names it.
//
// Ownership, one owner per signal so there is nothing to arbitrate:
//   durable entries and history boundaries ← chat_history.jsonl only (history.durable)
//   turns, phases, activity, pending requests ← control only (prompt.*, session.activity)
//
// The one cross-source rule, and the reason this layer exists: a turn that
// ended normally (`end_turn`) reaches consumers only AFTER its final durable
// answer. Agent Code's orchestration decides a child is finished from exactly
// that order (committed assistant entry, then turn_completed, then idle), and
// `turn_completed.fullText` is read off the same answer.
//
// Native does not guarantee that order. In the corpus the final assistant row
// lands before its completion in most normally ended turns, and after it in 13
// (8–418 ms later, across 11 scenarios; prompt.completion). So an `end_turn`
// completion with no final answer yet WAITS: it and every control output behind
// it are held, in order, until an appended final answer arrives or a bounded
// deadline passes. At the deadline the turn ends visibly degraded, with the live
// reply text as fullText; an answer that lands later still reaches the committed
// channel, after turn_completed. That late entry is the one documented exception
// to the order.
//
// A "final answer" is an assistant row with no tool calls that was appended after
// its generation's rewrite snapshot. Assistant rows that carry tool calls are
// intermediate steps of the same turn (command-error's first assistant row is its
// tool call; its final answer arrives separately). Snapshot rows are excluded
// because a rewrite (rewind, compaction, resume) re-delivers older answers. No
// recorded final answer first appeared inside a snapshot; if one did, the turn
// would complete at the deadline instead of taking a stale answer.
//
// Answers go to the oldest turn still owed one: first a turn that already
// completed at the deadline without its answer, then the oldest open turn.
// Native runs one prompt at a time, so a turn that completed started before every
// turn still open, and a late answer belongs to it (concurrent-prompts starts
// prompt 2 at 509 before announcing prompt 1's completion at 510). A row that
// arrives while no turn is owed one is attributed to none: no recorded turn
// writes a second final row (prompt.completion gap). If native never wrote an
// expired turn's answer (unrecorded), the next row would still settle that debt
// and the next turn would complete at its own deadline with its live text. That
// degradation is visible; handing a turn another turn's answer would be silent.
//
// Turns that did not end normally (cancelled, error, uncertain) complete at
// once: native writes no final answer for them (cancel-inference has no
// assistant row after its cancel), so waiting would only add the deadline.
//
// Sinks are isolated: one that throws cannot stop the turn from closing for the
// others. The error goes to `onSinkError`.

import type { GrokActivity, SemanticEvent } from '../channels/types.js'
import type { LiveOutput, PendingRequests } from '../live/types.js'
import type { GrokDurableEntry, GrokHistoryBoundary } from '../transcript/durable.js'

export type SequencerSink = {
  entry(entry: GrokDurableEntry): void
  history(boundary: GrokHistoryBoundary): void
  semantic(event: SemanticEvent): void
  activity(state: GrokActivity): void
  requests(state: PendingRequests): void
  mode(modeId: string): void
}

export type SessionSequencerOptions = {
  sink: SequencerSink
  now?: () => number
  /**
   * While active, re-emit the current activity at this interval. Agent Code's
   * main process keeps no process-state cache, so a renderer that reloads or
   * re-adopts a pane mid-turn only learns "busy" from the next emission; the
   * siblings re-emit about once a second for the same reason.
   */
  heartbeatMs?: number
  /** Longest a normally ended turn waits for its final durable answer. */
  settleDeadlineMs?: number
  onSinkError?: (error: unknown) => void
}

// WHY 2 s: the longest recorded gap between completion and the final durable
// answer is 418 ms, and the history tailer polls every 100 ms, so the answer is
// observable within about half a second in every recording. 2 s is four times
// that, and short enough that a pane reading busy after the terminal already
// shows the answer does not tempt anyone to press Stop. It is the same bound
// OpenCode Terminal uses for the same wait.
const SETTLE_DEADLINE_MS = 2_000

type OpenTurn = { liveText: string; finalAnswer: string | null }

export class SessionSequencer {
  private readonly now: () => number
  private readonly heartbeatMs: number
  private readonly settleDeadlineMs: number
  private readonly turns = new Map<string, OpenTurn>()
  // Turns that completed at the deadline and are still owed their answer, oldest first.
  private owedAnswers: string[] = []
  private activity: GrokActivity = { active: false, status: null }
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private settling: { turnId: string; stopReason: string } | null = null
  private backlog: LiveOutput[] = []
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null
  private exited = false
  private disposed = false

  constructor(private readonly options: SessionSequencerOptions) {
    this.now = options.now ?? Date.now
    this.heartbeatMs = options.heartbeatMs ?? 1000
    this.settleDeadlineMs = options.settleDeadlineMs ?? SETTLE_DEADLINE_MS
  }

  onDurableEntries(entries: readonly GrokDurableEntry[]): void {
    if (this.disposed) return
    for (const entry of entries) {
      if (!entry.inRewriteSnapshot && entry.item.type === 'assistant' && !(entry.item.tool_calls?.length)) {
        // See the header: an expired turn's debt first, then the oldest open turn
        // without an answer, otherwise no turn.
        if (this.owedAnswers.length > 0) this.owedAnswers.shift()
        else {
          const turn = this.oldestTurnWithoutAnswer()
          if (turn) turn.finalAnswer = entry.item.content
        }
      }
      this.call(() => this.options.sink.entry(entry))
    }
    if (this.settling && this.turns.get(this.settling.turnId)?.finalAnswer !== null) this.finishSettling()
  }

  onHistoryBoundary(boundary: GrokHistoryBoundary): void {
    if (this.disposed) return
    // A reset or caught-up boundary changes no turn: replacement is not
    // completion, idle or a new prompt (history.replacement).
    this.call(() => this.options.sink.history(boundary))
  }

  onLiveOutputs(outputs: readonly LiveOutput[]): void {
    if (this.exited) return
    for (const output of outputs) {
      if (this.settling) this.backlog.push(output)
      else this.handle(output)
    }
  }

  /**
   * The terminal exited: nothing on this pane will observe the rest of any open
   * turn. A waiting turn ends with what it has, the backlog is applied in order,
   * every other open turn ends uncertain, and the sequencer goes quiet.
   */
  onExit(): void {
    if (this.exited) return
    this.exited = true
    this.clearDeadline()
    if (this.settling) {
      const { turnId, stopReason } = this.settling
      this.settling = null
      this.completeTurn(turnId, stopReason)
    }
    const backlog = this.backlog
    this.backlog = []
    for (const output of backlog) this.handle(output, true)
    for (const turnId of [...this.turns.keys()]) this.completeTurn(turnId, 'uncertain')
    this.owedAnswers = []
    if (this.activity.active) this.setActivity({ active: false, status: null })
    this.stopHeartbeat()
  }

  dispose(): void {
    this.exited = true
    this.disposed = true
    this.owedAnswers = []
    this.clearDeadline()
    this.stopHeartbeat()
  }

  currentActivity(): GrokActivity {
    return this.activity
  }

  private handle(output: LiveOutput, exiting = false): void {
    const ts = this.now()
    switch (output.kind) {
      case 'turn-start':
        this.turns.set(output.turnId, { liveText: '', finalAnswer: null })
        this.call(() => this.options.sink.semantic({ type: 'turn_started', turnId: output.turnId, role: 'assistant', source: 'grok-acp', confidence: 'high', ts }))
        return
      case 'text': {
        const turn = output.turnId ? this.turns.get(output.turnId) : undefined
        if (turn) turn.liveText += output.text
        return
      }
      case 'turn-end': {
        const turn = this.turns.get(output.turnId)
        if (!exiting && turn && output.stopReason === 'end_turn' && turn.finalAnswer === null) {
          this.settling = { turnId: output.turnId, stopReason: output.stopReason }
          this.deadlineTimer = setTimeout(() => this.finishSettling(), this.settleDeadlineMs)
          this.deadlineTimer.unref?.()
          return
        }
        this.completeTurn(output.turnId, output.stopReason)
        return
      }
      case 'phase':
        this.call(() => this.options.sink.semantic({ type: 'stream_phase', turnId: output.turnId, phase: output.phase, ...(output.toolName ? { toolName: output.toolName } : {}), source: 'grok-acp', ts }))
        return
      case 'activity':
        this.setActivity({ active: output.active, status: output.status })
        return
      case 'requests':
        this.call(() => this.options.sink.requests({ permission: output.permission, question: output.question, planApproval: output.planApproval }))
        return
      case 'mode':
        this.call(() => this.options.sink.mode(output.modeId))
        return
      case 'api-error':
        this.call(() => this.options.sink.semantic({ type: 'api_error', turnId: output.turnId, message: output.message, source: 'grok-acp', ts }))
        return
      // Submission results and terminal detection are handled by the root class
      // before outputs reach the sequencer: they change no turn, request or durable
      // state, so there is nothing to order them against.
      case 'prompt-accepted':
      case 'prompt-uncertain':
      case 'prompt-not-sent':
      case 'prompt-refused':
      case 'session-switched':
      case 'terminal-loaded':
      case 'terminal-load-refused':
        return
    }
  }

  private finishSettling(): void {
    if (!this.settling || this.disposed) return
    const { turnId, stopReason } = this.settling
    this.settling = null
    this.clearDeadline()
    // Expired without its answer: the answer is still owed to this turn, and the
    // next final row must not become the next turn's answer (see header).
    if (this.turns.get(turnId)?.finalAnswer === null) this.owedAnswers.push(turnId)
    this.completeTurn(turnId, stopReason)
    // Everything that arrived behind the turn end, in order. A later normally
    // ended turn in the backlog may start waiting again; the rest stays behind it.
    while (!this.settling && this.backlog.length > 0) this.handle(this.backlog.shift()!)
  }

  private completeTurn(turnId: string, stopReason: string): void {
    const turn = this.turns.get(turnId)
    this.turns.delete(turnId)
    // The durable answer is what the user will see in history; live text is the
    // fallback only when none was committed in time.
    const fullText = turn?.finalAnswer ?? turn?.liveText ?? ''
    this.call(() => this.options.sink.semantic({ type: 'turn_completed', turnId, fullText, stopReason, source: 'grok-acp', confidence: 'high', ts: this.now() }))
  }

  private oldestTurnWithoutAnswer(): OpenTurn | undefined {
    for (const turn of this.turns.values()) if (turn.finalAnswer === null) return turn
    return undefined
  }

  private setActivity(next: GrokActivity): void {
    this.activity = next
    this.call(() => this.options.sink.activity(next))
    if (next.active) this.startHeartbeat()
    else this.stopHeartbeat()
  }

  private startHeartbeat(): void {
    if (this.heartbeat || this.heartbeatMs <= 0) return
    this.heartbeat = setInterval(() => {
      if (this.activity.active && !this.exited) this.call(() => this.options.sink.activity(this.activity))
    }, this.heartbeatMs)
    this.heartbeat.unref?.()
  }

  private stopHeartbeat(): void {
    if (!this.heartbeat) return
    clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  private clearDeadline(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer)
    this.deadlineTimer = null
  }

  private call(deliver: () => void): void {
    try {
      deliver()
    } catch (error) {
      if (!this.options.onSinkError) {
        queueMicrotask(() => { throw error })
        return
      }
      try { this.options.onSinkError(error) } catch { /* nowhere left to report */ }
    }
  }
}
