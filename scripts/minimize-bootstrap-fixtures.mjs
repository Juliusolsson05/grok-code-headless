// Explicitly minimize the existing probe fixtures, never live provider files.
// Provider bootstrap text carries personal skill/MCP inventories even when
// the test prompt itself is harmless. These tests need the record shape and
// discriminators, not the user's account/project inventory or ciphertext.
import { readFileSync, writeFileSync } from 'node:fs'

if (process.env.UPDATE_FIXTURES !== '1') throw new Error('Set UPDATE_FIXTURES=1 to minimize the recorded probe fixtures')
for (const name of ['chat-history.story.jsonl', 'chat-history.toolcall.jsonl', 'chat-history.synth-resume.jsonl']) {
  const path = new URL(`../testing/fixtures/${name}`, import.meta.url)
  const records = readFileSync(path, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line))
  for (const record of records) {
    if (record.type === 'system') record.content = '[Native Grok system instructions omitted]'
    if (record.type === 'user' && record.synthetic_reason === 'system_reminder') {
      record.content = [{ type: 'text', text: '[Runtime reminder omitted]' }]
    }
    if (record.type === 'user' && record.content?.[0]?.text?.startsWith('<user_info>')) {
      record.content = [{ type: 'text', text: '<user_info>\nWorkspace Path: /fixture/workspace\n</user_info>' }]
    }
    if (record.type === 'reasoning') delete record.encrypted_content
  }
  writeFileSync(path, records.map(record => JSON.stringify(record)).join('\n') + '\n')
}
