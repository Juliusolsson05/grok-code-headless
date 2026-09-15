import { join, resolve } from 'node:path'
import type { Scenario } from './NativeHarness.js'
import { generatedPng, countInputImages } from './generatedImage.js'
import { modelSequence, innerParams } from './modelSequence.js'

export const advancedScenarios: Scenario[] = [
  ...(['fixture_echo', 'fixture_error', 'fixture_structured', 'fixture_image', 'fixture_mixed'] as const).map(tool => ({
    id: `mcp-loop-${tool.replace('fixture_', '')}`, description: `Actual search_tool → use_tool → ${tool} → native follow-up`, targets: ['mcp-discovery-and-use', tool],
    async run(context) {
      const outputs = await modelSequence(context, [
        { name: 'search_tool', arguments: { query: tool, limit: 10 } },
        actual => {
          // This shape was recorded in mcp-search. Use the returned qualified
          // name; never synthesize a Claude-style name or guess a Grok prefix.
          const result = JSON.parse(actual[0])
          const found = result.results?.filter((group: any) => group.server === 'fixture').flatMap((group: any) => group.tools)
            .find((item: any) => item.tool_name?.endsWith(`__${tool}`))
          if (!found || typeof found.tool_name !== 'string' || !found.input_schema) throw new Error('Requested tool absent from actual native discovery output')
          context.capture.record('verification', 'native-qualified-tool-selected', { name: found.tool_name, schema: found.input_schema })
          return { name: 'use_tool', arguments: { tool_name: found.tool_name, tool_input: tool === 'fixture_echo' ? { text: 'MODEL_LOOP_FIXTURE' } : {} } }
        },
      ])
      if (!context.backend.mcpCalls.some(call => call.name === tool)) throw new Error('MCP tool was not actually invoked')
      context.capture.record('verification', 'mcp-native-followup', {
        tool, outputKind: Array.isArray(outputs[1]) ? 'array' : typeof outputs[1],
        images: Math.max(0, ...context.backend.requests.map(body => countInputImages(body.input))),
      })
    },
  } satisfies Scenario)),
  ...(['approved', 'cancelled', 'abandoned'] as const).map(outcome => ({
    id: `plan-exit-${outcome}`, description: `Native plan creation and exit-plan response ${outcome}`, targets: ['plan-mode', 'plan-content', outcome],
    async run(context) {
      const before = context.requests.length
      await modelSequence(context, [
        { name: 'enter_plan_mode', arguments: {} },
        actual => {
          // The path comes from the recorded native enter-plan output. Check
          // ownership before allowing the scripted write into the native home.
          const path = /Write your plan to (.+?)\. The file exists/.exec(String(actual[0]))?.[1]
          if (!path || !resolve(path).startsWith(resolve(context.home) + '/sessions/')) throw new Error('Native plan path is missing or outside the capture home')
          return { name: 'write', arguments: { file_path: path, content: '# Controlled fixture plan\n\nDescribe the fixture; perform no external work.\n' } }
        },
        { name: 'exit_plan_mode', arguments: {} },
      ], async request => {
        if (request.method !== '_x.ai/exit_plan_mode') throw new Error('Unexpected plan interaction')
        const params = innerParams(request)
        if (!params.planContent?.includes('Controlled fixture plan')) throw new Error('Native plan request did not carry the written fixture')
        await context.checkpoint('before-plan-answer')
        await context.answer(request, { outcome, ...(outcome === 'cancelled' ? { feedback: 'Controlled fixture feedback' } : {}) })
      })
      if (context.requests.length === before) throw new Error('No native exit-plan request observed')
    },
  } satisfies Scenario)),
  { id: 'image-normalization', description: 'Generated wide image through native image normalization', targets: ['image-normalization'],
    async run(context) {
      const image = generatedPng(2500, 100)
      context.capture.record('stimulus', 'generated-image', { width: 2500, height: 100, mimeType: 'image/png' }, image)
      await context.prompt([{ type: 'text', text: 'Inspect the controlled wide image.' }, { type: 'image', data: image.toString('base64'), mimeType: 'image/png' }])
      const images = Math.max(0, ...context.backend.requests.map(body => countInputImages(body.input)))
      if (!images) throw new Error('No inference image observed')
      context.capture.record('verification', 'wide-image-input', { images })
      await context.checkpoint('after-wide-image')
    } },
  { id: 'question-freeform', description: 'Native question answer with free-form notes', targets: ['question-freeform'],
    async run(context) {
      await modelSequence(context, [{ name: 'ask_user_question', arguments: { questions: [{ question: 'Describe the controlled fixture?', options: [
        { label: 'First', description: 'First fixture option' }, { label: 'Second', description: 'Second fixture option' },
      ] }] } }], async request => {
        if (request.method !== '_x.ai/ask_user_question') throw new Error('Unexpected question interaction')
        const question = innerParams(request).questions[0].question
        await context.waitFor(() => context.terminal!.snapshotPlain().includes('Describe the controlled'), 'native question surface')
        await context.checkpoint('before-freeform-answer')
        await context.answer(request, { outcome: 'accepted', answers: { [question]: ['Other'] }, annotations: { [question]: { notes: 'Controlled free-form notes' } } })
      })
    } },
  { id: 'manual-compaction', description: 'Native manual compact request and observed history generations', targets: ['compaction', 'history-replacement'],
    async run(context) {
      for (let turn = 0; turn < 4; turn++) await context.prompt(`Controlled compaction context ${turn}.`)
      await context.checkpoint('before-compaction')
      // Native compaction rejects summaries below its recorded 500-character
      // seed floor and retries them as transient failures. The ordinary short
      // fixture reply would therefore probe retry exhaustion, not replacement.
      // Keep this response plainly synthetic while making it long enough for
      // the real compaction path to commit and expose its persistence events.
      context.backend.handler = () => ({ kind: 'text', text: [
        '<summary>',
        'The controlled session contains four fixture prompts and four fixture replies. '.repeat(9),
        'No external work, personal data, credentials, or inferred user intent belongs in this summary.',
        '</summary>',
      ].join('\n') })
      await context.call('_x.ai/compact_conversation', { session_id: context.sessionId, user_context: 'Retain the controlled fixture context.' }, 60000)
      await context.checkpoint('after-compaction')
      await context.call('session/load', { sessionId: context.sessionId, cwd: context.cwd, mcpServers: context.mcpServers })
      await context.checkpoint('after-compaction-load')
    } },
  { id: 'native-subagent', description: 'Native foreground subagent tool and completion envelope', targets: ['subagent', 'child-lifecycle'],
    async run(context) {
      await modelSequence(context, [{ name: 'spawn_subagent', arguments: { prompt: 'Reply with the controlled fixture response. Do not use tools.', description: 'Controlled capture child',
        subagent_type: 'general-purpose', background: false, cwd: context.cwd } }])
      await context.checkpoint('after-subagent')
    } },
]
