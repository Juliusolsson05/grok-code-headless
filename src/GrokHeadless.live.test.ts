// These tests use a paid provider and may consult the user's native config.
// They belong exclusively to test:live with an explicit opt-in, never npm test.
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { GrokHeadless } from './GrokHeadless.js'
import { encodeGrokSessionsDir, getGrokSessionsRoot } from './transcript/SessionDirEncoding.js'

describe('native Grok TUI round trip', () => {
  it('observes the requested assistant answer, native completion and acknowledged shutdown', async context => {
    if (process.env.GROK_HEADLESS_LIVE !== '1') context.skip('Set GROK_HEADLESS_LIVE=1 to use the installed provider')
    const binary = process.env.GROK_BINARY ?? join(homedir(), '.local', 'bin', 'grok')
    if (!existsSync(binary)) context.skip('Grok CLI binary is not installed')
    const home = process.env.GROK_HOME || join(homedir(), '.grok')
    if (!existsSync(join(home, 'auth.json')) && !process.env.XAI_API_KEY) context.skip('Grok native authentication is unavailable')
    const cwd = mkdtempSync(join(tmpdir(), 'grok-live-'))
    const directory = join(getGrokSessionsRoot(home), encodeGrokSessionsDir(cwd))
    let runtime: GrokHeadless | undefined
    let stopped = false
    const token = `reply-${randomUUID()}`
    let answered = false
    let completed = false
    let painted = false
    const errors: Error[] = []
    try {
      runtime = new GrokHeadless({ cwd, grokBinary: binary, grokHome: home })
      runtime.on('screen', () => { painted = true })
      runtime.on('error', error => errors.push(error))
      runtime.on('grok-entry', ({ item }) => {
        if (item.type === 'assistant' && item.content.trim() === token) answered = true
      })
      runtime.on('grok-update', event => {
        if (event.params.update.sessionUpdate === 'turn_completed') completed = true
      })
      const startDeadline = performance.now() + 15000
      while (!painted && performance.now() < startDeadline) await new Promise(resolve => setTimeout(resolve, 50))
      expect(painted, 'the PTY must paint before a prompt is delivered').toBe(true)
      runtime.sendPrompt(`Do not use tools. Reply with exactly ${token}`)
      const deadline = performance.now() + 90000
      while (!(answered && completed) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
      expect(errors).toEqual([])
      expect(answered, 'a committed assistant reply, not the prompt echo, must match').toBe(true)
      expect(completed, 'the actual params.update envelope must report completion').toBe(true)
    } finally {
      if (runtime) { await runtime.dispose(); stopped = true }
      // Remove only this invocation's random cwd/session namespace, and only
      // after process shutdown. Never sweep historical sessions or auth/cache.
      if (stopped || !runtime) {
        rmSync(directory, { recursive: true, force: true })
        rmSync(cwd, { recursive: true, force: true })
      }
    }
  }, 120000)
})
