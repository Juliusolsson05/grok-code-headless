import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SemanticEvent } from '../channels/types.js'
import { ControlStateProjector } from '../live/ControlStateProjector.js'
import { REPLAY_SESSION_ID, replayableScenarios, replaySteps, type ReplayStep } from '../testing/replay/corpusReplay.js'
import { isGenuineUserItem } from '../transcript/ConversationItem.js'
import type { GrokDurableEntry } from '../transcript/durable.js'
import { SessionSequencer } from './SessionSequencer.js'

// The host-visible order, replayed from every committed recording through the
// same projector + sequencer composition GrokHeadless uses. Expectations come from
// the recordings (prompt.completion, history.durable, history.replacement), read
// off the timeline independently of the code under test.

type Logged =
  | { at: number; kind: 'entry'; entry: GrokDurableEntry }
  | { at: number; kind: 'semantic'; event: SemanticEvent }
  | { at: number; kind: 'activity'; active: boolean }

/** Where a completion released by the deadline is logged: after every recorded line. */
const DEADLINE = Number.MAX_SAFE_INTEGER

afterEach(() => { vi.useRealTimers() })

function run(steps: ReplayStep[]): Logged[] {
  vi.useFakeTimers()
  const log: Logged[] = []
  const sinkErrors: unknown[] = []
  let at = 0
  const sequencer = new SessionSequencer({
    heartbeatMs: 0,
    onSinkError: error => sinkErrors.push(error),
    sink: {
      entry: entry => log.push({ at, kind: 'entry', entry }),
      history: () => {},
      semantic: event => log.push({ at, kind: 'semantic', event }),
      activity: state => log.push({ at, kind: 'activity', active: state.active }),
      requests: () => {},
      mode: () => {},
    },
  })
  const projector = new ControlStateProjector(REPLAY_SESSION_ID)
  for (const step of steps) {
    at = step.sequence
    if (step.kind === 'register-prompt') projector.registerPrompt(step.promptId)
    else if (step.kind === 'control') sequencer.onLiveOutputs(projector.apply(step.input))
    else if (step.kind === 'durable') sequencer.onDurableEntries([step.entry])
    else sequencer.onHistoryBoundary(step.boundary)
  }
  at = DEADLINE
  vi.runAllTimers()
  sequencer.dispose()
  // The sequencer isolates sink errors, so a broken sink here would otherwise pass silently.
  expect(sinkErrors).toEqual([])
  return log
}

const isFinalAnswer = (entry: GrokDurableEntry) => !entry.inRewriteSnapshot && entry.item.type === 'assistant' && !(entry.item.tool_calls?.length)

/**
 * Where each normally ended turn must reach consumers, read off the replayed
 * timeline without the projector or sequencer: at its first completion signal or
 * at its final appended answer, whichever is later. Answers are matched to turns in
 * running order, one each, never to a turn that had not started yet (catalog
 * prompt.completion). Turns that end any other way are not in the map.
 */
function expectedReleases(steps: ReplayStep[]): Map<string, number> {
  const started: Array<{ turnId: string; at: number }> = []
  const ended = new Map<string, { at: number; stopReason: string }>()
  const answers: number[] = []
  const end = (turnId: unknown, stopReason: unknown, at: number) => {
    if (typeof turnId === 'string' && !ended.has(turnId)) ended.set(turnId, { at, stopReason: typeof stopReason === 'string' ? stopReason : 'end_turn' })
  }
  for (const step of steps) {
    if (step.kind === 'durable' && isFinalAnswer(step.entry)) answers.push(step.sequence)
    if (step.kind !== 'control') continue
    const input = step.input
    if (input.kind === 'prompt-result') end(input.promptId, (input.result as { stopReason?: unknown } | undefined)?.stopReason, step.sequence)
    if (input.kind !== 'notification') continue
    const params = (input.params ?? {}) as {
      sessionId?: unknown; runningPromptId?: unknown; promptId?: unknown; stopReason?: unknown
      update?: { sessionUpdate?: unknown; prompt_id?: unknown; stop_reason?: unknown }; _meta?: { isReplay?: unknown }
    }
    if (params.sessionId !== REPLAY_SESSION_ID || params._meta?.isReplay === true) continue
    const running = params.runningPromptId
    if (input.method === '_x.ai/queue/changed' && typeof running === 'string' && !ended.has(running) && !started.some(turn => turn.turnId === running)) started.push({ turnId: running, at: step.sequence })
    if (input.method === '_x.ai/session/prompt_complete') end(params.promptId, params.stopReason, step.sequence)
    if (params.update?.sessionUpdate === 'turn_completed') end(params.update.prompt_id, params.update.stop_reason, step.sequence)
  }
  const releases = new Map<string, number>()
  let next = 0
  for (const turn of started) {
    const completion = ended.get(turn.turnId)
    if (completion?.stopReason !== 'end_turn') continue
    while (next < answers.length && answers[next]! < turn.at) next++
    const answer = answers[next++]
    releases.set(turn.turnId, answer === undefined ? DEADLINE : Math.max(completion.at, answer))
  }
  return releases
}

describe('SessionSequencer replaying the recorded Grok corpus', () => {
  it('pairs every turn_started with exactly one turn_completed in every recording', () => {
    for (const scenario of replayableScenarios()) {
      const semantic = run(replaySteps(scenario)).flatMap(item => item.kind === 'semantic' ? [item.event] : [])
      const started = semantic.filter(event => event.type === 'turn_started').map(event => event.turnId)
      const completed = semantic.filter(event => event.type === 'turn_completed').map(event => event.turnId)
      expect([...completed].sort(), scenario).toEqual([...started].sort())
    }
  })

  it('releases every normally ended turn at its completion or its final appended answer, whichever is later, never at the deadline (prompt.completion)', () => {
    let turns = 0
    for (const scenario of replayableScenarios()) {
      const steps = replaySteps(scenario)
      const expected = expectedReleases(steps)
      const released = run(steps).flatMap(item => item.kind === 'semantic' && item.event.type === 'turn_completed' && item.event.stopReason === 'end_turn' ? [[item.event.turnId, item.at] as const] : [])
      expect(Object.fromEntries(released), scenario).toEqual(Object.fromEntries(expected))
      expect(released.filter(([, at]) => at === DEADLINE), scenario).toEqual([])
      turns += expected.size
    }
    // Guards the loop itself: the corpus holds dozens of normally ended turns.
    expect(turns).toBeGreaterThan(40)
  })

  it('never reports idle before the turn it names completed, nor inactive while a started turn is open', () => {
    for (const scenario of replayableScenarios()) {
      const open = new Set<string>()
      const done = new Set<string>()
      for (const item of run(replaySteps(scenario))) {
        if (item.kind === 'activity') {
          if (!item.active) expect([...open], `${scenario} inactive at ${item.at}`).toEqual([])
          continue
        }
        if (item.kind !== 'semantic') continue
        const event = item.event
        if (event.type === 'turn_started') open.add(event.turnId)
        if (event.type === 'turn_completed') { open.delete(event.turnId); done.add(event.turnId) }
        if (event.type === 'stream_phase' && event.phase === 'idle' && event.turnId) expect(done.has(event.turnId), `${scenario} idle for ${event.turnId} at ${item.at}`).toBe(true)
      }
    }
  })

  it('holds a completion that arrives before its answer until the answer lands (text-load-repeat 484 → 517)', () => {
    const completed = run(replaySteps('text-load-repeat')).find(item => item.kind === 'semantic' && item.event.type === 'turn_completed' && item.event.turnId === 'prompt-1')
    expect(completed?.at).toBe(517)
  })

  it('completes a cancelled turn at once, without waiting for an answer (prompt.cancel)', () => {
    const completed = run(replaySteps('cancel-queued-prompt')).find(item => item.kind === 'semantic' && item.event.type === 'turn_completed' && item.event.turnId === 'prompt-1')
    expect(completed).toMatchObject({ at: 341, event: { stopReason: 'cancelled' } })
  })

  it('marks how a row arrived, not that it is old: a rewrite snapshot can carry rows never delivered before (history.replacement)', () => {
    const rows = (scenario: string) => replaySteps(scenario).flatMap(step => step.kind === 'durable' ? [{ at: step.sequence, entry: step.entry }] : [])
    // text-load-repeat: generation 0 delivered only the system row, and generation
    // 1's snapshot adds a reminder at 72.
    const text = rows('text-load-repeat')
    expect(text.filter(row => row.entry.generation === 0).map(row => row.entry.item.type)).toEqual(['system'])
    expect(text.find(row => row.at === 72)?.entry).toMatchObject({ generation: 1, inRewriteSnapshot: true, item: { type: 'user' } })
    // command-error: the first genuine user row appears inside generation 2's snapshot (313).
    const command = rows('command-error')
    expect(command.filter(row => row.entry.generation < 2 && isGenuineUserItem(row.entry.item))).toEqual([])
    const first = command.find(row => row.at === 313)
    expect(first?.entry.inRewriteSnapshot).toBe(true)
    expect(first !== undefined && isGenuineUserItem(first.entry.item)).toBe(true)
  })

  it('replays the resumed epoch on its own and completes its prompt normally (process.restart-resume)', () => {
    const firstEpoch = new Set(run(replaySteps('native-restart-resume')).flatMap(item => item.kind === 'semantic' && item.event.type === 'turn_started' ? [item.event.turnId] : []))
    const completed = run(replaySteps('native-restart-resume', { epoch: 2 })).flatMap(item => item.kind === 'semantic' && item.event.type === 'turn_completed' ? [{ ...item.event, at: item.at }] : [])
    expect(completed.map(event => event.stopReason)).toEqual(['end_turn'])
    expect(completed[0]!.at).not.toBe(DEADLINE)
    expect(firstEpoch.has(completed[0]!.turnId)).toBe(false)
  })
})
