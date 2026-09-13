import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Scenario, PromptContent } from './NativeHarness.js'
import { generatedPng, countInputImages } from './generatedImage.js'
import { modelSequence, innerParams } from './modelSequence.js'

export const contentScenarios: Scenario[] = [
  ...([1, 2] as const).map(count => ({ id: `image-content-${count}`, description: `${count} generated image blocks interleaved with text over ACP`, targets: ['user-image', 'mixed-content', 'image-load-replay'],
    async run(context) {
      const blocks: PromptContent[] = []
      for (let index = 0; index < count; index++) {
        const image = generatedPng(100, 80, index)
        context.capture.record('stimulus', 'generated-image', { index, width: 100, height: 80, mimeType: 'image/png' }, image)
        blocks.push({ type: 'text', text: `Controlled image ${index + 1}.` }, { type: 'image', data: image.toString('base64'), mimeType: 'image/png' })
      }
      await context.prompt(blocks)
      const observed = Math.max(0, ...context.backend.requests.map(body => countInputImages(body.input)))
      context.capture.record('verification', 'inference-image-count', { expected: count, observed })
      if (observed < count) throw new Error('Native inference did not contain the supplied image count')
      await context.checkpoint('after-image-input')
      await context.call('session/load', { sessionId: context.sessionId, cwd: context.cwd, mcpServers: context.mcpServers })
      await context.checkpoint('after-image-load')
    },
  } satisfies Scenario)),
  { id: 'image-invalid-bytes', description: 'Actual native response to corrupt generated image bytes', targets: ['image-error'],
    async run(context) {
      let rejected = false
      try { await context.prompt([{ type: 'image', data: Buffer.from('NOT_AN_IMAGE').toString('base64'), mimeType: 'image/png' }]) }
      catch { rejected = true }
      context.capture.record('verification', 'invalid-image-outcome', { rejected, inferenceRequests: context.backend.requests.length })
      await context.checkpoint('after-invalid-image')
    } },
  { id: 'read-generated-image', description: 'Native read_file image result and subsequent inference content', targets: ['tool-result-image', 'image-followup'],
    async run(context) {
      const path = join(context.cwd, 'fixture.png')
      const image = generatedPng()
      await writeFile(path, image)
      context.capture.record('stimulus', 'generated-file', { name: 'fixture.png', mimeType: 'image/png' }, image)
      await modelSequence(context, [{ name: 'read_file', arguments: { target_file: path } }])
      const images = Math.max(0, ...context.backend.requests.map(body => countInputImages(body.input)))
      context.capture.record('verification', 'tool-image-followup', { images })
    } },
  { id: 'file-read-write-edit-search', description: 'Actual native write/read/edit/list/grep tool-result shapes', targets: ['write', 'read', 'edit', 'list', 'grep'],
    async run(context) {
      const file = join(context.cwd, 'fixture.txt')
      await modelSequence(context, [
        { name: 'write', arguments: { file_path: file, content: 'ALPHA\nBETA\n' } },
        { name: 'read_file', arguments: { target_file: file } },
        { name: 'search_replace', arguments: { file_path: file, old_string: 'BETA', new_string: 'GAMMA' } },
        { name: 'list_dir', arguments: { target_directory: context.cwd } },
        { name: 'grep', arguments: { pattern: 'GAMMA', path: file } },
      ])
    } },
  { id: 'resource-link-input', description: 'Generated file resource link expanded by native prompt parsing', targets: ['resource-link', 'file-reference'],
    async run(context) {
      const path = join(context.cwd, 'linked.txt'); await writeFile(path, 'CONTROLLED_RESOURCE_CONTENT')
      await context.call('session/prompt', { sessionId: context.sessionId, prompt: [
        { type: 'text', text: 'Read this controlled reference.' },
        { type: 'resource_link', name: 'linked.txt', uri: pathToFileURL(path).href, mimeType: 'text/plain' },
      ] })
      await context.checkpoint('after-resource-link')
    } },
  { id: 'embedded-resource-input', description: 'Inline text resource through native ACP parsing', targets: ['embedded-resource'],
    async run(context) {
      await context.call('session/prompt', { sessionId: context.sessionId, prompt: [
        { type: 'text', text: 'Inspect the controlled inline resource.' },
        { type: 'resource', resource: { uri: 'fixture://inline/text', mimeType: 'text/plain', text: 'CONTROLLED_EMBEDDED_RESOURCE' } },
      ] })
      await context.checkpoint('after-embedded-resource')
    } },
  ...(['single', 'multi', 'cancel'] as const).map(mode => ({ id: `question-${mode}`, description: `Native ask_user_question ${mode} interaction`, targets: ['question', mode],
    async run(context) {
      const before = context.requests.length
      await modelSequence(context, [{ name: 'ask_user_question', arguments: { questions: [{ question: 'Choose a controlled fixture option?', multi_select: mode === 'multi',
        options: [{ label: 'Blue', description: 'First fixture', preview: '<p>Blue fixture preview</p>' }, { label: 'Green', description: 'Second fixture' }] }] } }], async request => {
        if (request.method !== '_x.ai/ask_user_question') throw new Error('Unexpected question method')
        const params = innerParams(request)
        if (mode === 'cancel') await context.answer(request, { outcome: 'cancelled' })
        else {
          const answers = Object.fromEntries(params.questions.map((question: any) => [question.question, question.options.slice(0, mode === 'multi' ? 2 : 1).map((option: any) => option.label)]))
          await context.answer(request, { outcome: 'accepted', answers })
        }
      })
      if (context.requests.length === before) throw new Error('No native question request observed')
    },
  } satisfies Scenario)),
  { id: 'todo-transitions', description: 'Native todo_write replacement and status merge', targets: ['todo-create', 'todo-update'],
    async run(context) {
      await modelSequence(context, [
        { name: 'todo_write', arguments: { merge: false, todos: [{ id: 'fixture-a', content: 'First controlled task', status: 'in_progress' }, { id: 'fixture-b', content: 'Second controlled task', status: 'pending' }] } },
        { name: 'todo_write', arguments: { merge: true, todos: [{ id: 'fixture-a', status: 'completed' }, { id: 'fixture-b', status: 'in_progress' }] } },
      ])
    } },
  { id: 'plan-mode-enter', description: 'Native planning mode transition and its real tool output', targets: ['plan-mode'],
    run: async context => { await modelSequence(context, [{ name: 'enter_plan_mode', arguments: {} }]) } },
  { id: 'mcp-search', description: 'Native model-loop search_tool output, including actual qualified tool names', targets: ['tool-discovery', 'mcp-search'],
    run: async context => { await modelSequence(context, [{ name: 'search_tool', arguments: { query: 'fixture echo', limit: 5 } }]) } },
  { id: 'concurrent-prompts', description: 'Two native prompt calls issued concurrently, without assuming queue or busy semantics', targets: ['concurrent-prompts', 'queue'],
    async run(context) {
      const results = await Promise.allSettled([context.prompt('Concurrent controlled prompt.'), context.prompt('Concurrent controlled prompt.')])
      context.capture.record('verification', 'concurrent-results', results.map(result => ({ status: result.status,
        ...(result.status === 'rejected' ? { code: result.reason?.code, rpcCode: result.reason?.rpcCode } : { stopReason: result.value?.stopReason }) })))
      await context.checkpoint('after-concurrent-prompts')
    } },
  { id: 'cancel-inference', description: 'Native cancellation while fixture inference is outstanding', targets: ['cancel', 'partial-turn'],
    async run(context) {
      let held = false
      context.backend.handler = body => context.backend.advertisedToolNames(body).includes('run_terminal_command') ? (held = true, { kind: 'hold' }) : { kind: 'text', text: 'FIXTURE_AUXILIARY_REPLY' }
      const pending = context.prompt('Hold this controlled inference.').catch(error => error)
      await context.waitFor(() => held, 'outstanding native inference')
      context.capture.record('action', 'cancel-requested', { sessionId: context.sessionId })
      await context.control.rpc.notify('session/cancel', { sessionId: context.sessionId })
      const outcome = await pending
      context.capture.record('verification', 'cancel-outcome', { stopReason: outcome?.stopReason, errorCode: outcome?.code, uncertain: outcome?.uncertain })
      await context.checkpoint('after-cancellation')
    } },
]
