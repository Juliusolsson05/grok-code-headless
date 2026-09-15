import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { decodeGrokConversationItem, encodeGrokConversationItem } from '../transcript/ConversationItem.js'
import type { TranscriptFixtureManifest } from './transcriptCorpus.js'

const directory = new URL('../../testing/fixtures/recorded/', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8')) as TranscriptFixtureManifest

// Deliberately independent from the normalizer: a future pass-through branch
// must not bless itself by updating the same function used by the test oracle.
const safeKeys = new Set(('type content text url synthetic_reason cwd_generation prior_turn_interrupt prompt_index tool_calls id name arguments tool_call_id images kind tool_type summary encrypted_content model_id model_fingerprint reasoning_effort status action query queries results title output command description path file_path old_string new_string pattern include limit offset metadata').split(' '))
const safeValues = new Set(('system user assistant tool_result backend_tool_call reasoning text image summary_text function_call function_call_output web_search_call code_interpreter_call search open_page find_in_page compaction_meta system_reminder length_continue project_instructions auto_continue auto_recovery interjection agent_message parent_agent_message task_completed subagent_completed notification_drain goal_summary goal_classifier_nudge scheduler_fired stop_hook_feedback working_directory_switch unknown web_search x_search code_interpreter completed in_progress failed incomplete none minimal low medium high xhigh').split(' '))
function assertSafe(value: unknown, key = '', maxRank = 0): void {
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'number') {
    const rank = ['prompt_index', 'cwd_generation', 'id', 'tool_call_id'].includes(key) && Number.isSafeInteger(value) && value >= 0 && value <= maxRank
    expect(rank || [0, -1, 1, -1.5, 1.5].includes(value), 'unreviewed fixture number').toBe(true)
    return
  }
  if (Array.isArray(value)) { for (const item of value) assertSafe(item, key, maxRank); return }
  if (typeof value === 'object') {
    for (const [field, item] of Object.entries(value)) {
      expect(safeKeys.has(field) || /^field_\d+$/.test(field), 'unreviewed fixture key').toBe(true)
      assertSafe(item, field, maxRank)
    }
    return
  }
  expect(typeof value).toBe('string')
  const text = value as string
  if (text === '' || safeValues.has(text) || text === '[encrypted payload omitted]' || text === '[invalid JSON arguments omitted]') return
  if (key === 'arguments') { assertSafe(JSON.parse(text), '', maxRank); return }
  if (key === 'url') {
    expect(/^https:\/\/fixture\.invalid\/image-\d+\.png$/.test(text) || /^data:(?:image\/(?:png|jpeg|gif|webp)|application\/octet-stream);base64,/.test(text)).toBe(true)
    if (text.startsWith('data:')) expect(Buffer.from(text.split(',')[1], 'base64').toString()).toMatch(/^fixture image \d+$/)
    return
  }
  expect(text.replace(/\[fixture text \d+\]|fixture-(?:id|tool)-\d+|<\/?(?:user_query|user_info)>/g, '').trim(), 'unreviewed fixture string').toBe('')
}

describe('recorded Grok corpus', () => {
  it('rejects raw numeric payloads in the independent publication gate', () => {
    expect(() => assertSafe({ metadata: { offset: 1725891600000 } })).toThrow('unreviewed fixture number')
  })
  it('retains the collected six native record variants, including hosted tools and context metadata', () => {
    expect(manifest.sessions).toHaveLength(22)
    expect([...new Set(manifest.sessions.flatMap(session => Object.keys(session.types)))].sort()).toEqual([
      'assistant', 'backend_tool_call', 'reasoning', 'system', 'tool_result', 'user',
    ])
    expect(manifest.sessions.some(session => session.syntheticReasons.compaction_meta > 0)).toBe(true)
  })
  it.each(manifest.sessions)('$file: safe structural vocabulary, native decoding and exact normalized archive replay', async session => {
    const jsonl = await readFile(new URL(session.file, directory), 'utf8')
    expect(Buffer.byteLength(jsonl)).toBe(session.bytes)
    expect(createHash('sha256').update(jsonl).digest('hex')).toBe(session.sha256)
    const lines = jsonl.trimEnd().split('\n')
    expect(lines).toHaveLength(session.records)
    for (const line of lines) {
      const decoded = decodeGrokConversationItem(line)
      assertSafe(decoded.item, '', session.records)
      expect(encodeGrokConversationItem(decoded)).toBe(line)
    }
  })
})
