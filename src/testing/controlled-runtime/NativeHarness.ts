import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import type { IPty } from 'node-pty'
import { GrokNativeControl, type GrokControlLifecycleObservation, type GrokMcpServer } from '../../control/GrokNativeControl.js'
import { GrokTuiSocketGuard } from '../../control/GrokTuiSocketGuard.js'
import type { GrokAcpServerRequest } from '../../control/GrokAcpClient.js'
import type { GrokTransportObservation } from '../../control/transportObservation.js'
import { HeadlessTerminal } from '../../terminal/HeadlessTerminal.js'
import { FileTailer } from '../../transcript/JsonlTailer.js'
import { encodeGrokSessionsDir } from '../../transcript/SessionDirEncoding.js'
import { RuntimeCapture, verifyRuntimeCapture } from './Capture.js'
import { EvidenceRejectedError, sealEvidenceVerdict, verifyLifecycleScenarioEvidence, verifyScenarioEvidence } from './EvidenceVerification.js'
import { FixtureBackend, type FixtureTool } from './FixtureBackend.js'
import { FrameSplitter } from './frames.js'

export type Scenario = { id: string; description: string; targets: string[]; run(context: NativeHarness): Promise<void> }
export type StartupFailureScenario = { kind: 'startup-failure'; id: string; description: string; targets: string[]; configToml: string }
export type CaptureScenario = Scenario | StartupFailureScenario
export type PromptContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string; uri?: string }

/** Capture-only resource assembly. This intentionally is NOT the future public
 * runtime coordinator: it reports raw observations and caller actions, leaving
 * conflicting source authority and app acceptance to the later catalog stage. */
export class NativeHarness {
  readonly sessionId = randomUUID()
  readonly requests: GrokAcpServerRequest[] = []
  readonly notifications: Array<{ method: string; params?: unknown }> = []
  readonly openConnections = new Set<string>()
  // Messages the native TUI itself sends on its own connection, requests and
  // notifications alike, counted by method name for the current TUI epoch.
  // Scenarios that drive the terminal (for example a slash command) wait on these
  // instead of assuming a control notification exists: in the recorded 1.0.30
  // `/new` run the terminal sent session/new here, and nothing naming the new
  // session reached the control client through the control prompt that followed.
  readonly tuiSentMethodCounts = new Map<string, number>()
  // session/update frames written toward the TUI, counted by the session id they
  // carry, for the current TUI epoch. WHY: in the reviewed 1.0.30 `/new` timeline
  // a terminal that requested and displayed a new session was still streamed the
  // original session's updates, so what the screen shows cannot say which
  // conversation the terminal is fed. These are write attempts, not deliveries;
  // EvidenceVerification owns write receipts.
  readonly tuiSessionUpdateWrites = new Map<string, number>()
  control!: GrokNativeControl
  backend!: FixtureBackend
  guard?: GrokTuiSocketGuard
  terminal?: HeadlessTerminal
  tui?: IPty
  private tuiExited = false
  private tuiExit!: Promise<void>
  private observers: FileTailer<unknown>[] = []
  private watched = new Map<string, { sessionId: string; file: string; attached: boolean }>()
  private poller?: ReturnType<typeof setInterval>
  private actionId = 0
  // Per TUI connection: the JSON-encoded id (so 3 and "3" never pair) of a
  // session/load for this session that native has not answered yet.
  private pendingLoads = new Map<string, string>()
  private tuiLoaded = false
  // WHY a load answer alone is not enough to call a resume real: the first
  // epoch's freshly created, empty conversation is answered successfully too,
  // with nothing replayed. On the recorded Grok 1.0.30 wire the leader streams a
  // stored conversation to the TUI as `session/update user_message_chunk` frames
  // BEFORE answering its load, so replay seen while that load is pending is the
  // observable difference. Whether native ever answers a load of an unreadable
  // stored conversation successfully has not been recorded.
  private tuiReplayObserved = false
  private decoders = new Map<string, FrameSplitter>()
  private closing?: Promise<void>
  private failDependentCleanup = false
  private tuiEpoch = 0
  private binary = ''
  private nativeEnv: NodeJS.ProcessEnv = {}
  readonly cwd: string
  readonly home: string
  version = ''
  private constructor(readonly capture: RuntimeCapture) {
    this.cwd = join(capture.directory, 'workspace')
    this.home = join(capture.directory, 'native-home')
  }
  static async create(parent: string, scenario: Scenario, tools: FixtureTool[]): Promise<NativeHarness> {
    const capture = await RuntimeCapture.create(parent, { scenario: scenario.id, description: scenario.description, targets: scenario.targets,
      provenance: 'real installed native runtime driven by scripted local inference/MCP',
      ordering: 'observer arrival sequence; not global native causality', publication: 'private exact capture; privacy review required',
      ptyEncoding: 'node-pty decoded UTF-8 callback, not kernel-byte capture',
      // Exact durable writes are deliberately favored over low observer
      // overhead in this evidence pass. Consequently wall-clock intervals and
      // race probabilities are not baselines for an uninstrumented runtime;
      // only retained content and the ordering that actually occurred qualify.
      timingValidity: 'synchronous fsync recording perturbs timing; do not use capture intervals as latency or race-frequency evidence' })
    const context = new NativeHarness(capture)
    try {
      await mkdir(context.cwd, { mode: 0o700 }); await mkdir(context.home, { mode: 0o700 })
      await writeFile(join(context.home, 'config.toml'), '[cli]\nauto_update = false\n[ui]\npermission_mode = "ask"\n', { mode: 0o600 })
      context.backend = await FixtureBackend.create(capture, tools)
      const binary = context.binary = await realpath(process.env.GROK_BINARY ?? join(homedir(), '.local', 'bin', 'grok'))
      const base = context.backend.baseUrl
      const env = context.nativeEnv = { PATH: process.env.PATH, HOME: context.capture.directory, USER: 'fixture', LOGNAME: 'fixture', GROK_HOME: context.home,
        XDG_CONFIG_HOME: join(context.capture.directory, 'config'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
        XAI_API_KEY: 'fixture-only-not-a-real-key', GROK_MODELS_BASE_URL: `${base}/v1`, GROK_XAI_API_BASE_URL: `${base}/v1`,
        GROK_CLI_CHAT_PROXY_BASE_URL: `${base}/v1`, GROK_CONTEXTUAL_HINTS: '0', GROK_PROMPT_SUGGESTIONS: '0',
        OTEL_TRACES_EXPORTER: 'none', OTEL_METRICS_EXPORTER: 'none' }
      context.version = execFileSync(binary, ['--version'], { env, encoding: 'utf8' }).trim()
      capture.record('lifecycle', 'capture-start', { nativeVersion: context.version, nodeVersion: process.version, binary, cwd: context.cwd, home: context.home })
      context.control = await context.startControl(base)
      context.watchSession(context.sessionId)
      const created = await context.call('session/new', { cwd: context.cwd, mcpServers: context.mcpServers, _meta: { sessionId: context.sessionId } })
      if (created.sessionId !== context.sessionId) throw new Error('Native assigned a different capture session')
      await context.startTui()
      await context.control.updateMcpServers(context.sessionId, context.mcpServers)
      await context.checkpoint('ready')
      return context
    } catch (error) {
      capture.record('scenario', 'startup-failed', { error: error instanceof Error ? error.name : 'unknown' })
      await context.close().catch(() => {})
      capture.finish('failed')
      throw new Error(`Native capture startup failed; private evidence: ${capture.directory}`)
    }
  }
  static async recordExpectedStartupFailure(parent: string, scenario: StartupFailureScenario) {
    const capture = await RuntimeCapture.create(parent, captureMetadata(scenario))
    const context = new NativeHarness(capture)
    let control: GrokNativeControl | undefined
    let sealed = false
    try {
      await mkdir(context.cwd, { mode: 0o700 }); await mkdir(context.home, { mode: 0o700 })
      await writeFile(join(context.home, 'config.toml'), scenario.configToml, { mode: 0o600 })
      context.binary = await realpath(process.env.GROK_BINARY ?? join(homedir(), '.local', 'bin', 'grok'))
      context.nativeEnv = isolatedEnv(context.capture.directory, context.home, 'http://127.0.0.1:9')
      context.version = execFileSync(context.binary, ['--version'], { env: context.nativeEnv, encoding: 'utf8' }).trim()
      capture.record('lifecycle', 'capture-start', { nativeVersion: context.version, nodeVersion: process.version, binary: context.binary, cwd: context.cwd, home: context.home })
      capture.record('scenario', 'started', { id: scenario.id })
      const lifecycle: GrokControlLifecycleObservation[] = []
      let rejected = false
      try {
        control = await GrokNativeControl.start({ cwd: context.cwd, binary: context.binary, env: context.nativeEnv, inheritEnv: false, startupTimeoutMs: 5000,
          onLifecycleObservation: event => { lifecycle.push(event); capture.record('leader', event.kind, { ...event, epoch: 'startup-failure' }) } })
      } catch { rejected = true }
      await control?.dispose()
      await new Promise(resolve => setImmediate(resolve))
      const pid = lifecycle.find(event => event.kind === 'spawned')?.pid
      const exited = lifecycle.find(event => event.kind === 'exited')
      const processAbsent = pid !== undefined && !processAlive(pid)
      const nativeExitCode = exited?.exitCode
      const nativeSignal = exited?.signal
      capture.record('verification', 'startup-failure-outcome', { rejected, pid, processAbsent, nativeExitCode, nativeSignal })
      // A timeout followed by our own SIGTERM would also be rejected and absent.
      // Requiring the installed process's unsignaled nonzero exit proves the
      // malformed disposable config, rather than the deadline, caused failure.
      if (!rejected || !processAbsent || !Number.isInteger(nativeExitCode) || nativeExitCode === 0 || nativeSignal !== null) {
        // Native behaving differently is a scenario outcome, exactly like an
        // ordinary scenario whose run() throws: seal a complete failed capture
        // and report it as failed, so the variant is counted instead of being
        // hidden as an incomplete capture.
        const failure = 'Installed native did not produce a cleaned native startup failure'
        capture.record('scenario', 'failed', { id: scenario.id, failure })
        capture.record('lifecycle', 'observation-window-drained')
        sealed = true
        const manifest = capture.finish('failed')
        const { events } = await verifyRuntimeCapture(capture.directory)
        return { manifest, events, directory: capture.directory, failure: failure as string | undefined }
      }
      capture.record('scenario', 'passed', { id: scenario.id })
      capture.record('lifecycle', 'observation-window-drained')
      sealed = true
      const manifest = capture.finish('passed')
      const verified = await sealEvidenceVerdict(capture.directory, verifyLifecycleScenarioEvidence)
      return { manifest, events: verified.events, directory: capture.directory, failure: undefined as string | undefined }
    } catch (error) {
      // A sealed refusal is a verdict about complete evidence, not a failed
      // capture; the runner reports the two outcomes separately.
      if (error instanceof EvidenceRejectedError) throw error
      await control?.dispose().catch(() => {})
      if (!sealed) {
        capture.record('scenario', 'failed', { id: scenario.id, error: error instanceof Error ? error.name : 'unknown' })
        capture.record('lifecycle', 'observation-window-drained')
        sealed = true
        capture.finish('failed')
      }
      throw new Error(`Native startup-failure capture failed; private evidence: ${capture.directory}`)
    }
  }
  get mcpServers(): GrokMcpServer[] { return [{ type: 'http', name: 'fixture', url: this.backend.baseUrl + '/mcp', headers: [{ name: 'Authorization', value: 'Bearer fixture-only' }] }] }
  async call(method: string, params: unknown, timeoutMs: number | null = 30000): Promise<any> {
    const actionId = ++this.actionId
    this.capture.record('action', 'rpc-requested', { actionId, method, params })
    try {
      const result = await this.control.rpc.request(method, params, { timeoutMs })
      this.capture.record('action', 'rpc-result', { actionId, method, result })
      return result
    } catch (error: any) {
      this.capture.record('action', 'rpc-error', { actionId, method, code: error.code, rpcCode: error.rpcCode, uncertain: error.uncertain })
      throw error
    }
  }
  prompt(text: string | PromptContent[]): Promise<any> {
    // This is an explicit probe of the native content protocol, not a new
    // production send API. Scenarios own sequential/intentional concurrent
    // stimulus and record each result; no acceptance policy is inferred here.
    return this.call('session/prompt', { sessionId: this.sessionId, prompt: typeof text === 'string' ? [{ type: 'text', text }] : text })
  }
  async answer(request: GrokAcpServerRequest, result: unknown) {
    this.capture.record('action', 'reverse-reply-attempt', { token: request.token, result })
    await this.control.rpc.respond(request.token, result)
    this.capture.record('action', 'reverse-reply-written', { token: request.token })
  }
  async waitFor(predicate: () => boolean, label: string, timeoutMs = 20000) {
    const deadline = performance.now() + timeoutMs
    while (!predicate() && performance.now() < deadline) await delay(25)
    if (!predicate()) throw new Error(`Capture scenario deadline: ${label}`)
  }
  failNextDependentCleanupForCapture() { this.failDependentCleanup = true }
  async restartNativeAndResume() {
    const previousLeaderPid = this.control.pid
    const previousTuiPid = this.tui?.pid
    if (!previousLeaderPid || !previousTuiPid || !this.guard) throw new Error('No complete owned native epoch to restart')
    await this.control.dispose()
    const previousLeaderAbsent = !processAlive(previousLeaderPid)
    const previousTuiAbsent = !processAlive(previousTuiPid)
    this.guard = undefined; this.tui = undefined; this.terminal = undefined
    // A guard admits exactly one viewer for its entire lifetime, and disposing
    // it intentionally faults the old leader connection. Restart therefore
    // replaces the whole owned epoch; only the disposable session/home persist.
    this.control = await this.startControl(this.backend.baseUrl)
    const resumed = await this.startTui()
    await this.control.updateMcpServers(this.sessionId, this.mcpServers)
    const resumedLeaderPid = this.control.pid
    const resumedTuiPid = resumed.pid
    // `loadObserved`/`replayObserved` are the harness's fail-fast summary of the
    // TUI wire it just decoded, so a broken resume stops the scenario instead of
    // burning the rest of the native run. EvidenceVerification does not use them:
    // it re-derives load, replay, prompt completion and file growth from raw
    // frames and native files, and trusts only the OS absence probes and PIDs,
    // which can be observed nowhere but here, between the two epochs.
    const evidence = { sessionId: this.sessionId, previousLeaderPid, previousTuiPid, resumedLeaderPid, resumedTuiPid,
      previousLeaderAbsent, previousTuiAbsent, loadObserved: this.tuiLoaded, replayObserved: this.tuiReplayObserved }
    this.capture.record('verification', 'native-restart-resume', evidence)
    if (!previousLeaderAbsent || !previousTuiAbsent || !resumedLeaderPid || resumedLeaderPid === previousLeaderPid ||
      resumedTuiPid === previousTuiPid || !this.tuiLoaded || !this.tuiReplayObserved) throw new Error('Native restart/resume evidence is incomplete')
    return evidence
  }
  private startControl(base: string) {
    return GrokNativeControl.start({ cwd: this.cwd, binary: this.binary, env: this.nativeEnv, inheritEnv: false, model: 'grok-4.6',
      relayUrl: base.replace('http:', 'ws:') + '/disabled', relayOrigin: base,
      onTransportObservation: event => this.transport(event),
      onLifecycleObservation: event => this.capture.record('leader', event.kind, event),
      onNotification: event => { this.notifications.push(event); this.capture.record('control', 'notification', event) },
      onRequest: request => { this.requests.push(request); this.capture.record('control', 'reverse-request', request) },
      onClose: event => this.capture.record('lifecycle', 'control-close-complete', { code: event.code, uncertain: event.uncertain }),
      beforeClose: async () => { if (this.guard) await this.guard.dispose(() => this.stopTui()); else await this.stopTui() },
    })
  }
  private async startTui() {
    const pid = this.control.pid
    if (!pid || this.control.isClosed) throw new Error('Owned leader closed before TUI creation')
    // Each TUI epoch gets fresh connections; state and splitters from the closed
    // epoch must neither satisfy nor leak into the next one.
    this.tuiLoaded = false; this.tuiReplayObserved = false; this.pendingLoads.clear(); this.decoders.clear(); this.tuiSentMethodCounts.clear(); this.tuiSessionUpdateWrites.clear(); this.tuiExited = false
    this.guard = await GrokTuiSocketGuard.create({ upstreamPath: this.control.socketPath, expectedPid: pid,
      onTransportObservation: event => this.transport(event),
      onFault: reason => { this.capture.record('guard', 'holding', { reason }); void this.control?.dispose().catch(() => {}) },
    })
    // This protects the disposable experiment from escaped descendants. It
    // is explicitly part of the capture provenance, not production policy.
    const profile = '(version 1) (allow default) (deny process-fork)'
    execFileSync('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '-e',
      "const r=require('node:child_process').spawnSync('/usr/bin/true');process.exit(r.error?.code==='EPERM'?0:1)"], { env: this.nativeEnv, stdio: 'ignore' })
    const epoch = ++this.tuiEpoch
    this.capture.record('lifecycle', 'tui-containment', { epoch, profile: 'deny-process-fork', independentlyVerified: true, clipboardIsolated: false })
    const native = createRequire(import.meta.url)('node-pty') as typeof import('node-pty')
    const tui = this.tui = native.spawn('/usr/bin/sandbox-exec', ['-p', profile, this.binary, '--no-auto-update', '--fullscreen', '--leader',
      '--leader-socket', this.guard.socketPath, '--resume', this.sessionId], {
      cwd: this.cwd, env: { ...this.nativeEnv, TERM: 'xterm-256color' }, name: 'xterm-256color', cols: 120, rows: 40,
    })
    this.capture.record('tui', 'spawn-returned', { epoch, pid: tui.pid, cols: 120, rows: 40 })
    tui.onData(data => this.capture.record('tui', 'output', {}, Buffer.from(data)))
    this.tuiExit = new Promise(resolve => tui.onExit(event => {
      this.tuiExited = true; this.capture.record('tui', 'exited', { epoch, ...event }); resolve()
    }))
    const terminal = this.terminal = new HeadlessTerminal({ pty: tui, cols: 120, rows: 40 })
    terminal.on('screen', snapshot => {
      this.capture.record('terminal', 'screen', snapshot)
      this.capture.record('terminal', 'frame-at-screen-event', terminal.snapshotStableFrame())
    })
    terminal.attach()
    await this.waitFor(() => this.tuiLoaded, 'native TUI load response')
    return tui
  }
  private transport(event: GrokTransportObservation) {
    const { bytes, ...metadata } = event
    this.capture.record('ipc', event.kind, metadata, bytes)
    if (event.kind === 'opened') this.openConnections.add(event.connectionId)
    if (event.kind === 'closed') this.openConnections.delete(event.connectionId)
    if (event.role !== 'tui' || !bytes || (event.kind !== 'received' && event.kind !== 'write-attempt')) return
    // A deliberately smaller subset of EvidenceVerification's pairing: per
    // connection, type-exact ids, first answer, refusal is not a load. The
    // verifier additionally refuses reused or outstanding ids, undecodable frames,
    // failed writes and any live prompt before the answer. That drift only fails
    // closed (a run this check lets through can still be refused); this exists to
    // stop a clearly broken resume before the rest of the native run is spent.
    const key = `${event.connectionId}:${event.kind}`
    let splitter = this.decoders.get(key)
    if (!splitter) { splitter = new FrameSplitter(); this.decoders.set(key, splitter) }
    for (const envelope of splitter.push(bytes) as Array<{ type?: unknown; payload?: unknown }>) {
      if (envelope?.type !== 'acp' || typeof envelope.payload !== 'string') continue
      let rpc: any
      // One undecodable payload must not hide the frames that follow it.
      try { rpc = JSON.parse(envelope.payload) } catch { continue }
      const id = rpc?.id === undefined ? undefined : JSON.stringify(rpc.id)
      const pending = this.pendingLoads.get(event.connectionId)
      if (event.kind === 'received') {
        if (typeof rpc?.method === 'string') this.tuiSentMethodCounts.set(rpc.method, (this.tuiSentMethodCounts.get(rpc.method) ?? 0) + 1)
        if (rpc?.method === 'session/load' && rpc.params?.sessionId === this.sessionId && id !== undefined) this.pendingLoads.set(event.connectionId, id)
        continue
      }
      const updated = rpc?.method === 'session/update' ? rpc.params?.sessionId : undefined
      if (typeof updated === 'string') this.tuiSessionUpdateWrites.set(updated, (this.tuiSessionUpdateWrites.get(updated) ?? 0) + 1)
      if (pending === undefined) continue
      if (rpc?.method === 'session/update' && rpc.params?.sessionId === this.sessionId && rpc.params?.update?.sessionUpdate === 'user_message_chunk') {
        this.tuiReplayObserved = true
      } else if (rpc?.method === undefined && id === pending) {
        this.pendingLoads.delete(event.connectionId)
        if ('result' in rpc && !('error' in rpc)) this.tuiLoaded = true
        // A refused load handed the TUI nothing it could resume from.
        else this.tuiReplayObserved = false
      }
    }
  }
  watchSession(sessionId: string) {
    const directory = join(this.home, 'sessions', encodeGrokSessionsDir(this.cwd), sessionId)
    for (const file of ['summary.json', 'chat_history.jsonl', 'updates.jsonl', 'events.jsonl']) this.watched.set(join(directory, file), { sessionId, file, attached: false })
    this.poller ??= setInterval(() => this.attachHistory(), 25)
    this.attachHistory()
  }
  private attachHistory() {
    for (const [path, value] of this.watched) {
      if (value.attached || !path.endsWith('.jsonl') || !existsSync(path)) continue
      try {
        value.attached = true
        this.capture.record('history', 'observer-attached', value)
        this.observers.push(new FileTailer(path, (_entry, metadata) => this.capture.record('history', 'row', {
          sessionId: value.sessionId, file: value.file, generation: metadata.generation, lineStartOffset: metadata.lineStartOffset,
        }, Buffer.from(metadata.rawLine)), error => this.capture.record('history', 'read-error', { ...value, error: error.name }), {
          onSnapshot: event => this.capture.record('history', event.type, { sessionId: value.sessionId, file: value.file, ...event }),
        }))
      } catch { this.capture.record('history', 'attach-error', value) }
    }
  }
  async checkpoint(label: string) {
    this.capture.record('scenario', 'checkpoint', { label })
    if (this.terminal) this.capture.record('terminal', 'checkpoint-frame', { label, frame: this.terminal.snapshotStableFrame() })
    for (const [path, value] of this.watched) {
      try {
        const before = await stat(path)
        if (!before.isFile() || before.size > 32 * 1024 * 1024) throw new Error('Snapshot budget/type')
        const bytes = await readFile(path)
        const after = await stat(path)
        const stable = before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
        this.capture.record('file', 'snapshot', { ...value, label, stable }, bytes)
      } catch { this.capture.record('file', 'snapshot-unavailable', { ...value, label }) }
    }
  }
  private async stopTui() {
    if (this.failDependentCleanup) {
      this.failDependentCleanup = false
      this.capture.record('stimulus', 'dependent-cleanup-failure', { injected: true })
      throw new Error('Controlled capture cleanup failure')
    }
    if (this.tui && !this.tuiExited) {
      this.capture.record('action', 'tui-signal', { signal: 'SIGTERM' }); this.tui.kill('SIGTERM')
      const force = setTimeout(() => { if (!this.tuiExited) { this.capture.record('action', 'tui-signal', { signal: 'SIGKILL' }); this.tui!.kill('SIGKILL') } }, 1000)
      let timeout: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([this.tuiExit, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('TUI exit unconfirmed')), 5000) })]) }
      finally { clearTimeout(force); clearTimeout(timeout) }
    }
    this.terminal?.dispose()
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    const attempt = (async () => {
      this.capture.record('action', 'close-requested')
      if (this.control) await this.control.dispose(); else await this.stopTui()
      if (this.guard && this.guard.state !== 'disposed') await this.guard.dispose(() => this.stopTui())
      clearInterval(this.poller); this.attachHistory()
      for (const observer of this.observers) { await observer.drain(); await observer.close() }
      await this.checkpoint('after-owned-exit')
      await this.backend?.close()
      await this.waitFor(() => this.openConnections.size === 0, 'observed transport closure', 5000)
      await new Promise(resolve => setImmediate(resolve))
      this.capture.record('lifecycle', 'observation-window-drained')
    })()
    this.closing = attempt
    // WHY a rejected close is not terminal state: every resource operation in
    // this harness is intentionally idempotent, and a transient rejection may
    // leave later resources untouched. Keeping the rejected promise would turn
    // all explicit cleanup retries into no-ops while native processes survive.
    void attempt.catch(() => { if (this.closing === attempt) this.closing = undefined })
    return attempt
  }
  async finish(outcome: 'passed' | 'failed') {
    await this.close()
    const manifest = this.capture.finish(outcome)
    // A checksum-valid journal is necessary but not sufficient. Passing native
    // scenarios are reported only after transport receipts, framed streams and
    // reconstructed history agree with their stable final native snapshots.
    // sealEvidenceVerdict refuses to judge lossy or corrupt storage and leaves
    // recorder-integrity failures unsealed (plain errors the runner reports as
    // capture-incomplete); it seals only scenario-claim judgements, so a reader
    // using readEvidenceVerdict never sees refused evidence as passing.
    const verified = outcome === 'passed'
      ? await sealEvidenceVerdict(this.capture.directory, verifyScenarioEvidence)
      : await verifyRuntimeCapture(this.capture.directory)
    return { manifest, events: verified.events, directory: this.capture.directory }
  }
}

function captureMetadata(scenario: { id: string; description: string; targets: string[] }) {
  return { scenario: scenario.id, description: scenario.description, targets: scenario.targets,
    provenance: 'real installed native runtime in disposable HOME/cwd; controlled stimuli are explicitly recorded',
    ordering: 'observer arrival sequence; not global native causality', publication: 'private exact capture; privacy review required',
    ptyEncoding: 'node-pty decoded UTF-8 callback, not kernel-byte capture',
    timingValidity: 'synchronous fsync recording perturbs timing; do not use capture intervals as latency or race-frequency evidence' }
}

export function isolatedEnv(directory: string, home: string, base: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: directory, USER: 'fixture', LOGNAME: 'fixture', GROK_HOME: home,
    XDG_CONFIG_HOME: join(directory, 'config'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    XAI_API_KEY: 'fixture-only-not-a-real-key', GROK_MODELS_BASE_URL: `${base}/v1`, GROK_XAI_API_BASE_URL: `${base}/v1`,
    GROK_CLI_CHAT_PROXY_BASE_URL: `${base}/v1`, GROK_CONTEXTUAL_HINTS: '0', GROK_PROMPT_SUGGESTIONS: '0',
    OTEL_TRACES_EXPORTER: 'none', OTEL_METRICS_EXPORTER: 'none' }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error: any) { if (error?.code === 'ESRCH') return false; throw error }
}
