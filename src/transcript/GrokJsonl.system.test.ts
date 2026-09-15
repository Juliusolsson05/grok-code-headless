import { mkdirSync, mkdtempSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeGrokSessionsDir } from './SessionDirEncoding.js'
import {
  readGrokChatHistory,
  appendGrokChatHistory,
  writeGrokChatHistory,
} from './GrokJsonl.js'
import type { GrokConversationItem } from './ConversationItem.js'

const directories: string[] = []
function tempDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'grok-jsonl-'))
  directories.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('encodeGrokSessionsDir', () => {
  it('uses RFC3986 encoding for punctuation in real project directory names', () => {
    const dir = join(tempDirectory(), "Project !'()* ~")
    mkdirSync(dir)
    expect(encodeGrokSessionsDir(dir)).toMatch(/%2FProject%20%21%27%28%29%2A%20~$/)
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

  it('returns complete native lines while the next append is still torn', async () => {
    const path = join(tempDirectory(), 'chat_history.jsonl')
    writeFileSync(path, '{"type":"assistant","content":"complete"}\n{"type":"assistant","content":')
    expect((await readGrokChatHistory(path)).map(entry => entry.item.type)).toEqual(['assistant'])
  })

  it('append then read preserves order and bytes', async () => {
    const dir = tempDirectory()
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
    const dir = tempDirectory()
    const path = join(dir, 's2', 'chat_history.jsonl')
    await appendGrokChatHistory(path, [system, user])
    await writeGrokChatHistory(path, [system]) // compaction-style rewrite
    expect((await readGrokChatHistory(path)).map(i => i.item.type)).toEqual(['system'])
    expect(existsSync(path)).toBe(true)
    expect(readdirSync(join(dir, 's2'))).toEqual(['chat_history.jsonl'])
  })
})
