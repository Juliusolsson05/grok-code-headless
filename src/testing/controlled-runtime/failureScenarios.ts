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
      context.capture.record('action', 'cancel-requested', { sessionId: context.sessionId })
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
  { id: 'client-supplied-prompt-identity', description: 'Control prompt carrying a client-chosen _meta.promptId, to learn whether native adopts it', targets: ['prompt-identity', 'acceptance-correlation'],
    async run(context) {
      // WHY recorded rather than assumed: a prompt can only be correlated with its
      // native acceptance before completion if native reports an identity the
      // client already knows. The TUI supplies _meta.promptId; the control prompts
      // in every other scenario do not, so whether native honours a client-chosen
      // id is an open Stage 2 question. Adoption and non-adoption are both
      // evidence, so this records the observation instead of asserting either.
      const promptId = randomUUID()
      const result = await context.call('session/prompt', {
        sessionId: context.sessionId, prompt: [{ type: 'text', text: 'Controlled prompt with a client-chosen identity.' }], _meta: { promptId },
      })
      if (typeof result?.stopReason !== 'string') throw new Error('Client-identified prompt has no native completion')
      // The result above is native's completion. The completion notification is
      // observed for a bounded moment, not required: a run without it is evidence
      // too, and the notification counts below keep "not adopted" distinguishable
      // from "never notified".
      await context.waitFor(() => context.notifications.some(event => event.method === '_x.ai/session/prompt_complete'), 'native prompt completion notification', 5000).catch(() => {})
      const queueChanges = context.notifications.filter(event => event.method === '_x.ai/queue/changed').map(event => event.params as any)
      const completions = context.notifications.filter(event => event.method === '_x.ai/session/prompt_complete').map(event => event.params as any)
      context.capture.record('verification', 'client-prompt-identity', {
        // Earliest acceptance point: the waiting entry native lists before the
        // prompt runs. The boolean is computed from the exact capture; the public
        // corpus numbers prompt-kind entry ids with prompt ids, so the same
        // equality is also readable there.
        adoptedAsQueueEntry: queueChanges.some(params => (params?.entries ?? []).some((entry: any) => entry?.id === promptId)),
        adoptedAsRunning: queueChanges.some(params => params?.runningPromptId === promptId),
        adoptedAsCompleted: completions.some(params => params?.promptId === promptId),
        adoptedInResult: result?._meta?.promptId === promptId,
        queueNotifications: queueChanges.length, completionNotifications: completions.length,
      })
      await context.checkpoint('after-client-prompt-identity')
    } },
  { id: 'cancel-queued-prompt', description: 'Session cancel while a second control prompt is queued behind a held running turn', targets: ['cancel', 'queued-prompt', 'cancel-with-queued-prompt'],
    async run(context) {
      // WHY this is not "cancel before delivery": the second prompt has already
      // been accepted into native's queue when the cancel is sent, and
      // session/cancel names the session, not a prompt. What this records is
      // whether a session cancel also retires queued work; a cancel racing the
      // first prompt write remains a coverage gap in the corpus manifest.
      const runningText = 'CONTROLLED_RUNNING_BEFORE_CANCEL'
      const queuedText = 'CONTROLLED_QUEUED_BEFORE_CANCEL'
      // Client-chosen ids (see client-supplied-prompt-identity) let the queue
      // notifications say which prompt was running and which was waiting, rather
      // than inferring it from text that native also copies into runningText once
      // a prompt starts.
      const runningId = randomUUID()
      const queuedId = randomUUID()
      // Only the main turn advertises native tools. Title and other sidecar
      // requests can carry the same prompt text without them; a text-only selector
      // could hold a sidecar while the real turn ran to completion, and the record
      // would then show the queued prompt as the one the cancel hit.
      const mainTurn = (body: any) => context.backend.advertisedToolNames(body).includes('run_terminal_command')
      let held = false
      context.backend.handler = body => {
        if (!held && mainTurn(body) && hasText(body.input, runningText)) { held = true; return { kind: 'hold' } }
        return { kind: 'text', text: 'FIXTURE_AFTER_CANCEL' }
      }
      const send = (text: string, promptId: string) => context.call('session/prompt', { sessionId: context.sessionId, prompt: [{ type: 'text', text }], _meta: { promptId } })
      // Each prompt is settled into a record; the control client's RPC deadline
      // bounds a prompt native never answers, so this cannot hang the batch.
      const settle = (turn: Promise<any>): Promise<{ result?: any; error?: ReturnType<typeof outcome> }> =>
        turn.then(result => ({ result }), error => ({ error: outcome(error) }))
      let runningSettled = false
      const running = settle(send(runningText, runningId)).finally(() => { runningSettled = true })
      await context.waitFor(() => held, 'held running inference')
      const queued = settle(send(queuedText, queuedId))
      const queueChanges = () => context.notifications.filter(event => event.method === '_x.ai/queue/changed').map(event => event.params as any)
      // Queued means listed among the waiting entries while the held prompt has
      // not settled. Matching the text anywhere in the notification would also
      // accept runningText, i.e. a "queued" prompt that had already started.
      await context.waitFor(() => !runningSettled && queueChanges().some(params => hasText(params?.entries ?? [], queuedText)), 'queued prompt listed behind the held turn')
      const changesAtCancel = queueChanges()
      const queueAtCancel = changesAtCancel[changesAtCancel.length - 1]
      const runningSettledBeforeCancel = runningSettled
      context.capture.record('action', 'cancel-requested', { sessionId: context.sessionId })
      await context.control.rpc.notify('session/cancel', { sessionId: context.sessionId })
      const [runningOutcome, queuedOutcome] = await Promise.all([running, queued])
      context.capture.record('verification', 'cancel-queued-outcome', {
        runningOutcome, queuedOutcome, runningSettledBeforeCancel, queueAtCancel,
        runningReportedWithClientId: queueChanges().some(params => params?.runningPromptId === runningId),
        queuedEntryUsesClientId: queueChanges().some(params => (params?.entries ?? []).some((entry: any) => entry?.id === queuedId)),
        // A main-turn request carrying the queued text: the held turn's input never
        // contains it, and sidecars do not advertise native tools.
        queuedInferenceObserved: context.backend.requests.some(body => mainTurn(body) && hasText(body.input, queuedText)),
      })
      // Only a result or a JSON-RPC error answer (code 'remote' with a numeric
      // rpcCode) came from native. Every other settlement was produced locally:
      // the harness deadline, a connection closed before or after the write, a
      // capacity refusal or an abort. The control client's uncertain flag cannot
      // separate the two, because it marks native error answers uncertain and
      // some local refusals certain. The record above keeps whatever happened; a
      // capture whose outcome native never produced must not verify as a
      // recorded cancellation result.
      const answeredByNative = (settled: { result?: unknown; error?: ReturnType<typeof outcome> }) =>
        'result' in settled || (settled.error?.code === 'remote' && typeof settled.error.rpcCode === 'number')
      if (!answeredByNative(runningOutcome) || !answeredByNative(queuedOutcome)) throw new Error('A prompt around the session cancel was settled locally, not answered by native')
      await context.checkpoint('after-cancel-queued-prompt')
    } },
  { id: 'tui-new-session', description: 'The native TUI requests and displays a new session with /new while the owned control client keeps prompting the original session', targets: ['session-change', 'tui-initiated', 'session-identity'],
    async run(context) {
      // WHY this exists: the approved ownership rule fences input when the native
      // terminal moves to another conversation, but no capture showed what a
      // terminal-initiated change looks like on the wire. `/new` is taken from
      // the installed 1.0.30 command table ("Start a new session"); `/resume`
      // opens an interactive picker and `/fork` can create worktrees, so `/new`
      // is the deterministic first case. Only the original session's native
      // files are observed. The new session exists in the capture only as the
      // terminal's own session/new answer and its later traffic; no control
      // announcement of it has been recorded.
      //
      // WHY it measures what the terminal is fed, not only what it shows: in the
      // reviewed first timeline the terminal showed the new id while native kept
      // streaming the original session's updates to it. "Shows another session"
      // therefore cannot mean "left the original session", so the record counts
      // the original session's updates written to the terminal and samples
      // whether the original session's distinct reply is drawn.
      const afterText = 'Controlled prompt to the original session after the terminal requested a new one.'
      const afterReply = 'FIXTURE_ORIGINAL_REPLY_AFTER_TERMINAL_NEW'
      // The distinct reply goes only to the main turn: a sidecar title carrying it
      // could be painted as a heading and read as the reply being drawn.
      context.backend.handler = body => ({ kind: 'text',
        text: context.backend.advertisedToolNames(body).includes('run_terminal_command') && hasText(body.input, afterText) ? afterReply : 'FIXTURE_REPLY' })
      const before = await context.prompt('Controlled prompt before the native terminal starts a new session.')
      if (typeof before?.stopReason !== 'string') throw new Error('Original session prompt has no native completion')
      const announced = (event: { method: string; params?: unknown }) => event.method === '_x.ai/sessions/changed' &&
        ((event.params as any)?.upserted ?? []).some((session: any) => typeof session?.sessionId === 'string' && session.sessionId !== context.sessionId)
      await context.checkpoint('before-tui-new-session')
      const newSessionRequestsBefore = context.tuiSentMethodCounts.get('session/new') ?? 0
      context.tui!.write('/new')
      await context.waitFor(() => context.terminal!.snapshotPlain().includes('/new'), 'typed native /new command')
      context.tui!.write('\r')
      // The first 1.0.30 recording showed the terminal requesting session/new on
      // its own connection and painting the new session id, while nothing was
      // announced to the control client before the deadline. Wait on the
      // terminal's own request and the new id it shows, never on a notification
      // the recording did not contain.
      await context.waitFor(() => (context.tuiSentMethodCounts.get('session/new') ?? 0) > newSessionRequestsBefore, 'native terminal session/new request')
      // Windows of the original session's updates written to the terminal: from
      // its session/new request to the control prompt, then during that prompt.
      // Trailing updates of the completed first prompt can still land in the first
      // window, which is why the two are recorded separately.
      const originalUpdates = () => context.tuiSessionUpdateWrites.get(context.sessionId) ?? 0
      const otherSessionUpdates = () => [...context.tuiSessionUpdateWrites].reduce((sum, [sessionId, count]) => sessionId === context.sessionId ? sum : sum + count, 0)
      const originalAtNewRequest = originalUpdates()
      const showsOtherSession = () => [...context.terminal!.snapshotPlain().matchAll(/Session ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g)]
        .some(match => match[1] !== context.sessionId)
      await context.waitFor(showsOtherSession, 'native terminal showing a different session')
      await context.checkpoint('after-tui-new-session')
      const originalAtPrompt = originalUpdates()
      // Settled rather than awaited: native refusing or fencing the original
      // session after the terminal's /new is the variant this scenario most needs
      // to keep, so the record is written before any failure is raised.
      const after: { result?: any; error?: ReturnType<typeof outcome> } = await context.prompt(afterText).then(result => ({ result }), error => ({ error: outcome(error) }))
      const originalAfterPrompt = originalUpdates()
      const completed = typeof after.result?.stopReason === 'string'
      // Bounded sample: a terminal that never draws the original session's reply
      // is evidence too, not a failed stimulus. Without a completion there is no
      // reply to look for, so the record says "not sampled" (null) rather than
      // "not drawn" (false).
      const drewOriginalReply = completed
        ? await context.waitFor(() => context.terminal!.snapshotPlain().includes(afterReply), 'original session reply drawn on the terminal', 5000).then(() => true, () => false)
        : null
      context.capture.record('verification', 'tui-new-session-outcome', {
        terminalRequestedNewSession: true, terminalShowsOtherSession: showsOtherSession(),
        newSessionAnnouncedToControl: context.notifications.some(announced),
        originalUpdatesToTerminalBeforePrompt: originalAtPrompt - originalAtNewRequest,
        originalUpdatesToTerminalDuringPrompt: originalAfterPrompt - originalAtPrompt,
        otherSessionUpdatesToTerminal: otherSessionUpdates(),
        terminalDrewOriginalReply: drewOriginalReply,
        originalPromptOutcome: after,
      })
      // A native error answer (code 'remote' with a numeric rpcCode) is the
      // refusal/fence variant this scenario exists to keep, so it passes and is
      // published like a completion. Anything else was settled locally (the
      // harness deadline, a closed connection, a capacity refusal, an abort) and
      // fails the capture. The control client's uncertain flag cannot make that
      // distinction: it marks native error answers uncertain and some local
      // refusals certain.
      const answeredByNative = 'result' in after || (after.error?.code === 'remote' && typeof after.error.rpcCode === 'number')
      if (!answeredByNative) throw new Error('Original session prompt after the terminal requested a new session was settled locally, not answered by native')
      await context.checkpoint('after-original-session-prompt')
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
