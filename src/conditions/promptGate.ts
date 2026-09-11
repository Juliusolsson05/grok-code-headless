import type { StableTerminalFrame } from '../terminal/HeadlessTerminal.js'

export type GrokPromptGate =
  | { kind: 'ready' }
  | { kind: 'warming'; reason: 'unpainted' | 'unstable' | 'resizing' | 'awaiting-input-ack' | 'awaiting-composer-repaint' }
  | { kind: 'occupied'; reason: 'draft' | 'stashed-draft' }
  | { kind: 'blocked'; reason: 'unfocused-or-modal' | 'unknown-composer' | 'command-permission' | 'history-generation-changed' }
  | { kind: 'closed' }

export function evaluateGrokPromptGate(frame: StableTerminalFrame | null): GrokPromptGate {
  if (!frame) return { kind: 'warming', reason: 'unstable' }
  if (frame.generation <= 0) return { kind: 'warming', reason: 'unpainted' }
  if (frame.layoutEpoch !== frame.providerLayoutEpoch) return { kind: 'warming', reason: 'resizing' }
  if (frame.cursor.visible !== true) return { kind: 'blocked', reason: 'unfocused-or-modal' }
  const unknown: GrokPromptGate = { kind: 'blocked', reason: 'unknown-composer' }
  if (frame.cols < 20 || frame.rows.length < 8) return unknown

  // This is the observed fullscreen bottom dock, not a search through transcript
  // text for an arrow. Cell coordinates keep multiline/Unicode layout physical;
  // xterm null cells are blanks, not absent columns to collapse with join().
  const left = 2
  const right = frame.cols - 3
  const bottom = frame.rows.length - 4
  const cells = (row: number) => frame.rows[row]?.cells.map(cell => cell || ' ') ?? []
  const marginIsBlank = (row: number) => {
    const line = cells(row)
    return line.length === frame.cols && [...line.slice(0, left), ...line.slice(right + 1)].every(cell => cell === ' ')
  }
  const lower = cells(bottom)
  if (!marginIsBlank(bottom) || lower[left] !== '╰' || lower[right] !== '╯' ||
    !/^─+ [A-Za-z0-9][A-Za-z0-9 ._:/-]* ─+$/.test(lower.slice(left + 1, right).join(''))) return unknown
  let top = bottom - 2
  while (top >= 0 && cells(top)[left] !== '╭') top--
  if (top < 0 || !marginIsBlank(top) || cells(top)[right] !== '╮') return unknown
  const upper = cells(top).slice(left + 1, right).join('')
  if (!/^─+(?: Stashed ─+)?$/.test(upper)) return unknown
  const first = top + 1
  const inputColumn = left + 4
  if (cells(first).slice(left + 1, inputColumn).join('') !== ' ❯ ') return unknown
  for (let row = first; row < bottom; row++) {
    if (!marginIsBlank(row) || cells(row)[left] !== '│' || cells(row)[right] !== '│') return unknown
    if (row > first && cells(row).slice(left + 1, inputColumn).some(cell => cell !== ' ')) return unknown
  }
  if (frame.cursor.y < first || frame.cursor.y >= bottom || frame.cursor.x < inputColumn || frame.cursor.x >= right) {
    return { kind: 'blocked', reason: 'unfocused-or-modal' }
  }
  if (frame.layoutEpoch > 0) {
    const start = frame.layoutStartGeneration
    if (start === undefined || frame.rows.slice(top, bottom + 1).some(row => (row.paintGeneration ?? -1) <= start)) {
      return { kind: 'warming', reason: 'resizing' }
    }
  }
  // Double Escape stashes and later restores a human draft. An empty-looking
  // box with this native marker is not ours to consume for an automated turn.
  if (upper.includes('Stashed')) return { kind: 'occupied', reason: 'stashed-draft' }
  if (bottom - first > 1 || frame.cursor.x !== inputColumn ||
    cells(first).slice(inputColumn, right).some(cell => cell !== ' ')) return { kind: 'occupied', reason: 'draft' }

  const footer = cells(frame.rows.length - 2).join('').trim().replace(/\s+/g, ' ')
  if (footer.includes('Enter:send')) return { kind: 'occupied', reason: 'draft' }
  // Native unfocused, picker and escape-confirmation hints are different even
  // when an underlying empty composer survives. Unknown hints fail closed.
  // Native capability detection chooses Ctrl+. for iTerm and Ctrl+x for the
  // generic terminal. Both are independently captured, not inferred aliases.
  if (!/^Shift\+Tab:mode │ Ctrl\+[x.]:shortcuts$/.test(footer)) return unknown
  return { kind: 'ready' }
}
