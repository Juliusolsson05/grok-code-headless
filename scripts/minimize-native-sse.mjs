// Explicit fixture regeneration, not an ordinary test dependency. Retain the
// captured Responses shape required by the native Rust deserializer while
// removing encrypted reasoning, tool schemas and free-form reasoning text.
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const [input, output] = process.argv.slice(2)
if (!input || !output || process.env.UPDATE_FIXTURES !== '1') throw new Error('Usage: UPDATE_FIXTURES=1 node scripts/minimize-native-sse.mjs INPUT OUTPUT')
const raw = readFileSync(input, 'utf8')
const primitiveFields = [
  'sequence_number', 'type', 'id', 'item_id', 'call_id', 'output_index', 'content_index', 'summary_index',
  'role', 'status', 'created_at', 'completed_at', 'model', 'object', 'parallel_tool_calls',
  'max_output_tokens', 'temperature', 'top_p', 'store', 'background', 'service_tier', 'truncation',
]
const pick = value => Object.fromEntries(primitiveFields.filter(key => key in value).map(key =>
  [key, ['created_at', 'completed_at'].includes(key) && value[key] !== null ? 0 : value[key]]))
function part(value) {
  const out = pick(value)
  if ('text' in value) {
    if (value.type === 'summary_text' || value.type === 'reasoning_text') out.text = '[reasoning omitted]'
    else if (value.type === 'output_text' && ['', 'PAPAYA'].includes(value.text)) out.text = value.text
    else throw new Error('Unreviewed text part in native fixture source')
  }
  if ('logprobs' in value) out.logprobs = []
  if ('annotations' in value) out.annotations = []
  return out
}
function item(value) {
  const out = pick(value)
  if ('summary' in value) out.summary = value.summary.map(part)
  if ('content' in value) out.content = value.content.map(part)
  return out
}
function numericShape(value) {
  if (value === null) return null
  if (typeof value === 'number') return 0
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected usage shape')
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (!/^[a-z_]+$/.test(key)) throw new Error('Unexpected usage key')
    return [key, numericShape(child)]
  }))
}
const frames = []
for (const block of raw.split(/\r?\n\r?\n/)) {
  const data = block.split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')
  if (!data || data === '[DONE]') continue
  const value = JSON.parse(data)
  const out = pick(value)
  if ('delta' in value) {
    if (/^response\.reasoning/.test(value.type)) out.delta = '.'
    else if (value.type === 'response.output_text.delta' && ['PAP', 'AYA'].includes(value.delta)) out.delta = value.delta
    else throw new Error('Unreviewed delta in native fixture source')
  }
  if ('text' in value) {
    if (/^response\.reasoning/.test(value.type)) out.text = '[reasoning omitted]'
    else if (value.type === 'response.output_text.done' && value.text === 'PAPAYA') out.text = value.text
    else throw new Error('Unreviewed text event in native fixture source')
  }
  if ('logprobs' in value) out.logprobs = []
  if ('item' in value) out.item = item(value.item)
  if ('part' in value) out.part = part(value.part)
  if (value.response) {
    const response = pick(value.response)
    response.output = value.response.output.map(item)
    response.tools = []
    response.tool_choice = 'auto'
    response.reasoning = { effort: 'high', summary: 'detailed' }
    response.text = { format: { type: 'text' } }
    for (const key of ['error', 'incomplete_details', 'metadata', 'previous_response_id', 'user']) {
      if (key in value.response) response[key] = null
    }
    if (value.response.usage) response.usage = numericShape(value.response.usage)
    out.response = response
  }
  frames.push(`event: ${out.type}\ndata: ${JSON.stringify(out)}`)
}
const minimized = frames.join('\n\n') + '\n\n'
if (!minimized.includes('PAPAYA') || /encrypted_content|\/Users\/|Bearer |api_key/i.test(minimized)) throw new Error('Fixture privacy/identity gate failed')
writeFileSync(output, minimized, { flag: 'wx' })
console.log(`Exported ${frames.length} projected frames; source sha256=${createHash('sha256').update(raw).digest('hex')}`)
