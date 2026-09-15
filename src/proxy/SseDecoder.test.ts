import { describe, expect, it } from 'vitest'
import { SseDecoder } from './SseDecoder.js'

describe('SSE framing boundary faults', () => {
  it.each(['\n', '\r\n', '\r'])('decodes split UTF-8 and multiline data with %j delimiters', newline => {
    const frames: unknown[] = []
    const errors: string[] = []
    const decoder = new SseDecoder(frame => frames.push(frame), code => errors.push(code))
    const wire = Buffer.from([': ignored', 'event: message', 'data: {"text":', 'data: "\u00e9"}', '', ''].join(newline))
    for (const byte of wire) decoder.write(Uint8Array.of(byte))
    decoder.end()
    expect(frames).toEqual([{ event: 'message', data: '{"text":\n"\u00e9"}' }])
    expect(errors).toEqual([])
  })

  it('does not publish an uncommitted final frame', () => {
    const frames: unknown[] = []
    const errors: string[] = []
    const decoder = new SseDecoder(frame => frames.push(frame), code => errors.push(code))
    decoder.write(Buffer.from('data: {"type":"response.completed"}\n'))
    decoder.end()
    expect(frames).toEqual([])
    expect(errors).toEqual(['unterminated-frame'])
  })

  it('does not accumulate comment-only heartbeat lines without blank separators', () => {
    const frames: unknown[] = []
    const errors: string[] = []
    const decoder = new SseDecoder(frame => frames.push(frame), code => errors.push(code), 64)
    for (let index = 0; index < 100; index++) decoder.write(Buffer.from(': heartbeat\n'))
    decoder.write(Buffer.from('data: ok\n\n'))
    decoder.end()
    expect(frames).toEqual([{ event: 'message', data: 'ok' }])
    expect(errors).toEqual([])
  })
})
