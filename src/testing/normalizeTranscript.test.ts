import { describe, expect, it } from 'vitest'
import { normalizeTranscript } from './normalizeTranscript.js'

// These are adversarial privacy inputs, not claimed native recordings. The
// separate recorded-corpus test below is the evidence for actual CLI shapes.
describe('transcript fixture privacy', () => {
  it('removes private strings and object keys, including inside JSON arguments', () => {
    const records = [
      { type: 'system', content: 'PRIVATE system inventory' },
      { type: 'user', content: [{ type: 'text', text: '<user_info>\nPRIVATE workspace\n</user_info>' }] },
      { type: 'user', content: [{ type: 'text', text: '<user_query>\nPRIVATE prompt\n</user_query>' }], prompt_index: 9 },
      { type: 'assistant', content: 'PRIVATE answer', tool_calls: [{
        id: 'PRIVATE call', name: 'PRIVATE custom tool',
        arguments: JSON.stringify({ command: 'PRIVATE command', 'PRIVATE key': ['PRIVATE token', 94832, false, null] }),
      }] },
      { type: 'tool_result', tool_call_id: 'PRIVATE call', content: 'PRIVATE output', images: [{ type: 'image', url: 'https://PRIVATE/image' }] },
      { type: 'reasoning', id: 'PRIVATE reasoning', summary: [{ type: 'summary_text', text: 'PRIVATE thought' }], encrypted_content: 'PRIVATE ciphertext' },
      { type: 'user', synthetic_reason: 'interjection', content: [{ type: 'text', text: 'PRIVATE steering' }], 'PRIVATE extension': { 'PRIVATE nested key': 'PRIVATE value' } },
    ]
    const normalized = normalizeTranscript(records)
    expect(JSON.stringify(normalized)).not.toContain('PRIVATE')
    expect(JSON.stringify(normalized)).not.toContain('94832')
    expect(normalized.map(record => record.type)).toEqual(records.map(record => record.type))
    expect(normalized[1].content).toEqual([{ type: 'text', text: '<user_info>\n[fixture text 2]\n</user_info>' }])
    expect((normalized[2].content as { text: string }[])[0].text).toMatch(/^<user_query>\n.+\n<\/user_query>$/)
    const call = (normalized[3].tool_calls as Record<string, unknown>[])[0]
    expect(call.id).toBe(normalized[4].tool_call_id)
    expect(JSON.parse(call.arguments as string)).toEqual({ command: '[fixture text 5]', field_1: ['[fixture text 6]', 1, false, null] })
    expect(normalized[5].encrypted_content).toBe('[encrypted payload omitted]')
    expect(normalized[6].synthetic_reason).toBe('interjection')
  })

  it('depends on structure and equality, not the private words or ID values', () => {
    const sample = (secret: string) => [
      { type: 'assistant', content: secret, tool_calls: [{ id: `${secret}-id`, name: secret, arguments: JSON.stringify({ [secret]: secret }) }] },
      { type: 'tool_result', tool_call_id: `${secret}-id`, content: secret },
    ]
    expect(normalizeTranscript(sample('first-person-secret'))).toEqual(normalizeTranscript(sample('entirely-different-secret')))
  })

  it('preserves empty strings, nulls, arrays and distinct/repeated IDs without conflating namespaces', () => {
    const normalized = normalizeTranscript([
      { type: 'reasoning', id: 'same', summary: [], encrypted_content: null },
      { type: 'assistant', content: '', tool_calls: [{ id: 'same', name: 'same', arguments: '{}' }, { id: 'other', name: 'same', arguments: 'not JSON PRIVATE' }] },
      { type: 'tool_result', tool_call_id: 'same', content: '' },
      { type: 'tool_result', tool_call_id: 'other', content: '', images: [] },
    ])
    const calls = normalized[1].tool_calls as Record<string, unknown>[]
    expect(calls[0].id).not.toBe(calls[1].id)
    expect(calls[0].id).toBe(normalized[2].tool_call_id)
    expect(calls[1].id).toBe(normalized[3].tool_call_id)
    expect(calls[0].name).toBe(calls[1].name)
    expect(calls[0].id).not.toBe(calls[0].name)
    expect(calls[0].arguments).toBe('{}')
    expect(() => JSON.parse(calls[1].arguments as string)).toThrow()
    expect(normalized[0]).toMatchObject({ summary: [], encrypted_content: null })
    expect(normalized[3]).toMatchObject({ content: '', images: [] })
  })

  it('does not preserve arbitrary enum-looking values or dynamic keys disguised as fields', () => {
    const normalized = normalizeTranscript([{ type: 'user', synthetic_reason: 'PRIVATE new reason', content: [{ type: 'PRIVATE new part', text: 'PRIVATE' }], metadata: JSON.parse('{"/PRIVATE/path":12,"__proto__":"PRIVATE own key"}') }])
    expect(JSON.stringify(normalized)).not.toContain('PRIVATE')
    expect(normalized[0].synthetic_reason).not.toBe('interjection')
    expect(normalized[0].synthetic_reason).not.toBe('compaction_meta')
    expect(Object.keys(normalized[0].metadata as object)).toHaveLength(2)
  })

  it('retains prompt/generation equality and order without retaining original counters', () => {
    const result = normalizeTranscript([
      { type: 'user', content: [], prompt_index: 872, cwd_generation: 34 },
      { type: 'user', content: [], prompt_index: 872, cwd_generation: 35 },
      { type: 'user', content: [], prompt_index: 900, cwd_generation: null },
    ])
    expect(result.map(record => record.prompt_index)).toEqual([0, 0, 1])
    expect(result.map(record => record.cwd_generation)).toEqual([0, 1, null])
  })

  it('preserves descending counter relationships and nonempty whitespace', () => {
    const result = normalizeTranscript([
      { type: 'user', content: [{ type: 'text', text: '   ' }], prompt_index: 900 },
      { type: 'user', content: [], prompt_index: 872 },
    ])
    expect(result.map(record => record.prompt_index)).toEqual([1, 0])
    expect((result[0].content as { text: string }[])[0].text).toBe(' ')
  })

  it('retains inline-image versus URL carrier shapes without retaining image bytes', () => {
    const result = normalizeTranscript([{ type: 'user', content: [
      { type: 'image', url: 'data:image/png;base64,PRIVATE' },
      { type: 'image', url: 'https://PRIVATE/image' },
    ] }])
    const images = result[0].content as { url: string }[]
    expect(images[0].url).toMatch(/^data:image\/png;base64,/)
    expect(images[1].url).toMatch(/^https:\/\/fixture\.invalid\//)
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
  })

  it('does not repair invalid native counters or interpret nested payload fields as native counters', () => {
    const result = normalizeTranscript([
      { type: 'user', content: [], prompt_index: -99 },
      { type: 'user', content: [], prompt_index: 12.25 },
      { type: 'user', content: [], prompt_index: Number.MAX_SAFE_INTEGER + 1 },
      { type: 'user', content: [], prompt_index: 20, metadata: { prompt_index: 983402 } },
    ])
    expect(result.map(record => record.prompt_index)).toEqual([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, 0])
    expect(result[3].metadata).toEqual({ prompt_index: 1 })
  })

  it('keeps numeric identities distinct without converting their JSON type', () => {
    const result = normalizeTranscript([
      { type: 'backend_tool_call', kind: { tool_type: 'web_search', id: 2983 } },
      { type: 'backend_tool_call', kind: { tool_type: 'web_search', id: 9873 } },
      { type: 'tool_result', tool_call_id: 2983, content: '' },
    ])
    const first = result[0].kind as { id: unknown }
    const second = result[1].kind as { id: unknown }
    expect(first.id).not.toBe(second.id)
    expect(first.id).toBe(result[2].tool_call_id)
    expect(typeof first.id).toBe('number')
  })
})
