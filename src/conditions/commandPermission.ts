import { createHash } from 'node:crypto'

export type GrokPermissionChoice = 'allow-once' | 'reject-once'
export type GrokCommandPermission = {
  kind: 'grok.command-permission'
  id: string
  toolCallId: string
  title: string
  command: string
  actions: Array<{ id: GrokPermissionChoice; label: string; key: string }>
}
export type GrokCommandPermissionState =
  | { status: 'closed' | 'unstable' | 'resizing' | 'none' }
  | { status: 'card'; card: GrokCommandPermission }

// Deliberately narrow: this recognizes the captured command card in the
// focused input dock, not arbitrary "allow" prose or a pending tool call.
// Different/truncated layouts remain available through the raw terminal;
// they must not silently become broader permission grants.
export function detectCommandPermission(
  screen: string,
  pending: ReadonlyArray<{ toolCallId: string; command: string }>,
): GrokCommandPermission | null {
  if (screen.length > 128 * 1024) return null
  const rows = screen.split('\n').map(row => row.trimEnd())
  let footer = -1
  for (let index = rows.length - 1; index >= 0; index--) {
    if (/^\s*[1-9]\/[1-9]:select\s+\u2502\s+Tab:next option/.test(rows[index]!)) { footer = index; break }
  }
  if (footer < 0 || rows.slice(footer + 1).some(row => row.trim() !== '')) return null
  let end = footer - 1
  while (end >= 0 && rows[end]!.trim() === '') end--
  let start = end
  while (start >= 0 && /^\s*\u2503/.test(rows[start]!)) start--
  if (start === end) return null
  const card = rows.slice(start + 1, end + 1).map(row => row.replace(/^\s*\u2503\s*/, ''))
  const options = card.flatMap(row => {
    const match = /^([1-9])\s+\([\u25cf\u25cb]\)\s+(.+)$/.exec(row)
    return match ? [{ key: match[1]!, label: match[2]! }] : []
  })
  const total = Number(/^\s*[1-9]\/([1-9]):/.exec(rows[footer]!)?.[1])
  if (options.length !== total || options.some((option, index) => Number(option.key) !== index + 1)) return null
  const beforeOptions = card.slice(0, card.findIndex(row => /^[1-9]\s+\(/.test(row))).filter(Boolean)
  const title = beforeOptions[0]
  if (!title) return null
  // The tool ID corroborates a live pending command; the current card is the
  // action target. Native file writes may lag a same-command replacement, so
  // callers must not treat this ID as a provider-signed approval receipt.
  const matches = pending.filter(call => beforeOptions.slice(1).includes(call.command))
  if (matches.length !== 1) return null
  const call = matches[0]!
  const allow = options.find(option => option.label === 'Yes, proceed')
  const reject = options.find(option => option.label === 'No, reject (type to add feedback)')
  if (!allow || !reject) return null
  // The keybind for option 1 in the capture enables GLOBAL always-approve.
  // Only exact one-shot labels enter this API; persistent scope is never
  // inferred from option position, selection marker, or a generic "Yes".
  return {
    kind: 'grok.command-permission',
    id: createHash('sha256').update(JSON.stringify({ toolCallId: call.toolCallId, card })).digest('hex'),
    toolCallId: call.toolCallId, title, command: call.command,
    actions: [{ id: 'allow-once', ...allow }, { id: 'reject-once', ...reject }],
  }
}
