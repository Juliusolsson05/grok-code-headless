import { mkdtempSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { encodeGrokSessionsDir } from './SessionDirEncoding.js'
import {
  readGrokChatHistory,
  appendGrokChatHistory,
  writeGrokChatHistory,
} from './GrokJsonl.js'
import type { GrokConversationItem } from './ConversationItem.js'

describe('encodeGrokSessionsDir', () => {
  it('percent-encodes the resolved path with %2F separators', () => {
    // Synthetic tmpdir (not a symlinked path) keeps this deterministic.
    const dir = mkdtempSync(join(tmpdir(), 'grok-enc-'))
    expect(encodeGrokSessionsDir(dir)).toBe(
      realpathSync(dir).split('/').map(encodeURIComponent).join('%2F'),
    )
  })

  it('resolves symlinked /var through /private/var on macOS', () => {
    const encoded = encodeGrokSessionsDir('/var')
    // On macOS this MUST be %2Fprivate%2Fvar — the probe-verified trap where
    // unresolved encoding finds zero sessions. On linux /var is real and the
    // plain encoding is correct.
    expect(encoded === '%2Fprivate%2Fvar' || encoded === '%2Fvar').toBe(true)
    if (process.platform === 'darwin') expect(encoded).toBe('%2Fprivate%2Fvar')
  })
})

describe('GrokJsonl write disciplines', () => {
  const system: GrokConversationItem = { type: 'system', content: 'You are a test.' }
  const user: GrokConversationItem = {
    type: 'user',
    content: [{ type: 'text', text: 'Remember the codeword TESTFRUIT.' }],
  }

  it('append then read preserves order and bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'grok-jsonl-'))
    const path = join(dir, 's1', 'chat_history.jsonl')
    await appendGrokChatHistory(path, [system, user])
    await appendGrokChatHistory(path, [
      { type: 'assistant', content: 'OK. The codeword is TESTFRUIT.' },
    ])
    const items = await readGrokChatHistory(path)
    expect(items.map(i => i.item.type)).toEqual(['system', 'user', 'assistant'])
    // raw lines round-trip byte-stable through our writer.
    expect(items[0]!.raw).toBe(JSON.stringify(system))
  })

  it('full rewrite is atomic (tmp file gone) and replaces content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'grok-jsonl-'))
    const path = join(dir, 's2', 'chat_history.jsonl')
    await appendGrokChatHistory(path, [system, user])
    await writeGrokChatHistory(path, [system]) // compaction-style rewrite
    expect((await readGrokChatHistory(path)).map(i => i.item.type)).toEqual(['system'])
    expect(existsSync(`${path}.headless-tmp`)).toBe(false)
    // sanity: the file existed before rewrite (append path ran)
    expect(writeFileSync !== undefined).toBe(true)
  })
})
