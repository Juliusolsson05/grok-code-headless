// chat_history.jsonl IO with grok's two write disciplines:
//   append (normal turns) and full-file rewrite (compaction/rewind —
//   replace_history in xai-chat-state/src/persistence.rs).
//
// WHY rewrite goes through tmp+rename: grok itself rewrites the file in one
// shot; a reader (our JsonlTailer, Task 4) must never observe a half-written
// history, and rename is atomic on APFS/ext4. Appends are line-buffered by
// the OS like any jsonl producer.

import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  decodeGrokConversationItem,
  encodeGrokConversationItem,
  type DecodedGrokItem,
  type GrokConversationItem,
} from './ConversationItem.js'

export async function readGrokChatHistory(path: string): Promise<DecodedGrokItem[]> {
  const text = await readFile(path, 'utf8')
  const out: DecodedGrokItem[] = []
  // Native writers terminate committed records with a newline. A partial
  // final append is not yet a record and must not hide all complete history.
  for (const line of text.slice(0, text.lastIndexOf('\n') + 1).split('\n')) {
    if (line === '') continue
    out.push(decodeGrokConversationItem(line))
  }
  return out
}

export async function appendGrokChatHistory(
  path: string,
  items: Array<GrokConversationItem | DecodedGrokItem>,
): Promise<void> {
  if (items.length === 0) return
  await mkdir(dirname(path), { recursive: true })
  const payload = items.map(encodeGrokConversationItem).join('\n') + '\n'
  await appendFile(path, payload, 'utf8')
}

export async function writeGrokChatHistory(
  path: string,
  items: Array<GrokConversationItem | DecodedGrokItem>,
): Promise<void> {
  // Full rewrite = replace_history semantics (compaction, rewind, and
  // session-dir synthesis for provider switching). tmp+rename keeps the
  // transition atomic for concurrent tailers.
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.headless-tmp`
  const payload = items.map(encodeGrokConversationItem).join('\n') + (items.length ? '\n' : '')
  try {
    await writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(tmp, path)
  } finally {
    await rm(tmp, { force: true })
  }
}
