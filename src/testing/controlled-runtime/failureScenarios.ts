import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { detectCommandPermission } from '../../conditions/commandPermission.js'
import type { CaptureScenario, Scenario } from './NativeHarness.js'

const outcome = (error: any) => ({ name: error?.name, code: error?.code, rpcCode: error?.rpcCode, uncertain: error?.uncertain })
const hasText = (value: unknown, text: string) => JSON.stringify(value).includes(text)

/** Failure cases kill only the leader PID spawned inside NativeHarness's
 * private home/cwd. They never discover or signal a user's ambient Grok
 * process; loss evidence without that ownership proof would be unsafe. */
export const failureScenarios: CaptureScenario[] = [
  { id: 'tui-draft-during-acp', description: 'Known native TUI draft while an ACP prompt completes', targets: ['draft-preservation', 'tui-app-input'],
    async run(context) {
      const draft = 'CONTROLLED_NATIVE_DRAFT'
      context.tui!.write(draft)
      await context.waitFor(() => context.terminal!.snapshotPlain().includes(draft), 'known native draft')
      await context.checkpoint('draft-before-acp')
      await context.prompt('Controlled ACP prompt while the native draft is pending.')
      const retained = context.terminal!.snapshotPlain().includes(draft)
      context.capture.record('verification', 'native-draft-after-acp', { retained })
      if (!retained) throw new Error('Known native draft was not retained after ACP prompt')
      await context.checkpoint('draft-after-acp')
    } },
  { id: 'resource-link-unavailable', description: 'Native ACP handling of an unavailable generated resource link', targets: ['unavailable-attachment', 'resource-error'],
    async run(context) {
      const path = join(context.cwd, 'does-not-exist.txt')
      let error: unknown
      try { await context.call('session/prompt', { sessionId: context.sessionId, prompt: [
        { type: 'text', text: 'Inspect the unavailable controlled resource.' },
        { type: 'resource_link', name: 'does-not-exist.txt', uri: new URL(`file://${path}`).href, mimeType: 'text/plain' },
      ] }) } catch (caught) { error = caught }
      context.capture.record('verification', 'unavailable-resource-outcome', { rejected: !!error, error: outcome(error) })
      await context.checkpoint('after-unavailable-resource')
    } },
  { id: 'load-unavailable-session', description: 'Native load failure for a valid but absent session identity', targets: ['load-failure', 'unavailable-session'],
    async run(context) {
      const absent = randomUUID()
      let error: unknown
      try { await context.call('session/load', { sessionId: absent, cwd: context.cwd, mcpServers: context.mcpServers }) } catch (caught) { error = caught }
      context.capture.record('verification', 'unavailable-load-outcome', { rejected: !!error, error: outcome(error) })
      if (!error) throw new Error('Native accepted an unavailable session load')
      await context.checkpoint('after-unavailable-load')
    } },
  { id: 'rewind-history-replacement', description: 'Native rewind points, conversation rewind and subsequent load replay', targets: ['rewind', 'history-replacement', 'load-replay'],
    async run(context) {
      for (let index = 0; index < 3; index++) await context.prompt(`Controlled rewind prompt ${index}.`)
      await context.checkpoint('before-rewind')
      // Raw ACP extension requests use the `_x.ai` wire namespace. The native
      // pager's in-process client names this `x.ai`, but the successful compact
      // capture and the prior -32601 response prove those spellings are not
      // interchangeable at this external control boundary.
      const points = await context.call('_x.ai/rewind/points', { session_id: context.sessionId })
      context.capture.record('verification', 'rewind-points', points)
      const preview = await context.call('_x.ai/rewind/execute', {
        session_id: context.sessionId, target_prompt_index: 1, force: false, mode: 'conversation_only',
      })
      context.capture.record('verification', 'rewind-preview', preview)
      if (preview?.success !== false || preview?.target_prompt_index !== 1) throw new Error('Native rewind preview did not describe the controlled prompt')
      const response = await context.call('_x.ai/rewind/execute', {
        session_id: context.sessionId, target_prompt_index: 1, force: true, mode: 'conversation_only',
      })
      context.capture.record('verification', 'rewind-response', response)
      if (response?.success !== true || response?.target_prompt_index !== 1) throw new Error('Native rewind did not reach the controlled prompt')
      await context.checkpoint('after-rewind')
      await context.call('session/load', { sessionId: context.sessionId, cwd: context.cwd, mcpServers: context.mcpServers })
      await context.checkpoint('after-rewind-load')
    } },
  { id: 'leader-loss-idle', description: 'Owned native leader SIGKILL after the session reaches idle', targets: ['leader-loss', 'idle-loss', 'guard-hold'],
    async run(context) {
      const pid = context.control.pid
      if (!pid) throw new Error('No owned leader PID')
      context.capture.record('action', 'owned-leader-signal', { pid, signal: 'SIGKILL', phase: 'idle' })
      process.kill(pid, 'SIGKILL')
      await context.waitFor(() => context.control.isClosed, 'idle leader closure')
      await context.checkpoint('after-idle-leader-loss')
    } },
  { id: 'leader-loss-mid-turn', description: 'Owned native leader SIGKILL with an outstanding inference response', targets: ['leader-loss', 'mid-turn-loss', 'uncertain-prompt'],
    async run(context) {
      let held = false
      context.backend.handler = body => context.backend.advertisedToolNames(body).includes('run_terminal_command') ? (held = true, { kind: 'hold' }) : { kind: 'text', text: 'FIXTURE_AUXILIARY_REPLY' }
      const pending = context.prompt('Hold the controlled turn before owned leader loss.').then(value => ({ value }), error => ({ error: outcome(error) }))
      await context.waitFor(() => held, 'outstanding inference before leader loss')
      const pid = context.control.pid
      if (!pid) throw new Error('No owned leader PID')
      context.capture.record('action', 'owned-leader-signal', { pid, signal: 'SIGKILL', phase: 'mid-turn' })
      process.kill(pid, 'SIGKILL')
      const result = await pending
      context.capture.record('verification', 'mid-turn-loss-outcome', result)
      await context.waitFor(() => context.control.isClosed, 'mid-turn leader closure')
      await context.checkpoint('after-mid-turn-leader-loss')
    } },
  { id: 'tui-submit-after-acp', description: 'Known TUI draft retained through ACP and subsequently committed', targets: ['draft-preservation', 'draft-commit'],
    async run(context) {
      const draft = 'CONTROLLED_RETAINED_DRAFT'
      context.tui!.write(draft)
      await context.waitFor(() => context.terminal!.snapshotPlain().includes(draft), 'known retained draft')
      await context.prompt('Complete ACP while preserving the controlled draft.')
      if (!context.terminal!.snapshotPlain().includes(draft)) throw new Error('Known draft disappeared before submission')
      context.tui!.write('\r')
      await context.waitFor(() => context.backend.requests.some(body => hasText(body.input, draft)), 'retained draft inference request')
      // Prompt completion deliberately omits the submitted text. The queue is
      // therefore the only observed bridge between a TUI draft and the later
      // completion event; matching prose would misattribute concurrent turns.
      await context.waitFor(() => context.notifications.some(event => event.method === '_x.ai/queue/changed' && hasText(event.params, draft)), 'retained draft queue identity')
      const queue = context.notifications.find(event => event.method === '_x.ai/queue/changed' && hasText(event.params, draft))!.params as any
      const promptId = queue.runningPromptId ?? queue.entries?.find((entry: any) => entry.text === draft)?.id
      if (typeof promptId !== 'string') throw new Error('Retained draft has no native prompt identity')
      await context.waitFor(() => context.notifications.some(event => event.method === '_x.ai/session/prompt_complete' && (event.params as any)?.promptId === promptId), 'retained draft completion')
      context.capture.record('verification', 'retained-draft-committed', { inferenceObserved: true, completionObserved: true, promptId })
      await context.checkpoint('after-retained-draft-submit')
    } },
  ...(['acp-then-tui', 'tui-then-acp'] as const).map(order => ({
    id: `concurrent-${order}`, description: `Actual overlapping native submissions in ${order} order`, targets: ['tui-app-concurrency', order],
    async run(context) {
      const acpText = `CONTROLLED_CONCURRENT_ACP_${order}`
      const tuiText = `CONTROLLED_CONCURRENT_TUI_${order}`
      let held = false
      context.backend.handler = body => {
        if (!held && context.backend.advertisedToolNames(body).includes('run_terminal_command')) { held = true; return { kind: 'hold' } }
        return { kind: 'text', text: 'FIXTURE_CONCURRENT_REPLY' }
      }
      let acp: Promise<any>
      if (order === 'acp-then-tui') {
        acp = context.prompt(acpText).catch(error => ({ error: outcome(error) }))
        await context.waitFor(() => held, 'held ACP inference')
        context.tui!.write(`${tuiText}\r`)
      } else {
        context.tui!.write(`${tuiText}\r`)
        await context.waitFor(() => held, 'held TUI inference')
        acp = context.prompt(acpText).catch(error => ({ error: outcome(error) }))
      }
      await context.waitFor(() => context.notifications.some(event => event.method === '_x.ai/queue/changed' && hasText(event.params, order === 'acp-then-tui' ? tuiText : acpText)), 'second submission queue evidence')
      await context.control.rpc.notify('session/cancel', { sessionId: context.sessionId })
      const acpOutcome = await acp
      await context.waitFor(() => context.backend.requests.some(body => hasText(body.input, acpText)) && context.backend.requests.some(body => hasText(body.input, tuiText)), 'both inference inputs')
      context.capture.record('verification', 'concurrent-native-submissions', { order, acpOutcome, bothInferenceInputsObserved: true })
      await context.checkpoint('after-concurrent-native-submissions')
    },
  } satisfies Scenario)),
  { id: 'permission-dual-client-race', description: 'TUI resolves a permission before control attempts the same token', targets: ['permission', 'dual-client-race', 'stale-token'],
    async run(context) {
      const directory = join(context.cwd, 'permission-race')
      await mkdir(directory); await writeFile(join(directory, 'owned'), 'fixture')
      const command = 'rm -rf ./permission-race'
      let sent = false
      context.backend.handler = body => {
        if (sent || !context.backend.advertisedToolNames(body).includes('run_terminal_command')) return { kind: 'text', text: 'FIXTURE_PERMISSION_DONE' }
        sent = true
        return { kind: 'tool', name: 'run_terminal_command', arguments: { command, description: 'Controlled dual-client permission' }, callId: 'call_dual_permission' }
      }
      const turn = context.prompt('Exercise the controlled dual-client permission race.')
      await context.waitFor(() => context.requests.some(request => request.method === 'session/request_permission'), 'dual-client permission request')
      const request = context.requests.find(request => request.method === 'session/request_permission')!
      let key: string | undefined
      await context.waitFor(() => {
        key = detectCommandPermission(context.terminal!.snapshotPlain(), [{ toolCallId: 'call_dual_permission', command }])
          ?.actions.find(action => action.id === 'allow-once')?.key
        return !!key
      }, 'TUI permission action')
      context.tui!.write(key!)
      // Interaction lifecycle is transient control state and is not persisted
      // as a transcript update. Waiting on the extension notification keeps
      // the stale-token attempt ordered after the TUI actually won the race.
      await context.waitFor(() => context.notifications.some(event => event.method === '_x.ai/session_notification' && hasText(event.params, 'interaction_resolved')), 'TUI permission resolution')
      let staleError: unknown
      try { await context.answer(request, { outcome: { outcome: 'cancelled' } }) } catch (error) { staleError = error }
      const result = await turn
      const retained = await readFile(join(directory, 'owned')).then(() => true, () => false)
      context.capture.record('verification', 'dual-client-permission-outcome', { staleReplyRejected: !!staleError, staleError: outcome(staleError), retained, turn: result })
      if (!staleError) throw new Error('Second client unexpectedly resolved an already-retired permission token')
      if (retained) throw new Error('TUI allow-once did not execute the controlled command')
      await context.checkpoint('after-dual-client-permission')
    } },
  { id: 'second-session-control', description: 'A second disposable session created and prompted while the original TUI remains attached', targets: ['multi-session', 'session-identity'],
    async run(context) {
      const second = randomUUID()
      const created = await context.call('session/new', { cwd: context.cwd, mcpServers: context.mcpServers, _meta: { sessionId: second } })
      if (created?.sessionId !== second) throw new Error('Native changed the second controlled session identity')
      const result = await context.call('session/prompt', { sessionId: second, prompt: [{ type: 'text', text: 'CONTROLLED_SECOND_SESSION_PROMPT' }] })
      context.capture.record('verification', 'second-session-outcome', { primarySessionId: context.sessionId, secondSessionId: second, result })
      await context.call('session/load', { sessionId: context.sessionId, cwd: context.cwd, mcpServers: context.mcpServers })
      await context.checkpoint('after-second-session')
    } },
  { id: 'mcp-remove-restore', description: 'Remove the session MCP set, observe stale-call failure, then restore readiness', targets: ['mcp-reseed', 'mcp-unavailable', 'mcp-restore'],
    async run(context) {
      await context.call('_x.ai/session/update_mcp_servers', { sessionId: context.sessionId, mcpServers: [] })
      const removed = await context.call('_x.ai/mcp/list', { sessionId: context.sessionId })
      let staleError: unknown
      try { await context.call('_x.ai/mcp/call', { sessionId: context.sessionId, server: 'fixture', serverUrl: context.backend.baseUrl + '/mcp', tool: 'fixture_echo', arguments: { text: 'stale' } }) }
      catch (error) { staleError = error }
      context.capture.record('verification', 'mcp-removed', { list: removed, staleCallRejected: !!staleError, staleError: outcome(staleError) })
      if (!staleError) throw new Error('Removed MCP server remained callable')
      await context.control.updateMcpServers(context.sessionId, context.mcpServers)
      const restored = await context.call('_x.ai/mcp/call', { sessionId: context.sessionId, server: 'fixture', serverUrl: context.backend.baseUrl + '/mcp', tool: 'fixture_echo', arguments: { text: 'restored' } })
      context.capture.record('verification', 'mcp-restored', { restored })
      await context.checkpoint('after-mcp-restore')
    } },
  { id: 'native-restart-resume', description: 'Owned leader and TUI exit followed by a fresh native epoch loading the same disposable session', targets: ['restart', 'resume', 'session-identity'],
    async run(context) {
      context.backend.handler = () => ({ kind: 'text', text: 'FIXTURE_RESTART_HISTORY' })
      // WHY no rendered-text waits: the resumed TUI paints the replayed turns
      // itself, so screen text cannot tell replay apart from anything else, and
      // any frame may contain the fixture reply. The owned control connection
      // correlates each prompt by JSON-RPC id and returns native's stopReason;
      // load and replay are proven from the resumed TUI's raw frames by
      // restartNativeAndResume and, independently, by EvidenceVerification.
      const before = await context.prompt('Controlled prompt before native TUI restart.')
      if (typeof before?.stopReason !== 'string') throw new Error('Pre-restart prompt has no native completion')
      await context.checkpoint('before-tui-restart')
      await context.restartNativeAndResume()
      // The verifier's continuity baseline: a native file read taken after the
      // resumed load was answered and MCP servers were reseeded, and before the
      // prompt is sent. `stable` covers only this one read; the verifier also
      // requires it to begin with the pre-restart checkpoint and brackets the
      // prompt between it and `after-tui-resume`. Tailer-reported growth alone
      // cannot be bounded that way, because a poll may report earlier writes.
      await context.checkpoint('before-resumed-prompt')
      const after = await context.prompt('Controlled prompt after native TUI resume.')
      if (typeof after?.stopReason !== 'string') throw new Error('Resumed session has no native prompt completion')
      await context.checkpoint('after-tui-resume')
    } },
  { kind: 'startup-failure', id: 'native-startup-failure', description: 'Installed native rejects malformed disposable configuration and cleans its owned process',
    targets: ['startup-failure', 'owned-process-exit'],
    // WHY malformed disposable configuration: an impossible binary path would
    // test Node spawn failure, while a tiny timeout would only test scheduling.
    // This input reaches the installed native and deterministically asks its
    // own configuration parser to reject startup without touching user state.
    configToml: '[[controlled_invalid_toml]\n',
  },
  { id: 'cleanup-retry-native', description: 'Injected dependent cleanup failure retains real owned processes before explicit retry succeeds', targets: ['cleanup-retry', 'owned-process-retention'],
    async run(context) {
      const pid = context.control.pid
      if (!pid) throw new Error('No owned leader PID before cleanup retry')
      context.failNextDependentCleanupForCapture()
      let rejected = false
      try { await context.close() } catch { rejected = true }
      let leaderAlive = false
      try { process.kill(pid, 0); leaderAlive = true } catch (error: any) { if (error?.code !== 'ESRCH') throw error }
      context.capture.record('verification', 'cleanup-first-attempt', { pid, rejected, leaderAlive, guardState: context.guard?.state })
      if (!rejected || !leaderAlive) throw new Error('First cleanup did not retain the owned native leader')
      // The runner's normal finish path performs the explicit second close.
      // Its matched leader exit and second close receipt are verified after the
      // manifest is published, rather than guessed here from a delay.
    } },
]
