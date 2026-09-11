// Owns one native TUI process and its two durable observation channels.
// The process receives its UUID before spawn: directory order, prompt text,
// and "newest file" cannot establish ownership when agents share a cwd.
// See xai-grok-pager/src/app/cli.rs: --session-id names a fresh TUI session.
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { IPty, IDisposable } from 'node-pty'
import { HeadlessTerminal, type ScreenSnapshot } from './terminal/HeadlessTerminal.js'
import { FileTailer, type FileTailerSnapshotEvent } from './transcript/JsonlTailer.js'
import { encodeGrokSessionsDir, validateGrokSessionId } from './transcript/SessionDirEncoding.js'
import { decodeGrokConversationItem, type GrokConversationItem } from './transcript/ConversationItem.js'
import { GrokResponsesProxy, type GrokResponsesProxyOptions } from './proxy/GrokResponsesProxy.js'
import type { GrokStreamEvent } from './proxy/GrokResponseObserver.js'
import { detectCommandPermission, type GrokCommandPermission, type GrokCommandPermissionState, type GrokPermissionChoice } from './conditions/commandPermission.js'

const require = createRequire(import.meta.url)

export interface GrokUpdateEvent {
  timestamp: number
  method: string
  params: {
    sessionId: string
    update: { sessionUpdate: string; [key: string]: unknown }
    [key: string]: unknown
  }
  [key: string]: unknown
}
export type GrokHeadlessOptions = {
  cwd: string
  grokBinary?: string
  cols?: number
  rows?: number
  /** Explicit test/consumer home; otherwise honor the caller's GROK_HOME. */
  grokHome?: string
  /** Caller owns relay readiness and cache safety; this class only routes. */
  proxyUrl?: string
  modelsListUrl?: string
  resumeSessionId?: string
  extraArgs?: string[]
  env?: Record<string, string | undefined>
}
export type GrokHeadlessCreateOptions = Omit<GrokHeadlessOptions, 'proxyUrl' | 'modelsListUrl'> & {
  streaming: Omit<GrokResponsesProxyOptions, 'onEvent'>
}
export interface GrokScreenEvent { snapshot: ScreenSnapshot }
export interface GrokObservationMetadata { replay: boolean; generation: number; lineStartOffset: number }
export interface GrokEntryEvent extends GrokObservationMetadata { sessionId: string; item: GrokConversationItem; raw: string }
export type GrokHistoryEvent = FileTailerSnapshotEvent & { sessionId: string; channel: 'chat-history' | 'updates' }
export interface GrokSessionEvent { sessionId: string }
export interface GrokExitEvent { code: number | undefined; signal: number | undefined }
export interface GrokActivityEvent { at: number }
export interface GrokIdleEvent { at: number }
export interface GrokHeadlessEvents {
  /** Native bytes for terminal consumers; never synthesized from screen text. */
  'pty-data': string
  screen: GrokScreenEvent
  'grok-entry': GrokEntryEvent
  'grok-update': GrokUpdateEvent & GrokSessionEvent & GrokObservationMetadata
  /** Reset precedes replacement rows; caught-up is a byte boundary, not idle. */
  'grok-history': GrokHistoryEvent
  session: GrokSessionEvent
  activity: GrokActivityEvent
  idle: GrokIdleEvent
  exit: GrokExitEvent
  error: Error
  /** Per-HTTP-request observations, not asserted main-turn ownership. */
  'stream-event': GrokStreamEvent
  'command-permission': GrokCommandPermission | null
}
export interface GrokHeadless {
  on<K extends keyof GrokHeadlessEvents>(event: K, listener: (payload: GrokHeadlessEvents[K]) => void): this
}

export class GrokHeadless extends EventEmitter {
  private ownedRelay: GrokResponsesProxy | undefined
  private startup: NodeJS.Immediate | undefined
  private readonly pty: IPty
  private readonly terminal: HeadlessTerminal
  private readonly sessionId: string
  private readonly waiters = new Map<ReturnType<typeof setInterval>, () => void>()
  private readonly tailers: Array<{ drain(): Promise<void>; close(): Promise<void> }> = []
  private exitSubscription: IDisposable | undefined
  private dataSubscription: IDisposable | undefined
  private closed = false
  private cleanupPromise: Promise<void> | undefined
  private disposePromise: Promise<void> | undefined
  private resolveExit!: () => void
  private readonly exited = new Promise<void>(resolve => { this.resolveExit = resolve })
  private lastFailure: Error | undefined
  private active = false
  private readonly pendingCommands = new Map<string, string>()
  private lastPermissionId: string | undefined
  private submittedPermissionId: string | undefined
  private updateGeneration = 0
  private streamObservations = 0
  private promptStreamBaseline: number | undefined

  static async create(options: GrokHeadlessCreateOptions): Promise<GrokHeadless> {
    const { streaming, ...sessionOptions } = options
    let runtime: GrokHeadless | undefined
    const relay = await GrokResponsesProxy.create({
      ...streaming,
      onEvent: event => {
        if (runtime && event.type !== 'diagnostic') runtime.streamObservations++
        runtime?.emit('stream-event', event)
      },
    })
    try {
      runtime = new GrokHeadless({
        ...sessionOptions,
        proxyUrl: relay.info.proxyBaseUrl,
        // Native cache reuse is fenced by models-list origin. Splitting the
        // list onto the real upstream gives the relay-modified catalog the
        // SAME identity as a plain native catalog and poisons later sessions.
        // Keep both URLs relay-local; never sweep or rewrite the shared cache.
        modelsListUrl: relay.info.modelsListUrl,
        env: { ...sessionOptions.env, GROK_XAI_API_BASE_URL: relay.info.proxyBaseUrl },
      })
      runtime.ownedRelay = relay
      // node-pty may return a process whose exec later fails. Such failures
      // surface through exit (and owned cleanup), not through this rejection.
      // Native config/managed endpoints outrank env defaults; no config is
      // overwritten here. A turn with zero relay observations is diagnosed,
      // not represented as proof that main-turn streaming was available.
      return runtime
    } catch (error) {
      await relay.stop()
      throw error
    }
  }

  constructor(options: GrokHeadlessOptions) {
    super()
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries({ ...process.env, ...options.env })) {
      if (value !== undefined) env[key] = value
    }
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'
    if (options.grokHome) env.GROK_HOME = options.grokHome
    const home = env.GROK_HOME || join(homedir(), '.grok')
    if (options.proxyUrl) {
      env.GROK_MODELS_BASE_URL = options.proxyUrl
      env.GROK_MODELS_LIST_URL = options.modelsListUrl ?? `${options.proxyUrl.replace(/\/$/, '')}/models`
      // Keep a manually supplied relay's catalog separate from the native
      // upstream catalog too. create() additionally fences port reuse with a
      // unique catalog URL and owns the listener's full lifecycle.
    }
    this.sessionId = options.resumeSessionId ?? randomUUID()
    validateGrokSessionId(this.sessionId)
    // Extra arguments may select modes, but may not replace the identity or
    // cwd that authorizes these tailers. Otherwise this instance could read
    // one conversation while its PTY writes into another.
    const reserved = /^(?:-r|-s|-c|-p|--resume|--session-id|--continue|--single|--cwd|--fork-session)(?:=|$)/
    if (options.extraArgs?.some(arg => reserved.test(arg))) throw new Error('Extra arguments cannot override session ownership')
    const dir = join(home, 'sessions', encodeGrokSessionsDir(options.cwd), this.sessionId)
    const args = ['--no-auto-update', options.resumeSessionId ? '-r' : '--session-id', this.sessionId, ...(options.extraArgs ?? [])]
    const native = require('node-pty') as typeof import('node-pty')
    const local = join(homedir(), '.local', 'bin', 'grok')
    const binary = options.grokBinary ?? (existsSync(local) ? local : 'grok')
    this.pty = native.spawn(binary, args, {
      name: 'xterm-256color', cwd: options.cwd,
      cols: options.cols ?? 120, rows: options.rows ?? 40, env,
    })
    try {
      this.terminal = new HeadlessTerminal({ pty: this.pty, cols: options.cols, rows: options.rows })
      this.terminal.on('screen', snapshot => {
        this.refreshCommandPermission()
        this.emit('screen', { snapshot })
      })
      this.terminal.attach()
      this.dataSubscription = this.pty.onData(data => {
        try { this.emit('pty-data', data) } catch (error) { this.emitError(error) }
      })
      this.exitSubscription = this.pty.onExit(({ exitCode, signal }) => {
        this.closed = true
        this.exitSubscription?.dispose()
        this.exitSubscription = undefined
        void this.cleanup(true).catch(error => this.emitError(error as Error)).then(() => {
          try { this.emit('exit', { code: exitCode, signal }) } finally { this.resolveExit() }
        }).catch(error => this.emitError(error as Error))
      })
    } catch (error) {
      this.dataSubscription?.dispose()
      this.pty.kill()
      throw error
    }
    // Constructors cannot publish events before the caller has had a chance
    // to subscribe. Resume replay and fresh session identity use one boundary.
    this.startup = setImmediate(() => {
      this.startup = undefined
      if (this.closed) return
      this.emit('session', { sessionId: this.sessionId })
      this.waitForFile(join(dir, 'chat_history.jsonl'), path => {
        let replayThrough = 0
        this.tailers.push(new FileTailer<unknown>(path, (_entry, metadata) => {
          const decoded = decodeGrokConversationItem(metadata.rawLine)
          this.emit('grok-entry', {
            sessionId: this.sessionId, item: decoded.item, raw: decoded.raw,
            lineStartOffset: metadata.lineStartOffset, generation: metadata.generation,
            replay: metadata.lineStartOffset < replayThrough,
          })
        }, error => this.emitError(error), {
          onSnapshot: event => {
            // The tailer's opened descriptor defines this snapshot, not a
            // separate path stat racing native atomic replacement. Rewritten
            // history is replay even in a session we originally started fresh.
            if (event.type === 'reset') replayThrough = options.resumeSessionId || event.generation > 0 ? event.snapshotByteLength : 0
            this.emit('grok-history', { ...event, sessionId: this.sessionId, channel: 'chat-history' })
          },
        }))
      })
      this.waitForFile(join(dir, 'updates.jsonl'), path => {
        let replayThrough = 0
        this.tailers.push(new FileTailer<GrokUpdateEvent>(path, (entry, metadata) => {
          if (!entry || typeof entry.timestamp !== 'number' || typeof entry.method !== 'string' ||
            typeof entry.params?.sessionId !== 'string' || typeof entry.params?.update?.sessionUpdate !== 'string') {
            throw new Error('Malformed update envelope')
          }
          if (entry.params.sessionId !== this.sessionId) {
            throw new Error('Update envelope belongs to a different session')
          }
          const replay = metadata.lineStartOffset < replayThrough
          this.emit('grok-update', {
            ...entry, sessionId: this.sessionId, replay,
            lineStartOffset: metadata.lineStartOffset, generation: metadata.generation,
          })
          if (replay) return
          // A historical interrupted call is not a current permission request.
          // Reissued commands must be corroborated by live update evidence.
          this.observePendingCommand(entry.params.update)
          // Quiet screens do not prove idle: slow inference and permission
          // waits may paint nothing for minutes. Only provider completion
          // ends activity; prompt_index can reset on resume and is not an ID.
          const kind = entry.params.update.sessionUpdate
          if (kind === 'turn_completed' && this.promptStreamBaseline !== undefined) {
            if (this.ownedRelay && this.streamObservations === this.promptStreamBaseline) {
              this.emit('stream-event', { type: 'diagnostic', flowId: 'unobserved-turn', code: 'no-stream-observations' })
            }
            this.promptStreamBaseline = undefined
          }
          if (kind === 'user_message_chunk') this.markActivity()
          if (kind === 'turn_completed' && this.active) {
            this.active = false
            this.emit('idle', { at: Date.now() })
          }
        }, error => this.emitError(error), {
          onSnapshot: event => {
            if (event.type === 'reset') {
              this.updateGeneration = event.generation
              replayThrough = options.resumeSessionId || event.generation > 0 ? event.snapshotByteLength : 0
              // A discarded update generation cannot authorize an action on
              // a still-painted card. Require newly appended command evidence;
              // replacement replay may contain abandoned approvals/completions.
              if (event.generation > 0) this.clearCommandPermission()
            }
            this.emit('grok-history', { ...event, sessionId: this.sessionId, channel: 'updates' })
          },
        }))
      })
    })
  }

  get sessionIdentity(): string { return this.sessionId }
  get pid(): number | undefined { return this.closed ? undefined : this.pty.pid }
  get lastError(): Error | undefined { return this.lastFailure }
  get streamingInfo(): GrokResponsesProxy['info'] | undefined { return this.ownedRelay?.info }
  get commandPermission(): GrokCommandPermission | null {
    const state = this.commandPermissionState
    return state.status === 'card' ? state.card : null
  }
  get commandPermissionState(): GrokCommandPermissionState {
    if (this.closed) return { status: 'closed' }
    const frame = this.terminal.snapshotStableFrame()
    if (!frame) return { status: 'unstable' }
    if (frame.layoutEpoch !== frame.providerLayoutEpoch) return { status: 'resizing' }
    const card = detectCommandPermission(frame.rows.map(row => row.text).join('\n'),
      [...this.pendingCommands].map(([toolCallId, command]) => ({ toolCallId, command })))
    // A reissued native call may reuse its text and tool ID after rewind.
    // Resetting the consumed token alone would accept a delayed old UI action
    // for that new card. Scope action identity to the update generation too.
    return card ? { status: 'card', card: { ...card, id: `${this.updateGeneration}:${card.id}` } } : { status: 'none' }
  }

  /** True means a one-shot key was submitted, not that execution completed. */
  answerCommandPermission(id: string, choice: GrokPermissionChoice): boolean {
    const current = this.commandPermission
    if (!current || current.id !== id || this.submittedPermissionId === id) return false
    const action = current.actions.find(candidate => candidate.id === choice)
    if (!action) return false
    // Re-read the native frame immediately before the write. Never retain a
    // guessed digit across modal replacement, scope edits or terminal resize.
    // A refused action requires a fresh user decision, not automatic digit
    // retries: the native input owner can change while a frame is unstable.
    this.submittedPermissionId = id
    this.pty.write(action.key)
    return true
  }

  private observePendingCommand(update: GrokUpdateEvent['params']['update']): void {
    if (update.sessionUpdate === 'tool_call' && update.title === 'run_terminal_command' && typeof update.toolCallId === 'string') {
      const input = update.rawInput as { command?: unknown } | null | undefined
      if (update.toolCallId.length <= 256 && typeof input?.command === 'string' && input.command.length <= 65536 && this.pendingCommands.size < 64) {
        this.pendingCommands.set(update.toolCallId, input.command)
      }
    }
    if (update.sessionUpdate === 'tool_call_update' && typeof update.toolCallId === 'string' &&
      ['in_progress', 'completed', 'failed'].includes(String(update.status))) this.pendingCommands.delete(update.toolCallId)
    if (update.sessionUpdate === 'turn_completed') this.pendingCommands.clear()
    this.refreshCommandPermission()
  }
  private refreshCommandPermission(): void {
    const current = this.commandPermission
    if (current?.id === this.lastPermissionId) return
    this.lastPermissionId = current?.id
    // Keep the consumed token even across temporarily unreadable frames. A
    // flicker must not turn one user decision into two key submissions.
    try { this.emit('command-permission', current) } catch (error) { this.emitError(error) }
  }
  private clearCommandPermission(): void {
    this.pendingCommands.clear()
    this.submittedPermissionId = undefined
    if (this.lastPermissionId === undefined) return
    this.lastPermissionId = undefined
    try { this.emit('command-permission', null) } catch (error) { this.emitError(error as Error) }
  }

  sendPrompt(text: string): void {
    this.assertOpen()
    this.promptStreamBaseline = this.streamObservations
    this.pty.write(`\x1b[200~${text}\x1b[201~`)
    this.pty.write('\r')
    this.markActivity()
  }
  sendInput(data: string): void { this.assertOpen(); this.pty.write(data) }
  resize(cols: number, rows: number): void { this.assertOpen(); this.terminal.resize(cols, rows) }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    const kill = !this.closed
    this.closed = true
    this.clearCommandPermission()
    this.disposePromise = (async () => {
      let force: ReturnType<typeof setTimeout> | undefined
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        if (kill) {
          this.pty.kill()
          force = setTimeout(() => {
            try { this.pty.kill(process.platform === 'win32' ? undefined : 'SIGKILL') }
            catch (error) { this.emitError(error as Error) }
          }, 1000)
        }
        await Promise.race([
          this.exited,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(new Error('Grok PTY did not exit after termination')), 5000)
          }),
        ])
      } finally {
        clearTimeout(force)
        clearTimeout(deadline)
        await this.cleanup(false)
      }
    })()
    return this.disposePromise
  }
  private assertOpen(): void { if (this.closed) throw new Error('Grok session is closed') }
  private markActivity(): void {
    if (!this.active) { this.active = true; this.emit('activity', { at: Date.now() }) }
  }
  private emitError(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error))
    this.lastFailure = failure
    // Consumer diagnostics cannot take ownership of process shutdown.
    try { if (this.listenerCount('error')) this.emit('error', failure) } catch { /* retain lastFailure */ }
  }
  private waitForFile(path: string, start: (path: string) => void): void {
    if (this.closed) return
    if (existsSync(path)) { start(path); return }
    const timer = setInterval(() => {
      // dispose closes input before the process exits. Retain this final-file
      // callback during that gap: the producer may still flush it on exit.
      if (!this.closed && existsSync(path)) {
        clearInterval(timer)
        this.waiters.delete(timer)
        start(path)
      }
    }, 100)
    timer.unref()
    this.waiters.set(timer, () => { if (existsSync(path)) start(path) })
  }
  private cleanup(drain: boolean): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise
    this.closed = true
    this.clearCommandPermission()
    if (this.startup) clearImmediate(this.startup)
    this.startup = undefined
    for (const [timer, startFinalFile] of this.waiters) {
      clearInterval(timer)
      if (drain) {
        try { startFinalFile() } catch (error) { this.emitError(error as Error) }
      }
    }
    this.waiters.clear()
    this.dataSubscription?.dispose()
    this.dataSubscription = undefined
    this.terminal.dispose()
    // PTY exit may follow kill asynchronously. The exit handler, not this
    // observation cleanup, owns that last subscription and acknowledgement.
    this.cleanupPromise = Promise.all(this.tailers.splice(0).map(async tailer => {
      try { if (drain) await tailer.drain() }
      catch (error) { this.emitError(error as Error) }
      finally { await tailer.close() }
    })).then(async () => { await this.ownedRelay?.stop() })
    return this.cleanupPromise
  }
}
