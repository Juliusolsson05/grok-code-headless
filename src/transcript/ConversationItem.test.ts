import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  decodeGrokConversationItem,
  encodeGrokConversationItem,
  isGenuineUserItem,
  isSyntheticUserItem,
  GrokConversationItemDecodeError,
} from './ConversationItem.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'testing', 'fixtures')

function fixtureLines(name: string): string[] {
  return readFileSync(join(fixtures, name), 'utf8')
    .split('\n')
    .filter(l => l !== '')
}

// Round-trip against real serde output: the Rust codec (tag="type",
// snake_case, compact) is the oracle. If re-encoding drifts by a byte,
// provider-switching projection corrupts sessions — this is the invariant
// that makes synthesize-and-resume (D3) safe.
describe.each(['chat-history.story.jsonl', 'chat-history.toolcall.jsonl', 'chat-history.synth-resume.jsonl'])(
  'serde fixture round-trip: %s',
  name => {
    it('decodes and re-encodes every line byte-identically', () => {
      for (const line of fixtureLines(name)) {
        const decoded = decodeGrokConversationItem(line)
        expect(encodeGrokConversationItem(decoded.item)).toBe(line)
      }
    })
  },
)

describe('conversation structure laws (captured sessions)', () => {
  const story = fixtureLines('chat-history.story.jsonl').map(decodeGrokConversationItem)

  it('opens with system; genuine users split into <user_info> preamble + <user_query> turn', () => {
    // FORMAT LAW (fixture-discovered): the <user_info> workspace/git context
    // lands as a GENUINE user item (no synthetic_reason) — only later
    // injections are tagged. The user TURN is therefore the genuine item
    // whose text is wrapped in <user_query>…</user_query>; decode for
    // provider switching must key on the wrapper, not on synthetic_reason
    // alone, or every session gains a phantom opening user turn.
    expect(story[0]!.item.type).toBe('system')
    const genuine = story.filter(d => isGenuineUserItem(d.item))
    expect(genuine.length).toBe(2)
    const texts = genuine.map(
      d => ((d.item as { content: Array<{ type: string; text?: string }> }).content[0]!.text ?? ''),
    )
    expect(texts.some(t => t.includes('<user_info>'))).toBe(true)
    expect(texts.some(t => t.includes('<user_query>'))).toBe(true)
  })

  it('marks every runtime injection with a synthetic_reason', () => {
    const synthetic = story.filter(d => isSyntheticUserItem(d.item))
    expect(synthetic.length).toBeGreaterThan(0)
    for (const d of synthetic) {
      expect(d.item.synthetic_reason).toBe('system_reminder')
    }
  })

  it('places reasoning as the sibling immediately before its assistant item', () => {
    const idx = story.findIndex(d => d.item.type === 'assistant')
    expect(idx).toBeGreaterThan(0)
    expect(story[idx - 1]!.item.type).toBe('reasoning')
  })

  it('pairs tool_calls with a following tool_result (toolcall fixture)', () => {
    const tool = fixtureLines('chat-history.toolcall.jsonl').map(decodeGrokConversationItem)
    const call = tool.find(
      d => d.item.type === 'assistant' && (d.item as { tool_calls?: unknown }).tool_calls,
    )
    const result = tool.find(d => d.item.type === 'tool_result')
    expect(call).toBeDefined()
    expect(result).toBeDefined()
    const callId = ((call!.item as { tool_calls: Array<{ id: string }> }).tool_calls[0]!.id)
    expect((result!.item as { tool_call_id: string }).tool_call_id).toBe(callId)
    // Order matters: result lands after its calling assistant item.
    expect(tool.indexOf(result!)).toBeGreaterThan(tool.indexOf(call!))
  })

  it('synth-resume fixture ends with the codeword answer and recounts prompt_index from 0', () => {
    const synth = fixtureLines('chat-history.synth-resume.jsonl').map(decodeGrokConversationItem)
    const last = synth[synth.length - 1]!
    expect(last.item.type).toBe('assistant')
    expect((last.item as { content: string }).content).toContain('PINEAPPLE')
    const resumedQuery = synth.find(
      d => isGenuineUserItem(d.item) && d.item.prompt_index === 0,
    )
    expect(resumedQuery).toBeDefined()
  })
})

describe('decode failure mode', () => {
  it('throws a typed error on an unknown type tag instead of skipping', () => {
    expect(() => decodeGrokConversationItem('{"type":"brand_new_thing"}')).toThrow(
      GrokConversationItemDecodeError,
    )
  })
})
