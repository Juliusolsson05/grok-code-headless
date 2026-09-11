import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { GrokAcpError, type GrokAcpClientOptions, type GrokAcpRequestOptions } from './GrokAcpClient.js'
import { GrokLeaderConnection } from './GrokLeaderConnection.js'
import { validateGrokSessionId } from '../transcript/SessionDirEncoding.js'
import { validateDeadlineMs } from './deadline.js'
import { retireResolvedInteraction } from './GrokInteractions.js'
export type GrokMcpServer = { type: 'http'; name: string; url: string; headers: Array<{ name: string; value: string }> }
export interface GrokNativeControlOptions extends GrokAcpClientOptions {
  cwd: string; binary?: string; env?: NodeJS.ProcessEnv; model?: string; startupTimeoutMs?: number
  /** Startup cancellation only; use dispose() after start has returned. */
  signal?: AbortSignal
  /** False supplies only env, so isolated native probes cannot inherit host auth/config overrides. */
  inheritEnv?: boolean
  /** Must acknowledge dependent TUI exit. RPC is already closed; this hook owns process cleanup only. */
  beforeClose?: () => Promise<void>
  relayUrl?: string; relayOrigin?: string
}
export class GrokNativeControl {
  readonly socketPath: string
  private child: ChildProcess | undefined
  private connection: GrokLeaderConnection | undefined
  private closing = false
  private disposal: Promise<void> | undefined
  private readonly abort = new AbortController()
  private resolveExit!: () => void
  private readonly exited = new Promise<void>(resolve => { this.resolveExit = resolve })
  private exitObserved = false
  private closeReported = false
  private started = false
  private readonly pendingTurns = new Set<string>()

  private constructor(private readonly options: GrokNativeControlOptions, private readonly directory: string) {
    this.socketPath = join(directory, 'l.sock')
  }
  get pid(): number | undefined {
    return this.child && this.child.exitCode === null && this.child.signalCode === null ? this.child.pid : undefined
  }
  get isClosed(): boolean { return this.closing }
  get rpc() {
    if (this.closing || !this.connection) throw new GrokAcpError('closed', false)
    return this.connection.rpc
  }
  static async start(options: GrokNativeControlOptions): Promise<GrokNativeControl> {
    if (options.signal?.aborted) throw new GrokAcpError('aborted', false)
    const cwd = await realpath(options.cwd)
    const timeout = options.startupTimeoutMs ?? 20000
    validateDeadlineMs(timeout)
    const directory = await mkdtemp(join(tmpdir(), 'g-ctl-'))
    const control = new GrokNativeControl({ ...options, cwd }, directory)
    const cancel = () => control.abort.abort()
    options.signal?.addEventListener('abort', cancel, { once: true })
    try {
      if (options.signal?.aborted) throw new GrokAcpError('aborted', false)
      // Unix-domain paths are short on macOS. Never fall back to the global
      // leader socket if a custom TMPDIR leaves insufficient path space.
      if (Buffer.byteLength(control.socketPath) >= 104) throw new Error('Private Grok socket path is too long')
      await control.launch(timeout)
      control.started = true
      return control
    } catch (error) {
      try { await control.dispose() }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Grok startup and cleanup failed') }
      throw error
    } finally { options.signal?.removeEventListener('abort', cancel) }
  }
  private async launch(timeout: number): Promise<void> {
    const env: NodeJS.ProcessEnv = { ...(this.options.inheritEnv === false ? {} : process.env), ...this.options.env }
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key]
    const args = ['agent', ...(this.options.model ? ['--model', this.options.model] : []), 'leader',
      '--leader-socket', this.socketPath, '--relay-on-demand', '--no-auto-update', '--no-exit-on-disconnect']
    if (this.options.relayUrl) args.push('--grok-ws-url', this.options.relayUrl)
    if (this.options.relayOrigin) args.push('--grok-ws-origin', this.options.relayOrigin)
    this.child = spawn(this.options.binary ?? join(homedir(), '.local', 'bin', 'grok'), args, {
      // Diagnostics may contain private configuration. No output is retained,
      // and descendants cannot hold a parent-owned stderr pipe open past exit.
      cwd: this.options.cwd, env, stdio: 'ignore',
    })
    this.child.on('error', () => {
      if (!this.child?.pid) { this.exitObserved = true; this.resolveExit() }
      this.abort.abort()
    })
    this.child.once('exit', () => {
      this.exitObserved = true; this.resolveExit(); this.abort.abort()
      this.connection?.close()
      void this.dispose().catch(() => { /* explicit dispose caller receives the same promise */ })
    })
    const deadline = Date.now() + timeout
    let admitted = false
    while (!this.closing && !this.abort.signal.aborted && Date.now() < deadline) {
      if (!this.child.pid) break
      try {
        const connection = await GrokLeaderConnection.connect(this.socketPath, this.child.pid, {
          ...this.options, signal: this.abort.signal, connectTimeoutMs: Math.max(1, deadline - Date.now()),
          onNotification: value => {
            if (this.connection) retireResolvedInteraction(this.connection.rpc, value)
            this.options.onNotification?.(value)
          },
          onClose: () => {
            if (admitted) void this.dispose().catch(() => {})
          },
        })
        if (this.closing || this.abort.signal.aborted) { connection.close(); break }
        this.connection = connection
        admitted = true
        const initialized = await this.rpc.request('initialize', { protocolVersion: 1,
          clientCapabilities: { _meta: { 'x.ai/userMessageEcho': true } },
          clientInfo: { name: 'grok-code-headless', version: '0.0.1' },
        }, { timeoutMs: Math.max(1, deadline - Date.now()) }) as { protocolVersion?: unknown }
        if (initialized?.protocolVersion !== 1) throw new Error('Unsupported native ACP protocol')
        if (this.closing) throw new Error('Grok leader closed during initialization')
        return
      } catch {
        // Only pre-admission connection attempts may retry. An initialized
        // epoch is never reconnected and no user RPC is replayed elsewhere.
        if (admitted) break
        await delay(Math.min(50, Math.max(0, deadline - Date.now())))
      }
    }
    if (this.options.signal?.aborted) throw new GrokAcpError('aborted', false)
    throw new Error('Grok native control startup failed')
  }
  async createSession(id: string, servers: GrokMcpServer[]): Promise<string> {
    validateGrokSessionId(id)
    const value = await this.rpc.request('session/new', { cwd: this.options.cwd, mcpServers: servers, _meta: { sessionId: id } }) as { sessionId?: unknown }
    if (value?.sessionId !== id) throw new Error('Grok native session identity mismatch')
    return id
  }
  async loadSession(id: string, servers: GrokMcpServer[]): Promise<void> {
    validateGrokSessionId(id)
    await this.rpc.request('session/load', { sessionId: id, cwd: this.options.cwd, mcpServers: servers })
  }
  async prompt(id: string, text: string, options: GrokAcpRequestOptions = {}): Promise<unknown> {
    validateGrokSessionId(id)
    if (options.signal?.aborted) throw new GrokAcpError('aborted', false)
    const rpc = this.rpc
    if (this.pendingTurns.has(id)) throw new GrokAcpError('busy', false)
    this.pendingTurns.add(id)
    return new Promise((resolve, reject) => {
      const cancelNative = () => { void rpc.notify('session/cancel', { sessionId: id }).catch(() => rpc.close()) }
      const abort = () => { cancelNative(); reject(new GrokAcpError('aborted', true)) }
      options.signal?.addEventListener('abort', abort, { once: true })
      // ACP text bypasses paste/clipboard handling. Keep native correlation
      // after caller cancellation: a cancel write is not proof the turn has
      // stopped, and admitting the next prompt could cancel that new turn.
      // Only the native response releases this session's in-flight gate.
      void rpc.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text }] }, {
        timeoutMs: options.timeoutMs === undefined ? null : options.timeoutMs,
      }).then(value => {
        this.pendingTurns.delete(id)
        options.signal?.removeEventListener('abort', abort)
        resolve(value)
      }, error => {
        options.signal?.removeEventListener('abort', abort)
        // A correlated error is also a completed RPC, even when any earlier
        // tool effects remain uncertain. Lost correlation is the case that
        // must retain the gate, not an explicit native failure response.
        if (!(error instanceof GrokAcpError) || !error.uncertain || error.code === 'remote') this.pendingTurns.delete(id)
        else if (error.code === 'timeout') cancelNative()
        // An uncertain timeout retains the gate for this epoch. Recreating an
        // owned control lifetime is explicit recovery, never automatic replay.
        reject(error)
      })
    })
  }
  async updateMcpServers(id: string, servers: GrokMcpServer[], timeoutMs = 20000): Promise<void> {
    validateGrokSessionId(id)
    validateDeadlineMs(timeoutMs)
    const deadline = Date.now() + timeoutMs
    const remaining = () => Math.max(1, deadline - Date.now())
    await this.rpc.request('_x.ai/session/update_mcp_servers', { sessionId: id, mcpServers: servers }, { timeoutMs: remaining() })
    do {
      const reply = await this.rpc.request('_x.ai/mcp/list', { sessionId: id }, { timeoutMs: remaining() }) as { result?: { servers?: unknown[] } }
      const entries = reply?.result?.servers
      if (!Array.isArray(entries)) throw new Error('Invalid native MCP status response')
      if (servers.every(server => {
        const matches = entries.filter(value => value !== null && typeof value === 'object' && (value as { name?: unknown }).name === server.name)
        if (matches.length !== 1) return false
        const entry = matches[0] as { type?: string; source?: string; command?: string; url?: string; session?: { enabled?: boolean; status?: string } }
        // Installed 1.0.25 deliberately renders session-only HTTP clients as
        // local stdio placeholders with an empty command and no URL (native
        // extensions/mcp.rs). Requiring URL equality rejects healthy clients.
        // Accept that specific representation by its unambiguous name; this
        // is a readiness check, not an independent endpoint identity proof.
        const endpoint = entry.type === 'http' && entry.url === server.url
        const placeholder = entry.type === 'stdio' && entry.source === 'local' && entry.command === '' && entry.url === undefined
        return (endpoint || placeholder) && entry.session?.enabled === true && entry.session.status === 'ready'
      })) return
      await delay(Math.min(100, Math.max(0, deadline - Date.now())))
    } while (Date.now() < deadline)
    throw new Error('Native MCP servers did not become ready before the deadline')
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.closing = true
    // Publish the receipt BEFORE abort closes the RPC stream synchronously.
    // Its onClose callback re-enters dispose; without this ordering dependent
    // TUI cleanup runs twice and callers observe different shutdown promises.
    this.disposal = Promise.resolve().then(() => this.shutdown()).catch(error => {
      // Keep input permanently fenced, but let the owner explicitly retry
      // cleanup after resolving a dependent-exit or filesystem failure.
      this.disposal = undefined
      throw error
    })
    this.abort.abort()
    return this.disposal
  }
  private async shutdown(): Promise<void> {
    const errors: unknown[] = []
    // A live native TUI reconnects/autospawns when its leader disappears. If
    // dependent shutdown fails, retaining this owned leader is safer than
    // deliberately triggering an unowned replacement. Cleanup is retryable.
    if (this.started) await this.options.beforeClose?.()
    this.connection?.close()
    if (this.child && !this.exitObserved) {
      let force: ReturnType<typeof setTimeout> | undefined
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        this.child.kill('SIGTERM')
        force = setTimeout(() => { try { this.child?.kill('SIGKILL') } catch { /* wait for explicit exit below */ } }, 1000)
        await Promise.race([this.exited, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('Owned Grok leader did not exit')), 5000) })])
      } catch (error) { errors.push(error) }
      finally { clearTimeout(force); clearTimeout(deadline) }
    }
    // A failed dependent/exit cleanup retains its private directory for
    // diagnosis. Never unlink a socket and call a still-live process cleaned.
    if (errors.length === 0) await rm(this.directory, { recursive: true, force: true })
    if (!this.closeReported) {
      this.closeReported = true
      try { this.options.onClose?.(new GrokAcpError('closed', true)) } catch { /* diagnostics cannot own cleanup */ }
    }
    if (errors.length) throw new AggregateError(errors, 'Grok native control cleanup failed')
  }
}
