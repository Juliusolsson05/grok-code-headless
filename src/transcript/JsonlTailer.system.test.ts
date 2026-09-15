import { appendFile, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileTailer, type FileTailerSnapshotEvent } from './JsonlTailer.js'

let root: string
let tailer: FileTailer<unknown> | undefined
const recorded = await readFile(new URL('../../testing/fixtures/recorded/session-014.jsonl', import.meta.url), 'utf8')
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'grok-history-boundary-')) })
afterEach(async () => { await tailer?.close(); tailer = undefined; await rm(root, { recursive: true, force: true }) })

describe('physical transcript snapshot boundaries', () => {
  it('orders reset, recorded rows and caught-up across atomic replacement, including an empty replacement', async () => {
    const path = join(root, 'history.jsonl')
    await writeFile(path, recorded)
    const events: Array<FileTailerSnapshotEvent | { type: 'entry'; generation: number }> = []
    tailer = new FileTailer(path, (_, metadata) => events.push({ type: 'entry', generation: metadata.generation }), undefined,
      { onSnapshot: event => events.push(event) })
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ type: 'caught-up', generation: 0, complete: true }))
    expect(events[0]).toEqual({ type: 'reset', generation: 0, snapshotByteLength: Buffer.byteLength(recorded) })
    expect(events.filter(event => event.type === 'entry')).toHaveLength(12)
    await writeFile(join(root, 'next'), '')
    await rename(join(root, 'next'), path)
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: 'caught-up', generation: 1, byteOffset: 0, snapshotByteLength: 0, complete: true }))
    expect(events.at(-2)).toEqual({ type: 'reset', generation: 1, snapshotByteLength: 0 })
    const before = events.length
    await appendFile(path, recorded)
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ type: 'caught-up', generation: 1, complete: true }))
    await tailer.drain()
    expect(events.slice(before).filter(event => event.type === 'entry')).toHaveLength(12)
    expect(events.filter(event => event.type === 'reset')).toHaveLength(2)
  })

  it('does not claim a complete snapshot while a UTF-8 line is partial', async () => {
    const path = join(root, 'history.jsonl')
    // Fault injection into a recorded shape, not additional native evidence.
    const line = Buffer.from('{"type":"assistant","content":"\u00e9"}\n')
    const split = line.indexOf(Buffer.from('\u00e9')) + 1
    await writeFile(path, line.subarray(0, split))
    const boundaries: FileTailerSnapshotEvent[] = []
    const rows: unknown[] = []
    tailer = new FileTailer(path, row => rows.push(row), undefined, { onSnapshot: event => boundaries.push(event) })
    await vi.waitFor(() => expect(boundaries.at(-1)).toMatchObject({ type: 'caught-up', complete: false, byteOffset: 0 }))
    expect(rows).toEqual([])
    await appendFile(path, line.subarray(split))
    await tailer.drain()
    expect(rows).toEqual([{ type: 'assistant', content: '\u00e9' }])
    expect(boundaries.at(-1)).toEqual({ type: 'caught-up', generation: 0, byteOffset: line.length, snapshotByteLength: line.length, complete: true })
  })

  it('marks corruption incomplete, continues valid rows, and recovers only after replacement', async () => {
    const path = join(root, 'history.jsonl')
    await writeFile(path, 'not JSON\n' + recorded)
    const boundaries: FileTailerSnapshotEvent[] = []
    const errors: Error[] = []
    tailer = new FileTailer(path, () => {}, error => errors.push(error), { onSnapshot: event => boundaries.push(event) })
    await vi.waitFor(() => expect(boundaries.at(-1)).toMatchObject({ type: 'caught-up', complete: false }))
    expect(errors).toHaveLength(1)
    await writeFile(join(root, 'next'), recorded)
    await rename(join(root, 'next'), path)
    await tailer.drain()
    expect(boundaries.at(-1)).toMatchObject({ type: 'caught-up', generation: 1, complete: true })
  })

  it('publishes one initial boundary for an empty file and no callbacks after close', async () => {
    const path = join(root, 'history.jsonl')
    await writeFile(path, '')
    const boundaries: FileTailerSnapshotEvent[] = []
    tailer = new FileTailer(path, () => {}, undefined, { onSnapshot: event => boundaries.push(event) })
    await tailer.drain()
    expect(boundaries).toEqual([
      { type: 'reset', generation: 0, snapshotByteLength: 0 },
      { type: 'caught-up', generation: 0, byteOffset: 0, snapshotByteLength: 0, complete: true },
    ])
    await tailer.close()
    await writeFile(path, recorded)
    await tailer.drain()
    expect(boundaries).toHaveLength(2)
  })

  it('does not certify a snapshot when the opened inode is truncated before its read completes', async () => {
    const path = join(root, 'history.jsonl')
    await writeFile(path, recorded)
    const boundaries: FileTailerSnapshotEvent[] = []
    const errors: Error[] = []
    tailer = new FileTailer(path, () => {}, error => errors.push(error), { onSnapshot: event => boundaries.push(event) })
    // The constructor has opened/stat'ed the descriptor but its stream read
    // has not run yet. This is deterministic short-read fault injection.
    truncateSync(path, 0)
    await tailer.drain()
    expect(boundaries.find(event => event.type === 'caught-up' && event.generation === 0)).toMatchObject({ complete: false, byteOffset: 0 })
    expect(errors.some(error => error.message === 'Transcript changed during snapshot read')).toBe(true)
    expect(boundaries.at(-1)).toMatchObject({ type: 'caught-up', generation: 1, byteOffset: 0, complete: true })
  })

  it('contains snapshot consumer errors without stranding the reader', async () => {
    const path = join(root, 'history.jsonl')
    await writeFile(path, recorded)
    const rows: unknown[] = []
    const errors: Error[] = []
    tailer = new FileTailer(path, row => rows.push(row), error => errors.push(error), {
      onSnapshot: () => { throw new Error('controlled snapshot subscriber failed') },
    })
    await tailer.drain()
    expect(rows).toHaveLength(12)
    expect(errors).toHaveLength(2)
  })
})
