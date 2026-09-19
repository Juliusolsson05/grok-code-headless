import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ResponseCapture, replayResponseCapture } from './ResponseCapture.js'
import { GrokResponseObserver, type GrokStreamEvent } from '../proxy/GrokResponseObserver.js'

const wire = readFileSync(new URL('../../testing/fixtures/streaming/papaya.sse', import.meta.url))

describe('package-owned bounded response recording', () => {
  it('replays captured chunks through the same observer without cross-flow mixing', () => {
    const capture = new ResponseCapture()
    const expected: GrokStreamEvent[] = []
    const live = ['main', 'recap'].map(flowId => new GrokResponseObserver({ flowId, onEvent: event => expected.push(event) }))
    for (let offset = 0; offset < wire.length; offset += 31) {
      for (const [index, flowId] of ['main', 'recap'].entries()) {
        const chunk = wire.subarray(offset, offset + 31)
        capture.write(flowId, chunk)
        live[index]!.write(chunk)
      }
    }
    for (const [index, flowId] of ['main', 'recap'].entries()) { capture.end(flowId); live[index]!.end() }
    const replay: GrokStreamEvent[] = []
    const summary = replayResponseCapture(capture.serialize(), event => replay.push(event))
    expect(replay).toEqual(expected)
    expect(summary.complete).toBe(true)
    expect(summary.truncated).toBe(false)
  })

  it('marks an over-budget capture incomplete and stops accumulating data', () => {
    const capture = new ResponseCapture({ maxBytes: 1024, maxRecords: 2 })
    expect(capture.write('one', Buffer.from('data: partial'))).toBe(true)
    expect(capture.write('one', Buffer.alloc(2000))).toBe(false)
    const before = capture.serialize()
    expect(capture.write('one', Buffer.alloc(2000))).toBe(false)
    expect(capture.serialize()).toBe(before)
    expect(Buffer.byteLength(before)).toBeLessThanOrEqual(1024)
    expect(JSON.parse(before)).toMatchObject({ complete: false, truncated: true, reason: 'byte-limit' })
  })

  it('keeps interrupted streams incomplete even when the response contains terminal events', () => {
    const capture = new ResponseCapture()
    capture.write('one', wire)
    capture.end('one', true)
    const events: GrokStreamEvent[] = []
    expect(replayResponseCapture(capture.serialize(), event => events.push(event)).complete).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'diagnostic', code: 'capture-interrupted' })
  })

  it('rejects oversized or malformed imported captures before replay', () => {
    expect(() => replayResponseCapture('x'.repeat(2048), () => {}, { maxBytes: 1024 })).toThrow(/budget/)
    expect(() => replayResponseCapture('{"version":99,"records":[]}', () => {})).toThrow(/capture/)
  })

  it('rejects inconsistent truncation metadata before delivering any replay event', () => {
    const capture = new ResponseCapture()
    capture.write('one', wire); capture.end('one')
    const document = JSON.parse(capture.serialize())
    document.reason = 'byte-limit'
    const events: GrokStreamEvent[] = []
    expect(() => replayResponseCapture(JSON.stringify(document), event => events.push(event))).toThrow(/truncation/)
    expect(events).toEqual([])
  })

  it('rejects a false completion claim and data appended after an end marker', () => {
    const capture = new ResponseCapture()
    capture.write('one', wire); capture.end('one', true)
    const document = JSON.parse(capture.serialize())
    document.complete = true
    expect(() => replayResponseCapture(JSON.stringify(document), () => {})).toThrow(/completion/)
    document.complete = false
    document.records.push(document.records[0])
    expect(() => replayResponseCapture(JSON.stringify(document), () => {})).toThrow(/record/)
  })

  it.each(['__proto__', 'prototype', 'constructor'])('does not propagate object-prototype identifiers from imported captures: %s', flowId => {
    const capture = new ResponseCapture()
    capture.write('one', wire); capture.end('one')
    const document = JSON.parse(capture.serialize())
    for (const record of document.records) record.flowId = flowId
    expect(() => replayResponseCapture(JSON.stringify(document), () => {})).toThrow(/record/)
  })

  it('contains consumer exceptions on interrupted replay just as the live observer does', () => {
    const capture = new ResponseCapture()
    capture.write('one', wire); capture.end('one', true)
    expect(() => replayResponseCapture(capture.serialize(), () => { throw new Error('consumer failed') })).not.toThrow()
  })
})
