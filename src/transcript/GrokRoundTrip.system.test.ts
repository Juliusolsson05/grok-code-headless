// Integration: a real grok TUI turn end-to-end (spawn → prompt → committed
// history), plus the real-session-tree discovery laws.
//
// The PTY piece runs in the plain-node runner subprocess (see the runner's
// header for the node-pty-in-forked-child posix_spawnp quirk). Everything
// else runs in-process against the real ~/.grok tree.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { encodeGrokSessionsDir, getGrokSessionsRoot } from './SessionDirEncoding.js'
import { listGrokSessions, resolveGrokTranscriptPath } from './SessionList.js'

const here = dirname(fileURLToPath(import.meta.url))
const runner = join(here, '..', 'testing', 'ptyRoundTripRunner.mjs')

function grokAvailable(): boolean {
  return existsSync(join(homedir(), '.local', 'bin', 'grok')) ||
    spawnSync('grok', ['--version'], { timeout: 15000 }).status === 0
}

describe('live TUI round-trip (real grok)', () => {
  it(
    'spawns the TUI, answers a prompt, and appends committed history',
    () => {
      if (!grokAvailable() || !existsSync(join(homedir(), '.grok', 'auth.json'))) {
        // Named-capability skip (testing standard): the deterministic net is
        // the fixture suite; this test needs the real CLI + auth.
        return
      }
      const result = spawnSync(process.execPath, [runner], {
        encoding: 'utf8',
        timeout: 150000,
      })
      expect(result.status).toBe(0)
      const verdict = JSON.parse(result.stdout.trim().split('\n').filter(Boolean).pop()!)
      expect(verdict.ok, verdict.error ?? 'runner failed').toBe(true)
      // Structure laws on the LIVE-written file, not just fixtures:
      expect(verdict.kinds[0]).toBe('system')
      expect(verdict.kinds).toContain('user')
      expect(verdict.kinds).toContain('assistant')
      expect(verdict.sawPrompt).toBe(true)
    },
    160000,
  )
})

describe('real ~/.grok session tree', () => {
  it('our encoding reproduces every percent-encoded dirname on disk', () => {
    const root = getGrokSessionsRoot()
    if (!existsSync(root)) return // named skip: no grok sessions directory
    const names = readdirSync(root).filter(n => n.includes('%2F'))
    if (names.length === 0) return // named skip: no encoded session dirs yet
    for (const name of names) {
      expect(encodeGrokSessionsDir(decodeURIComponent(name))).toBe(name)
    }
  })

  it('discovers a real session by cwd and resolves its transcript', () => {
    // Any genuine prior session works; the stage-0 synth session is the
    // machine-local evidence anchor.
    const synthCwd = '/var/folders/tv/yfsy4sfx1qnbs39hbtzgl0xc0000gn/T/opencode/grok-stage0/synth'
    if (!existsSync(join(getGrokSessionsRoot(), encodeGrokSessionsDir(synthCwd)))) {
      return // named skip: stage-0 evidence session absent on this machine
    }
    const sessions = listGrokSessions({ cwd: synthCwd })
    expect(sessions.length).toBeGreaterThanOrEqual(1)
    const transcript = resolveGrokTranscriptPath(synthCwd, sessions[0]!.sessionId)
    expect(existsSync(transcript)).toBe(true)
    expect(readFileSync(transcript, 'utf8')).toContain('PINEAPPLE')
  })
})
