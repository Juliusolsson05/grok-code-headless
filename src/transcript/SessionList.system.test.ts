import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeGrokSessionsDir, getGrokSessionsRoot } from './SessionDirEncoding.js'
import { listAllGrokSessions, listGrokSessions, resolveGrokTranscriptPath } from './SessionList.js'

let root: string
let home: string
const first = '11111111-1111-4111-8111-111111111111'
const second = '22222222-2222-4222-8222-222222222222'
const recordedSummary = JSON.parse(readFileSync(new URL('../../testing/fixtures/summary.probe.json', import.meta.url), 'utf8'))

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'grok-list-')); home = join(root, 'home') })
afterEach(() => rmSync(root, { recursive: true, force: true }))

function session(id: string, date: string, storedId = id) {
  const path = join(getGrokSessionsRoot(home), encodeGrokSessionsDir(root), id)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'summary.json'), JSON.stringify({
    ...recordedSummary, info: { id: storedId, cwd: root }, updated_at: date,
  }))
  return path
}

describe('session discovery with the recorded summary schema', () => {
  it('sorts newest first and applies a zero or positive bound', () => {
    session(first, '2026-09-07T12:00:00Z')
    session(second, '2026-09-07T13:00:00Z')
    expect(listGrokSessions({ cwd: root, grokHome: home, limit: 1 }).map(row => row.sessionId)).toEqual([second])
    expect(listGrokSessions({ cwd: root, grokHome: home, limit: 0 })).toEqual([])
    expect(listAllGrokSessions({ grokHome: home, limit: 0 })).toEqual([])
  })

  it('does not return metadata naming a different session than the containing directory', () => {
    session(first, '2026-09-07T12:00:00Z', second)
    expect(listGrokSessions({ cwd: root, grokHome: home })).toEqual([])
    expect(listAllGrokSessions({ grokHome: home })).toEqual([])
  })

  it('keeps other sessions discoverable when one summary is torn', () => {
    const path = session(first, '2026-09-07T12:00:00Z')
    writeFileSync(join(path, 'summary.json'), '{')
    session(second, '2026-09-07T13:00:00Z')
    expect(listGrokSessions({ cwd: root, grokHome: home }).map(row => row.sessionId)).toEqual([second])
    // The global list is the one the app's catalog calls (review B).
    expect(listAllGrokSessions({ grokHome: home }).map(row => row.sessionId)).toEqual([second])
  })

  it('falls back field by field when only the preferred one is mistyped, and passes valid ones through', () => {
    const path = session(first, '2026-09-07T12:00:00Z')
    writeFileSync(join(path, 'summary.json'), JSON.stringify({
      ...recordedSummary, info: { id: first, cwd: root },
      session_summary: 7, generated_title: 'Generated title',
      updated_at: 7, last_active_at: '2026-09-07T14:00:00Z',
      created_at: '2026-09-07T11:00:00Z', current_model_id: 'grok-4.6',
    }))
    session(second, '2026-09-07T13:00:00Z')
    const rows = listAllGrokSessions({ grokHome: home })
    expect(rows.map(row => row.sessionId)).toEqual([first, second])
    expect(rows[0]).toMatchObject({ title: 'Generated title', updatedAt: '2026-09-07T14:00:00Z', createdAt: '2026-09-07T11:00:00Z', modelId: 'grok-4.6' })
  })

  it('skips a summary.json that is not a regular file instead of blocking on it', () => {
    const path = session(first, '2026-09-07T12:00:00Z')
    const fifo = join(path, 'summary.json')
    rmSync(fifo)
    execFileSync('mkfifo', [fifo])
    session(second, '2026-09-07T13:00:00Z')
    // A regression must FAIL, not hang the worker: a synchronous read of a
    // FIFO blocks until a writer appears, so one appears, feeding a valid
    // summary that a correct implementation never reads.
    // The content travels as an argument, not over stdin: a blocked read
    // stalls this event loop, so stdin data would never be flushed.
    const writer = spawn('sh', ['-c', 'sleep 0.5; printf "%s" "$1" > "$0"', fifo,
      JSON.stringify({ ...recordedSummary, info: { id: first, cwd: root }, updated_at: '2026-09-07T12:00:00Z' })], { stdio: 'ignore' })
    try {
      expect(listAllGrokSessions({ grokHome: home }).map(row => row.sessionId)).toEqual([second])
      expect(listGrokSessions({ cwd: root, grokHome: home }).map(row => row.sessionId)).toEqual([second])
    } finally {
      writer.kill('SIGKILL')
    }
  }, 5_000)

  // agent-code#1249: summary.json is written by grok, and a build that types a
  // field differently (a number timestamp, an object summary) used to reach
  // the sort's localeCompare or the app's title.trim() and throw, emptying
  // the WHOLE catalog. A mistyped optional field is dropped for that row only.
  it('keeps every session listed when one summary has mistyped optional fields', () => {
    const path = session(first, '2026-09-07T12:00:00Z')
    writeFileSync(join(path, 'summary.json'), JSON.stringify({
      ...recordedSummary, info: { id: first, cwd: root },
      updated_at: 1789000000, last_active_at: { at: 'x' }, created_at: 7,
      session_summary: { text: 'x' }, generated_title: ['x'], current_model_id: 42,
    }))
    session(second, '2026-09-07T13:00:00Z')
    for (const rows of [listGrokSessions({ cwd: root, grokHome: home }), listAllGrokSessions({ grokHome: home })]) {
      expect(rows.map(row => row.sessionId)).toEqual([second, first])
      const mistyped = rows.find(row => row.sessionId === first)!
      expect(mistyped).toEqual({ sessionId: first, cwd: root, title: first, createdAt: undefined, updatedAt: undefined, modelId: undefined })
    }
  })

  it('refuses transcript identity traversal before constructing a path', () => {
    expect(() => resolveGrokTranscriptPath(root, '../../outside', home)).toThrow(/UUID/)
  })
})
