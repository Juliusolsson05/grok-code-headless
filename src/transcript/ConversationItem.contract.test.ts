import { readFileSync } from 'node:fs'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { decodeGrokConversationItem, encodeGrokConversationItem, GrokConversationItemDecodeError } from './ConversationItem.js'

describe('recorded ConversationItem public contract', () => {
  it('exposes the flat tool-call schema emitted by Grok, not OpenAI request fields', () => {
    const lines = readFileSync(new URL('../../testing/fixtures/chat-history.toolcall.jsonl', import.meta.url), 'utf8').trim().split('\n')
    const items = lines.map(line => decodeGrokConversationItem(line).item)
    const assistant = items.find(item => item.type === 'assistant' && item.tool_calls?.length)
    if (assistant?.type !== 'assistant') throw new Error('Recorded tool call missing')
    const call = assistant.tool_calls![0]!
    expectTypeOf(call.name).toEqualTypeOf<string>()
    expectTypeOf(call.arguments).toEqualTypeOf<string>()
    expect(call.name).toBe('run_terminal_command')
    expect(JSON.parse(call.arguments)).toMatchObject({ command: 'touch PERMISSION_PROBE.txt' })
  })

  it('retains the original JSON number lexemes when replaying decoded evidence', () => {
    // Boundary fault injection, not a claimed live capture: JS would round
    // the integer and change 1.0 to 1. Archive replay must use the raw line.
    const line = '{"type":"reasoning","summary":[],"cost":1.0,"sequence":9007199254740993}'
    expect(encodeGrokConversationItem(decodeGrokConversationItem(line))).toBe(line)
  })

  it.each([
    '{"type":"assistant","content":42}',
    '{"type":"assistant","content":"","tool_calls":[{"id":"x","function":{"name":"read_file","arguments":"{}"}}]}',
    '{"type":"user","content":[{"type":"image"}]}',
    '{"type":"tool_result","content":"missing id"}',
    '{"type":"reasoning","id":42}',
    '{"type":"user","content":[],"prompt_index":"wrong"}',
    '{"type":"user","content":[],"cwd_generation":-1}',
    '{"type":"assistant",',
  ])('rejects invalid structure with the public decode error: %s', line => {
    expect(() => decodeGrokConversationItem(line)).toThrow(GrokConversationItemDecodeError)
  })
})
