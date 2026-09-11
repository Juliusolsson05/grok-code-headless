import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  })

  it('refuses transcript identity traversal before constructing a path', () => {
    expect(() => resolveGrokTranscriptPath(root, '../../outside', home)).toThrow(/UUID/)
  })
})
