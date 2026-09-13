import { describe, expect, it } from 'vitest'

import { FrameSplitter, MAX_LEADER_FRAME_BYTES } from './frames.js'

const frame = (value: unknown) => {
  const body = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4); header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

// Recorded transport arrives in whatever chunks the socket delivered, and the
// verifier certifies ordering from where each frame completes. A splitter that
// only works when chunks align with frames would pass hand-built tests and
// misread real captures.
describe('leader frame splitter', () => {
  const expected = [{ type: 'acp', payload: '{"jsonrpc":"2.0","id":3}' }, { type: 'ping' }]
  const wire = Buffer.concat(expected.map(frame))

  it('reassembles consecutive frames split at every byte boundary', () => {
    for (let cut = 0; cut <= wire.length; cut++) {
      const splitter = new FrameSplitter()
      expect([...splitter.push(wire.subarray(0, cut)), ...splitter.push(wire.subarray(cut))]).toEqual(expected)
      expect(splitter.pendingBytes).toBe(0)
    }
  })

  it('reassembles frames delivered one byte at a time and reports a truncated tail as pending', () => {
    const splitter = new FrameSplitter()
    const envelopes: unknown[] = []
    for (const byte of wire.subarray(0, wire.length - 1)) envelopes.push(...splitter.push(Uint8Array.of(byte)))
    expect(envelopes).toEqual(expected.slice(0, 1))
    expect(splitter.pendingBytes).toBe(frame(expected[1]).length - 1)
  })

  it('refuses an oversized header before buffering its body', () => {
    const header = Buffer.alloc(4); header.writeUInt32BE(MAX_LEADER_FRAME_BYTES + 1)
    expect(() => new FrameSplitter().push(header)).toThrow(/size limit/)
  })

  it('reports an undecodable body without quoting its content, which may be a private prompt', () => {
    const body = Buffer.from('{"prompt":"private prompt text"')
    const header = Buffer.alloc(4); header.writeUInt32BE(body.length)
    const error = (() => { try { new FrameSplitter().push(Buffer.concat([header, body])) } catch (caught) { return caught as Error } })()
    expect(error?.message).toMatch(/not JSON/)
    expect(error?.message).not.toContain('private')
  })

  it('does not depend on the caller leaving a pushed chunk unchanged', () => {
    const splitter = new FrameSplitter()
    const reused = Buffer.from(wire)
    const cut = frame(expected[0]).length + 2
    expect(splitter.push(reused.subarray(0, cut))).toEqual(expected.slice(0, 1))
    const tail = Buffer.from(reused.subarray(cut))
    reused.fill(0)
    expect(splitter.push(tail)).toEqual(expected.slice(1))
  })
})
