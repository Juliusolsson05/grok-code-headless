// Replays a committed controlled-runtime timeline as the inputs GrokHeadless's
// reconcile layer receives. Test-only: its consumers are the recorded tests of
// live/ and reconcile/; production code must not import it.
//
// WHY from the published corpus and not the private captures: the corpus is
// what CI has, and it keeps every identity the reconcile layer keys on (session,
// prompt and tool-call ids as cross-channel ordinals; prompt-kind queue entry ids
// numbered with prompt ids) plus observer order. Text is placeholders, so a test
// may compare which row or event arrived, never what it said.
//
// WHY the harness session is `session-1`: corpus identities are ordinals in
// first-seen order, and every scenario creates its own session first.

import { readFileSync } from 'node:fs'

import type { ControlInput } from '../../live/types.js'
import type { GrokConversationItem } from '../../transcript/ConversationItem.js'
import type { GrokDurableEntry, GrokHistoryBoundary } from '../../transcript/durable.js'
import { rewriteSnapshotEnd } from '../../transcript/HistoryReader.js'

export const REPLAY_SESSION_ID = 'session-1'

export type ReplayStep =
  | { sequence: number; kind: 'control'; input: ControlInput }
  | { sequence: number; kind: 'register-prompt'; promptId: string }
  | { sequence: number; kind: 'durable'; entry: GrokDurableEntry }
  | { sequence: number; kind: 'boundary'; boundary: GrokHistoryBoundary }

const corpus = new URL('../../../testing/fixtures/controlled-runtime/corpus/', import.meta.url)

type Line = { sequence: number; channel: string; kind: string; data?: any; frames?: Array<{ payload?: unknown }>; row?: unknown }

export function loadTimeline(scenario: string): Line[] {
  return readFileSync(new URL(`${scenario}.jsonl`, corpus), 'utf8').trimEnd().split('\n').map(text => JSON.parse(text) as Line)
}

export function replayableScenarios(): string[] {
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', corpus), 'utf8')) as { scenarios: Array<{ id: string }> }
  return manifest.scenarios.map(scenario => scenario.id)
}

/**
 * The reconcile inputs one control epoch of a scenario contains, in observer order.
 *
 * WHY per epoch: a restart's second epoch belongs to a new GrokHeadless with new
 * helper handles, so each epoch is replayed on its own and ends at its control
 * close. Epoch 2 exists only in native-restart-resume, and there the app resumed
 * the session, so its history snapshots follow the resume rule.
 */
export function replaySteps(scenario: string, options: { epoch?: 1 | 2 } = {}): ReplayStep[] {
  const wanted = options.epoch ?? 1
  const steps: ReplayStep[] = []
  // Ranked byte offsets keep order within one generation, which is all the
  // replay comparison needs (corpus limits). The recorder followed one file
  // across both epochs, so snapshot ends are kept for the whole timeline.
  const snapshotEnd = new Map<number, number>()
  const promptByAction = new Map<number, string>()
  let epoch = 1
  for (const line of loadTimeline(scenario)) {
    if (epoch > wanted) break
    const { sequence } = line
    const d = line.data ?? {}
    const push = (step: ReplayStep) => { if (epoch === wanted) steps.push(step) }
    const control = (input: ControlInput) => push({ sequence, kind: 'control', input })
    if (line.channel === 'control' && line.kind === 'notification') control({ kind: 'notification', method: d.method, params: d.params })
    else if (line.channel === 'control' && line.kind === 'reverse-request') control({ kind: 'request', token: d.token, method: d.method, params: d.params })
    else if (line.channel === 'action' && line.kind === 'rpc-requested' && d.method === 'session/prompt') {
      const promptId = d.params?._meta?.promptId
      // Only prompts sent with a client id are app prompts the reconcile layer
      // can correlate; the others are native-assigned and replay as foreign.
      if (typeof promptId === 'string') { promptByAction.set(d.actionId, promptId); push({ sequence, kind: 'register-prompt', promptId }) }
    } else if (line.channel === 'action' && line.kind === 'rpc-result' && d.method === 'session/prompt') {
      const promptId = d.result?._meta?.promptId
      if (typeof promptId === 'string') control({ kind: 'prompt-result', promptId, result: d.result })
    } else if (line.channel === 'action' && line.kind === 'rpc-error' && d.method === 'session/prompt') {
      const promptId = promptByAction.get(d.actionId)
      if (promptId) control({ kind: 'prompt-error', promptId, native: d.code === 'remote' && typeof d.rpcCode === 'number', written: d.uncertain !== false, ...(typeof d.code === 'string' ? { detail: d.code } : {}) })
    } else if (line.channel === 'history' && d.file === 'chat_history.jsonl') {
      if (line.kind === 'reset' || line.kind === 'caught-up') {
        if (line.kind === 'reset') snapshotEnd.set(d.generation, rewriteSnapshotEnd({ resume: epoch > 1, generation: d.generation, snapshotByteLength: d.snapshotByteLength }))
        push({ sequence, kind: 'boundary', boundary: { ...d, type: line.kind, sessionId: REPLAY_SESSION_ID } })
      } else if (line.kind === 'row' && line.row) {
        push({ sequence, kind: 'durable', entry: {
          sessionId: REPLAY_SESSION_ID,
          item: line.row as GrokConversationItem,
          raw: JSON.stringify(line.row),
          generation: d.generation,
          lineStartOffset: d.lineStartOffset,
          inRewriteSnapshot: d.lineStartOffset < (snapshotEnd.get(d.generation) ?? 0),
        } })
      }
    } else if (line.channel === 'ipc' && d.role === 'tui' && (line.kind === 'received' || line.kind === 'write-attempt')) {
      for (const frame of line.frames ?? []) {
        if (typeof frame?.payload !== 'string') continue
        let message: any
        try { message = JSON.parse(frame.payload) } catch { continue }
        if (line.kind === 'received' && typeof message.method === 'string') control({ kind: 'terminal-request', id: message.id, method: message.method, params: message.params })
        if (line.kind === 'write-attempt' && message.method === undefined && message.id !== undefined) control({ kind: 'terminal-answer', id: message.id, result: message.result, error: message.error })
      }
    } else if (line.channel === 'lifecycle' && line.kind === 'control-close-complete') {
      control({ kind: 'control-closed' })
      epoch++
    }
  }
  return steps
}
