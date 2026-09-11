import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { expect, it } from 'vitest'
import { GrokHeadless } from './GrokHeadless.js'
import type { GrokStreamEvent } from './proxy/GrokResponseObserver.js'

// Installed native TUI, but local replay servers rather than paid inference.
// Every writable path and credential belongs to this fixture test. The fake
// model catalog shape is pinned by upstream remote/model_source/oai.rs.
it('routes native inference through the relay and rejects a prior catalog origin on restart', async context => {
  if (process.env.GROK_HEADLESS_RELAY_LIVE !== '1') context.skip('Set GROK_HEADLESS_RELAY_LIVE=1 for the native fixture-backed relay gate')
  const binary = process.env.GROK_BINARY ?? join(homedir(), '.local', 'bin', 'grok')
  if (!existsSync(binary)) context.skip('Installed Grok CLI unavailable')
  const root = mkdtempSync(join(tmpdir(), 'grok-native-relay-'))
  const home = join(root, '.grok')
  mkdirSync(home)
  writeFileSync(join(home, 'config.toml'), '[cli]\nauto_update = false\n[ui]\npermission_mode = "ask"\n')
  const wire = readFileSync(new URL('../testing/fixtures/streaming/native-papaya.sse', import.meta.url))
  const title = readFileSync(new URL('../testing/fixtures/sse.responses.txt', import.meta.url))
  const servers: Server[] = []
  const sessions: GrokHeadless[] = []
  const catalogOrigins: string[] = []
  try {
    for (const attempt of [1, 2]) {
      let catalogHits = 0
      let responses = 0
      const requestKinds: unknown[] = []
      const server = createServer(async (req, res) => {
        if (req.url?.startsWith('/v1/models')) {
          catalogHits++
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ data: [{ id: 'grok-4.6', model: 'grok-4.6', name: 'Fixture Grok', api_backend: 'responses', context_window: 500000 }] }))
          return
        }
        if (req.url === '/v1/responses') {
          const chunks: Buffer[] = []
          let bytes = 0
          for await (const chunk of req) {
            bytes += chunk.length
            if (bytes > 2 * 1024 * 1024) { res.writeHead(413); res.end(); return }
            chunks.push(chunk)
          }
          const request = JSON.parse(Buffer.concat(chunks).toString())
          const sidecar = request.tools?.some((tool: { name?: string }) => tool.name === 'session_title')
          requestKinds.push({ tools: request.tools?.length, choice: request.tool_choice, sidecar })
          responses++
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end(sidecar ? title : wire)
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}')
      })
      servers.push(server)
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('No local address')
      const upstream = `http://127.0.0.1:${address.port}/v1`
      const events: GrokStreamEvent[] = []
      let painted = false
      let lastScreen = ''
      let answer = false
      let completed = false
      let stopReason: unknown
      const errors: string[] = []
      const userEchoes: unknown[] = []
      const userUpdates: unknown[] = []
      const runtime = await GrokHeadless.create({
        cwd: root, grokHome: home, grokBinary: binary,
        streaming: { upstreamBaseUrl: upstream },
        extraArgs: ['--model', 'grok-4.6', '--fullscreen', '--no-leader'],
        env: {
          HOME: root, XDG_CONFIG_HOME: join(root, '.config'), XAI_API_KEY: 'fixture-only-not-a-real-key',
          GROK_CLI_CHAT_PROXY_BASE_URL: upstream,
          // Supported native per-process policy: automation owns the composer;
          // do not reinterpret model-generated ghost suggestions as user text.
          GROK_PROMPT_SUGGESTIONS: '0',
          OTEL_TRACES_EXPORTER: 'none', OTEL_METRICS_EXPORTER: 'none',
        },
      })
      sessions.push(runtime)
      expect(catalogOrigins).not.toContain(runtime.streamingInfo!.modelsListUrl)
      catalogOrigins.push(runtime.streamingInfo!.modelsListUrl)
      runtime.on('stream-event', event => events.push(event))
      runtime.on('screen', event => { painted = true; lastScreen = event.snapshot.plain })
      runtime.on('grok-entry', ({ item }) => { if (item.type === 'assistant' && item.content.trim() === 'PAPAYA') answer = true })
      runtime.on('grok-entry', ({ item, replay }) => {
        if (item.type !== 'user') return
        const prompt = 'Do not use tools. Say PAPAYA.'
        const wrapped = `<user_query>\n${prompt}\n</user_query>`
        userEchoes.push({ replay, reason: item.synthetic_reason ?? null, parts: item.content.filter(part => part.type === 'text').map(part => ({
          chars: part.text.length, plainMatch: part.text === prompt, wrappedMatch: part.text === wrapped,
          trimmedWrappedMatch: part.text.trim() === wrapped, containsPrompt: part.text.includes(prompt),
        })) })
      })
      runtime.on('grok-update', event => { if (event.params.update.sessionUpdate === 'turn_completed') { completed = true; stopReason = event.params.update.stop_reason } })
      runtime.on('grok-update', event => {
        if (event.params.update.sessionUpdate !== 'user_message_chunk') return
        const content = event.params.update.content as { type?: string; text?: string } | undefined
        userUpdates.push({ replay: event.replay, generation: event.generation, type: content?.type, plainMatch: content?.text === 'Do not use tools. Say PAPAYA.' })
      })
      runtime.on('error', error => errors.push(error.message))
      const readyDeadline = performance.now() + 15000
      while (runtime.promptGateState.kind !== 'ready' && performance.now() < readyDeadline) await new Promise(resolve => setTimeout(resolve, 50))
      expect(painted, `native TUI painted on attempt ${attempt}`).toBe(true)
      expect(runtime.promptGateState, `native composer before automated input: ${lastScreen.split('\n').slice(-8).join('\n')}`).toEqual({ kind: 'ready' })
      expect(runtime.trySendPrompt('Do not use tools. Say PAPAYA.')).toBe(true)
      const deadline = performance.now() + 45000
      while (!(answer && completed) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
      expect(errors).toEqual([])
      expect(catalogHits, `attempt ${attempt} fetched its own catalog`).toBeGreaterThan(0)
      expect(responses, 'fixture server handled inference').toBeGreaterThan(0)
      expect({ answer, completed }, `native completion: ${JSON.stringify({ stopReason, requestKinds })}; test-only screen: ${lastScreen.slice(0, 2500)}`).toEqual({ answer: true, completed: true })
      expect(events.filter(event => event.type === 'text-delta').map(event => event.delta).join('')).toContain('PAPAYA')
      expect(runtime.promptGateState, `native user-echo shapes: ${JSON.stringify({ userEchoes, userUpdates })}`).not.toMatchObject({ reason: 'awaiting-input-ack' })
      const cache = JSON.parse(readFileSync(join(home, 'models_cache.json'), 'utf8'))
      expect(cache.origin).toBe(runtime.streamingInfo!.modelsListUrl)
      runtime.resize(80, 24)
      const resizeDeadline = performance.now() + 5000
      while (runtime.promptGateState.kind !== 'ready' && performance.now() < resizeDeadline) await new Promise(resolve => setTimeout(resolve, 50))
      expect(runtime.promptGateState, `native resized composer: ${lastScreen.split('\n').slice(-8).join('\n')}`).toEqual({ kind: 'ready' })
      await runtime.dispose()
    }
  } finally {
    for (const session of sessions) await session.dispose()
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
    rmSync(root, { recursive: true, force: true })
  }
}, 130000)
