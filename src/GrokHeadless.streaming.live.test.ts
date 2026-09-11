import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { expect, it } from 'vitest'
import { GrokHeadless } from './GrokHeadless.js'
import { encodeGrokSessionsDir, getGrokSessionsRoot } from './transcript/SessionDirEncoding.js'

// Explicit paid-provider gate. Separate from the fixture-backed CLI tests:
// this verifies the actual upstream/auth transport, but not main-vs-recap
// attribution (equal text must never be promoted to that stronger claim).
it('observes a real native reply through an owned relay and durable transcript', async context => {
  if (process.env.GROK_HEADLESS_STREAM_LIVE !== '1') context.skip('Set GROK_HEADLESS_STREAM_LIVE=1 for real streamed inference')
  const upstreamBaseUrl = process.env.GROK_HEADLESS_UPSTREAM
  if (!upstreamBaseUrl) context.skip('Set GROK_HEADLESS_UPSTREAM for the native authentication mode')
  const binary = process.env.GROK_BINARY ?? join(homedir(), '.local', 'bin', 'grok')
  if (!existsSync(binary)) context.skip('Grok CLI unavailable')
  const home = process.env.GROK_HOME || join(homedir(), '.grok')
  const cwd = mkdtempSync(join(tmpdir(), 'grok-stream-live-'))
  const namespace = join(getGrokSessionsRoot(home), encodeGrokSessionsDir(cwd))
  const token = `stream-${randomUUID()}`
  const streams = new Map<string, string>()
  const ended = new Set<string>()
  let runtime: GrokHeadless | undefined
  let painted = false
  let answered = false
  let completed = false
  const errors: string[] = []
  try {
    runtime = await GrokHeadless.create({ cwd, grokHome: home, grokBinary: binary, streaming: { upstreamBaseUrl: upstreamBaseUrl! } })
    runtime.on('screen', () => { painted = true })
    runtime.on('error', error => errors.push(error.message))
    runtime.on('grok-entry', event => { if (event.item.type === 'assistant' && event.item.content.trim() === token) answered = true })
    runtime.on('grok-update', event => { if (event.params.update.sessionUpdate === 'turn_completed') completed = true })
    runtime.on('stream-event', event => {
      if (event.type === 'text-delta') streams.set(event.flowId, (streams.get(event.flowId) ?? '') + event.delta)
      if (event.type === 'completed') ended.add(event.flowId)
      if (event.type === 'diagnostic') errors.push(event.code)
    })
    const ready = performance.now() + 15000
    while (!painted && performance.now() < ready) await new Promise(resolve => setTimeout(resolve, 50))
    expect(painted).toBe(true)
    runtime.sendPrompt(`Do not use tools. Reply with exactly ${token}`)
    const deadline = performance.now() + 90000
    const streamed = () => [...streams].some(([flowId, text]) => text.trim() === token && ended.has(flowId))
    while (!(answered && completed && streamed()) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
    expect(errors).toEqual([])
    expect(answered, 'durable assistant reply matches').toBe(true)
    expect(completed, 'native turn completed').toBe(true)
    expect(streamed(), 'one bounded request flow streamed the matching response and completed').toBe(true)
  } finally {
    await runtime?.dispose()
    rmSync(namespace, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
}, 120000)
