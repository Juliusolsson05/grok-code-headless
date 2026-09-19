import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { GrokResponseObserver, type GrokStreamEvent } from './GrokResponseObserver.js'

const recorded = readFileSync(new URL('../../testing/fixtures/streaming/papaya.sse', import.meta.url))
function observe(bytes: Buffer, chunkSize: number) {
  const events: GrokStreamEvent[] = []
  const observer = new GrokResponseObserver({ flowId: 'recorded-main', onEvent: event => events.push(event) })
  for (let offset = 0; offset < bytes.length; offset += chunkSize) observer.write(bytes.subarray(offset, offset + chunkSize))
  observer.end()
  return events
}

describe('recorded Grok Responses SSE', () => {
  it.each([1, 7, 31, 65536])('preserves actual deltas and terminal state with %i-byte reads', size => {
    const events = observe(recorded, size)
    expect(events.filter(event => event.type === 'text-delta').map(event => event.delta)).toEqual(['PAP', 'AYA'])
    expect(events.filter(event => event.type === 'reasoning-delta').map(event => event.delta)).toEqual(['The', ' user'])
    expect(events.filter(event => event.type === 'completed')).toHaveLength(1)
    expect(events.filter(event => event.type === 'diagnostic')).toEqual([])
    expect(events.every(event => event.flowId === 'recorded-main')).toBe(true)
  })

  it('does not merge identical text from independent main and side requests', () => {
    const events: GrokStreamEvent[] = []
    const first = new GrokResponseObserver({ flowId: 'main', onEvent: event => events.push(event) })
    const second = new GrokResponseObserver({ flowId: 'recap', onEvent: event => events.push(event) })
    for (let offset = 0; offset < recorded.length; offset += 31) {
      first.write(recorded.subarray(offset, offset + 31))
      second.write(recorded.subarray(offset, offset + 31))
    }
    first.end(); second.end()
    expect(events.filter(event => event.type === 'completed').map(event => event.flowId)).toEqual(['main', 'recap'])
  })

  it('recognizes the recorded title tool without inventing an assistant text delta', () => {
    const title = readFileSync(new URL('../../testing/fixtures/sse.responses.txt', import.meta.url))
    const events = observe(title, 31)
    expect(events.filter(event => event.type === 'tool-started').map(event => event.name)).toContain('session_title')
    expect(events.filter(event => event.type === 'text-delta')).toEqual([])
  })

  it('reports unfinished streams instead of fabricating completion', () => {
    const prefix = recorded.subarray(0, recorded.indexOf('event: response.completed'))
    const events = observe(prefix, 17)
    expect(events.some(event => event.type === 'completed')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'diagnostic', code: 'incomplete-stream' })
  })

  it('bounds a frame that never terminates and stops observation explicitly', () => {
    const events: GrokStreamEvent[] = []
    const observer = new GrokResponseObserver({ flowId: 'overflow', maxFrameBytes: 64, onEvent: event => events.push(event) })
    observer.write(Buffer.from('data: ' + 'x'.repeat(1000)))
    observer.end()
    expect(events).toEqual([{ type: 'diagnostic', flowId: 'overflow', code: 'frame-too-large' }])
  })

  it('ignores an empty SSE heartbeat instead of permanently disabling observation', () => {
    const events = observe(Buffer.concat([Buffer.from('data\n\n'), recorded]), 7)
    expect(events.filter(event => event.type === 'text-delta').map(event => event.delta)).toEqual(['PAP', 'AYA'])
    expect(events.filter(event => event.type === 'diagnostic')).toEqual([])
  })
})
