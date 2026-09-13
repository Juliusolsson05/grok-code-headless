import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { verifyRuntimeCapture } from '../src/testing/controlled-runtime/Capture.js'

const directory = process.argv[2]
if (!directory) throw new Error('Usage: inspect-runtime-capture.mts PRIVATE_CAPTURE_DIRECTORY')
const verified = await verifyRuntimeCapture(resolve(directory))
const rowTypes: Record<string, number> = {}
const updates: Record<string, number> = {}
const methods: Record<string, number> = {}
const tools = new Set<string>()
const advertisedTools = new Map<string, unknown>()
const modelOutputs = new Map<string, unknown>()
const count = (target: Record<string, number>, key: unknown) => { if (typeof key === 'string') target[key] = (target[key] ?? 0) + 1 }
for (const event of verified.events) {
  const data = event.data as any
  if (event.channel === 'control' && event.kind === 'notification') {
    count(methods, data.method)
    const params = data.params?.method ? data.params.params : data.params
    count(updates, params?.update?.sessionUpdate)
  }
  if (!event.blob) continue
  if (event.channel === 'history' && event.kind === 'row') {
    try {
      const row = JSON.parse((await readFile(join(directory, event.blob.path))).toString())
      count(rowTypes, row.type)
      for (const call of row.tool_calls ?? []) if (typeof call.name === 'string') tools.add(call.name)
    } catch { count(rowTypes, 'unparsed') }
  }
  if (event.channel === 'http' && event.kind === 'request' && data.path === '/v1/responses') {
    const body = JSON.parse((await readFile(join(directory, event.blob.path))).toString())
    for (const item of body.input ?? []) if (item.type === 'function_call_output') modelOutputs.set(item.call_id, {
      keys: Object.keys(item), output: typeof item.output === 'string' ? item.output.slice(0, 3500) : item.output,
    })
    for (const tool of body.tools ?? []) {
      const name = tool.name ?? tool.function?.name
      if (typeof name === 'string') advertisedTools.set(name, tool.parameters ?? tool.function?.parameters)
    }
  }
}
console.log(JSON.stringify({ scenario: verified.manifest.metadata.scenario, outcome: verified.manifest.scenarioOutcome,
  captureComplete: verified.manifest.captureComplete, observations: verified.events.length, bytes: verified.manifest.totalBytes,
  channels: verified.manifest.channelCounts, rowTypes, updates, methods, invokedTools: [...tools],
  advertisedTools: process.argv.includes('--schemas') ? Object.fromEntries(advertisedTools) : [...advertisedTools.keys()],
  ...(process.argv.includes('--outputs') ? { modelOutputs: Object.fromEntries(modelOutputs) } : {}) }, null, 2))
