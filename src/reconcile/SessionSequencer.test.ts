import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SemanticEvent } from '../channels/types.js'
import type { LiveOutput } from '../live/types.js'
import type { GrokDurableEntry } from '../transcript/durable.js'
import { SessionSequencer } from './SessionSequencer.js'

// Synthetic, labelled as such: these cover sequencing paths no Stage 1 recording
// exercises (a normally ended turn whose answer never lands or lands after the
// deadline, a rewrite re-delivering an old answer while a turn waits, a second
// final row, a throwing sink, a terminal exit mid-turn). The recorded order is
// proven in SessionSequencer.recorded.system.test.ts; nothing here stands in for it.

afterEach(() => { vi.useRealTimers() })

function rig(options: { onSinkError?: (error: unknown) => void } = {}) {
  vi.useFakeTimers()
  const log: string[] = []
  const sequencer = new SessionSequencer({
    heartbeatMs: 0,
    settleDeadlineMs: 2_000,
    onSinkError: options.onSinkError,
    sink: {
      entry: entry => log.push(`entry ${entry.item.type}`),
      history: () => {},
      semantic: (event: SemanticEvent) => log.push(event.type === 'turn_completed' ? `completed ${event.turnId} ${event.stopReason} ${event.fullText}` : event.type === 'stream_phase' ? `phase ${event.phase}` : `${event.type} ${'turnId' in event ? event.turnId : ''}`),
      activity: state => log.push(`activity ${state.active}`),
      requests: () => {},
      mode: () => {},
    },
  })
  return { log, sequencer, completed: () => log.filter(line => line.startsWith('completed')) }
}

const answer = (content: string, inRewriteSnapshot = false): GrokDurableEntry => ({ sessionId: 's', item: { type: 'assistant', content }, raw: '{}', generation: 1, lineStartOffset: 0, inRewriteSnapshot })
const turn = (turnId: string, text: string): LiveOutput[] => [
  { kind: 'activity', active: true, status: 'working' },
  { kind: 'turn-start', turnId, foreign: false },
  { kind: 'text', turnId, text },
]
const end = (turnId: string, stopReason = 'end_turn'): LiveOutput[] => [
  { kind: 'turn-end', turnId, stopReason, foreign: false },
  { kind: 'phase', phase: 'idle', turnId },
  { kind: 'activity', active: false, status: null },
]

describe('SessionSequencer synthetic paths', () => {
  it('ends a normally ended turn at the deadline with its live text when no answer lands, keeping later outputs behind it', () => {
    const { log, sequencer } = rig()
    sequencer.onLiveOutputs([...turn('p1', 'partial reply'), ...end('p1')])
    expect(log).toEqual(['activity true', 'turn_started p1'])
    vi.advanceTimersByTime(1_999)
    expect(log).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(log.slice(2)).toEqual(['completed p1 end_turn partial reply', 'phase idle', 'activity false'])
  })

  it('prefers the committed answer over live text, and never takes a row re-delivered inside a rewrite snapshot', () => {
    const { sequencer, completed } = rig()
    sequencer.onLiveOutputs([...turn('p1', 'live'), ...end('p1')])
    sequencer.onDurableEntries([answer('old answer', true)])
    expect(completed()).toEqual([])
    sequencer.onDurableEntries([answer('committed answer')])
    expect(completed()).toEqual(['completed p1 end_turn committed answer'])
  })

  it('gives an answer that lands after the deadline to the turn that expired waiting for it, not to the next turn', () => {
    const { sequencer, completed } = rig()
    // Native starts p2 before announcing p1's completion (the concurrent-prompts order).
    sequencer.onLiveOutputs([...turn('p1', 'live one'), { kind: 'turn-start', turnId: 'p2', foreign: false }, { kind: 'text', turnId: 'p2', text: 'live two' }, ...end('p1')])
    vi.advanceTimersByTime(2_000)
    expect(completed()).toEqual(['completed p1 end_turn live one'])
    sequencer.onDurableEntries([answer('answer one')])
    sequencer.onLiveOutputs(end('p2'))
    // p2 must wait for its own answer rather than complete with p1's.
    expect(completed()).toEqual(['completed p1 end_turn live one'])
    sequencer.onDurableEntries([answer('answer two')])
    expect(completed()).toEqual(['completed p1 end_turn live one', 'completed p2 end_turn answer two'])
  })

  it('attributes a second final row to no turn, since no recorded turn writes one', () => {
    const { sequencer, completed } = rig()
    sequencer.onLiveOutputs(turn('p1', 'live'))
    sequencer.onDurableEntries([answer('first'), answer('second')])
    sequencer.onLiveOutputs(end('p1'))
    expect(completed()).toEqual(['completed p1 end_turn first'])
  })

  it('lets a throwing sink fail only its own delivery; the turn still closes for everyone else', () => {
    const errors: unknown[] = []
    const { log, sequencer } = rig({ onSinkError: error => errors.push(error) })
    let first = true
    const original = sequencer['options'].sink.semantic
    sequencer['options'].sink.semantic = event => { if (first) { first = false; throw new Error('listener bug') } original(event) }
    sequencer.onLiveOutputs([...turn('p1', 'x'), ...end('p1', 'cancelled')])
    expect(errors).toHaveLength(1)
    expect(log).toContain('completed p1 cancelled x')
    expect(log[log.length - 1]).toBe('activity false')
  })

  it('closes every open turn uncertain when the terminal exits, including a waiting one, and goes quiet', () => {
    const { log, sequencer, completed } = rig()
    // What the projector emits when a queued p2 starts as p1 ends: p2's start
    // re-activates the session behind p1's completion.
    sequencer.onLiveOutputs([...turn('p1', 'a'), ...end('p1'), ...turn('p2', '')])
    sequencer.onExit()
    expect(completed()).toEqual(['completed p1 end_turn a', 'completed p2 uncertain '])
    expect(log[log.length - 1]).toBe('activity false')
    sequencer.onLiveOutputs(turn('p3', 'late'))
    expect(log.some(line => line.includes('p3'))).toBe(false)
  })
})
